/**
 * quota-service.test.ts — Unit tests for QuotaService (in-memory fallback mode).
 *
 * These tests run WITHOUT Redis by not setting REDIS_URL,
 * exercising the in-memory counter path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QuotaService } from '../src/shared/quota-service.js';

describe('QuotaService (in-memory mode)', () => {
  let quota: QuotaService;

  beforeEach(() => {
    // Create fresh instance with a low limit for easy testing
    quota = new QuotaService(5);
  });

  describe('tryIncrement', () => {
    it('should allow sends under the daily limit', async () => {
      const result = await quota.tryIncrement('account-1');
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
    });

    it('should track counts incrementally', async () => {
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-1');
      const result = await quota.tryIncrement('account-1');
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(3);
    });

    it('should reject when daily limit is reached', async () => {
      // Send 5 (the limit)
      for (let i = 0; i < 5; i++) {
        const r = await quota.tryIncrement('account-1');
        expect(r.allowed).toBe(true);
      }

      // 6th should be rejected
      const result = await quota.tryIncrement('account-1');
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(5); // Rolled back to 5, not 6
    });

    it('should track separate accounts independently', async () => {
      for (let i = 0; i < 5; i++) {
        await quota.tryIncrement('account-1');
      }

      // account-1 exhausted, but account-2 should still be available
      const result1 = await quota.tryIncrement('account-1');
      expect(result1.allowed).toBe(false);

      const result2 = await quota.tryIncrement('account-2');
      expect(result2.allowed).toBe(true);
      expect(result2.currentCount).toBe(1);
    });
  });

  describe('getCount', () => {
    it('should return 0 for unused accounts', async () => {
      expect(await quota.getCount('new-account')).toBe(0);
    });

    it('should return the correct count after increments', async () => {
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-1');
      expect(await quota.getCount('account-1')).toBe(3);
    });
  });

  describe('getRemaining', () => {
    it('should return full limit for unused accounts', async () => {
      expect(await quota.getRemaining('new-account')).toBe(5);
    });

    it('should decrease as messages are sent', async () => {
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-1');
      expect(await quota.getRemaining('account-1')).toBe(3);
    });

    it('should return 0 when limit is exhausted', async () => {
      for (let i = 0; i < 5; i++) await quota.tryIncrement('account-1');
      expect(await quota.getRemaining('account-1')).toBe(0);
    });
  });

  describe('findAvailableAccount', () => {
    it('should return the first account with remaining quota', async () => {
      // Exhaust account-1
      for (let i = 0; i < 5; i++) await quota.tryIncrement('account-1');

      const result = await quota.findAvailableAccount(['account-1', 'account-2', 'account-3']);
      expect(result).toBe('account-2');
    });

    it('should return null when all accounts are exhausted', async () => {
      for (let i = 0; i < 5; i++) {
        await quota.tryIncrement('account-1');
        await quota.tryIncrement('account-2');
      }

      const result = await quota.findAvailableAccount(['account-1', 'account-2']);
      expect(result).toBeNull();
    });

    it('should return the first account if all have quota', async () => {
      const result = await quota.findAvailableAccount(['account-1', 'account-2']);
      expect(result).toBe('account-1');
    });
  });

  describe('getMultipleCounts', () => {
    it('should return counts for multiple accounts', async () => {
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-1');
      await quota.tryIncrement('account-2');

      const counts = await quota.getMultipleCounts(['account-1', 'account-2', 'account-3']);
      expect(counts['account-1']).toBe(2);
      expect(counts['account-2']).toBe(1);
      expect(counts['account-3']).toBe(0);
    });
  });

  describe('getDailyLimit', () => {
    it('should return the configured limit', () => {
      expect(quota.getDailyLimit()).toBe(5);
    });

    it('should default to 200 when not specified', () => {
      const defaultQuota = new QuotaService();
      expect(defaultQuota.getDailyLimit()).toBe(200);
    });
  });
});
