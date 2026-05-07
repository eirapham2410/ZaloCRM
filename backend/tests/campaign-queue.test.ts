/**
 * campaign-queue.test.ts — Unit tests for campaign queue utility functions.
 * Tests active hours checking and recipient-type delay calculation.
 * Does NOT require Redis (pure logic tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkActiveHours, getDelayForRecipientType } from '../src/modules/campaign/campaign-queue.js';

describe('checkActiveHours', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return withinHours=true when current time is inside active hours', () => {
    // Simulate 10:00 AM
    vi.setSystemTime(new Date('2026-05-07T10:00:00'));

    const result = checkActiveHours({ start: '08:00', end: '20:00' });
    expect(result.withinHours).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it('should return withinHours=true at exact start time', () => {
    vi.setSystemTime(new Date('2026-05-07T08:00:00'));

    const result = checkActiveHours({ start: '08:00', end: '20:00' });
    expect(result.withinHours).toBe(true);
  });

  it('should return withinHours=false before start time', () => {
    // Simulate 6:00 AM — before 08:00 start
    vi.setSystemTime(new Date('2026-05-07T06:00:00'));

    const result = checkActiveHours({ start: '08:00', end: '20:00' });
    expect(result.withinHours).toBe(false);
    // Should delay until 08:00 = 2 hours
    expect(result.delayMs).toBe(2 * 60 * 60 * 1000);
  });

  it('should return withinHours=false after end time (delay until next day)', () => {
    // Simulate 21:00 (9 PM) — after 20:00 end
    vi.setSystemTime(new Date('2026-05-07T21:00:00'));

    const result = checkActiveHours({ start: '08:00', end: '20:00' });
    expect(result.withinHours).toBe(false);
    // Should delay until 08:00 next day = 11 hours
    expect(result.delayMs).toBe(11 * 60 * 60 * 1000);
  });

  it('should return withinHours=false at exact end time', () => {
    vi.setSystemTime(new Date('2026-05-07T20:00:00'));

    const result = checkActiveHours({ start: '08:00', end: '20:00' });
    expect(result.withinHours).toBe(false);
  });
});

describe('getDelayForRecipientType', () => {
  it('should return delay between 15s–30s for thread_exist', () => {
    for (let i = 0; i < 20; i++) {
      const delay = getDelayForRecipientType('thread_exist');
      expect(delay).toBeGreaterThanOrEqual(15_000);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it('should return delay between 30s–60s for friend', () => {
    for (let i = 0; i < 20; i++) {
      const delay = getDelayForRecipientType('friend');
      expect(delay).toBeGreaterThanOrEqual(30_000);
      expect(delay).toBeLessThanOrEqual(60_000);
    }
  });

  it('should return delay between 300s–600s for stranger', () => {
    for (let i = 0; i < 20; i++) {
      const delay = getDelayForRecipientType('stranger');
      expect(delay).toBeGreaterThanOrEqual(300_000);
      expect(delay).toBeLessThanOrEqual(600_000);
    }
  });

  it('should default to stranger delay for unknown types', () => {
    const delay = getDelayForRecipientType('unknown');
    expect(delay).toBeGreaterThanOrEqual(300_000);
    expect(delay).toBeLessThanOrEqual(600_000);
  });
});
