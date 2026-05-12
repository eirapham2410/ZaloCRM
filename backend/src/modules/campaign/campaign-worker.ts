/**
 * campaign-worker.ts — Job processor for bulk campaign message sending.
 *
 * This is the core "brain" that BullMQ's Worker calls for each job.
 * It orchestrates the full send pipeline:
 *
 *   1. Active hours gate   — delay job until next morning if outside window
 *   2. Blacklist check     — skip if recipient is blacklisted
 *   3. Account rotation    — pick a Zalo account with remaining quota (Redis atomic)
 *   4. Content render      — Spintax + variable substitution → unique message
 *   5. Media cache         — reuse mediaId across the campaign to avoid re-upload
 *   6. Send via zaloOps    — call zca-js through the operations layer
 *   7. DB update           — mark recipient sent/failed, bump campaign counters
 *   8. Socket.IO progress  — real-time dashboard updates
 *
 * Error handling:
 *   - SESSION_EXPIRED / NOT_CONNECTED → mark account "blocked", pick another,
 *     re-throw with UnrecoverableError so BullMQ doesn't count this as a normal retry.
 *   - RATE_LIMITED → throw so BullMQ retries with exponential backoff.
 *   - API_ERROR    → log, mark recipient failed, do NOT retry.
 */
import type { Job } from 'bullmq';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloOps, ZaloOpError } from '../../shared/zalo-operations.js';
import { quotaService } from '../../shared/quota-service.js';
import { ContentProcessor } from '../../shared/text-formatter.js';
import { checkActiveHours, getDelayForRecipientType } from './campaign-queue.js';
import type { CampaignJobData, CampaignJobResult } from './campaign-queue.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeZaloUid } from '../../shared/utils/normalize.js';
import { downloadMediaToBuffer } from '../../shared/utils/file-downloader.js';
import { getImageDimensions } from '../../shared/utils/image-dimensions.js';

const TAG = '[campaign-worker]';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Media cache (in-memory per process, keyed by campaignId) ────────────────
// Stores mediaId returned by Zalo after the first upload so subsequent
// messages in the same campaign skip the upload step.
const mediaCache = new Map<string, Map<string, string>>(); // campaignId → { url → mediaId }

function getCachedMediaId(campaignId: string, url: string): string | undefined {
  return mediaCache.get(campaignId)?.get(url);
}

function setCachedMediaId(campaignId: string, url: string, mediaId: string): void {
  if (!mediaCache.has(campaignId)) {
    mediaCache.set(campaignId, new Map());
  }
  mediaCache.get(campaignId)!.set(url, mediaId);
}

/** Clean up cache when a campaign finishes to free memory. */
export function clearCampaignMediaCache(campaignId: string): void {
  mediaCache.delete(campaignId);
}

// ── Socket.IO reference (set from app.ts at startup) ────────────────────────
let ioServer: Server | null = null;

export function setCampaignWorkerIO(io: Server): void {
  ioServer = io;
}

// ── Helper: emit campaign progress via Socket.IO ────────────────────────────
function emitProgress(campaignId: string, orgId: string, data: {
  recipientId: string;
  status: 'sent' | 'failed' | 'delayed' | 'rate_limited';
  usedAccountId?: string;
  sentCount?: number;
  failedCount?: number;
  totalRecipients?: number;
}): void {
  if (!ioServer) return;
  ioServer.to(`org:${orgId}`).emit('campaign:progress', {
    campaignId,
    ...data,
  });
}

// ── Helper: mark account as blocked in DB + notify ──────────────────────────
async function blockAccountInCampaign(
  campaignId: string,
  accountId: string,
  orgId: string,
  reason: string,
): Promise<void> {
  await prisma.campaignAccountStat.updateMany({
    where: { campaignId, zaloAccountId: accountId },
    data: { status: 'blocked' },
  });

  logger.warn(`${TAG} Account ${accountId} blocked in campaign ${campaignId}: ${reason}`);

  if (ioServer) {
    ioServer.to(`org:${orgId}`).emit('campaign:account_blocked', {
      campaignId,
      accountId,
      reason,
    });
  }
}

// ── Helper: update campaign aggregate counts ────────────────────────────────
async function updateCampaignCounts(campaignId: string): Promise<{
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
}> {
  const [sentCount, failedCount, totalRecipients] = await Promise.all([
    prisma.campaignRecipient.count({ where: { campaignId, status: 'sent' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: { in: ['failed', 'blacklisted', 'rate_limited'] } } }),
    prisma.campaignRecipient.count({ where: { campaignId } }),
  ]);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      failedCount,
      // Mark completed if all recipients are processed
      ...(sentCount + failedCount >= totalRecipients
        ? { status: 'completed', completedAt: new Date() }
        : {}),
    },
  });

  return { sentCount, failedCount, totalRecipients };
}

// ── Helper: find a working account with quota from the pool ─────────────────
async function pickAccount(
  campaignId: string,
  accountIds: string[],
  orgId: string,
): Promise<string | null> {
  // Get accounts that are still active in this campaign
  const activeStats = await prisma.campaignAccountStat.findMany({
    where: {
      campaignId,
      zaloAccountId: { in: accountIds },
      status: 'active',
    },
    select: { zaloAccountId: true },
  });

  const activeIds = activeStats.map(s => s.zaloAccountId);
  if (activeIds.length === 0) return null;

  // Use QuotaService to find one with remaining daily quota
  return quotaService.findAvailableAccount(activeIds);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PROCESSOR — called by BullMQ Worker for each job
// ══════════════════════════════════════════════════════════════════════════════

export async function processCampaignJob(
  job: Job<CampaignJobData>,
): Promise<CampaignJobResult> {
  const {
    campaignId,
    recipientId,
    orgId,
    templateContent,
    templateAttachments,
    contactData,
    recipientType,
    accountIds,
    activeHours,
    delayConfig,
  } = job.data;

  const logPrefix = `${TAG} [campaign:${campaignId.slice(0, 8)}] [recipient:${recipientId.slice(0, 8)}]`;

  // ── Step 1: Active hours gate ─────────────────────────────────────────
  const { withinHours, delayMs } = checkActiveHours(activeHours);
  if (!withinHours) {
    logger.info(`${logPrefix} Outside active hours, delaying ${Math.round(delayMs / 3600000)}h`);

    // moveToDelayed pushes the job back into the queue with a future timestamp
    await job.moveToDelayed(Date.now() + delayMs, job.token);

    // Throw DelayedError so BullMQ doesn't count this as a completed/failed attempt
    throw new DelayedError();
  }

  // ── Step 2: Check if campaign is still running ────────────────────────
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });

  if (!campaign || campaign.status !== 'running') {
    logger.info(`${logPrefix} Campaign not running (status: ${campaign?.status}), skipping`);
    return { recipientId, status: 'failed', error: 'Campaign not running' };
  }

  // ── Step 2.5: Backend Duplicate Prevention ──────────────────────────────
  // Prevent sending the exact same campaign message to the same person multiple times.
  const isDuplicate = await prisma.campaignRecipient.findFirst({
    where: {
      campaignId,
      id: { not: recipientId }, // any OTHER recipient job in this campaign
      OR: [
        ...(contactData.zaloUid ? [{ zaloUid: contactData.zaloUid }] : []),
        ...(contactData.phone ? [{ phone: contactData.phone }] : [])
      ],
      status: { in: ['sent', 'processing'] }
    }
  });

  if (isDuplicate) {
    logger.info(`${logPrefix} Duplicate recipient detected in backend (already sent/processing). Dropping this job.`);
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'failed', errorLog: 'Duplicate recipient dropped to prevent spam.' },
    });
    const counts = await updateCampaignCounts(campaignId);
    emitProgress(campaignId, orgId, { recipientId, status: 'failed', ...counts });
    return { recipientId, status: 'failed', error: 'Duplicate recipient' };
  }

  // ── Step 3: Blacklist check ───────────────────────────────────────────
  const blacklisted = await prisma.blacklist.findFirst({
    where: {
      orgId,
      OR: [
        ...(contactData.phone ? [{ phone: contactData.phone }] : []),
        ...(contactData.zaloUid ? [{ zaloUid: contactData.zaloUid }] : []),
      ],
    },
  });

  if (blacklisted) {
    logger.info(`${logPrefix} Recipient blacklisted, skipping`);
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'blacklisted', errorLog: `Blacklisted: ${blacklisted.reason || 'N/A'}` },
    });
    const counts = await updateCampaignCounts(campaignId);
    emitProgress(campaignId, orgId, { recipientId, status: 'failed', ...counts });
    return { recipientId, status: 'failed', error: 'Blacklisted' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AFFINITY ROUTING ENGINE — Steps 3.5 → 5
  // Determines: (a) is recipient a friend or stranger, (b) which account sends
  // ══════════════════════════════════════════════════════════════════════════

  // Normalize the UID once for all subsequent lookups and API calls
  const cleanUid = normalizeZaloUid(contactData.zaloUid);

  let isStranger = true;
  let accountId: string | null = null;

  // ── Step 3.5: Affinity Match — find the account that owns this friendship ─
  if (cleanUid) {
    // Query: "Which of our campaign accounts is friends with this recipient?"
    const affinityMatch = await prisma.zaloFriend.findFirst({
      where: {
        zaloUid: cleanUid,
        zaloAccountId: { in: accountIds },
      },
      select: { zaloAccountId: true },
    });

    if (affinityMatch) {
      // ── FRIEND PATH: Lock onto the account that owns the relationship ──
      isStranger = false;

      // Verify this account is still active in the campaign
      const accountStat = await prisma.campaignAccountStat.findFirst({
        where: {
          campaignId,
          zaloAccountId: affinityMatch.zaloAccountId,
          status: 'active',
        },
      });

      if (accountStat) {
        accountId = affinityMatch.zaloAccountId;
        logger.info(
          `${logPrefix} [Affinity] Recipient: ${cleanUid.slice(0, 8)}... | ` +
          `Sender: ${accountId.slice(0, 8)}... | Mode: Friend ✓`,
        );
      } else {
        // The friend's account is blocked/exhausted — still treat as friend
        // but pick another active account (friendship benefit = no stranger quota)
        logger.info(
          `${logPrefix} [Affinity] Recipient: ${cleanUid.slice(0, 8)}... | ` +
          `Friend of ${affinityMatch.zaloAccountId.slice(0, 8)}... (inactive). ` +
          `Falling back to another active account (still Friend mode).`,
        );
        accountId = await pickAccount(campaignId, accountIds, orgId);
      }
    } else {
      // ── STRANGER PATH ─────────────────────────────────────────────────
      logger.info(
        `${logPrefix} [Affinity] Recipient: ${cleanUid.slice(0, 8)}... | ` +
        `Mode: Stranger (no friendship found across ${accountIds.length} accounts)`,
      );
    }
  } else {
    // No UID at all — definitely a stranger (phone-only recipient)
    logger.info(`${logPrefix} [Affinity] Recipient has no UID | Mode: Stranger (phone-only)`);
  }

  // Also mark non-friend/non-group as stranger if recipientType says so
  if (recipientType === 'stranger' || recipientType === 'group_member') {
    // Only override if affinity didn't find a friend match
    if (accountId === null) isStranger = true;
  }
  // If recipientType is 'friend' or 'thread_exist' and no affinity match found,
  // trust the frontend classification
  if (recipientType === 'friend' || recipientType === 'thread_exist') {
    isStranger = false;
  }

  // ── Step 4: Account selection (if not already locked by Affinity) ─────
  if (!accountId) {
    accountId = await pickAccount(campaignId, accountIds, orgId);
  }

  if (!accountId) {
    logger.warn(`${logPrefix} All accounts exhausted (quota/blocked). Delaying job 1h.`);
    await job.moveToDelayed(Date.now() + 3600_000, job.token);
    throw new DelayedError();
  }

  // ── Step 5: Quota check with Affinity-aware rotation ──────────────────
  let quotaResult = await quotaService.tryIncrement(accountId, isStranger);

  if (!quotaResult.allowed) {
    const quotaStatus = isStranger ? 'quota_stranger_reached' : 'quota_reached';

    await prisma.campaignAccountStat.updateMany({
      where: { campaignId, zaloAccountId: accountId },
      data: { status: quotaStatus },
    });

    logger.info(`${logPrefix} Account ${accountId.slice(0, 8)} ${quotaStatus}, rotating...`);

    if (isStranger) {
      // ── Stranger rotation: try each remaining account's stranger quota ──
      const remainingAccounts = accountIds.filter(id => id !== accountId);
      let rotated = false;

      for (const candidateId of remainingAccounts) {
        // Check if candidate is still active
        const candidateStat = await prisma.campaignAccountStat.findFirst({
          where: { campaignId, zaloAccountId: candidateId, status: 'active' },
        });
        if (!candidateStat) continue;

        const candidateQuota = await quotaService.tryIncrement(candidateId, true);
        if (candidateQuota.allowed) {
          accountId = candidateId;
          quotaResult = candidateQuota;
          rotated = true;
          logger.info(
            `${logPrefix} [Affinity] Stranger rotation → ${candidateId.slice(0, 8)}... ` +
            `(quota count: ${candidateQuota.currentCount})`,
          );
          break;
        } else {
          // Mark this account's stranger quota as exhausted too
          await prisma.campaignAccountStat.updateMany({
            where: { campaignId, zaloAccountId: candidateId },
            data: { status: 'quota_stranger_reached' },
          });
        }
      }

      if (!rotated) {
        // All accounts exhausted stranger quota
        throw new StrangerQuotaExceededError(accountId!);
      }
    } else {
      // Friend quota exhausted — try another account (general rotation)
      accountId = await pickAccount(campaignId, accountIds, orgId);
      if (!accountId) {
        logger.warn(`${logPrefix} All accounts exhausted after rotation. Delaying 1h.`);
        await job.moveToDelayed(Date.now() + 3600_000, job.token);
        throw new DelayedError();
      }

      quotaResult = await quotaService.tryIncrement(accountId, isStranger);
      if (!quotaResult.allowed) {
        await job.moveToDelayed(Date.now() + 3600_000, job.token);
        throw new DelayedError();
      }
    }
  }

  // ── Step 6: Mark recipient as "processing" ────────────────────────────
  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: 'processing', usedAccountId: accountId },
  });

  // ── Step 7: Content rendering (Spintax + Variables) ───────────────────
  const finalContent = ContentProcessor.process(templateContent, contactData);

  // ── Step 8: Resolve thread ID for sending ─────────────────────────────
  // For bulk campaigns, we send to the recipient's Zalo UID.
  // The zaloOps.sendMessage needs a threadId (which is the zaloUid for 1-to-1 chats).
  let threadId = cleanUid || contactData.zaloUid;

  try {
    if (!threadId) {
      if (contactData.phone) {
        logger.error(`${logPrefix} Missing zaloUid for phone ${contactData.phone}. Pre-campaign resolution should have handled this!`);
      } else {
        logger.error(`${logPrefix} Missing both zaloUid and phone.`);
      }
      throw new Error('Recipient missing valid Zalo UID');
    }

    if (!threadId) {
      const errorMsg = 'No zaloUid and could not resolve phone number';
      logger.warn(`${logPrefix} ${errorMsg}`);
      await prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status: 'failed', errorLog: errorMsg },
      });
      const counts = await updateCampaignCounts(campaignId);
      emitProgress(campaignId, orgId, { recipientId, status: 'failed', ...counts });
      return { recipientId, status: 'failed', error: errorMsg };
    }

    // ── Step 9: Anti-Spam Random Delay + Time-Window Compliance ──────────
    const minDelay = delayConfig?.min ?? 5;
    const maxDelay = delayConfig?.max ?? 15;
    const sleepTime = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;

    logger.info(
      `${logPrefix} Random delay: ${sleepTime}ms. Next message at: ${new Date(Date.now() + sleepTime).toISOString()}`,
    );

    // Notify frontend that this recipient is in delay/sleep state
    emitProgress(campaignId, orgId, {
      recipientId,
      status: 'delayed',
      usedAccountId: accountId,
    });

    // Sleep for the random delay period
    await sleep(sleepTime);

    // After waking up, re-check active hours (we may have slept past the window)
    const postSleepCheck = checkActiveHours(activeHours);
    if (!postSleepCheck.withinHours) {
      logger.info(
        `${logPrefix} Post-sleep check: outside active hours, delaying ${Math.round(postSleepCheck.delayMs / 3600000)}h until next window`,
      );
      await job.moveToDelayed(Date.now() + postSleepCheck.delayMs, job.token);
      throw new DelayedError();
    }

    // Also re-check campaign status (user may have paused/cancelled during sleep)
    const postSleepCampaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!postSleepCampaign || postSleepCampaign.status !== 'running') {
      logger.info(`${logPrefix} Campaign paused/cancelled during delay, skipping`);
      return { recipientId, status: 'failed', error: 'Campaign stopped during delay' };
    }

    // ── Step 10: Send message via zaloOps ─────────────────────────────────
    // 10a. Send text message first
    await zaloOps.sendMessage(accountId, threadId, 0, { msg: finalContent });

    // 9b. Extract source path from attachment (handles multiple field names)
    //     and classify into images vs files for separate Zalo API calls
    interface ResolvedAttachment {
      type: string;
      sourcePath: string;
    }
    const imageAttachments: ResolvedAttachment[] = [];
    const fileAttachments: ResolvedAttachment[] = [];

    for (const attachment of templateAttachments) {
      const att = attachment as Record<string, any>;

      // Data mapping fix: check all possible field names for the source path
      const sourcePath: string | undefined =
        att.url || att.path || att.filePath || att.link || att.src;

      if (!sourcePath) {
        logger.warn(`${logPrefix} Skipping attachment with no source path: ${JSON.stringify(att).slice(0, 120)}`);
        continue;
      }

      const attType = (att.type || '').toLowerCase();

      if (attType === 'image') {
        imageAttachments.push({ type: 'image', sourcePath });
      } else if (['file', 'document', 'video'].includes(attType)) {
        fileAttachments.push({ type: attType, sourcePath });
      } else {
        // Unknown type — treat as file (safe default)
        logger.info(`${logPrefix} Unknown attachment type "${attType}", treating as file`);
        fileAttachments.push({ type: 'file', sourcePath });
      }
    }

    // 9c. Send images — all go through Buffer (no more raw URL passthrough)
    for (const img of imageAttachments) {
      try {
        // Check media cache (avoid re-downloading for subsequent recipients)
        const cachedId = getCachedMediaId(campaignId, img.sourcePath);
        if (cachedId) {
          logger.debug(`${logPrefix} Using cached mediaId for image`);
          // Even with cache, zca-js still needs a Buffer to build the request.
          // Re-download is unavoidable, but upload is skipped server-side.
        }

        // Download image into Buffer (supports both HTTP URLs and local paths)
        const media = await downloadMediaToBuffer(img.sourcePath);

        // Read real image dimensions from Buffer headers (JPEG/PNG/WebP/GIF)
        const dims = getImageDimensions(media.data);
        const imgWidth = dims.width > 0 ? dims.width : 1024;
        const imgHeight = dims.height > 0 ? dims.height : 1024;
        logger.debug(`${logPrefix} Image dimensions: ${imgWidth}x${imgHeight} (${media.filename})`);

        // Send via unified sendAttachments (Buffer-based) with real dimensions
        const imgResult = await zaloOps.sendAttachments(accountId, threadId, 0, [
          { filename: media.filename, data: media.data, metadata: { totalSize: media.size, width: imgWidth, height: imgHeight } },
        ]);

        // Cache the returned mediaId/photoId for subsequent recipients
        const result = imgResult as any;
        const returnedId =
          result?.attachment?.[0]?.photoId ||
          result?.attachment?.[0]?.fileId ||
          result?.mediaId ||
          result?.fileId;
        if (returnedId) {
          setCachedMediaId(campaignId, img.sourcePath, returnedId);
          logger.debug(`${logPrefix} Cached mediaId for image`);
        }

        logger.info(`${logPrefix} ✓ Sent image: ${media.filename} (${(media.size / 1024).toFixed(1)} KB, ${imgWidth}x${imgHeight})`);

        // Free Buffer immediately to help GC
        (media as any).data = null;
      } catch (imgErr: any) {
        logger.warn(`${logPrefix} Failed to send image: ${imgErr.message}`);
        // Continue — don't fail the whole recipient for one bad image
      }
    }

    // 9d. Send file attachments (PDF, Docx, etc.) — each in its own API call
    for (const file of fileAttachments) {
      try {
        // Download file into Buffer (with 25MB Memory Guard)
        const media = await downloadMediaToBuffer(file.sourcePath);

        // Send via unified sendAttachments (Buffer-based)
        await zaloOps.sendAttachments(accountId, threadId, 0, [
          { filename: media.filename, data: media.data, metadata: { totalSize: media.size } },
        ]);

        logger.info(`${logPrefix} ✓ Sent file: ${media.filename} (${(media.size / 1024).toFixed(1)} KB)`);

        // Free Buffer immediately to help GC
        (media as any).data = null;
      } catch (fileErr: any) {
        logger.warn(`${logPrefix} Failed to send file: ${fileErr.message}`);
        // Continue — don't fail the whole recipient for one bad file
      }
    }

    // ── Step 10: Mark recipient as sent ────────────────────────────────
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'sent',
        usedAccountId: accountId,
        sentAt: new Date(),
      },
    });

    // Update campaign-level account stats
    await prisma.campaignAccountStat.updateMany({
      where: { campaignId, zaloAccountId: accountId },
      data: { sentCount: { increment: 1 } },
    });

    // Update aggregate counts and emit progress
    const counts = await updateCampaignCounts(campaignId);
    emitProgress(campaignId, orgId, {
      recipientId,
      status: 'sent',
      usedAccountId: accountId,
      ...counts,
    });

    logger.info(`${logPrefix} ✓ Sent via ${accountId.slice(0, 8)} (${counts.sentCount}/${counts.totalRecipients})`);

    return { recipientId, status: 'sent', usedAccountId: accountId };

  } catch (err) {
    // ── Error handling: classify and respond ─────────────────────────────

    // ── STRANGER QUOTA EXCEEDED ───────────────────────────────────────
    // All accounts have hit their daily stranger message limit.
    // Mark this recipient as 'rate_limited' (NOT 'failed') so it can
    // be retried on a future day. Bulk-mark all remaining stranger
    // recipients in this campaign to avoid wasting processing cycles.
    if (err instanceof StrangerQuotaExceededError) {
      logger.warn(`${logPrefix} ✗ Stranger quota exceeded on all accounts. Marking remaining strangers as rate_limited.`);

      // Mark THIS recipient
      await prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: 'rate_limited',
          usedAccountId: accountId,
          errorLog: `Stranger quota exceeded (limit: ${quotaService.getStrangerLimit()}/day). Retry tomorrow.`,
        },
      });

      // Bulk-mark all OTHER pending stranger recipients in this campaign
      const bulkResult = await prisma.campaignRecipient.updateMany({
        where: {
          campaignId,
          id: { not: recipientId },
          recipientType: 'stranger',
          status: 'pending',
        },
        data: {
          status: 'rate_limited',
          errorLog: `Stranger quota exceeded on all accounts. Paused to protect account.`,
        },
      });

      logger.info(`${logPrefix} Bulk-marked ${bulkResult.count} pending stranger recipients as rate_limited.`);

      // Notify frontend
      const counts = await updateCampaignCounts(campaignId);
      emitProgress(campaignId, orgId, { recipientId, status: 'rate_limited', usedAccountId: accountId, ...counts });

      if (ioServer) {
        ioServer.to(`org:${orgId}`).emit('campaign:stranger_quota_hit', {
          campaignId,
          accountId,
          strangerLimit: quotaService.getStrangerLimit(),
          bulkPaused: bulkResult.count,
        });
      }

      return { recipientId, status: 'failed', usedAccountId: accountId, error: 'Stranger quota exceeded' };
    }

    if (err instanceof ZaloOpError) {
      switch (err.code) {
        // ── SESSION_EXPIRED / NOT_CONNECTED ──────────────────────────
        // Account lost its session mid-campaign. Block it, pick another,
        // and re-queue this job so it gets a fresh account.
        case 'SESSION_EXPIRED':
        case 'NOT_CONNECTED': {
          await blockAccountInCampaign(campaignId, accountId, orgId, err.message);

          // Reset recipient status so it can be re-processed
          await prisma.campaignRecipient.update({
            where: { id: recipientId },
            data: { status: 'pending', usedAccountId: null, errorLog: null },
          });

          // Check if there are other active accounts
          const fallbackAccount = await pickAccount(campaignId, accountIds, orgId);
          if (fallbackAccount) {
            logger.info(
              `${logPrefix} Account ${accountId.slice(0, 8)} expired, re-queuing for ${fallbackAccount.slice(0, 8)}`,
            );
            // Throw so BullMQ retries this job (it will pick a new account)
            throw new Error(`Account ${accountId.slice(0, 8)} session expired — retrying with another account`);
          } else {
            // No more accounts — delay the job
            logger.warn(`${logPrefix} All accounts down. Delaying 1h.`);
            await job.moveToDelayed(Date.now() + 3600_000, job.token);
            throw new DelayedError();
          }
        }

        // ── RATE_LIMITED ─────────────────────────────────────────────
        // Zalo's own rate limit hit. Let BullMQ retry with backoff.
        case 'RATE_LIMITED': {
          logger.warn(`${logPrefix} Rate limited on ${accountId.slice(0, 8)}, will retry with backoff`);
          await prisma.campaignRecipient.update({
            where: { id: recipientId },
            data: { status: 'pending', usedAccountId: null },
          });
          throw err; // BullMQ will retry with exponential backoff
        }

        // ── API_ERROR / INVALID_PARAMS ──────────────────────────────
        // Permanent error for this recipient. Don't retry.
        case 'API_ERROR':
        case 'INVALID_PARAMS':
        default: {
          const errorMsg = `${err.code}: ${err.message}`;
          logger.warn(`${logPrefix} ✗ ${errorMsg}`);

          await prisma.campaignRecipient.update({
            where: { id: recipientId },
            data: {
              status: 'failed',
              usedAccountId: accountId,
              errorLog: errorMsg.slice(0, 500), // Truncate for DB storage
            },
          });

          await prisma.campaignAccountStat.updateMany({
            where: { campaignId, zaloAccountId: accountId },
            data: { failedCount: { increment: 1 } },
          });

          const counts = await updateCampaignCounts(campaignId);
          emitProgress(campaignId, orgId, {
            recipientId,
            status: 'failed',
            usedAccountId: accountId,
            ...counts,
          });

          return { recipientId, status: 'failed', usedAccountId: accountId, error: errorMsg };
        }
      }
    }

    // ── Unknown / unexpected errors ───────────────────────────────────
    const errorMsg = `Unexpected: ${(err as Error).message || String(err)}`;
    logger.error(`${logPrefix} ✗ ${errorMsg}`);

    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'failed',
        usedAccountId: accountId,
        errorLog: errorMsg.slice(0, 500),
      },
    });

    const counts = await updateCampaignCounts(campaignId);
    emitProgress(campaignId, orgId, {
      recipientId,
      status: 'failed',
      usedAccountId: accountId,
      ...counts,
    });

    return { recipientId, status: 'failed', usedAccountId: accountId, error: errorMsg };
  }
}

// ── DelayedError — signals BullMQ that the job was intentionally delayed ────
// This is NOT a real failure. BullMQ treats it as "job moved, not failed".

class DelayedError extends Error {
  constructor() {
    super('Job delayed — moved to future timestamp');
    this.name = 'DelayedError';
  }
}

// ── StrangerQuotaExceededError — all accounts hit stranger daily limit ───────
// This is a soft error: the campaign should stop processing stranger recipients
// but continue processing friend recipients normally.

export class StrangerQuotaExceededError extends Error {
  public readonly accountId: string;

  constructor(accountId: string) {
    super(`All accounts reached stranger quota limit. Last account: ${accountId}`);
    this.name = 'StrangerQuotaExceededError';
    this.accountId = accountId;
  }
}
