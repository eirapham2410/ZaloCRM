import cron from 'node-cron';
import { prisma } from '../../shared/database/prisma-client.js';
import { getRedis } from '../../shared/redis-client.js';
import { logger } from '../../shared/utils/logger.js';
import { telemetryService } from './telemetry-service.js';

/**
 * Sweeps active Zalo accounts every 5 minutes to evaluate Shadow-Ban signals
 * and automatically lift restrictions (Auto-Unthrottling) if the account is clean.
 */
async function runTelemetrySweepJob() {
  logger.info('[TelemetryCron] Starting scheduled telemetry evaluation sweep...');
  try {
    // We only care about currently active sessions producing telemetry data
    const activeAccounts = await prisma.zaloAccount.findMany({
      where: { status: 'connected' },
      select: { id: true, orgId: true }
    });

    if (activeAccounts.length === 0) {
      logger.info('[TelemetryCron] No active accounts to evaluate.');
      return;
    }

    const r = await getRedis();
    let evaluated = 0;
    let unthrottled = 0;

    for (const account of activeAccounts) {
      // 1. Evaluate current sliding window (Last 1 hour)
      const signalsCount = await telemetryService.evaluateAccount(account.id);
      evaluated++;

      // 2. Auto-Unthrottling Logic
      // If the account is currently throttled, but has completely cooled down
      // (0 signals in the current evaluation window), we lift the penalty early.
      if (r) {
        const throttledKey = `tel:throttled:${account.id}`;
        const isThrottled = await r.get(throttledKey);

        if (isThrottled && signalsCount === 0) {
          await r.del(throttledKey);
          unthrottled++;
          
          logger.info(`[TelemetryCron:${account.id}] Account is clean. Lifting Auto-Throttling penalty.`);
          
          // Log the unthrottling action to DB for auditing
          try {
            await prisma.activityLog.create({
              data: {
                orgId: account.orgId,
                action: 'shadow_ban_lifted',
                entityType: 'ZaloAccount',
                entityId: account.id,
                details: { timestamp: Date.now(), reason: 'auto_unthrottled' },
              }
            });
          } catch (err) {
             logger.error(`[TelemetryCron:${account.id}] Failed to save unthrottle log:`, err);
          }
        }
      }
    }

    logger.info(`[TelemetryCron] Sweep completed. Evaluated ${evaluated} accounts, Unthrottled ${unthrottled} accounts.`);
  } catch (err) {
    logger.error('[TelemetryCron] Job failed:', err);
  }
}

export function startTelemetryCron() {
  // Run every 5 minutes
  const task = cron.schedule('*/5 * * * *', runTelemetrySweepJob);
  logger.info('[TelemetryCron] Telemetry evaluation cronjob scheduled (runs every 5m).');
  return task;
}
