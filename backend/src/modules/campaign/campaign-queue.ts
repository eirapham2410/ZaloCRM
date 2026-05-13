/**
 * campaign-queue.ts — BullMQ Queue + Worker for bulk campaign message sending.
 *
 * Architecture:
 *   - One shared Queue (`zalo-campaigns`) holds all send jobs across campaigns.
 *   - A single Worker processes jobs with controlled concurrency.
 *   - Each job represents ONE message to ONE recipient.
 *   - The Worker enforces: active hours, quota (via QuotaService), account
 *     rotation, spintax/variables (via ContentProcessor), and anti-spam delays.
 *
 * Job lifecycle:
 *   1. CampaignService creates N jobs (one per recipient) with staggered delays.
 *   2. Worker picks up a job → checks active hours → checks quota → sends.
 *   3. On success: updates CampaignRecipient + emits Socket.IO progress.
 *   4. On failure: logs error, may retry (transient) or mark failed (permanent).
 *
 * Retry strategy:
 *   - 3 attempts with exponential backoff (30s, 60s, 120s).
 *   - SESSION_EXPIRED errors are NOT retried (account is marked blocked).
 */
import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisForBullMQ } from '../../shared/redis-client.js';
import { logger } from '../../shared/utils/logger.js';

// ── Job data shape ──────────────────────────────────────────────────────────

export interface CampaignJobData {
  campaignId: string;
  recipientId: string;
  orgId: string;
  templateContent: string;          // Raw template with spintax + variables
  templateAttachments: unknown[];    // Media attachments from MessageTemplate
  contactData: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    zaloUid?: string | null;
    [key: string]: any;
  };
  recipientType: 'stranger' | 'friend' | 'thread_exist' | 'group_member' | 'group';
  accountIds: string[];             // Pool of available Zalo account IDs
  activeHours: { start: string; end: string };
  delayConfig?: { min: number; max: number };
}

export interface CampaignJobResult {
  recipientId: string;
  status: 'sent' | 'failed' | 'delayed' | 'skipped' | 'rate_limited';
  usedAccountId?: string;
  error?: string;
}

// ── Queue name ──────────────────────────────────────────────────────────────

export const CAMPAIGN_QUEUE_NAME = 'zalo-campaigns';

// ── Queue factory ───────────────────────────────────────────────────────────

let queueInstance: Queue<CampaignJobData, CampaignJobResult> | null = null;

/**
 * Get or create the campaign Queue singleton.
 * Call this from CampaignService when enqueuing jobs.
 */
export function getCampaignQueue(): Queue<CampaignJobData, CampaignJobResult> {
  if (queueInstance) return queueInstance;

  const connection = getRedisForBullMQ() as ConnectionOptions;

  queueInstance = new Queue<CampaignJobData, CampaignJobResult>(CAMPAIGN_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30_000,         // 30s → 60s → 120s
      },
      removeOnComplete: {
        age: 24 * 3600,       // Keep completed jobs for 24h (for dashboard queries)
        count: 5000,           // Max 5000 completed jobs retained
      },
      removeOnFail: {
        age: 7 * 24 * 3600,  // Keep failed jobs for 7 days (for debugging)
      },
    },
  });

  logger.info('[campaign-queue] Queue created: %s', CAMPAIGN_QUEUE_NAME);
  return queueInstance;
}

// ── Utility: Active hours check ─────────────────────────────────────────────

/**
 * Check if current time is within the campaign's active hours.
 * Returns the delay in ms until the next active window if outside hours.
 */
export function checkActiveHours(activeHours: { start: string; end: string }): { withinHours: boolean; delayMs: number } {
  const now = new Date();
  const [startH, startM] = activeHours.start.split(':').map(Number);
  const [endH, endM] = activeHours.end.split(':').map(Number);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return { withinHours: true, delayMs: 0 };
  }

  // Calculate delay until next start time
  let nextStart = new Date(now);
  nextStart.setHours(startH, startM, 0, 0);

  if (currentMinutes >= endMinutes) {
    // Past end time today → next start is tomorrow
    nextStart.setDate(nextStart.getDate() + 1);
  }

  const delayMs = nextStart.getTime() - now.getTime();
  return { withinHours: false, delayMs };
}

// ── Delay calculation based on recipient type ───────────────────────────────

/**
 * Calculate random delay between messages based on recipient type.
 * Strangers get much longer delays to reduce Zalo ban risk.
 */
export function getDelayForRecipientType(recipientType: string): number {
  switch (recipientType) {
    case 'thread_exist':
      // 15s – 30s: lowest risk, already have conversation history
      return randomBetween(15_000, 30_000);
    case 'friend':
      // 30s – 60s: low risk, already friends
      return randomBetween(30_000, 60_000);
    case 'stranger':
    default:
      // 300s – 600s (5–10 min): high risk, never interacted
      return randomBetween(300_000, 600_000);
  }
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Worker factory ──────────────────────────────────────────────────────────

let workerInstance: Worker<CampaignJobData, CampaignJobResult> | null = null;

/**
 * Create and start the campaign Worker.
 * Should be called ONCE during app startup (in app.ts).
 *
 * @param processor  The function that actually sends a message.
 *                   This is injected so the queue module stays decoupled
 *                   from Prisma/zaloOps/Socket.IO (easier to test).
 */
export function startCampaignWorker(
  processor: (job: Job<CampaignJobData>) => Promise<CampaignJobResult>,
): Worker<CampaignJobData, CampaignJobResult> {
  if (workerInstance) return workerInstance;

  const connection = getRedisForBullMQ() as ConnectionOptions;

  workerInstance = new Worker<CampaignJobData, CampaignJobResult>(
    CAMPAIGN_QUEUE_NAME,
    processor,
    {
      connection,
      concurrency: 3,          // Process up to 3 jobs in parallel
      limiter: {
        max: 1,                // Global: max 1 job completed per 10s
        duration: 10_000,      // Anti-spam baseline (per-recipient delay is on top)
      },
      autorun: true,
    },
  );

  // ── Worker event handlers ─────────────────────────────────────────────
  workerInstance.on('completed', (job) => {
    logger.debug(
      '[campaign-worker] Job %s completed (recipient: %s)',
      job.id,
      job.data.recipientId,
    );
  });

  workerInstance.on('failed', (job, err) => {
    logger.error(
      '[campaign-worker] Job %s failed (recipient: %s): %s',
      job?.id,
      job?.data.recipientId,
      err.message,
    );
  });

  workerInstance.on('error', (err) => {
    logger.error('[campaign-worker] Worker error:', err);
  });

  logger.info(
    '[campaign-queue] Worker started (concurrency: 3, limiter: 1 job/10s)',
  );

  return workerInstance;
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

export async function closeCampaignQueue(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    logger.info('[campaign-queue] Worker closed');
  }
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
    logger.info('[campaign-queue] Queue closed');
  }
}
