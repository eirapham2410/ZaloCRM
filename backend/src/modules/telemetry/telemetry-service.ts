import type { Server } from 'socket.io';
import { getRedis } from '../../shared/redis-client.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

const WINDOW_1H = 3600_000;
const BASE_LATENCY = 1500; // ms

export class TelemetryService {
  private io: Server | null = null;

  setIO(io: Server) {
    this.io = io;
  }

  /**
   * Cleans up events older than 1 hour.
   */
  private async gc(redis: any, key: string) {
    const cutoff = Date.now() - WINDOW_1H;
    await redis.zremrangebyscore(key, 0, cutoff);
  }

  async recordMessageSend(accountId: string, isSuccess: boolean, latencyMs: number, messageId: string, receiverId: string) {
    const r = await getRedis();
    if (!r) return;
    const now = Date.now();
    
    // Track latency
    const latKey = `tel:metrics:${accountId}:latency`;
    await r.zadd(latKey, String(now), `${now}:${latencyMs}`);
    await this.gc(r, latKey);

    // Track Phantom Delivery
    if (isSuccess) {
      const phanKey = `tel:metrics:${accountId}:phantom`;
      // Use JSON format as requested: Stringified JSON or unique string.
      // Here we use stringified JSON for easy parsing.
      const value = JSON.stringify({ id: messageId, to: receiverId, ts: now });
      await r.zadd(phanKey, String(now), value);
      await this.gc(r, phanKey);
    }
  }

  async recordDeliveryReceipt(accountId: string, messageId: string) {
    const r = await getRedis();
    if (!r) return;
    const phanKey = `tel:metrics:${accountId}:phantom`;
    const items = await r.zrange(phanKey, 0, -1);
    
    const target = items.find((item: string) => {
      try {
        const parsed = JSON.parse(item);
        return parsed.id === messageId;
      } catch { return false; }
    });

    if (target) {
      await r.zrem(phanKey, target);
    }
  }

  async recordRateLimitHit(accountId: string) {
    const r = await getRedis();
    if (!r) return;
    const now = Date.now();
    const key = `tel:metrics:${accountId}:rate_limit`;
    await r.zadd(key, String(now), String(now));
    await this.gc(r, key);
  }

  async recordDisconnect(accountId: string) {
    const r = await getRedis();
    if (!r) return;
    const now = Date.now();
    const key = `tel:metrics:${accountId}:disconnect`;
    await r.zadd(key, String(now), String(now));
    await this.gc(r, key);
  }

  async recordPhoneSearch(accountId: string, isNotFound: boolean) {
    const r = await getRedis();
    if (!r) return;
    const now = Date.now();
    const key = `tel:metrics:${accountId}:search`;
    const value = JSON.stringify({ ts: now, error: isNotFound });
    await r.zadd(key, String(now), value);
    await this.gc(r, key);
  }

  async evaluateAccount(accountId: string) {
    const r = await getRedis();
    if (!r) return;

    let signalsActivated = 0;
    const now = Date.now();

    // -- Signal 1: Phantom Delivery --
    // Check if there are >= 3 messages older than 5 mins without receipt
    const phanKey = `tel:metrics:${accountId}:phantom`;
    await this.gc(r, phanKey);
    const phantomItems = await r.zrangebyscore(phanKey, 0, now - 300_000); // older than 5 mins
    
    if (phantomItems.length >= 3) {
      const distinctReceivers = new Set<string>();
      for (const item of phantomItems) {
        try {
          const parsed = JSON.parse(item);
          if (parsed.to) distinctReceivers.add(parsed.to);
        } catch { /* ignore */ }
      }
      
      if (distinctReceivers.size >= 3) {
        signalsActivated++;
        logger.warn(`[Telemetry:${accountId}] Signal 1 (Phantom Delivery) triggered!`);
      }
    }

    // -- Signal 2: Latency Spike --
    const latKey = `tel:metrics:${accountId}:latency`;
    await this.gc(r, latKey);
    const latItems = await r.zrangebyscore(latKey, '-inf', '+inf');
    if (latItems.length > 0) {
      let totalLatency = 0;
      for (const item of latItems) {
        const parts = item.split(':');
        totalLatency += parseInt(parts[1], 10) || 0;
      }
      const avgLatency = totalLatency / latItems.length;
      if (avgLatency > BASE_LATENCY * 2) {
        signalsActivated++;
        logger.warn(`[Telemetry:${accountId}] Signal 2 (Latency Spike) triggered! Avg: ${Math.round(avgLatency)}ms`);
      }
    }

    // -- Signal 3: Search Blackhole --
    const searchKey = `tel:metrics:${accountId}:search`;
    await this.gc(r, searchKey);
    const searchItems = await r.zrangebyscore(searchKey, '-inf', '+inf');
    if (searchItems.length >= 10) {
      let errorCount = 0;
      for (const item of searchItems) {
        try {
          const parsed = JSON.parse(item);
          if (parsed.error) errorCount++;
        } catch { /* ignore */ }
      }
      const errorRate = errorCount / searchItems.length;
      if (errorRate > 0.8) {
        signalsActivated++;
        logger.warn(`[Telemetry:${accountId}] Signal 3 (Search Blackhole) triggered! Error Rate: ${(errorRate * 100).toFixed(1)}%`);
      }
    }

    // Check if Mitigation should be applied
    if (signalsActivated >= 2) {
      await this.applyMitigation(accountId, signalsActivated);
    }
    
    return signalsActivated;
  }

  private async applyMitigation(accountId: string, signalsCount: number) {
    const r = await getRedis();
    if (!r) return;

    // Check if already throttled
    const throttledKey = `tel:throttled:${accountId}`;
    const isAlreadyThrottled = await r.get(throttledKey);
    if (isAlreadyThrottled) return;

    logger.error(`[Telemetry:${accountId}] SHADOW-BAN DETECTED! Applying Auto-Throttling Mitigation.`);

    // 1. Throttle limits for 24h
    await r.setex(throttledKey, 86400, "1");

    // 2. Alert via Socket.IO
    if (this.io) {
      this.io.emit('zalo:shadow-ban-warning', {
        accountId,
        signals: signalsCount,
        message: 'Tài khoản có dấu hiệu bị Zalo chặn ngầm (Shadow-Ban). Hệ thống đã tự động hạ 50% tần suất hoạt động để bảo vệ tài khoản.',
      });
    }

    // 3. Log to DB
    try {
      const account = await prisma.zaloAccount.findUnique({ where: { id: accountId }, select: { orgId: true } });
      if (account) {
        await prisma.activityLog.create({
          data: {
            orgId: account.orgId,
            action: 'shadow_ban_detected',
            entityType: 'ZaloAccount',
            entityId: accountId,
            details: { signalsCount, timestamp: Date.now() },
          }
        });
      }
    } catch (dbErr) {
      logger.error(`[Telemetry:${accountId}] Failed to save activity log:`, dbErr);
    }
  }
}

export const telemetryService = new TelemetryService();
