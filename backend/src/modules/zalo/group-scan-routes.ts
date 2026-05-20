/**
 * group-scan-routes.ts — Quét thành viên nhóm Zalo qua Link mời.
 *
 * Endpoint: POST /api/v1/zalo-accounts/:accountId/groups/scan-by-link
 *
 * Luồng hoạt động:
 *   1. Xác thực JWT + kiểm tra quyền truy cập tài khoản Zalo
 *   2. Kiểm tra Scoped Scan Lock (tránh quét dồn dập gây checkpoint)
 *   3. Fire-and-forget: trả 202 cho client ngay, chạy quét nền
 *   4. Mỗi trang quét xong → emit Socket.IO "group:scan_progress" vào room riêng user
 *   5. Hoàn tất → emit "group:scan_complete"
 *
 * Data Isolation:
 *   - Lock key = `${accountId}_${userId}` → mỗi Member có lock riêng
 *   - Socket emit vào room `user:${userId}` → chỉ Member kích hoạt mới nhận
 *
 * Bulk Import (POST /api/v1/contacts/bulk-import-from-scan):
 *   - Handled bởi contact-routes.ts, gán assignedUserId = req.user.id
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Server } from 'socket.io';
import { authMiddleware } from '../auth/auth-middleware.js';
import { resolveAccount, checkAccess, handleError } from './zalo-route-helpers.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { logger } from '../../shared/utils/logger.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

// ── Scoped Scan Lock ────────────────────────────────────────────────────────
// Key: `${accountId}_${userId}` → ngăn 1 Member spam quét cùng 1 tài khoản
const scanLocks = new Map<string, boolean>();

// ── Config ──────────────────────────────────────────────────────────────────
const SCAN_CONFIG = {
  /** Số trang member tối đa khi paginate getGroupLinkInfo */
  maxPages: 50,
  /** Delay giữa các trang (ms) — tránh bị Zalo rate limit / checkpoint */
  pageDelayMs: 500,
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function groupScanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  /**
   * POST /api/v1/zalo-accounts/:accountId/groups/scan-by-link
   *
   * Body: { groupLink: string }
   *
   * Phân quyền: ADMIN, OWNER, hoặc MEMBER có quyền 'read' trên accountId.
   * Cơ chế khóa: Nếu lockKey đang active → trả 429.
   * Luồng: Fire-and-forget (respond 202 ngay, quét nền qua Socket.IO).
   */
  app.post<{ Params: { accountId: string }; Body: { groupLink: string } }>(
    '/api/v1/zalo-accounts/:accountId/groups/scan-by-link',
    async (request, reply) => {
      const { accountId } = request.params;
      const { groupLink } = request.body ?? {};
      const user = request.user!;

      // ── Validate input ──────────────────────────────────────────────────
      if (!groupLink) {
        return reply.status(400).send({ error: 'groupLink is required' });
      }

      try {
        // ── 1. Kiểm tra tài khoản thuộc org ─────────────────────────────
        await resolveAccount(accountId, user.orgId);

        // ── 2. Kiểm tra quyền truy cập ─────────────────────────────────
        if (!(await checkAccess(request, reply, accountId, 'read'))) return;

        // ── 3. Scoped Scan Lock ─────────────────────────────────────────
        const lockKey = `${accountId}_${user.id}`;
        if (scanLocks.get(lockKey)) {
          return reply.status(429).send({
            error: 'Tài khoản Zalo này đang bận quét dữ liệu. Vui lòng đợi trong giây lát hoặc chọn tài khoản khác.',
          });
        }

        scanLocks.set(lockKey, true);

        // ── 4. Respond ngay (202 Accepted) ──────────────────────────────
        reply.status(202).send({
          message: 'Tiến trình quét đang được khởi chạy',
          lockKey,
        });

        // ── 5. Fire-and-forget: Quét nền ────────────────────────────────
        runScanInBackground(request.server.io, accountId, user.id, groupLink, lockKey);

        return;
      } catch (err) {
        // Đảm bảo unlock nếu lỗi xảy ra trước khi vào background
        const lockKey = `${accountId}_${user.id}`;
        scanLocks.delete(lockKey);
        return handleError(reply, err, 'scanGroupByLink');
      }
    },
  );
}

/**
 * Background scan worker.
 * Pagination loop gọi zca-js getGroupLinkInfo theo chuẩn PoC:
 *   api.getGroupLinkInfo({ link, memberPage })
 *
 * Mỗi trang emit "group:scan_progress" → room `user:${userId}`.
 * Kết thúc emit "group:scan_complete" hoặc "group:scan_error".
 */
async function runScanInBackground(
  io: Server,
  accountId: string,
  userId: string,
  groupLink: string,
  lockKey: string,
) {
  const userRoom = `user:${userId}`;
  const allMembers: any[] = [];
  let groupInfo: any = null;

  try {
    let page = 1;

    while (page <= SCAN_CONFIG.maxPages) {
      // ── Gọi SDK theo đúng signature PoC ───────────────────────────────
      // PoC: api.getGroupLinkInfo({ link, memberPage })
      const rawRes: any = await zaloOps.exec(
        { accountId, category: 'group_read', operation: 'getGroupLinkInfo' },
        async (api: any) => api.getGroupLinkInfo({ link: groupLink, memberPage: page }),
      );

      // ── Parse response ────────────────────────────────────────────────
      // zca-js trả về object chứa: name, groupId, totalMember, currentMems[], hasMoreMember, ...
      const data = rawRes?.data || rawRes || {};

      // Lưu info từ trang đầu tiên
      if (!groupInfo) {
        groupInfo = {
          name: data.name || 'Nhóm Zalo',
          groupId: data.groupId || null,
          globalId: data.globalId || null,
          totalMember: data.totalMember || 0,
          creatorId: data.creatorId || null,
          adminIds: data.adminIds || [],
          avt: data.avt || null,
          desc: data.desc || null,
        };
      }

      // ── Thu thập thành viên ───────────────────────────────────────────
      const pageMembers = Array.isArray(data.currentMems) ? data.currentMems : [];
      allMembers.push(...pageMembers);

      // ── Emit progress cho user ────────────────────────────────────────
      io.to(userRoom).emit('group:scan_progress', {
        accountId,
        groupLink,
        groupName: groupInfo.name,
        groupId: groupInfo.groupId,
        totalMember: groupInfo.totalMember,
        scannedCount: allMembers.length,
        page,
        members: pageMembers.map(normalizeRawMember),
      });

      logger.info(
        `[GroupScan] account=${accountId} page=${page} scanned=${pageMembers.length} total=${allMembers.length}/${groupInfo.totalMember}`,
      );

      // ── Kiểm tra kết thúc pagination ──────────────────────────────────
      // hasMoreMember: 1 = còn trang tiếp, 0 = hết
      if (!data.hasMoreMember) break;

      page++;
      await sleep(SCAN_CONFIG.pageDelayMs);
    }

    // ── Emit hoàn tất ─────────────────────────────────────────────────────
    io.to(userRoom).emit('group:scan_complete', {
      accountId,
      groupLink,
      groupName: groupInfo?.name || 'Nhóm Zalo',
      groupId: groupInfo?.groupId || null,
      totalScanned: allMembers.length,
      totalMember: groupInfo?.totalMember || 0,
      members: allMembers.map(normalizeRawMember),
      message: 'Hoàn tất quét nhóm',
    });

    logger.info(
      `[GroupScan] ✅ COMPLETE account=${accountId} link=${groupLink} members=${allMembers.length}/${groupInfo?.totalMember}`,
    );
  } catch (err: any) {
    logger.error(`[GroupScan] ❌ account=${accountId} link=${groupLink} Error:`, err);
    io.to(userRoom).emit('group:scan_error', {
      accountId,
      groupLink,
      error: err.message || 'Lỗi trong quá trình quét nhóm',
    });
  } finally {
    // ── GUARANTEE: Luôn giải phóng lock ──────────────────────────────────
    scanLocks.delete(lockKey);
  }
}

/**
 * Chuẩn hóa raw member từ SDK response thành format thống nhất cho Frontend.
 *
 * SDK trả về: { id, dName, zaloName, avatar, avatar_25, type }
 */
function normalizeRawMember(m: any) {
  return {
    zaloUid: String(m.id || ''),
    name: m.dName || m.zaloName || 'Không tên',
    avatarUrl: m.avatar || m.avatar_25 || null,
  };
}
