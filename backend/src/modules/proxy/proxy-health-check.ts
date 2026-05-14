import cron from 'node-cron';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { createProxyAgent } from '../../shared/utils/proxy-parser.js';
import { logger } from '../../shared/utils/logger.js';

let ioInstance: Server | null = null;

export function setProxyHealthCheckIO(io: Server) {
  ioInstance = io;
}

export async function checkProxyStatus(proxyId: string, url: string): Promise<boolean> {
  try {
    const agent = await createProxyAgent(url);
    if (!agent) return false;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    // Request to Zalo's main site or httpbin
    const response = await fetch('https://zalo.me', {
      signal: controller.signal,
      // @ts-ignore
      agent,
    });
    
    clearTimeout(timeout);
    return response.ok;
  } catch (err) {
    return false;
  }
}

export async function runHealthCheckJob() {
  logger.info('[ProxyHealth] Starting scheduled health check for active proxies...');
  try {
    const proxies = await prisma.proxy.findMany({
      where: { status: 'active' },
    });

    if (proxies.length === 0) {
      logger.info('[ProxyHealth] No active proxies to check.');
      return;
    }

    let deadCount = 0;

    for (const proxy of proxies) {
      const isAlive = await checkProxyStatus(proxy.id, proxy.url);
      
      if (!isAlive) {
        deadCount++;
        await prisma.proxy.update({
          where: { id: proxy.id },
          data: { status: 'dead', lastCheckedAt: new Date() },
        });

        logger.warn(`[ProxyHealth] Proxy ${proxy.id} marked as dead.`);

        // Notify admins in the organization
        if (ioInstance) {
          ioInstance.to(`org:${proxy.orgId}`).emit('proxy:dead', {
            proxyId: proxy.id,
            url: proxy.url,
            message: `Proxy đã ngưng hoạt động! Các tài khoản Zalo liên kết có thể sẽ bị mất kết nối.`,
          });
        }
      } else {
        await prisma.proxy.update({
          where: { id: proxy.id },
          data: { lastCheckedAt: new Date() },
        });
      }
    }

    logger.info(`[ProxyHealth] Health check completed. Found ${deadCount} dead proxies out of ${proxies.length}.`);
  } catch (err) {
    logger.error('[ProxyHealth] Job failed:', err);
  }
}

export function startProxyHealthCheck() {
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', runHealthCheckJob);
  logger.info('Proxy health check cronjob scheduled (runs every 30m).');
}
