/**
 * zalo-operations.ts — DRY wrapper for all zca-js API calls.
 * Every Zalo operation goes through this service:
 *   1. Resolve account → get API instance from ZaloPool
 *   2. Check rate limits (per operation type)
 *   3. Execute zca-js call
 *   4. Handle session-expired errors (auto-reconnect + retry once)
 *   5. Emit Socket.IO events
 *   6. Return result or throw typed error
 */
import type { Server } from 'socket.io';
import { zaloPool } from '../modules/zalo/zalo-pool.js';
import { zaloRateLimiter } from '../modules/zalo/zalo-rate-limiter.js';
import { logger } from './utils/logger.js';
import { normalizeZaloUid, normalizeContent } from './utils/normalize.js';
import { prisma } from './database/prisma-client.js';
import { getImageDimensions } from './utils/image-dimensions.js';

// ── Error types ─────────────────────────────────────────────────────────────
export class ZaloOpError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_CONNECTED' | 'RATE_LIMITED' | 'SESSION_EXPIRED' | 'API_ERROR' | 'INVALID_PARAMS',
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ZaloOpError';
  }
}

// ── Operation categories for rate limiting ──────────────────────────────────
export type OpCategory =
  | 'message'       // send text, image, video, voice, link, card, sticker, forward
  | 'reaction'      // add reaction
  | 'chat_action'   // typing, delete, undo, edit, pin/unpin, reply
  | 'group_admin'   // create, rename, avatar, settings, add/remove members, deputy, transfer, block
  | 'group_read'    // list, info, members, polls, invite links, pending
  | 'friend_action' // add, accept, reject, cancel, remove, block, alias
  | 'friend_read'   // list, find, online, recommendations, sent requests
  | 'phone_search'  // search by phone
  | 'profile'       // update name, avatar, status
  | 'query';        // getUserInfo, getGroupInfo — read-only

// ── Types ───────────────────────────────────────────────────────────────────
interface ExecOptions {
  accountId: string;
  category: OpCategory;
  operation: string;           // human-readable name for logging
  io?: Server | null;          // Socket.IO server for event emission
  socketEvent?: string;        // event name to emit on success
  socketRoom?: string;         // room to emit to (default: org-level)
  socketPayload?: any;         // data to emit (merged with result)
}

interface ZaloCredentials {
  cookie: any;
  imei: string;
  userAgent: string;
}

// ── Reconnect mutex ─────────────────────────────────────────────────────────
const reconnecting = new Map<string, Promise<void>>();

async function attemptReconnect(accountId: string): Promise<void> {
  // If already reconnecting this account, wait for it
  const existing = reconnecting.get(accountId);
  if (existing) return existing;

  const attempt = (async () => {
    const account = await prisma.zaloAccount.findUnique({
      where: { id: accountId },
      select: { sessionData: true },
    });
    const session = account?.sessionData as ZaloCredentials | null;
    if (!session?.imei) {
      throw new ZaloOpError('No saved session for reconnect', 'SESSION_EXPIRED', 401);
    }
    logger.info(`[zalo-ops:${accountId}] Auto-reconnecting after session expiry...`);
    await zaloPool.reconnect(accountId, session);
  })();

  reconnecting.set(accountId, attempt);
  try {
    await attempt;
  } finally {
    reconnecting.delete(accountId);
  }
}

// ── Session expiry detection ────────────────────────────────────────────────
// Strict patterns to avoid false positives (e.g. "session data parsing" errors)
const SESSION_EXPIRED_PATTERNS = [
  'session expired',
  'session has expired',
  'not logged in',
  'login required',
  'cookie expired',
  'cookie is invalid',
  'invalid session',
  'invalid token',
];

function isSessionExpiredError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return SESSION_EXPIRED_PATTERNS.some(p => msg.includes(p));
}

// ── Transient network error detection ───────────────────────────────────────
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',       // Connection timeout (IPv6 fallback, slow proxy)
  'ECONNRESET',      // Connection reset by peer
  'ECONNREFUSED',    // Connection refused (transient)
  'ENOTFOUND',       // DNS resolution failure (transient)
  'UND_ERR_CONNECT_TIMEOUT',  // Undici-specific connect timeout
  'UND_ERR_SOCKET',           // Undici socket error
]);

function isNetworkError(err: any): boolean {
  const code = err?.cause?.code || err?.code || '';
  if (NETWORK_ERROR_CODES.has(code)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('fetch failed') || msg.includes('network error');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core execution engine ───────────────────────────────────────────────────
/**
 * Execute a zca-js operation with all safety layers.
 *
 * @param opts - account, category, operation name, socket config
 * @param fn  - callback receiving the zca-js `api` instance, returns result
 * @returns The result of fn(api)
 * @throws ZaloOpError with typed code
 *
 * Usage:
 *   const result = await zaloOps.exec(
 *     { accountId, category: 'message', operation: 'sendMessage' },
 *     (api) => api.sendMessage({ msg: 'hello' }, threadId, 0)
 *   );
 */
async function exec<T>(opts: ExecOptions, fn: (api: any) => Promise<T>): Promise<T> {
  const { accountId, category, operation } = opts;

  // 1. Check connection
  const instance = zaloPool.getInstance(accountId);
  if (!instance?.api || instance.status !== 'connected') {
    throw new ZaloOpError(
      `Zalo account not connected (status: ${instance?.status ?? 'unknown'})`,
      'NOT_CONNECTED',
      400,
    );
  }

  // 2. Rate limit check
  const limit = await zaloRateLimiter.checkLimits(accountId, category);
  if (!limit.allowed) {
    throw new ZaloOpError(limit.reason || 'Rate limited', 'RATE_LIMITED', 429);
  }

  // 3. Execute with retry on session expiry OR transient network errors
  const MAX_NETWORK_RETRIES = 3;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
    // Resolve current API instance (may change after reconnect)
    const currentInstance = attempt === 0 ? instance : zaloPool.getInstance(accountId);
    if (!currentInstance?.api || currentInstance.status !== 'connected') {
      throw new ZaloOpError(
        `Zalo account lost connection during retry (attempt ${attempt + 1})`,
        'NOT_CONNECTED',
        400,
      );
    }

    try {
      const result = await fn(currentInstance.api);

      // Record successful operation
      zaloRateLimiter.recordSend(accountId, category);

      // 4. Emit Socket.IO event if configured
      if (opts.io && opts.socketEvent) {
        const payload = opts.socketPayload
          ? { accountId, ...opts.socketPayload, result }
          : { accountId, operation, result };
        if (opts.socketRoom) {
          opts.io.to(opts.socketRoom).emit(opts.socketEvent, payload);
        } else {
          opts.io.emit(opts.socketEvent, payload);
        }
      }

      return result;
    } catch (err: any) {
      lastError = err;

      // ── Session expired → reconnect + retry (first attempt only) ──
      if (attempt === 0 && isSessionExpiredError(err)) {
        logger.warn(`[zalo-ops:${accountId}] Session expired during ${operation}, attempting reconnect...`);
        try {
          await attemptReconnect(accountId);
          const freshInstance = zaloPool.getInstance(accountId);
          if (freshInstance?.api && freshInstance.status === 'connected') {
            const retryResult = await fn(freshInstance.api);
            zaloRateLimiter.recordSend(accountId, category);
            return retryResult;
          }
        } catch (reconnectErr) {
          logger.error(`[zalo-ops:${accountId}] Reconnect failed:`, reconnectErr);
          throw new ZaloOpError(
            'Session expired and reconnect failed. QR re-login required.',
            'SESSION_EXPIRED',
            401,
          );
        }
      }

      // ── Transient network error → backoff + retry ──
      if (isNetworkError(err) && attempt < MAX_NETWORK_RETRIES - 1) {
        const backoffMs = 1000 * (attempt + 1); // 1s, 2s
        logger.warn(`[zalo-ops:${accountId}] ${operation} network error (${err?.cause?.code || 'unknown'}), retry ${attempt + 1}/${MAX_NETWORK_RETRIES - 1} in ${backoffMs}ms...`);
        await delay(backoffMs);
        continue;
      }

      // Non-retryable error → break
      break;
    }
  }

  // Wrap unknown errors
  if (lastError instanceof ZaloOpError) throw lastError;

  // Suppress verbose stack trace for expected business logic errors
  const apiCode = (lastError as any)?.code;
  if (apiCode == 114 || String(lastError?.message).includes('Tham số không hợp lệ')) {
    logger.warn(`[zalo-ops:${accountId}] ${operation} failed: Không thể gửi tin (Người nhận chặn người lạ hoặc lỗi tham số - Code 114)`);
  } else if (apiCode == 212 || String(lastError?.message).includes('Không tìm thấy')) {
    logger.warn(`[zalo-ops:${accountId}] ${operation} failed: Không tìm thấy (SĐT không đăng ký hoặc ẩn tìm kiếm - Code 212)`);
  } else {
    logger.error(`[zalo-ops:${accountId}] ${operation} failed:`, lastError);
  }

  throw new ZaloOpError(
    `${operation} failed: ${lastError?.message || String(lastError)}`,
    'API_ERROR',
    500,
  );
}

// ── Pre-built operations ────────────────────────────────────────────────────

// ─── Messaging ──────────────────────────────────────────────────────────────
async function sendMessage(accountId: string, threadId: string, threadType: 0 | 1, msg: any, io?: Server | null) {
  return exec({ accountId, category: 'message', operation: 'sendMessage', io, socketEvent: 'chat:message' },
    (api) => api.sendMessage(msg, threadId, threadType));
}

async function sendImage(accountId: string, threadId: string, threadType: 0 | 1, attachments: any[], io?: Server | null) {
  return exec({ accountId, category: 'message', operation: 'sendImage', io },
    (api) => api.sendMessage({ attachments }, threadId, threadType));
}

/**
 * Send file attachments (PDF, Docx, etc.) to a Zalo thread.
 * Each attachment must be a Buffer-based object: { filename: string, data: Buffer }
 *
 * zca-js's sendMessage({ attachments }) handles the upload + chunk logic internally
 * based on file extension (image → photo_original/upload, others → asyncfile/upload).
 *
 * IMPORTANT: zca-js requires:
 *   1. `msg` field (even empty string) — otherwise `msg.length` crashes with
 *      "Cannot read properties of undefined (reading 'length')"
 *   2. For images (jpg/png/webp): `metadata.width` and `metadata.height` are required
 *      by the upload pipeline. We default to 1024x1024 if not provided.
 */
async function sendAttachments(
  accountId: string,
  threadId: string,
  threadType: 0 | 1,
  attachments: Array<{ filename: string; data: Buffer; metadata?: { totalSize: number; width?: number; height?: number } }>,
  io?: Server | null,
) {
  if (!attachments || attachments.length === 0) {
    throw new Error('sendAttachments: no attachments provided');
  }

  // Ensure metadata is complete (totalSize is required, width/height for images)
  const prepared = attachments.map(att => {
    const ext = att.filename.split('.').pop()?.toLowerCase() || '';
    const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);

    let width = att.metadata?.width;
    let height = att.metadata?.height;

    // Auto-detect real dimensions from Buffer if not explicitly provided
    if (isImage && (!width || !height)) {
      const dims = getImageDimensions(att.data);
      if (dims.width > 0 && dims.height > 0) {
        width = dims.width;
        height = dims.height;
      } else {
        // Fallback: zca-js needs some value
        width = width || 1024;
        height = height || 1024;
      }
    }

    return {
      ...att,
      metadata: {
        totalSize: att.metadata?.totalSize || att.data.length,
        ...(isImage ? { width, height } : {}),
      },
    };
  });

  // CRITICAL: `msg` MUST be provided (even as empty string).
  // Without it, zca-js tries `msg.length` on undefined and crashes.
  return exec({ accountId, category: 'message', operation: 'sendAttachments', io },
    (api) => api.sendMessage({ msg: '', attachments: prepared }, threadId, threadType));
}

async function sendSticker(accountId: string, stickerId: number, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'message', operation: 'sendSticker' },
    (api) => api.sendSticker(stickerId, null, threadId, threadType));
}

async function sendLink(accountId: string, threadId: string, threadType: 0 | 1, link: any) {
  return exec({ accountId, category: 'message', operation: 'sendLink' },
    (api) => api.sendLink(link, threadId, threadType));
}

async function sendCard(accountId: string, threadId: string, threadType: 0 | 1, cardData: any) {
  return exec({ accountId, category: 'message', operation: 'sendCard' },
    (api) => api.sendCard(cardData, threadId, threadType));
}

async function sendVoice(accountId: string, threadId: string, threadType: 0 | 1, voicePath: string, duration?: number) {
  return exec({ accountId, category: 'message', operation: 'sendVoice' },
    (api) => api.sendVoice(voicePath, threadId, threadType, duration));
}

async function forwardMessage(accountId: string, msgId: string, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'message', operation: 'forwardMessage' },
    (api) => api.forwardMessage(msgId, threadId, threadType));
}

// ─── Chat Actions ───────────────────────────────────────────────────────────
async function addReaction(accountId: string, reaction: any, msgData: { msgId: string; cliMsgId?: string; threadId: string; threadType: 0 | 1 }) {
  const tag = `[zalo-ops:${accountId}]`;

  // ── 1. Validate & log input ──
  const rawMsgId = msgData.msgId;
  const rawCliMsgId = msgData.cliMsgId || rawMsgId;

  // BigInt safety check: parseInt() loses precision for values > Number.MAX_SAFE_INTEGER
  const parsedMsgId = parseInt(rawMsgId);
  const parsedCliMsgId = parseInt(rawCliMsgId);
  const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

  if (parsedMsgId > MAX_SAFE) {
    logger.warn(`${tag} addReaction: msgId ${rawMsgId} exceeds MAX_SAFE_INTEGER — parseInt will lose precision!`);
  }
  if (parsedCliMsgId > MAX_SAFE) {
    logger.warn(`${tag} addReaction: cliMsgId ${rawCliMsgId} exceeds MAX_SAFE_INTEGER — parseInt will lose precision!`);
  }

  // ── 2. Build zca-js AddReactionDestination ──
  const dest = {
    data: {
      msgId: rawMsgId,
      cliMsgId: rawCliMsgId,
    },
    threadId: msgData.threadId,
    type: msgData.threadType,
  };

  logger.info(`${tag} addReaction INPUT: reaction="${reaction}", dest=${JSON.stringify(dest)}, parsedMsgId=${parsedMsgId}, parsedCliMsgId=${parsedCliMsgId}`);

  // ── 3. Execute and capture full response ──
  const result = await exec({ accountId, category: 'reaction', operation: 'addReaction' },
    (api) => api.addReaction(reaction, dest));

  logger.info(`${tag} addReaction RESPONSE: ${JSON.stringify(result)}`);

  return result;
}

async function sendTypingEvent(accountId: string, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'chat_action', operation: 'sendTypingEvent' },
    (api) => api.sendTypingEvent(threadId, threadType));
}

async function deleteMessage(accountId: string, msgId: string, cliMsgId: string, ownerId: string, threadId: string, threadType: 0 | 1, onlyMe: boolean) {
  return exec({ accountId, category: 'chat_action', operation: 'deleteMessage' },
    (api) => api.deleteMessage(msgId, cliMsgId, ownerId, threadId, threadType, onlyMe));
}

async function undoMessage(accountId: string, msgId: string, cliMsgId: string, ownerId: string, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'chat_action', operation: 'undo' },
    (api) => api.undo(msgId, cliMsgId, ownerId, threadId, threadType));
}

async function editMessage(accountId: string, msgId: string, cliMsgId: string, content: string, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'chat_action', operation: 'editMessage' },
    (api) => api.sendMessage({ msg: content, editMsgId: msgId, editCliMsgId: cliMsgId }, threadId, threadType));
}

async function pinConversation(accountId: string, pin: boolean, threadId: string, threadType: 0 | 1) {
  return exec({ accountId, category: 'chat_action', operation: pin ? 'pin' : 'unpin' },
    (api) => api.setPinnedConversations(pin, threadId, threadType));
}

async function getPinConversations(accountId: string) {
  return exec({ accountId, category: 'query', operation: 'getPinConversations' },
    (api) => api.getPinConversations());
}

// ─── Group Management ───────────────────────────────────────────────────────
async function createGroup(accountId: string, options: { name: string; memberIds: string[] }) {
  return exec({ accountId, category: 'group_admin', operation: 'createGroup' },
    (api) => api.createGroup(options));
}

async function renameGroup(accountId: string, name: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'renameGroup' },
    (api) => api.changeGroupName(name, groupId));
}

async function changeGroupAvatar(accountId: string, avatarPath: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'changeGroupAvatar' },
    (api) => api.changeGroupAvatar(avatarPath, groupId));
}

async function updateGroupSettings(accountId: string, settings: any, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'updateGroupSettings' },
    (api) => api.updateGroupSettings(settings, groupId));
}

async function addUserToGroup(accountId: string, userIds: string[], groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'addUserToGroup' },
    (api) => api.addUserToGroup(userIds, groupId));
}

async function removeUserFromGroup(accountId: string, userIds: string[], groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'removeUserFromGroup' },
    (api) => api.removeUserFromGroup(userIds, groupId));
}

async function addGroupDeputy(accountId: string, userId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'addGroupDeputy' },
    (api) => api.addGroupDeputy(userId, groupId));
}

async function removeGroupDeputy(accountId: string, userId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'removeGroupDeputy' },
    (api) => api.removeGroupDeputy(userId, groupId));
}

async function changeGroupOwner(accountId: string, newOwnerId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'changeGroupOwner' },
    (api) => api.changeGroupOwner(newOwnerId, groupId));
}

async function blockGroupMember(accountId: string, userId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'blockGroupMember' },
    (api) => api.addGroupBlockedMember(userId, groupId));
}

async function unblockGroupMember(accountId: string, userId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'unblockGroupMember' },
    (api) => api.removeGroupBlockedMember(userId, groupId));
}

async function leaveGroup(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'leaveGroup' },
    (api) => api.leaveGroup(groupId));
}

async function disperseGroup(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'disperseGroup' },
    (api) => api.disperseGroup(groupId));
}

// ─── Group Read ─────────────────────────────────────────────────────────────
async function getGroupInfo(accountId: string, groupId: string | string[]) {
  return exec({ accountId, category: 'group_read', operation: 'getGroupInfo' },
    (api) => api.getGroupInfo(groupId));
}

async function getAllGroups(accountId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getAllGroups' },
    (api) => api.getAllGroups());
}

async function getGroupMembersInfo(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getGroupMembersInfo' },
    async (api) => {
      // ── BƯỚC 1: Lấy Group Info (chứa cả currentMems và memberIds) ─────────
      const infoRes: any = await api.getGroupInfo(groupId);
      
      const groupInfo = infoRes?.gridInfoMap?.[groupId];
      if (!groupInfo) {
        console.warn(`[member-debug] Group info not found for ${groupId}.`);
        console.log(`[member-debug] gridInfoMap keys:`, Object.keys(infoRes?.gridInfoMap || {}));
        return [];
      }

      console.log(`[member-debug] groupInfo keys:`, Object.keys(groupInfo));

      const adminIds: string[] = (groupInfo.adminIds || []).map(String);
      const creatorId: string = String(groupInfo.creatorId || '');
      const totalMember: number = groupInfo.totalMember || 0;

      console.log(`[member-debug] totalMember: ${totalMember}, creator: ${creatorId}, admins: ${adminIds.length}`);

      // ── CHIẾN LƯỢC A: Dùng currentMems (dữ liệu có sẵn, không cần gọi thêm API) ─
      // GroupInfo.currentMems: GroupCurrentMem[] = { id, dName, zaloName, avatar, type }
      const currentMems: any[] = groupInfo.currentMems || [];
      console.log(`[member-debug] currentMems count: ${currentMems.length}`);

      if (currentMems.length > 0) {
        const members = currentMems.map((m: any) => {
          const id = String(m.id || '');
          let role = 'member';
          if (id === creatorId) role = 'creator';
          else if (adminIds.includes(id)) role = 'admin';

          return {
            id,
            displayName: m.dName || m.zaloName || 'Không tên',
            avatar: m.avatar || m.avatar_25 || null,
            role,
          };
        });
        console.log(`[member-debug] ✅ Strategy A (currentMems) returned ${members.length} members`);
        return members;
      }

      // ── CHIẾN LƯỢC B: Dùng memberIds + getGroupMembersInfo (profiles map) ──
      const rawMemberIds: string[] = groupInfo.memberIds || [];
      const rawMemVerList: string[] = groupInfo.memVerList || [];
      
      // Dùng hàm chuẩn hóa chung để lột bỏ hậu tố version (_12, _0, etc.)
      const memberIds = rawMemberIds.map(id => normalizeZaloUid(id)).filter(Boolean);
      const memVerList = rawMemVerList.map(id => normalizeZaloUid(id)).filter(Boolean);
      
      const idsToFetch = memberIds.length > 0 ? memberIds : memVerList;
      console.log(`[member-debug] idsToFetch length: ${idsToFetch.length}. Sample:`, idsToFetch.slice(0, 3));

      if (idsToFetch.length > 0) {
        const BATCH_SIZE = 50;
        let allMembers: any[] = [];

        for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
          const batchIds = idsToFetch.slice(i, i + BATCH_SIZE);
          try {
            // getGroupMembersInfo trả về: { profiles: { [uid]: GroupMemberProfile }, unchangeds_profile: [] }
            const profilesRes: any = await api.getGroupMembersInfo(batchIds);
            console.log(`[member-debug] Batch ${Math.floor(i/BATCH_SIZE)+1} response keys:`, Object.keys(profilesRes || {}));
            
            // Parse profiles MAP → Array
            const profilesMap = profilesRes?.profiles || {};
            const batchMembers = Object.entries(profilesMap).map(([uid, profile]: [string, any]) => {
              const id = String(uid.replace(/_\d+$/, '')); // Remove "_0" suffix from UID
              let role = 'member';
              if (id === creatorId) role = 'creator';
              else if (adminIds.includes(id)) role = 'admin';

              return {
                id,
                displayName: profile.displayName || profile.zaloName || 'Không tên',
                avatar: profile.avatar || null,
                role,
              };
            });

            allMembers = allMembers.concat(batchMembers);
          } catch (err) {
            console.error(`[member-debug] Batch ${Math.floor(i/BATCH_SIZE)+1} error:`, err);
          }
        }

        if (allMembers.length > 0) {
          console.log(`[member-debug] ✅ Strategy B (memberIds + profiles) returned ${allMembers.length} members`);
          return allMembers;
        }
      }

      // ── CHIẾN LƯỢC C: Fallback — tự tạo từ adminIds + creatorId ───────────
      console.warn(`[member-debug] ⚠️ Both strategies failed. Falling back to admin/creator list only.`);
      const fallbackMembers: any[] = [];
      
      if (creatorId) {
        fallbackMembers.push({ id: creatorId, displayName: 'Creator', avatar: null, role: 'creator' });
      }
      for (const adminId of adminIds) {
        if (adminId !== creatorId) {
          fallbackMembers.push({ id: adminId, displayName: 'Admin', avatar: null, role: 'admin' });
        }
      }

      console.log(`[member-debug] Strategy C (fallback) returned ${fallbackMembers.length} members`);
      return fallbackMembers;
    });
}

async function getGroupBlockedMembers(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getGroupBlockedMembers' },
    (api) => api.getGroupBlockedMember({}, groupId));
}

async function getPendingGroupMembers(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getPendingGroupMembers' },
    (api) => api.getPendingGroupMembers(groupId));
}

async function getGroupLinkDetail(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getGroupLinkDetail' },
    (api) => api.getGroupLinkDetail(groupId));
}

// ─── Group Invite Link Management ───────────────────────────────────────────
async function enableGroupLink(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'enableGroupLink' },
    (api) => api.enableGroupLink(groupId));
}

async function disableGroupLink(accountId: string, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'disableGroupLink' },
    (api) => api.disableGroupLink(groupId));
}

async function joinGroupByLink(accountId: string, linkId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'joinGroupByLink' },
    (api) => api.joinGroupLink(linkId));
}

// ─── Group Polls ────────────────────────────────────────────────────────────
async function createPoll(accountId: string, options: any, groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'createPoll' },
    (api) => api.createPoll(options, groupId));
}

async function getPollDetail(accountId: string, pollId: string) {
  return exec({ accountId, category: 'group_read', operation: 'getPollDetail' },
    (api) => api.getPollDetail(pollId));
}

async function votePoll(accountId: string, pollId: string, optionIds: number[], groupId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'votePoll' },
    (api) => api.votePoll(optionIds, pollId, groupId));
}

async function lockPoll(accountId: string, pollId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'lockPoll' },
    (api) => api.lockPoll(pollId));
}

async function sharePoll(accountId: string, pollId: string) {
  return exec({ accountId, category: 'group_admin', operation: 'sharePoll' },
    (api) => api.sharePoll(pollId));
}

// ─── Friend Operations ──────────────────────────────────────────────────────
async function getAllFriends(accountId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getAllFriends' },
    (api) => api.getAllFriends());
}

async function findUser(accountId: string, query: string) {
  return exec({ accountId, category: 'friend_read', operation: 'findUser' },
    (api) => api.findUser(query));
}

async function getFriendOnlines(accountId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getFriendOnlines' },
    (api) => api.getFriendOnlines());
}

async function getFriendRecommendations(accountId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getFriendRecommendations' },
    (api) => api.getFriendRecommendations());
}

async function sendFriendRequest(accountId: string, message: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'sendFriendRequest' },
    (api) => api.sendFriendRequest(message, userId));
}

async function acceptFriendRequest(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'acceptFriendRequest' },
    (api) => api.acceptFriendRequest(userId));
}

async function rejectFriendRequest(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'rejectFriendRequest' },
    (api) => api.rejectFriendRequest(userId));
}

async function cancelFriendRequest(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'cancelFriendRequest' },
    (api) => api.undoFriendRequest(userId));
}

async function getSentFriendRequests(accountId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getSentFriendRequests' },
    (api) => api.getSentFriendRequest());
}

async function getFriendRequestStatus(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getFriendRequestStatus' },
    (api) => api.getFriendRequestStatus(userId));
}

async function removeFriend(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'removeFriend' },
    (api) => api.removeFriend(userId));
}

async function changeFriendAlias(accountId: string, alias: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'changeFriendAlias' },
    (api) => api.changeFriendAlias(alias, userId));
}

async function removeFriendAlias(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'removeFriendAlias' },
    (api) => api.removeFriendAlias(userId));
}

async function getAliasList(accountId: string) {
  return exec({ accountId, category: 'friend_read', operation: 'getAliasList' },
    (api) => api.getAliasList());
}

async function blockUser(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'blockUser' },
    (api) => api.blockUser(userId));
}

async function unblockUser(accountId: string, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'unblockUser' },
    (api) => api.unblockUser(userId));
}

async function blockViewFeed(accountId: string, block: boolean, userId: string) {
  return exec({ accountId, category: 'friend_action', operation: 'blockViewFeed' },
    (api) => api.blockViewFeed(block, userId));
}

// ─── Profile ────────────────────────────────────────────────────────────────
async function getUserInfo(accountId: string, userId: string) {
  return exec({ accountId, category: 'query', operation: 'getUserInfo' },
    (api) => api.getUserInfo(userId));
}

async function getOwnId(accountId: string) {
  return exec({ accountId, category: 'query', operation: 'getOwnId' },
    (api) => api.getOwnId());
}

async function getAccountInfo(accountId: string) {
  return exec({ accountId, category: 'profile', operation: 'getAccountInfo' },
    (api) => api.getAccountInfo());
}

async function changeAccountAvatar(accountId: string, filePath: string) {
  return exec({ accountId, category: 'profile', operation: 'changeAccountAvatar' },
    (api) => api.changeAccountAvatar(filePath));
}

async function setOnlineStatus(accountId: string, online: boolean) {
  return exec({ accountId, category: 'profile', operation: 'setOnlineStatus' },
    (api) => api.setOnlineStatus(online));
}

async function getLastOnline(accountId: string, userId: string) {
  return exec({ accountId, category: 'query', operation: 'getLastOnline' },
    (api) => api.getLastOnline(userId));
}

// ── Quote builder ───────────────────────────────────────────────────────────

/**
 * Map CRM contentType to zca-js msgType for quote payloads.
 * zca-js uses its own nomenclature ("webchat" for text, "photo" for images, etc.).
 */
function mapContentTypeToZaloMsgType(contentType: string): string {
  const map: Record<string, string> = {
    text:          'webchat',
    image:         'photo',
    file:          'file',
    video:         'video',
    voice:         'voice',
    sticker:       'sticker',
    gif:           'gif',
    link:          'link',
    location:      'location',
    contact_card:  'card',
    bank_transfer: 'bank',
    call:          'call',
    qr_code:       'qr',
    reminder:      'remind',
    poll:          'poll',
    note:          'note',
    forwarded:     'forward',
  };
  return map[contentType] ?? contentType;
}

/**
 * Input type for buildZaloQuote — matches the Prisma `Message` select shape.
 * Any caller (chat-routes, campaign-worker, etc.) must query at least these fields.
 */
export interface QuoteSourceMessage {
  zaloMsgId:   string | null;
  cliMsgId?:   string | null;
  senderUid:   string | null;
  senderName?: string | null;
  content:     string | null;
  contentType: string;
  sentAt:      Date;
}

/**
 * Build a zca-js compatible `quote` object from a database Message record.
 *
 * This is the **single source of truth** for constructing reply/quote payloads.
 * It replaces the local `buildReplyQuote` in chat-routes.ts so every send path
 * (direct chat, campaign worker, automation actions) produces identical payloads.
 *
 * Returns `null` if the message lacks the required remote IDs (zaloMsgId, senderUid)
 * — this means the message was never synced to Zalo and cannot be quoted.
 *
 * @example
 *   const msg = await prisma.message.findUnique({ where: { id }, select: { ... } });
 *   const quote = buildZaloQuote(msg);
 *   if (quote) {
 *     await zaloOps.sendMessage(accountId, threadId, 0, { msg: 'reply text', quote });
 *   }
 */
export function buildZaloQuote(message: QuoteSourceMessage): {
  content:     string;
  msgType:     string;
  propertyExt: Record<string, never>;
  uidFrom:     string;
  msgId:       string;
  cliMsgId:    string;
  ts:          string;
  ttl:         number;
} | null {
  if (!message.zaloMsgId || !message.senderUid) return null;

  return {
    content:     normalizeContent(message.content),
    msgType:     mapContentTypeToZaloMsgType(message.contentType),
    propertyExt: {},
    uidFrom:     message.senderUid,
    msgId:       message.zaloMsgId,
    cliMsgId:    message.cliMsgId || message.zaloMsgId,
    ts:          String(message.sentAt.getTime()),
    ttl:         0,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────
export const zaloOps = {
  // Core
  exec,

  // Messaging
  sendMessage,
  sendImage,
  sendAttachments,
  sendSticker,
  sendLink,
  sendCard,
  sendVoice,
  forwardMessage,

  // Chat actions
  addReaction,
  sendTypingEvent,
  deleteMessage,
  undoMessage,
  editMessage,
  pinConversation,
  getPinConversations,

  // Group management
  createGroup,
  renameGroup,
  changeGroupAvatar,
  updateGroupSettings,
  addUserToGroup,
  removeUserFromGroup,
  addGroupDeputy,
  removeGroupDeputy,
  changeGroupOwner,
  blockGroupMember,
  unblockGroupMember,
  leaveGroup,
  disperseGroup,

  // Group read
  getGroupInfo,
  getAllGroups,
  getGroupMembersInfo,
  getGroupBlockedMembers,
  getPendingGroupMembers,
  getGroupLinkDetail,

  // Group invite links
  enableGroupLink,
  disableGroupLink,
  joinGroupByLink,

  // Group polls
  createPoll,
  getPollDetail,
  votePoll,
  lockPoll,
  sharePoll,

  // Friend operations
  getAllFriends,
  findUser,
  getFriendOnlines,
  getFriendRecommendations,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  getSentFriendRequests,
  getFriendRequestStatus,
  removeFriend,
  changeFriendAlias,
  removeFriendAlias,
  getAliasList,
  blockUser,
  unblockUser,
  blockViewFeed,

  // Profile/query
  getUserInfo,
  getOwnId,
  getAccountInfo,
  changeAccountAvatar,
  setOnlineStatus,
  getLastOnline,

  // Quote builder
  buildZaloQuote,
};
