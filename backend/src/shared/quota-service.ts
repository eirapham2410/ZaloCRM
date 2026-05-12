/**
 * quota-service.ts — Atomic Redis-based quota tracking for campaign bulk sends.
 *
 * Uses Redis INCR/EXPIRE for concurrency-safe daily counters per Zalo account.
 * When multiple BullMQ Workers run in parallel, this prevents race conditions
 * that would otherwise cause an account to exceed its daily message limit.
 *
 * Key format (general):  `zalo:quota:YYYY-MM-DD:{accountId}`
 * Key format (stranger): `zalo:quota:stranger:YYYY-MM-DD:{accountId}`
 * TTL:                   48 hours (auto-cleanup, survives timezone edge cases)
 *
 * Stranger Quota:
 *   Zalo severely restricts messages to non-friends (Error 14).
 *   A separate, lower daily limit is enforced for stranger recipients.
 *   When the stranger limit is hit, friend messages can still proceed.
 *
 * Falls back to in-memory counters when Redis is unavailable (dev mode).
 */
import { getRedis } from './redis-client.js';
import { logger } from './utils/logger.js';

const KEY_PREFIX = 'zalo:quota';
const STRANGER_KEY_PREFIX = 'zalo:quota:stranger';
const TTL_SECONDS = 48 * 60 * 60; // 48h — covers timezone drift + next-day cleanup
const DEFAULT_DAILY_LIMIT = 200;
const DEFAULT_STRANGER_LIMIT = 40; // Zalo typically blocks after 30-50 stranger msgs/day

function todayKey(accountId: string, isStranger = false): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const prefix = isStranger ? STRANGER_KEY_PREFIX : KEY_PREFIX;
  return `${prefix}:${today}:${accountId}`;
}

// ── In-memory fallback (dev/test) ───────────────────────────────────────────
interface MemoryCounter { count: number; date: string; }

// ── QuotaService ────────────────────────────────────────────────────────────

export class QuotaService {
  private dailyLimit: number;
  private strangerLimit: number;
  private memoryCounters = new Map<string, MemoryCounter>();

  constructor(dailyLimit = DEFAULT_DAILY_LIMIT, strangerLimit = DEFAULT_STRANGER_LIMIT) {
    this.dailyLimit = dailyLimit;
    this.strangerLimit = strangerLimit;
  }

  /** Resolve the appropriate limit for the given quota type. */
  private getLimit(isStranger: boolean): number {
    return isStranger ? this.strangerLimit : this.dailyLimit;
  }

  private memoryIncr(accountId: string, isStranger = false): number {
    const today = new Date().toISOString().split('T')[0];
    const suffix = isStranger ? ':stranger' : '';
    const key = `${accountId}${suffix}:${today}`;
    const entry = this.memoryCounters.get(key);
    if (entry && entry.date === today) {
      entry.count++;
      return entry.count;
    }
    this.memoryCounters.set(key, { count: 1, date: today });
    return 1;
  }

  private memoryGet(accountId: string, isStranger = false): number {
    const today = new Date().toISOString().split('T')[0];
    const suffix = isStranger ? ':stranger' : '';
    const key = `${accountId}${suffix}:${today}`;
    const entry = this.memoryCounters.get(key);
    return entry && entry.date === today ? entry.count : 0;
  }

  private memoryDecr(accountId: string, isStranger = false): number {
    const today = new Date().toISOString().split('T')[0];
    const suffix = isStranger ? ':stranger' : '';
    const key = `${accountId}${suffix}:${today}`;
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
   * If the new count exceeds the applicable limit, the increment is rolled back
   * (DECR) and `allowed = false` is returned — the caller should switch
   * to another account or stop sending to strangers.
   *
   * When `isStranger = true`, the stranger-specific counter is incremented
   * using a separate Redis key (`zalo:quota:stranger:...`). The general
   * daily counter is ALSO incremented, so both limits are enforced.
   *
   * @param accountId  Zalo account UUID
   * @param isStranger Whether this message targets a non-friend (stranger)
   * @returns Whether the send is allowed and the current count
   */
  async tryIncrement(accountId: string, isStranger = false): Promise<{ allowed: boolean; currentCount: number }> {
    const redis = await getRedis();

    if (!redis) {
      // ── In-memory fallback ──
      // Always increment general counter
      const generalCount = this.memoryIncr(accountId, false);
      if (generalCount > this.dailyLimit) {
        this.memoryDecr(accountId, false);
        return { allowed: false, currentCount: generalCount - 1 };
      }

      // If stranger, also increment the stranger-specific counter
      if (isStranger) {
        const strangerCount = this.memoryIncr(accountId, true);
        if (strangerCount > this.strangerLimit) {
          this.memoryDecr(accountId, true);
          this.memoryDecr(accountId, false); // Rollback the general counter too
          return { allowed: false, currentCount: strangerCount - 1 };
        }
      }

      return { allowed: true, currentCount: generalCount };
    }

    try {
      // ── Step A: Always increment the GENERAL daily counter ──
      const generalKey = todayKey(accountId, false);
      const generalCount = await redis.incr(generalKey);
      if (generalCount === 1) await redis.expire(generalKey, TTL_SECONDS);

      if (generalCount > this.dailyLimit) {
        await redis.decr(generalKey);
        logger.warn(`[quota] Account ${accountId} reached daily limit (${this.dailyLimit})`);
        return { allowed: false, currentCount: generalCount - 1 };
      }

      // ── Step B: If stranger, also check the STRANGER counter ──
      if (isStranger) {
        const strangerKey = todayKey(accountId, true);
        const strangerCount = await redis.incr(strangerKey);
        if (strangerCount === 1) await redis.expire(strangerKey, TTL_SECONDS);

        if (strangerCount > this.strangerLimit) {
          // Rollback both counters
          await redis.decr(strangerKey);
          await redis.decr(generalKey);
          logger.warn(`[quota] Account ${accountId} reached STRANGER limit (${this.strangerLimit})`);
          return { allowed: false, currentCount: strangerCount - 1 };
        }
      }

      return { allowed: true, currentCount: generalCount };
    } catch (err) {
      logger.error('[quota] Redis INCR failed, falling back to allow:', err);
      // Fail-open: allow the send to avoid blocking campaigns due to Redis hiccups
      return { allowed: true, currentCount: 0 };
    }
  }

  /**
   * Get the current daily send count for an account (read-only).
   * @param isStranger  If true, returns the stranger-specific counter.
   */
  async getCount(accountId: string, isStranger = false): Promise<number> {
    const redis = await getRedis();
    if (!redis) return this.memoryGet(accountId, isStranger);

    try {
      const val = await redis.get(todayKey(accountId, isStranger));
      return val ? parseInt(val, 10) : 0;
    } catch {
      return this.memoryGet(accountId, isStranger);
    }
  }

  /**
   * Get remaining quota for an account today.
   * @param isStranger  If true, returns remaining stranger quota.
   */
  async getRemaining(accountId: string, isStranger = false): Promise<number> {
    const count = await this.getCount(accountId, isStranger);
    const limit = this.getLimit(isStranger);
    return Math.max(0, limit - count);
  }

  /**
   * Check multiple accounts and return the first one with remaining quota.
   * Used by campaign account rotation.
   *
   * @param accountIds  List of Zalo account UUIDs to check
   * @param isStranger  If true, checks stranger quota instead of general quota.
   * @returns The first accountId with quota, or null if all exhausted
   */
  async findAvailableAccount(accountIds: string[], isStranger = false): Promise<string | null> {
    for (const id of accountIds) {
      const remaining = await this.getRemaining(id, isStranger);
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

  /** Expose the stranger limit for external use (dashboard, safety checks). */
  getStrangerLimit(): number {
    return this.strangerLimit;
  }
}

/** Shared singleton instance */
export const quotaService = new QuotaService();
