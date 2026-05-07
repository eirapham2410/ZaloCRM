/**
 * redis-client.ts — Redis connection management.
 *
 * Provides:
 *   - `getRedis()` — Lazy singleton for general-purpose Redis (rate limiter, event buffer).
 *                     Returns null when REDIS_URL is not set (in-memory fallback).
 *   - `redisConnectionOpts` — Raw IORedis connection options for BullMQ (Queue/Worker
 *                              create their own connections internally).
 *   - `getRedisForBullMQ()` — Validates that Redis is available and returns connection
 *                              options. Throws if REDIS_URL is unset (BullMQ requires Redis).
 */
import { Redis, type RedisOptions } from 'ioredis';
import { logger } from './utils/logger.js';

export type RedisClient = Redis;

// ── Connection options (shared by all consumers) ────────────────────────────

function parseRedisUrl(url: string): RedisOptions {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.slice(1) || '0', 10) : 0,
      maxRetriesPerRequest: null,            // Required by BullMQ
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      enableReadyCheck: false,               // Faster startup for BullMQ
    };
  } catch {
    // Fallback: assume it's host:port
    return {
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      enableReadyCheck: false,
    };
  }
}

/**
 * Raw IORedis options derived from REDIS_URL.
 * Returns null if REDIS_URL is not set.
 */
export function getRedisConnectionOpts(): RedisOptions | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return parseRedisUrl(url);
}

/**
 * Get connection options for BullMQ. Throws if Redis is not configured.
 * BullMQ Queue/Worker each create their own IORedis instance from these options.
 */
export function getRedisForBullMQ(): RedisOptions {
  const opts = getRedisConnectionOpts();
  if (!opts) {
    throw new Error(
      '[redis] REDIS_URL is required for BullMQ. '
      + 'Set REDIS_URL in .env (e.g. redis://localhost:6379).',
    );
  }
  return opts;
}

// ── Lazy singleton for general-purpose Redis ────────────────────────────────

let redisInstance: Redis | null = null;
let initialized = false;

export async function getRedis(): Promise<Redis | null> {
  if (initialized) return redisInstance;
  initialized = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info('[redis] REDIS_URL not set — using in-memory mode');
    return null;
  }

  try {
    redisInstance = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      lazyConnect: true,
    });
    await redisInstance.connect();
    logger.info('[redis] Connected to %s', url.replace(/\/\/.*@/, '//*:*@'));
    return redisInstance;
  } catch (err) {
    logger.warn('[redis] Connection failed, falling back to in-memory: %s', (err as Error).message);
    redisInstance = null;
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
  initialized = false;
}

