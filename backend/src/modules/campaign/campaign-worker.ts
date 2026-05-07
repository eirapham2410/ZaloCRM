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

const TAG = '[campaign-worker]';

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
  status: 'sent' | 'failed' | 'delayed';
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
    prisma.campaignRecipient.count({ where: { campaignId, status: { in: ['failed', 'blacklisted'] } } }),
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

  // ── Step 4: Account rotation — pick account with quota ────────────────
  let accountId = await pickAccount(campaignId, accountIds, orgId);

  if (!accountId) {
    logger.warn(`${logPrefix} All accounts exhausted (quota/blocked). Delaying job 1h.`);
    await job.moveToDelayed(Date.now() + 3600_000, job.token);
    throw new DelayedError();
  }

  // ── Step 5: Quota check (atomic Redis INCR) ───────────────────────────
  let quotaResult = await quotaService.tryIncrement(accountId);

  // If this account just ran out, try the next one in pool
  if (!quotaResult.allowed) {
    await prisma.campaignAccountStat.updateMany({
      where: { campaignId, zaloAccountId: accountId },
      data: { status: 'quota_reached' },
    });

    logger.info(`${logPrefix} Account ${accountId.slice(0, 8)} quota reached, rotating...`);

    // Try remaining accounts
    accountId = await pickAccount(campaignId, accountIds, orgId);
    if (!accountId) {
      logger.warn(`${logPrefix} All accounts exhausted after rotation. Delaying 1h.`);
      await job.moveToDelayed(Date.now() + 3600_000, job.token);
      throw new DelayedError();
    }

    quotaResult = await quotaService.tryIncrement(accountId);
    if (!quotaResult.allowed) {
      await job.moveToDelayed(Date.now() + 3600_000, job.token);
      throw new DelayedError();
    }
  }

  // ── Step 6: Mark recipient as "processing" ────────────────────────────
  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: 'processing', usedAccountId: accountId },
  });

  // ── Step 7: Content rendering (Spintax + Variables) ───────────────────
  const finalContent = ContentProcessor.process(templateContent, {
    name: contactData.name,
    phone: contactData.phone,
    email: contactData.email,
    zaloUid: contactData.zaloUid,
  });

  // ── Step 8: Resolve thread ID for sending ─────────────────────────────
  // For bulk campaigns, we send to the recipient's Zalo UID.
  // The zaloOps.sendMessage needs a threadId (which is the zaloUid for 1-to-1 chats).
  const threadId = contactData.zaloUid;
  if (!threadId) {
    const errorMsg = 'No zaloUid — cannot send message';
    logger.warn(`${logPrefix} ${errorMsg}`);
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'failed', errorLog: errorMsg },
    });
    const counts = await updateCampaignCounts(campaignId);
    emitProgress(campaignId, orgId, { recipientId, status: 'failed', ...counts });
    return { recipientId, status: 'failed', error: errorMsg };
  }

  // ── Step 9: Send message via zaloOps ──────────────────────────────────
  try {
    // Send text message
    await zaloOps.sendMessage(accountId, threadId, 0, { msg: finalContent });

    // Send media attachments (if any)
    for (const attachment of templateAttachments) {
      const att = attachment as { type?: string; url?: string; mediaId?: string };
      if (att.type === 'image' && att.url) {
        // Check media cache first
        const cachedId = getCachedMediaId(campaignId, att.url);
        if (cachedId) {
          // Use cached mediaId (skip re-upload)
          logger.debug(`${logPrefix} Using cached mediaId for ${att.url.slice(0, 40)}`);
          await zaloOps.sendImage(accountId, threadId, 0, [{ url: att.url, mediaId: cachedId }]);
        } else {
          // First time — send and cache the mediaId from response
          const imgResult = await zaloOps.sendImage(accountId, threadId, 0, [{ url: att.url }]);
          // If Zalo returns a mediaId/fileId, cache it for subsequent sends
          const returnedMediaId = (imgResult as any)?.mediaId || (imgResult as any)?.fileId;
          if (returnedMediaId) {
            setCachedMediaId(campaignId, att.url, returnedMediaId);
            logger.debug(`${logPrefix} Cached mediaId for ${att.url.slice(0, 40)}`);
          }
        }
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
          logger.error(`${logPrefix} ✗ ${errorMsg}`);

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
