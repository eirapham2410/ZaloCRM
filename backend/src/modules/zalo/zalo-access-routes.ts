/**
 * Zalo account access control routes — manage per-user permissions on Zalo accounts.
 * Permission levels: read (view messages), chat (send messages), admin (manage account).
 * All write operations require owner/admin role OR being the ownerUserId of the account.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/utils/logger.js';

const VALID_PERMISSIONS = ['read', 'chat', 'admin'] as const;
type Permission = (typeof VALID_PERMISSIONS)[number];

export async function zaloAccessRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // Helper middleware to check if user has permission to manage access
  const requireManageAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const account = await prisma.zaloAccount.findFirst({ where: { id, orgId: user.orgId } });
    if (!account) return reply.status(404).send({ error: 'Zalo account not found' });

    const canManage = user.role === 'owner' || user.role === 'admin' || account.ownerUserId === user.id;
    if (!canManage) {
      return reply.status(403).send({ error: '403 Forbidden: You do not have permission to manage this account.' });
    }
    
    // Attach account to request for downstream use
    (request as any).zaloAccount = account;
  };

  // GET /api/v1/zalo-accounts/:id/access — list users with access to this account
  app.get(
    '/api/v1/zalo-accounts/:id/access',
    { preHandler: requireManageAccess },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const accessList = await prisma.zaloAccountAccess.findMany({
        where: { zaloAccountId: id },
        include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
        orderBy: { createdAt: 'asc' },
      });

      return { access: accessList };
    }
  );

  // POST /api/v1/zalo-accounts/:id/access — replace access list (owner/admin/ownerUserId only)
  app.post(
    '/api/v1/zalo-accounts/:id/access',
    { preHandler: requireManageAccess },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const payload = request.body as { userId: string; permission: string }[];
      const account = (request as any).zaloAccount;

      if (!Array.isArray(payload)) {
        return reply.status(400).send({ error: 'Payload must be an array of { userId, permission }' });
      }

      for (const item of payload) {
        if (!item.userId || !VALID_PERMISSIONS.includes(item.permission as Permission)) {
          return reply.status(400).send({ error: 'Mỗi mục phải có userId và permission hợp lệ (read, chat, admin)' });
        }
      }

      try {
        await prisma.$transaction(async (tx) => {
          // Xóa sạch các quyền cũ của tài khoản này (trừ quyền của Owner)
          await tx.zaloAccountAccess.deleteMany({
            where: {
              zaloAccountId: id,
              userId: { not: account.ownerUserId }
            }
          });

          // Nạp chuỗi quyền mới
          if (payload.length > 0) {
            const newAccessData = payload
              // Prevent accidentally re-adding the owner if they were in the payload (they already have access implicitly or via migration)
              .filter(p => p.userId !== account.ownerUserId)
              .map(p => ({
                id: randomUUID(),
                zaloAccountId: id,
                userId: p.userId,
                permission: p.permission
              }));
            
            if (newAccessData.length > 0) {
               await tx.zaloAccountAccess.createMany({
                 data: newAccessData
               });
            }
          }
        });

        logger.info(`Zalo access list updated for account ${id} by ${user.email}`);
        
        // Trả về danh sách mới
        const accessList = await prisma.zaloAccountAccess.findMany({
          where: { zaloAccountId: id },
          include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        });

        return reply.status(200).send({ access: accessList });
      } catch (error) {
        logger.error('Failed to update access list', error);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // DELETE /api/v1/zalo-accounts/:id/access/:userId — revoke access for a specific user
  app.delete(
    '/api/v1/zalo-accounts/:id/access/:userId',
    { preHandler: requireManageAccess },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id, userId } = request.params as { id: string; userId: string };
      const account = (request as any).zaloAccount;

      if (userId === account.ownerUserId) {
        return reply.status(400).send({ error: 'Không thể xóa quyền truy cập của chủ sở hữu tài khoản' });
      }

      try {
        const deleted = await prisma.zaloAccountAccess.deleteMany({ 
          where: { userId: userId, zaloAccountId: id } 
        });
        
        if (deleted.count === 0) {
          return reply.status(404).send({ error: 'Không tìm thấy quyền truy cập của nhân viên này' });
        }
        
        logger.info(`Zalo access revoked for user ${userId} on account ${id} by ${user.email}`);
        return reply.status(204).send();
      } catch {
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
  );
}
