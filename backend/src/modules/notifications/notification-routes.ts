/**
 * Notification routes — computed on-the-fly notifications for the authenticated user.
 * Sources: unreplied conversations, today/tomorrow appointments, disconnected Zalo accounts.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  detail: string;
  priority: string;
  createdAt: string;
}

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/notifications', async (request) => {
    const user = request.user!;
    const notifications: NotificationItem[] = [];

    // 1. Unreplied conversations > 30 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60000);
    const unreplied = await prisma.conversation.count({
      where: { orgId: user.orgId, isReplied: false, lastMessageAt: { lt: thirtyMinAgo } },
    });
    if (unreplied > 0) {
      notifications.push({
        id: 'unreplied',
        type: 'warning',
        priority: 'high',
        title: `${unreplied} cuộc trò chuyện chưa trả lời`,
        detail: 'Có tin nhắn chưa phản hồi quá 30 phút',
        createdAt: new Date().toISOString(),
      });
    }


    // 4. Disconnected Zalo accounts
    const accounts = await prisma.zaloAccount.findMany({
      where: { orgId: user.orgId },
      select: { id: true, displayName: true },
    });
    for (const acc of accounts) {
      const status = zaloPool.getStatus(acc.id);
      if (status !== 'connected') {
        notifications.push({
          id: `zalo-${acc.id}`,
          type: 'error',
          priority: 'high',
          title: `Zalo "${acc.displayName}" mất kết nối`,
          detail: `Trạng thái: ${status}`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return { notifications };
  });
}
