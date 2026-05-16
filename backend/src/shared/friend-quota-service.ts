/**
 * friend-quota-service.ts — Daily friend-request quota tracking per Zalo account.
 *
 * Uses Redis INCR/EXPIRE for concurrency-safe daily counters.
 * Prevents accounts from exceeding Zalo's friend-request limits (default: 30/day).
 *
 * Key format: `zalo:friend-quota:YYYY-MM-DD:{accountId}`
 * TTL:        48 hours (auto-cleanup, survives timezone edge cases)
 *
 * Falls back to in-memory counters when Redis is unavailable (dev mode).
 */
import { getRedis } from './redis-client.js';
import { logger } from './utils/logger.js';

const KEY_PREFIX = 'zalo:friend-quota';
const TTL_SECONDS = 48 * 60 * 60; // 48h — covers timezone drift + next-day cleanup
const DEFAULT_DAILY_LIMIT = 30;

function todayKey(accountId: string): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `${KEY_PREFIX}:${today}:${accountId}`;
}

// ── In-memory fallback (dev/test) ───────────────────────────────────────────
interface MemoryCounter { count: number; date: string; }

// ── FriendQuotaService ──────────────────────────────────────────────────────

export class FriendQuotaService {
  private dailyLimit: number;
  private memoryCounters = new Map<string, MemoryCounter>();

  constructor(dailyLimit = DEFAULT_DAILY_LIMIT) {
    this.dailyLimit = dailyLimit;
  }

  // ── In-memory helpers ───────────────────────────────────────────────────

  private memoryIncr(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const entry = this.memoryCounters.get(accountId);
    if (entry && entry.date === today) {
      entry.count++;
      return entry.count;
    }
    this.memoryCounters.set(accountId, { count: 1, date: today });
    return 1;
  }

  private memoryGet(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const entry = this.memoryCounters.get(accountId);
    return entry && entry.date === today ? entry.count : 0;
  }

  private memoryDecr(accountId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const entry = this.memoryCounters.get(accountId);
    if (entry && entry.date === today && entry.count > 0) {
      entry.count--;
      return entry.count;
    }
    return 0;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Atomically increment the daily friend-request counter for an account.
   * Returns `{ allowed, currentCount }`.
   *
   * If the new count exceeds the limit, the increment is rolled back (DECR)
   * and `allowed = false` is returned — the caller should rotate to another
   * account or defer the request.
   *
   * @param accountId  Zalo account UUID
   */
  async tryIncrement(accountId: string): Promise<{ allowed: boolean; currentCount: number }> {
    const redis = await getRedis();

    if (!redis) {
      // ── In-memory fallback ──
      const count = this.memoryIncr(accountId);
      if (count > this.dailyLimit) {
        this.memoryDecr(accountId);
        return { allowed: false, currentCount: count - 1 };
      }
      return { allowed: true, currentCount: count };
    }

    try {
      const key = todayKey(accountId);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, TTL_SECONDS);

      if (count > this.dailyLimit) {
        await redis.decr(key);
        logger.warn(`[friend-quota] Account ${accountId} reached friend-request limit (${this.dailyLimit})`);
        return { allowed: false, currentCount: count - 1 };
      }

      return { allowed: true, currentCount: count };
    } catch (err) {
      logger.error('[friend-quota] Redis INCR failed, falling back to allow:', err);
      // Fail-open: allow to avoid blocking campaigns due to Redis hiccups
      return { allowed: true, currentCount: 0 };
    }
  }

  /**
   * Rollback an increment if the friend request failed but the quota was already incremented.
   */
  async rollbackIncrement(accountId: string): Promise<void> {
    const redis = await getRedis();
    if (!redis) {
      this.memoryDecr(accountId);
      return;
    }
    try {
      const key = todayKey(accountId);
      await redis.decr(key);
    } catch (err) {
      logger.error(`[friend-quota] Failed to rollback increment for account ${accountId}:`, err);
    }
  }

  /**
   * Get the current daily friend-request count for an account (read-only).
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
   * Get remaining friend-request quota for an account today.
   */
  async getRemaining(accountId: string): Promise<number> {
    const count = await this.getCount(accountId);
    return Math.max(0, this.dailyLimit - count);
  }

  /**
   * Check multiple accounts and return the first one with remaining friend quota.
   * Used by ADD_FRIEND campaign account rotation.
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
   * Batch get daily friend-request counts for multiple accounts.
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
export const friendQuotaService = new FriendQuotaService();
