/**
 * Zalo Socket.IO event handlers.
 * Manages room subscriptions for org-level and per-account events.
 */
import type { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { logger } from '../../shared/utils/logger.js';
import { config } from '../../config/index.js';
import { prisma } from '../../shared/database/prisma-client.js';

export function registerZaloSocketHandlers(io: Server): void {
  // Connection Middleware: Authenticate every socket connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;
      socket.data.user = decoded; // Attach user payload to socket
      next();
    } catch (err) {
      return next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user;

    // Client should send orgId after connecting to join org-level room
    socket.on('org:join', (data: { orgId: string }) => {
      if (!data?.orgId) return;
      
      // Security Check: Only allow joining their own org
      if (user.orgId !== data.orgId) {
        logger.warn(`Socket ${socket.id} (User: ${user.id}) denied access to org:${data.orgId}`);
        return;
      }

      socket.join(`org:${data.orgId}`);
      logger.debug(`Socket ${socket.id} joined org:${data.orgId}`);
    });

    // Subscribe to QR/status updates for a specific Zalo account
    socket.on('zalo:subscribe', async (data: { accountId: string }) => {
      if (!data?.accountId) return;

      const { accountId } = data;

      try {
        if (user.role === 'owner' || user.role === 'admin') {
          // Owner and Admin have global access
          socket.join(`account:${accountId}`);
          logger.debug(`Socket ${socket.id} (Admin/Owner) joined account:${accountId}`);
        } else {
          // Staff must have explicit access via ZaloAccountAccess or be the owner
          const account = await prisma.zaloAccount.findFirst({
            where: {
              id: accountId,
              orgId: user.orgId,
              OR: [
                { ownerUserId: user.id },
                { access: { some: { userId: user.id } } }
              ]
            }
          });

          if (account) {
            socket.join(`account:${accountId}`);
            logger.debug(`Socket ${socket.id} (Staff: ${user.id}) joined account:${accountId}`);
          } else {
            // Forbidden access
            socket.emit('zalo:error', { accountId, error: '403 Forbidden: You do not have access to this account.' });
            logger.warn(`Socket ${socket.id} (Staff: ${user.id}) denied access to account:${accountId}`);
          }
        }
      } catch (error) {
        logger.error(`Error verifying socket subscription for account ${accountId}:`, error);
        socket.emit('zalo:error', { accountId, error: 'Internal Server Error during subscription verification.' });
      }
    });

    // Unsubscribe from a specific account room
    socket.on('zalo:unsubscribe', (data: { accountId: string }) => {
      if (!data?.accountId) return;
      socket.leave(`account:${data.accountId}`);
      logger.debug(`Socket ${socket.id} left account:${data.accountId}`);
    });
  });
}
