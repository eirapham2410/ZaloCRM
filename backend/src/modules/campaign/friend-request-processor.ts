import type { Job } from 'bullmq';
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloOps, ZaloOpError } from '../../shared/zalo-operations.js';
import { friendQuotaService } from '../../shared/friend-quota-service.js';
import { renderInviteMessage } from '../../shared/content-processor.js';
import { checkActiveHours } from './campaign-queue.js';
import type { CampaignJobData, CampaignJobResult } from './campaign-queue.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../../modules/zalo/zalo-pool.js';

const TAG = '[friend-request-processor]';

class DelayedError extends Error {
  constructor(message = 'Job delayed') {
    super(message);
    this.name = 'DelayedError';
  }
}

/**
 * Finds an active account with remaining friend request quota.
 */
async function pickAccount(
  campaignId: string,
  accountIds: string[],
): Promise<string | null> {
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

  return friendQuotaService.findAvailableAccount(activeIds);
}

/**
 * Blocks an account in the current campaign context.
 */
async function blockAccountInCampaign(
  campaignId: string,
  accountId: string,
  reason: string,
): Promise<void> {
  await prisma.campaignAccountStat.updateMany({
    where: { campaignId, zaloAccountId: accountId },
    data: { status: 'blocked' },
  });
  logger.warn(`${TAG} Account ${accountId} blocked in campaign ${campaignId}: ${reason}`);
}

export async function processFriendRequestJob(
  job: Job<CampaignJobData>,
): Promise<CampaignJobResult> {
  const {
    campaignId,
    recipientId,
    orgId,
    templateContent, // In ADD_FRIEND campaigns, this acts as the inviteMessage template
    contactData,
    accountIds,
    activeHours,
  } = job.data;

  const logPrefix = `${TAG} [campaign:${campaignId.slice(0, 8)}] [recipient:${recipientId.slice(0, 8)}]`;

  // 1. Check Active Hours
  const { withinHours, delayMs } = checkActiveHours(activeHours);
  if (!withinHours) {
    logger.info(`${logPrefix} Outside active hours, delaying ${Math.round(delayMs / 3600000)}h`);
    await job.moveToDelayed(Date.now() + delayMs, job.token);
    throw new DelayedError();
  }

  // 2. Check if Campaign is running
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });

  if (!campaign || campaign.status !== 'running') {
    logger.info(`${logPrefix} Campaign not running, skipping`);
    return { recipientId, status: 'failed', error: 'Campaign not running' };
  }

  // 3. Ensure Phone Number exists
  const phone = contactData.phone;
  if (!phone) {
    logger.error(`${logPrefix} Missing phone number for friend request.`);
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'failed', errorLog: 'Missing phone number' },
    });
    return { recipientId, status: 'failed', error: 'Missing phone number' };
  }

  // 4. Resolve an initial account (we'll rotate if it's out of quota)
  let accountId = await pickAccount(campaignId, accountIds);
  if (!accountId) {
    logger.warn(`${logPrefix} All accounts exhausted (quota/blocked). Delaying job 1h.`);
    await job.moveToDelayed(Date.now() + 3600_000, job.token);
    throw new DelayedError();
  }

  try {
    // 5. Find User by Phone
    let userId: string;
    try {
      const userProfile: any = await zaloOps.findUser(accountId, phone);
      userId = userProfile?.uid || userProfile?.userId;
      if (!userId) {
         throw new Error("Could not extract UID from findUser response");
      }
    } catch (err: any) {
      if (err instanceof ZaloOpError && (String(err.code) === '212' || String(err.message).includes('Không tìm thấy'))) {
        logger.info(`${logPrefix} SĐT ${phone} không tìm thấy trên Zalo (Code 212). Marking as not_found.`);
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: { status: 'not_found', errorLog: 'Số điện thoại chưa đăng ký Zalo hoặc chặn tìm kiếm' },
        });
        return { recipientId, status: 'skipped', error: 'User not found on Zalo' };
      }
      throw err; // Other network/auth errors bubble up
    }

    // 6. Quota check & Auto-Rotation
    let quotaResult = await friendQuotaService.tryIncrement(accountId);
    if (!quotaResult.allowed) {
      await prisma.campaignAccountStat.updateMany({
        where: { campaignId, zaloAccountId: accountId },
        data: { status: 'quota_reached' },
      });
      logger.info(`${logPrefix} Account ${accountId.slice(0, 8)} friend quota reached, rotating...`);

      let rotated = false;
      const remainingAccounts = accountIds.filter(id => id !== accountId);

      for (const candidateId of remainingAccounts) {
        const candidateStat = await prisma.campaignAccountStat.findFirst({
          where: { campaignId, zaloAccountId: candidateId, status: 'active' },
        });
        if (!candidateStat) continue;

        const candidateQuota = await friendQuotaService.tryIncrement(candidateId);
        if (candidateQuota.allowed) {
          accountId = candidateId;
          rotated = true;
          logger.info(`${logPrefix} Rotation successful -> ${candidateId.slice(0, 8)}`);
          break;
        } else {
          await prisma.campaignAccountStat.updateMany({
            where: { campaignId, zaloAccountId: candidateId },
            data: { status: 'quota_reached' },
          });
        }
      }

      if (!rotated) {
        logger.warn(`${logPrefix} All accounts exhausted daily friend quota. Delaying 24h.`);
        // Mark all remaining pending friends in this campaign? No, just delay the job 24h.
        await job.moveToDelayed(Date.now() + 86400000, job.token);
        throw new DelayedError();
      }
    }

    // 7. Render personalized invite message
    const finalMessage = renderInviteMessage(templateContent || '', contactData);

    // 8. Mark processing
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'processing', usedAccountId: accountId },
    });

    // 9. Send Friend Request
    await zaloOps.sendFriendRequest(accountId, finalMessage, userId);

    // 10. Update Success State
    await prisma.$transaction([
      prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status: 'sent_request', usedAccountId: accountId, sentAt: new Date() },
      }),
      prisma.campaignAccountStat.updateMany({
        where: { campaignId, zaloAccountId: accountId },
        data: { sentCount: { increment: 1 } },
      }),
    ]);

    logger.info(`${logPrefix} ✓ Friend request sent via ${accountId.slice(0, 8)}`);
    return { recipientId, status: 'sent_request', usedAccountId: accountId };

  } catch (err: any) {
    // If we incremented quota but sending failed, we should rollback
    if (accountId) {
      await friendQuotaService.rollbackIncrement(accountId).catch(() => {});
    }

    if (err instanceof ZaloOpError) {
      if (err.code === 'SESSION_EXPIRED') {
        await blockAccountInCampaign(campaignId, accountId, 'Session Expired');
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: { status: 'pending', usedAccountId: null },
        });
        throw new Error(`Account session expired - retrying`);
      }
      
      if (err.code === 'NOT_CONNECTED') {
        if (job.attemptsMade < 2) {
          await prisma.campaignRecipient.update({
            where: { id: recipientId },
            data: { status: 'pending', usedAccountId: null },
          });
          zaloPool.ensureConnection(accountId).catch(() => {});
          throw err;
        }
        await blockAccountInCampaign(campaignId, accountId, 'Failed to reconnect');
        throw new Error(`Account NOT_CONNECTED exhausted retries`);
      }
      
      if (err.code === 'RATE_LIMITED') {
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: { status: 'pending', usedAccountId: null },
        });
        throw err;
      }

      // Handle specific friend request errors (e.g. already friends, too many requests)
      const errMessage = err.message || '';
      if (errMessage.includes('đã là bạn bè')) {
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: { status: 'skipped', errorLog: 'Đã là bạn bè' },
        });
        return { recipientId, status: 'skipped', error: 'Already friends' };
      }
    }

    if (err instanceof DelayedError) throw err;

    // Permanent Failure
    logger.error(`${logPrefix} Failed to process friend request:`, err);
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'failed', errorLog: err.message || 'Unknown error' },
    });
    return { recipientId, status: 'failed', error: err.message };
  }
}
