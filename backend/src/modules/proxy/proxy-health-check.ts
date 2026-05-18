import cron from 'node-cron';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { createProxyAgent } from '../../shared/utils/proxy-parser.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';

let ioInstance: Server | null = null;

export function setProxyHealthCheckIO(io: Server) {
  ioInstance = io;
}

/**
 * Extract the expected IP/Hostname from a proxy URL.
 */
function extractExpectedIp(url: string): string | null {
  try {
    // Handling standard URLs
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Fallback for custom formats e.g. socks5://user:pass@ip:port
    const regex = /@([0-9\.]+):/;
    const match = url.match(regex);
    return match ? match[1] : null;
  }
}

/**
 * Phase 3.3: Strict IP Post-Verification
 * Verifies if proxy is alive and if the exit IP matches the expected proxy IP.
 */
export async function verifyProxyIP(proxyUrl: string): Promise<{ isAlive: boolean; originIp?: string }> {
  try {
    const agent = await createProxyAgent(proxyUrl);
    if (!agent) return { isAlive: false };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // Strict 8000ms timeout

    // Request to httpbin to verify exit IP
    const response = await fetch('https://httpbin.org/ip', {
      signal: controller.signal,
      // @ts-ignore
      agent,
    });
    
    clearTimeout(timeout);
    if (!response.ok) return { isAlive: false };

    const data = await response.json() as { origin?: string };
    const originIp = data.origin;

    if (!originIp) return { isAlive: false };

    const expectedIp = extractExpectedIp(proxyUrl);
    if (expectedIp && !originIp.includes(expectedIp)) {
      logger.error(`[ProxyHealth] IP Leak detected! Expected ${expectedIp} but exit IP is ${originIp}`);
      return { isAlive: false }; // Treat mismatch as dead to trigger Kill-Switch
    }

    return { isAlive: true, originIp };
  } catch (err) {
    return { isAlive: false };
  }
}

/**
 * Exported wrapper for Zalo Pool to use directly
 */
export async function checkProxyStatus(proxyUrl: string): Promise<boolean> {
  const result = await verifyProxyIP(proxyUrl);
  return result.isAlive;
}

/**
 * Process a batch of proxies for health checks
 */
async function processProxyBatch(proxies: any[]) {
  if (proxies.length === 0) return;

  const results = await Promise.allSettled(
    proxies.map(async (proxy) => {
      const { isAlive, originIp } = await verifyProxyIP(proxy.url);
      
      if (!isAlive && proxy.status === 'active') {
        // Active -> Dead
        await prisma.proxy.update({
          where: { id: proxy.id },
          data: { status: 'dead', lastCheckedAt: new Date() },
        });

        logger.warn(`[ProxyHealth] Proxy ${proxy.id} marked as dead.`);

        // Trigger Phase 3.2 Auto Failover for all linked accounts
        const linkedAccounts = await prisma.zaloAccount.findMany({
          where: { proxyId: proxy.id }
        });
        
        for (const account of linkedAccounts) {
          zaloPool.autoFailover(account.id).catch(err => {
            logger.error(`[ProxyHealth] Failed to trigger autoFailover for ${account.id}`, err);
          });
        }

        if (ioInstance) {
          ioInstance.to(`org:${proxy.orgId}`).emit('proxy:dead', {
            proxyId: proxy.id,
            url: proxy.url,
            message: `Proxy đã ngưng hoạt động! Các tài khoản đang được tự động chuyển vùng (Auto-Failover).`,
          });
        }
      } else if (isAlive) {
        // Alive -> Update verified IP and timestamp
        await prisma.proxy.update({
          where: { id: proxy.id },
          data: { 
            status: 'active', 
            lastCheckedAt: new Date(),
            verifiedIp: originIp 
          },
        });
        
        if (proxy.status === 'dead') {
           logger.info(`[ProxyHealth] Proxy ${proxy.id} recovered and marked as active.`);
           if (ioInstance) {
             ioInstance.to(`org:${proxy.orgId}`).emit('proxy:recovered', {
               proxyId: proxy.id,
               message: `Proxy đã kết nối lại thành công.`,
             });
           }
        }
      }
    })
  );
  
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logger.error(`[ProxyHealth] Batch processing had ${failed.length} failures.`);
  }
}

/**
 * Job 1: Active Probe - Short cycle (every 3 mins)
 */
async function activeProbeJob() {
  logger.info('[ProxyHealth] Running Active Probe Job...');
  try {
    const proxies = await prisma.proxy.findMany({ where: { status: 'active' } });
    await processProxyBatch(proxies);
  } catch (err) {
    logger.error('[ProxyHealth] activeProbeJob failed:', err);
  }
}

/**
 * Job 2: Dead Recovery - Long cycle (every 15 mins)
 */
async function deadRecoveryJob() {
  logger.info('[ProxyHealth] Running Dead Recovery Job...');
  try {
    const proxies = await prisma.proxy.findMany({ where: { status: 'dead' } });
    await processProxyBatch(proxies);
  } catch (err) {
    logger.error('[ProxyHealth] deadRecoveryJob failed:', err);
  }
}

export function startProxyHealthCheck() {
  // Dual-Cron Layout
  cron.schedule('*/3 * * * *', activeProbeJob);
  cron.schedule('*/15 * * * *', deadRecoveryJob);
  logger.info('[ProxyHealth] Dual-Cron scheduled: Active(3m), Recovery(15m).');
}
