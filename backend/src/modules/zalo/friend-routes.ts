/**
 * friend-routes.ts — REST API for Zalo friend management.
 * Ports openzca friend commands: queries, requests, management, privacy.
 * All routes scoped to /api/v1/zalo-accounts/:accountId/friends and require JWT auth.
 *
 * GET  .../friends          → read from local DB (ZaloFriend table)
 * POST .../friends/sync     → pull from Zalo SDK → chunked upsert into DB
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeZaloUid } from '../../shared/utils/normalize.js';
import { resolveAccount, checkAccess, handleError } from './zalo-route-helpers.js';
import { zaloRateLimiter, PhoneSearchTracker } from './zalo-rate-limiter.js';

const BASE = '/api/v1/zalo-accounts/:accountId/friends';

/** Chunk size for bulk upsert — tránh quá tải DB khi tài khoản có hàng nghìn bạn bè */
const SYNC_CHUNK_SIZE = 500;

/** Timeout (ms) khi gọi Zalo SDK getAllFriends — tránh treo API nếu SDK không phản hồi */
const SDK_TIMEOUT_MS = 30_000;

export async function friendRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── Friend Queries ────────────────────────────────────────────────────────

  // GET .../friends — lấy danh sách bạn bè từ Database (đã đồng bộ)
  app.get(BASE, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    if (!await checkAccess(request, reply, accountId, 'read')) return;
    try {
      await resolveAccount(accountId, user.orgId);
      const data = await prisma.zaloFriend.findMany({
        where: { zaloAccountId: accountId },
        orderBy: { displayName: 'asc' },
      });
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-list');
    }
  });

  // POST .../friends/sync — đồng bộ bạn bè từ Zalo SDK vào DB (chunked upsert)
  app.post(`${BASE}/sync`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    if (!await checkAccess(request, reply, accountId, 'chat')) return;

    try {
      await resolveAccount(accountId, user.orgId);

      logger.info(`[friend-sync] account=${accountId} — Bắt đầu đồng bộ bạn bè...`);

      // 1. Gọi Zalo SDK với timeout bảo vệ
      const sdkPromise = zaloOps.getAllFriends(accountId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Zalo SDK timeout sau ${SDK_TIMEOUT_MS / 1000}s`)), SDK_TIMEOUT_MS),
      );
      const rawFriends = await Promise.race([sdkPromise, timeoutPromise]);

      // 2. Chuẩn hóa dữ liệu — loại bỏ record thiếu UID
      const friendList = Object.values(rawFriends || {}) as any[];
      const normalized = friendList
        .map((f) => ({
          zaloUid:     normalizeZaloUid(f.userId || f.uid),
          displayName: f.zaloName || f.zalo_name || f.displayName || f.display_name || 'Unknown',
          avatarUrl:   f.avatar || null,
          phone:       f.phoneNumber || null,
        }))
        .filter((f) => f.zaloUid !== '');

      logger.info(`[friend-sync] account=${accountId} — SDK trả về ${friendList.length} bạn bè, hợp lệ: ${normalized.length}`);

      // 3. Chunked upsert — chia nhỏ thành các lô để tránh quá tải DB
      const totalChunks = Math.ceil(normalized.length / SYNC_CHUNK_SIZE) || 1;
      let totalUpserted = 0;

      for (let i = 0; i < normalized.length; i += SYNC_CHUNK_SIZE) {
        const chunkIndex = Math.floor(i / SYNC_CHUNK_SIZE) + 1;
        const chunk = normalized.slice(i, i + SYNC_CHUNK_SIZE);

        const ops = chunk.map((friend) =>
          prisma.zaloFriend.upsert({
            where: {
              zaloAccountId_zaloUid: {
                zaloAccountId: accountId,
                zaloUid: friend.zaloUid,
              },
            },
            update: {
              displayName: friend.displayName,
              avatarUrl:   friend.avatarUrl,
              phone:       friend.phone,
              syncedAt:    new Date(),
            },
            create: {
              zaloAccountId: accountId,
              zaloUid:       friend.zaloUid,
              displayName:   friend.displayName,
              avatarUrl:     friend.avatarUrl,
              phone:         friend.phone,
            },
          }),
        );

        // Mỗi lô chạy trong 1 transaction riêng
        // → nếu lô thứ N lỗi, các lô 1..(N-1) vẫn được commit
        await prisma.$transaction(ops);
        totalUpserted += chunk.length;

        logger.info(
          `[friend-sync] account=${accountId} — Chunk ${chunkIndex}/${totalChunks}: ` +
          `${chunk.length} records upserted (${totalUpserted}/${normalized.length})`,
        );
      }

      // 4. Cleanup: xóa bạn bè cũ không còn trong danh sách Zalo mới nhất
      const currentUids = normalized.map((f) => f.zaloUid);
      const { count: removedCount } = await prisma.zaloFriend.deleteMany({
        where: {
          zaloAccountId: accountId,
          zaloUid: { notIn: currentUids },
        },
      });

      if (removedCount > 0) {
        logger.info(`[friend-sync] account=${accountId} — Đã xóa ${removedCount} bạn bè cũ (không còn trong Zalo)`);
      }

      logger.info(
        `[friend-sync] account=${accountId} — Hoàn tất: ${totalUpserted} synced, ${removedCount} removed, ${totalChunks} chunks`,
      );

      return {
        success: true,
        totalSynced: totalUpserted,
        removed: removedCount,
        chunks: totalChunks,
      };
    } catch (err) {
      logger.error(`[friend-sync] account=${accountId} — Lỗi đồng bộ:`, err);
      return handleError(reply, err, 'friend-sync');
    }
  });

  // POST .../friends/bulk-upsert — Write-back mechanism from Campaign Builder
  app.post(`${BASE}/bulk-upsert`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const items = request.body as Array<{ zaloUid: string; phone?: string; name?: string }>;
    
    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'Body must be an array of objects' });
    }

    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      
      const chunkSize = 200;
      let totalUpserted = 0;

      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        
        const ops = chunk.map((item) => {
          const cleanUid = normalizeZaloUid(item.zaloUid);
          if (!cleanUid) return null; // skip empty UIDs
          return prisma.zaloFriend.upsert({
            where: {
              zaloAccountId_zaloUid: {
                zaloAccountId: accountId,
                zaloUid: cleanUid,
              }
            },
            update: {
              phone: item.phone || undefined,
              // Only update name if it was explicitly mapped
              displayName: item.name ? item.name : undefined,
              syncedAt: new Date(),
            },
            create: {
              zaloAccountId: accountId,
              zaloUid: cleanUid,
              phone: item.phone,
              displayName: item.name || 'Người dùng Zalo',
              tags: [],
              syncedAt: new Date(),
            }
          });
        });

        const validOps = ops.filter(Boolean);
        if (validOps.length > 0) await prisma.$transaction(validOps as any[]);
        totalUpserted += validOps.length;
      }

      logger.info(`[friend-sync] account=${accountId} — Bulk upserted ${totalUpserted} items from Write-back mechanism`);
      return { success: true, totalUpserted };
    } catch (err) {
      logger.error(`[friend-sync] account=${accountId} — Bulk upsert error:`, err);
      return handleError(reply, err, 'friend-sync');
    }
  });

  // Helper functions for search-by-phone
  function normalizePhoneVN(phone: string): string | null {
    if (!phone) return null;
    let cleaned = phone.replace(/[\s\-\.]/g, '');
    if (cleaned.startsWith('+84')) {
      cleaned = '0' + cleaned.substring(3);
    } else if (cleaned.startsWith('84')) {
      cleaned = '0' + cleaned.substring(2);
    }
    if (!/^\d{9,11}$/.test(cleaned)) return null;
    return cleaned;
  }

  function parseFriendRequestStatus(sdkStatus: any): 'friend' | 'pending_sent' | 'pending_received' | 'none' {
    if (!sdkStatus) return 'none';
    if (sdkStatus.status === 'friend' || sdkStatus.isFriend) return 'friend';
    if (sdkStatus.status === 'pending_received') return 'pending_received';
    return 'pending_sent';
  }

  // POST .../friends/search-by-phone — search user with anti-spam protections
  app.post(`${BASE}/search-by-phone`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const { phone } = request.body as { phone: string };
    const user = request.user!;

    if (!await checkAccess(request, reply, accountId, 'read')) return;
    const account = await resolveAccount(accountId, user.orgId);

    const normalized = normalizePhoneVN(phone);
    if (!normalized) {
      return reply.status(400).send({
        success: false,
        code: 'INVALID_PHONE',
        message: 'Số điện thoại không hợp lệ (9-11 số, bắt đầu bằng 0 hoặc +84)',
      });
    }

    const trackerStatus = PhoneSearchTracker.isBlocked(accountId);
    if (trackerStatus.blocked) {
      return reply.status(429).send({
        success: false,
        code: 'TEMP_BLOCKED',
        message: `Tạm khóa tìm kiếm do quá nhiều lần không tìm thấy. Thử lại sau ${Math.ceil(trackerStatus.remainingMs / 60000)} phút.`,
      });
    }

    const rl = await zaloRateLimiter.checkLimits(accountId, 'phone_search');
    if (!rl.allowed) {
      return reply.status(429).send({
        success: false,
        code: 'RATE_LIMITED',
        message: rl.reason || 'Đã vượt giới hạn tìm kiếm. Vui lòng thử lại sau.',
      });
    }

    let sdkResult: any;
    try {
      sdkResult = await zaloOps.findUser(accountId, normalized);
    } catch (err: any) {
      if (err.code === 212 || err.message?.includes('Không tìm thấy') || err.message?.includes('not found')) {
        PhoneSearchTracker.incrementFailure(accountId);
        return { success: false, code: 'USER_NOT_FOUND', message: 'Số điện thoại này chưa đăng ký Zalo hoặc đã chặn tìm kiếm' };
      }
      throw err;
    }

    const zaloUid = sdkResult?.uid || sdkResult?.userId;
    if (!zaloUid) {
      PhoneSearchTracker.incrementFailure(accountId);
      return { success: false, code: 'USER_NOT_FOUND', message: 'Số điện thoại này chưa đăng ký Zalo hoặc đã chặn tìm kiếm' };
    }

    PhoneSearchTracker.resetFailure(accountId);

    const [friendRecord, requestStatus, crmContact] = await Promise.all([
      prisma.zaloFriend.findFirst({
        where: { zaloAccountId: accountId, zaloUid: String(zaloUid) }
      }),
      zaloOps.getFriendRequestStatus(accountId, String(zaloUid)).catch(() => null),
      prisma.contact.findFirst({
        where: { orgId: account.orgId, zaloUid: String(zaloUid) },
        select: { id: true, fullName: true, status: true },
      }),
    ]);

    let friendshipStatus: 'friend' | 'pending_sent' | 'pending_received' | 'none' = 'none';
    if (friendRecord) {
      friendshipStatus = 'friend';
    } else if (requestStatus) {
      friendshipStatus = parseFriendRequestStatus(requestStatus);
    }

    const rawName = sdkResult.zaloName || sdkResult.displayName || sdkResult.display_name || '';
    const isPrivateProfile = !rawName || rawName.trim() === '';
    const displayName = isPrivateProfile ? 'Người dùng Zalo' : rawName;

    return {
      success: true,
      data: {
        zaloUid: String(zaloUid),
        displayName,
        avatarUrl: sdkResult.avatar || null,
        phone: normalized,
        friendshipStatus,
        isPrivateProfile,
        contact: crmContact,
      },
    };
  });

  // GET .../friends/find?q=query — search user by phone/name (realtime SDK)
  app.get(`${BASE}/find`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const { q } = request.query as { q?: string };
    const user = request.user!;
    if (!q) return reply.status(400).send({ error: 'Query param q is required' });
    if (!await checkAccess(request, reply, accountId, 'read')) return;
    try {
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.findUser(accountId, q);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // GET .../friends/online — get online friends (realtime SDK)
  app.get(`${BASE}/online`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.getFriendOnlines(accountId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // GET .../friends/recommendations — friend suggestions (realtime SDK)
  app.get(`${BASE}/recommendations`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.getFriendRecommendations(accountId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // GET .../friends/aliases — all custom aliases
  app.get(`${BASE}/aliases`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.getAliasList(accountId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // ── Friend Requests ───────────────────────────────────────────────────────

  // GET .../friends/requests/sent — list sent friend requests
  // NOTE: Registered before :userId routes to avoid route conflicts
  app.get(`${BASE}/requests/sent`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.getSentFriendRequests(accountId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // GET .../friends/requests/:userId/status — check request status with a user
  app.get(`${BASE}/requests/:userId/status`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'read')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.getFriendRequestStatus(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // POST .../friends/requests — send friend request { userId, message? }
  app.post(`${BASE}/requests`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const { userId, message = '' } = request.body as { userId: string; message?: string };
    const user = request.user!;
    if (!userId) return reply.status(400).send({ error: 'userId is required' });
    if (!await checkAccess(request, reply, accountId, 'chat')) return;
    try {
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.sendFriendRequest(accountId, message, userId);
      return reply.status(201).send({ data });
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // POST .../friends/requests/:userId/accept — accept incoming request
  app.post(`${BASE}/requests/:userId/accept`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.acceptFriendRequest(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // POST .../friends/requests/:userId/reject — reject incoming request
  app.post(`${BASE}/requests/:userId/reject`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.rejectFriendRequest(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // DELETE .../friends/requests/:userId — cancel sent request
  app.delete(`${BASE}/requests/:userId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.cancelFriendRequest(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // ── Friend Management ─────────────────────────────────────────────────────

  // DELETE .../friends/:userId — remove friend
  app.delete(`${BASE}/:userId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.removeFriend(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // PUT .../friends/:userId/alias — set custom alias { alias }
  app.put(`${BASE}/:userId/alias`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const { alias } = request.body as { alias: string };
    const user = request.user!;
    if (!alias) return reply.status(400).send({ error: 'alias is required' });
    if (!await checkAccess(request, reply, accountId, 'chat')) return;
    try {
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.changeFriendAlias(accountId, alias, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // DELETE .../friends/:userId/alias — remove custom alias
  app.delete(`${BASE}/:userId/alias`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.removeFriendAlias(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // ── Privacy ───────────────────────────────────────────────────────────────

  // POST .../friends/:userId/block — block user
  app.post(`${BASE}/:userId/block`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.blockUser(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // DELETE .../friends/:userId/block — unblock user
  app.delete(`${BASE}/:userId/block`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.unblockUser(accountId, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // POST .../friends/:userId/block-feed — block user from viewing feed
  app.post(`${BASE}/:userId/block-feed`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.blockViewFeed(accountId, true, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });

  // DELETE .../friends/:userId/block-feed — unblock user from viewing feed
  app.delete(`${BASE}/:userId/block-feed`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId, userId } = request.params as { accountId: string; userId: string };
    const user = request.user!;
    try {
      if (!await checkAccess(request, reply, accountId, 'chat')) return;
      await resolveAccount(accountId, user.orgId);
      const data = await zaloOps.blockViewFeed(accountId, false, userId);
      return { data };
    } catch (err) {
      return handleError(reply, err, 'friend-op');
    }
  });
}
