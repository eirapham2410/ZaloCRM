/**
 * quota-service.ts — Atomic Redis-based quota tracking for campaign bulk sends.
 *
 * Uses Redis INCR/EXPIRE for concurrency-safe daily counters per Zalo account.
 * When multiple BullMQ Workers run in parallel, this prevents race conditions
 * that would otherwise cause an account to exceed its daily message limit.
 *
 * Key format:  `zalo:quota:YYYY-MM-DD:{accountId}`
 * TTL:         48 hours (auto-cleanup, survives timezone edge cases)
 *
 * Falls back to in-memory counters when Redis is unavailable (dev mode).
 */
import { getRedis } from './redis-client.js';
import { logger } from './utils/logger.js';

const KEY_PREFIX = 'zalo:quota';
const TTL_SECONDS = 48 * 60 * 60; // 48h — covers timezone drift + next-day cleanup
const DEFAULT_DAILY_LIMIT = 200;

function todayKey(accountId: string): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `${KEY_PREFIX}:${today}:${accountId}`;
}

// ── In-memory fallback (dev/test) ───────────────────────────────────────────
interface MemoryCounter { count: number; date: string; }

// ── QuotaService ────────────────────────────────────────────────────────────

export class QuotaService {
  private dailyLimit: number;
  private memoryCounters = new Map<string, MemoryCounter>();

  constructor(dailyLimit = DEFAULT_DAILY_LIMIT) {
    this.dailyLimit = dailyLimit;
  }

  private memoryIncr(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const key = `${accountId}:${today}`;
    const entry = this.memoryCounters.get(key);
    if (entry && entry.date === today) {
      entry.count++;
      return entry.count;
    }
    this.memoryCounters.set(key, { count: 1, date: today });
    return 1;
  }

  private memoryGet(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const key = `${accountId}:${today}`;
    const entry = this.memoryCounters.get(key);
    return entry && entry.date === today ? entry.count : 0;
  }

  private memoryDecr(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const key = `${accountId}:${today}`;
    const entry = this.memoryCounters.get(key);
    if (entry && entry.date === today && entry.count > 0) {
      entry.count--;
      return entry.count;
    }
    return 0;
  }

  /**
   * Atomically increment the daily send counter for an account.
   * Returns `{ allowed, currentCount }`.
   *
   * If the new count exceeds `dailyLimit`, the increment is rolled back
   * (DECR) and `allowed = false` is returned — the caller should switch
   * to another account.
   *
   * @param accountId  Zalo account UUID
   * @returns Whether the send is allowed and the current count
   */
  async tryIncrement(accountId: string): Promise<{ allowed: boolean; currentCount: number }> {
    const redis = await getRedis();

    if (!redis) {
      // In-memory fallback
      const count = this.memoryIncr(accountId);
      if (count > this.dailyLimit) {
        this.memoryDecr(accountId);
        return { allowed: false, currentCount: count - 1 };
      }
      return { allowed: true, currentCount: count };
    }

    try {
      const key = todayKey(accountId);

      // INCR is atomic — safe for concurrent workers
      const newCount = await redis.incr(key);

      // Set TTL only on first increment (when count becomes 1)
      if (newCount === 1) {
        await redis.expire(key, TTL_SECONDS);
      }

      if (newCount > this.dailyLimit) {
        // Rollback: we over-incremented
        await redis.decr(key);
        logger.warn(`[quota] Account ${accountId} reached daily limit (${this.dailyLimit})`);
        return { allowed: false, currentCount: newCount - 1 };
      }

      return { allowed: true, currentCount: newCount };
    } catch (err) {
      logger.error('[quota] Redis INCR failed, falling back to allow:', err);
      // Fail-open: allow the send to avoid blocking campaigns due to Redis hiccups
      return { allowed: true, currentCount: 0 };
    }
  }

  /**
   * Get the current daily send count for an account (read-only).
   */
  async getCount(accountId: string): Promise<number> {
    const redis = await getRedis();
    if (!redis) return this.memoryGet(accountId);

    try {
      const val = await redis.get(todayKey(accountId));
      return val ? parseInt(val, 10) : 0;
    } catch {
      return this.memoryGet(accountId);
    }
  }

  /**
   * Get remaining quota for an account today.
   */
  async getRemaining(accountId: string): Promise<number> {
    const count = await this.getCount(accountId);
    return Math.max(0, this.dailyLimit - count);
  }

  /**
   * Check multiple accounts and return the first one with remaining quota.
   * Used by campaign account rotation.
   *
   * @param accountIds  List of Zalo account UUIDs to check
   * @returns The first accountId with quota, or null if all exhausted
   */
  async findAvailableAccount(accountIds: string[]): Promise<string | null> {
    for (const id of accountIds) {
      const remaining = await this.getRemaining(id);
      if (remaining > 0) return id;
    }
    return null;
  }

  /**
   * Batch get daily counts for multiple accounts.
   * Useful for dashboard display.
   */
  async getMultipleCounts(accountIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const redis = await getRedis();

    if (!redis) {
      for (const id of accountIds) {
        result[id] = this.memoryGet(id);
      }
      return result;
    }

    try {
      const pipeline = redis.pipeline();
      for (const id of accountIds) {
        pipeline.get(todayKey(id));
      }
      const responses = await pipeline.exec();
      if (responses) {
        for (let i = 0; i < accountIds.length; i++) {
          const [err, val] = responses[i];
          result[accountIds[i]] = !err && val ? parseInt(val as string, 10) : 0;
        }
      }
    } catch {
      for (const id of accountIds) {
        result[id] = 0;
      }
    }

    return result;
  }

  /** Expose the configured limit for external use. */
  getDailyLimit(): number {
    return this.dailyLimit;
  }
}

/** Shared singleton instance */
export const quotaService = new QuotaService();
