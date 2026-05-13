/**
 * group.service.ts — Business logic for syncing Zalo groups into local DB.
 * Follows the same chunked-upsert + orphan-removal pattern as friend-routes.ts.
 *
 * ── SDK Data Flow ──────────────────────────────────────────────────────────
 * 1. api.getAllGroups()  → { version, gridVerMap: { [groupId]: versionStr } }
 *    ↳ Returns only group IDs and their version hashes, NOT full info.
 * 2. api.getGroupInfo(groupIds[])  → { gridInfoMap: { [groupId]: GroupInfo } }
 *    ↳ Returns full group details: name, avt, totalMember, creatorId, adminIds, etc.
 *
 * We must call BOTH to get usable data.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeZaloUid } from '../../shared/utils/normalize.js';

/** Chunk size for bulk upsert — tránh quá tải DB khi tài khoản có nhiều nhóm */
const SYNC_CHUNK_SIZE = 200;

/** Chunk size for getGroupInfo batch calls — SDK may limit large batches */
const INFO_BATCH_SIZE = 20;

/** Timeout (ms) khi gọi Zalo SDK — tránh treo API nếu SDK không phản hồi */
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
 *   1. Gọi `getAllGroups(accountId)` → lấy danh sách group IDs.
 *   2. Gọi `getGroupInfo(accountId, groupIds)` → lấy full info cho từng nhóm.
 *   3. Chuẩn hóa dữ liệu trả về (map trường API → trường DB).
 *   4. Upsert từng nhóm vào DB theo lô (chunked transaction).
 *   5. Dọn dẹp (Orphan Removal): xóa nhóm cũ không còn tồn tại trên Zalo.
 *
 * @returns `{ total, updated, deleted }`
 */
export async function syncGroupsFromZalo(accountId: string): Promise<GroupSyncResult> {
  const tag = `[group-sync] account=${accountId}`;
  logger.info(`${tag} — Bắt đầu đồng bộ nhóm...`);

  // ── 1. Lấy danh sách group IDs ────────────────────────────────────────────
  const sdkPromise = zaloOps.getAllGroups(accountId);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Zalo SDK timeout sau ${SDK_TIMEOUT_MS / 1000}s`)), SDK_TIMEOUT_MS),
  );

  let rawResponse: any;
  try {
    rawResponse = await Promise.race([sdkPromise, timeoutPromise]);
  } catch (err) {
    logger.error(`${tag} — Lỗi khi gọi Zalo API getAllGroups:`, err);
    throw err;
  }

  // ── 1.5 Validation: ngăn xóa nhầm khi SDK trả lỗi ngầm định ─────────────
  if (!rawResponse || (typeof rawResponse === 'object' && ('error' in rawResponse || 'errorCode' in rawResponse))) {
    const errMsg = `Dữ liệu nhóm trả về không hợp lệ (nghi ngờ lỗi Zalo API): ${JSON.stringify(rawResponse)}`;
    logger.error(`${tag} — ${errMsg}`);
    throw new Error(errMsg);
  }

  // ── 1.6 Debug Log: cấu trúc raw response ─────────────────────────────────
  logger.info(`${tag} — [group-debug] Raw SDK Response: ${JSON.stringify(rawResponse)}`);

  // ── 2. Extract group IDs từ gridVerMap ────────────────────────────────────
  //  getAllGroups() trả về: { version: string, gridVerMap: { [groupId]: versionStr } }
  const gridVerMap: Record<string, string> = rawResponse?.gridVerMap || {};
  const groupIds = Object.keys(gridVerMap);

  logger.info(`${tag} — getAllGroups trả về ${groupIds.length} group IDs: [${groupIds.join(', ')}]`);

  if (groupIds.length === 0) {
    logger.info(`${tag} — Không tìm thấy nhóm nào từ Zalo`);
    return { total: 0, updated: 0, deleted: 0 };
  }

  // ── 3. Fetch full group info theo batch ───────────────────────────────────
  //  getGroupInfo(groupIds[]) trả về: { gridInfoMap: { [groupId]: GroupInfo }, ... }
  const allGroupInfos: any[] = [];

  for (let i = 0; i < groupIds.length; i += INFO_BATCH_SIZE) {
    const batchIds = groupIds.slice(i, i + INFO_BATCH_SIZE);
    const batchNum = Math.floor(i / INFO_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(groupIds.length / INFO_BATCH_SIZE);

    try {
      logger.info(`${tag} — Fetching group info batch ${batchNum}/${totalBatches}: [${batchIds.join(', ')}]`);

      // getGroupInfo accepts a single groupId or array of groupIds
      const infoResponse: any = await zaloOps.getGroupInfo(accountId, batchIds);
      logger.info(`${tag} — [group-debug] getGroupInfo batch ${batchNum} response: ${JSON.stringify(infoResponse)}`);

      const gridInfoMap: Record<string, any> = infoResponse?.gridInfoMap || {};

      for (const [gid, info] of Object.entries(gridInfoMap)) {
        allGroupInfos.push({ ...info, _resolvedGroupId: gid });
      }
    } catch (err) {
      logger.error(`${tag} — Lỗi khi lấy thông tin nhóm batch ${batchNum}:`, err);
      // Tiếp tục với các batch còn lại thay vì fail toàn bộ
    }
  }

  logger.info(`${tag} — Tổng group info fetched: ${allGroupInfos.length}`);

  // ── 4. Chuẩn hóa dữ liệu ────────────────────────────────────────────────
  //  GroupInfo fields (from zca-js types):
  //    groupId, name, desc, type, creatorId, avt, fullAvt,
  //    memberIds, adminIds, totalMember, maxMember, setting, ...
  const normalized = allGroupInfos
    .map((g) => {
      // Group ID: ưu tiên groupId trường chính thức, fallback _resolvedGroupId (key từ gridInfoMap)
      const zaloGroupId = String(g.groupId || g._resolvedGroupId || g.grid || g.id || '');

      // Xác định vai trò: kiểm tra xem account owner UID có nằm trong adminIds
      let role = 'Member';
      if (Array.isArray(g.adminIds) && g.adminIds.length > 0) {
        // Nếu có adminIds thì đánh dấu Admin nếu user hiện tại là admin
        // Tạm thời đánh dấu dựa trên sự hiện diện của adminIds (sẽ resolve chính xác sau)
        role = 'Admin';
      }

      // Fingerprint logic
      let fingerprint = g.globalId || null;
      if (!fingerprint) {
        const creatorId = g.creatorId || g.creator_id || '';
        const createdTime = g.createdTime || g.created_time || '';
        if (creatorId && createdTime) {
          fingerprint = `${normalizeZaloUid(creatorId)}_${createdTime}`;
        }
      }

      return {
        zaloGroupId,
        name:        g.name || 'Nhóm không tên',
        avatar:      g.avt || g.fullAvt || g.avatar || g.thumbUrl || null,
        memberCount: parseInt(g.totalMember || g.memberCount || '0', 10) || 0,
        ownerId:     g.creatorId || g.creator_id || null,
        role,
        fingerprint,
        metadata:    {
          description: g.desc || null,
          type:        g.type ?? null,
          maxMember:   g.maxMember ?? null,
          e2ee:        g.e2ee ?? null,
          subType:     g.subType ?? null,
        },
      };
    })
    .filter((g) => g.zaloGroupId !== '');

  logger.info(`${tag} — Total Raw: ${allGroupInfos.length} | Validated: ${normalized.length}`);

  // ── 4.5 Fingerprint diagnostic logging ───────────────────────────────────
  const withFingerprint = normalized.filter(g => g.fingerprint);
  const withoutFingerprint = normalized.filter(g => !g.fingerprint);
  logger.info(`${tag} — Fingerprint stats: ${withFingerprint.length} with fingerprint, ${withoutFingerprint.length} without`);
  if (withoutFingerprint.length > 0) {
    logger.warn(
      `${tag} — Groups without fingerprint (may fail Affinity routing): [${withoutFingerprint.map(g => g.zaloGroupId).join(', ')}]`,
    );
  }

  if (normalized.length === 0) {
    logger.warn(`${tag} — Không có nhóm hợp lệ sau khi chuẩn hóa, bỏ qua upsert & delete`);
    return { total: 0, updated: 0, deleted: 0 };
  }

  // ── 5. Chunked Upsert ────────────────────────────────────────────────────
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
          fingerprint: group.fingerprint,
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
          fingerprint:   group.fingerprint,
          metadata:      group.metadata,
        },
      }),
    );

    await prisma.$transaction(ops);
    totalUpserted += chunk.length;

    logger.info(
      `${tag} — Chunk ${chunkIndex}/${totalChunks}: ` +
      `${chunk.length} records upserted (${totalUpserted}/${normalized.length})`,
    );
  }

  // ── 6. Orphan Removal: xóa nhóm cũ không còn trong danh sách Zalo ───────
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
