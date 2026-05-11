/**
 * group.service.ts — Business logic for syncing Zalo groups into local DB.
 * Follows the same chunked-upsert + orphan-removal pattern as friend-routes.ts.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { logger } from '../../shared/utils/logger.js';

/** Chunk size for bulk upsert — tránh quá tải DB khi tài khoản có nhiều nhóm */
const SYNC_CHUNK_SIZE = 200;

/** Timeout (ms) khi gọi Zalo SDK getAllGroups — tránh treo API nếu SDK không phản hồi */
const SDK_TIMEOUT_MS = 30_000;

export interface GroupSyncResult {
  total: number;
  updated: number;
  deleted: number;
}

/**
 * Đồng bộ danh sách nhóm từ Zalo SDK vào bảng `zalo_groups`.
 *
 * Luồng hoạt động:
 *   1. Gọi `zaloOps.getAllGroups(accountId)` với timeout bảo vệ.
 *   2. Chuẩn hóa dữ liệu trả về (map trường API → trường DB).
 *   3. Upsert từng nhóm vào DB theo lô (chunked transaction).
 *   4. Dọn dẹp (Orphan Removal): xóa nhóm cũ không còn tồn tại trên Zalo.
 *
 * @returns `{ total, updated, deleted }`
 */
export async function syncGroupsFromZalo(accountId: string): Promise<GroupSyncResult> {
  const tag = `[group-sync] account=${accountId}`;
  logger.info(`${tag} — Bắt đầu đồng bộ nhóm...`);

  // ── 1. Gọi Zalo SDK với timeout bảo vệ ───────────────────────────────────
  const sdkPromise = zaloOps.getAllGroups(accountId);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Zalo SDK timeout sau ${SDK_TIMEOUT_MS / 1000}s`)), SDK_TIMEOUT_MS),
  );

  let rawGroups: any;
  try {
    rawGroups = await Promise.race([sdkPromise, timeoutPromise]);
  } catch (err) {
    logger.error(`${tag} — Lỗi khi gọi Zalo API getAllGroups:`, err);
    throw err;
  }

  // ── 1.5 Kiểm tra tính hợp lệ của dữ liệu trả về ─────────────────────────
  // Ngăn chặn việc xóa nhầm toàn bộ nhóm nếu Zalo SDK trả về lỗi ngầm định (không ném exception)
  if (!rawGroups || (typeof rawGroups === 'object' && ('error' in rawGroups || 'errorCode' in rawGroups))) {
    const errMsg = `Dữ liệu nhóm trả về không hợp lệ (nghi ngờ lỗi Zalo API): ${JSON.stringify(rawGroups)}`;
    logger.error(`${tag} — ${errMsg}`);
    throw new Error(errMsg);
  }

  // ── 2. Chuẩn hóa dữ liệu ────────────────────────────────────────────────
  // getAllGroups() trả về mảng hoặc object — chuẩn hóa thành array
  const groupList = Array.isArray(rawGroups)
    ? rawGroups
    : Object.values(rawGroups || {});

  const normalized = (groupList as any[])
    .map((g) => ({
      zaloGroupId: String(g.groupId || g.grid || g.id || ''),
      name:        g.name || g.groupName || g.group_name || 'Nhóm không tên',
      avatar:      g.avatar || g.avt || g.thumbUrl || null,
      memberCount: parseInt(g.totalMember || g.memberCount || g.member_count || '0', 10) || 0,
      ownerId:     g.creatorId || g.creator_id || g.ownerId || null,
      role:        g.isAdmin || g.role === 'admin' || g.role === 'Admin' ? 'Admin' : 'Member',
      metadata:    {
        description: g.desc || g.description || null,
        type:        g.type || null,
      },
    }))
    .filter((g) => g.zaloGroupId !== '');

  logger.info(`${tag} — SDK trả về ${groupList.length} nhóm, hợp lệ: ${normalized.length}`);

  if (normalized.length === 0) {
    // Không có nhóm nào → xóa tất cả nhóm cũ trong DB cho account này
    const { count: deletedAll } = await prisma.zaloGroup.deleteMany({
      where: { zaloAccountId: accountId },
    });
    if (deletedAll > 0) {
      logger.info(`${tag} — Không có nhóm từ Zalo, đã xóa ${deletedAll} nhóm cũ trong DB`);
    }
    return { total: 0, updated: 0, deleted: deletedAll };
  }

  // ── 3. Chunked Upsert ────────────────────────────────────────────────────
  const totalChunks = Math.ceil(normalized.length / SYNC_CHUNK_SIZE) || 1;
  let totalUpserted = 0;

  for (let i = 0; i < normalized.length; i += SYNC_CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / SYNC_CHUNK_SIZE) + 1;
    const chunk = normalized.slice(i, i + SYNC_CHUNK_SIZE);

    const ops = chunk.map((group) =>
      prisma.zaloGroup.upsert({
        where: {
          zaloAccountId_zaloGroupId: {
            zaloAccountId: accountId,
            zaloGroupId: group.zaloGroupId,
          },
        },
        update: {
          name:        group.name,
          avatar:      group.avatar,
          memberCount: group.memberCount,
          ownerId:     group.ownerId,
          role:        group.role,
          metadata:    group.metadata,
          syncedAt:    new Date(),
        },
        create: {
          zaloAccountId: accountId,
          zaloGroupId:   group.zaloGroupId,
          name:          group.name,
          avatar:        group.avatar,
          memberCount:   group.memberCount,
          ownerId:       group.ownerId,
          role:          group.role,
          metadata:      group.metadata,
        },
      }),
    );

    // Mỗi lô chạy trong 1 transaction riêng
    await prisma.$transaction(ops);
    totalUpserted += chunk.length;

    logger.info(
      `${tag} — Chunk ${chunkIndex}/${totalChunks}: ` +
      `${chunk.length} records upserted (${totalUpserted}/${normalized.length})`,
    );
  }

  // ── 4. Orphan Removal: xóa nhóm cũ không còn trong danh sách Zalo ───────
  const currentGroupIds = normalized.map((g) => g.zaloGroupId);
  const { count: removedCount } = await prisma.zaloGroup.deleteMany({
    where: {
      zaloAccountId: accountId,
      zaloGroupId: { notIn: currentGroupIds },
    },
  });

  if (removedCount > 0) {
    logger.info(`${tag} — Đã xóa ${removedCount} nhóm cũ (không còn trong Zalo)`);
  }

  logger.info(
    `${tag} — Hoàn tất: ${totalUpserted} synced, ${removedCount} removed`,
  );

  return {
    total: totalUpserted,
    updated: totalUpserted,
    deleted: removedCount,
  };
}
