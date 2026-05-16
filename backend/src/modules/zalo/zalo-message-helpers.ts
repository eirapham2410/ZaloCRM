/**
 * zalo-message-helpers.ts — utilities for processing incoming Zalo messages.
 * Detects content type from msgType and updates contact avatars fire-and-forget.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { normalizeContent } from '../../shared/utils/normalize.js';

// Well-known msgType keyword patterns — used to suppress noise logging
const KNOWN_MSG_TYPE_PATTERNS = [
  'photo', 'image', 'sticker', 'video', 'voice',
  'gif', 'link', 'location', 'file', 'doc',
  'recommended', 'card', 'bank', 'transfer',
  'call', 'voip', 'qr', 'remind', 'todo',
  'poll', 'vote', 'note', 'forward',
  'webchat', 'text', 'chat',
];

/**
 * Map zca-js msgType string to a normalized content type label.
 * Falls back to 'text' for unrecognised types or plain-string content.
 */
export function detectContentType(msgType: string | undefined, content: any): string {
  if (!msgType) return 'text';
  if (msgType.includes('photo') || msgType.includes('image')) return 'image';
  if (msgType.includes('sticker')) return 'sticker';
  if (msgType.includes('video')) return 'video';
  if (msgType.includes('voice')) return 'voice';
  if (msgType.includes('gif')) return 'gif';
  if (msgType.includes('link')) return 'link';
  if (msgType.includes('location')) return 'location';
  if (msgType.includes('file') || msgType.includes('doc')) return 'file';
  if (msgType.includes('recommended') || msgType.includes('card')) return 'contact_card';

  // Special message types
  if (msgType.includes('bank') || msgType.includes('transfer')) return 'bank_transfer';
  if (msgType.includes('call') || msgType.includes('voip')) return 'call';
  if (msgType.includes('qr')) return 'qr_code';
  if (msgType.includes('remind') || msgType.includes('todo')) return 'reminder';
  if (msgType.includes('poll') || msgType.includes('vote')) return 'poll';
  if (msgType.includes('note')) return 'note';
  if (msgType.includes('forward')) return 'forwarded';

  // Check content object shape for action-based messages
  if (typeof content === 'object' && content !== null) {
    if (content.action === 'msginfo.actionlist') return 'reminder';
    if (content.bankCode || content.bankName) return 'bank_transfer';
    if (content.callDuration !== undefined || content.callType) return 'call';

    // Log unknown types for analysis before returning rich
    if (!KNOWN_MSG_TYPE_PATTERNS.some((p) => msgType.includes(p))) {
      logger.info(`[zalo:msgType] Unknown object type: "${msgType}"`, {
        contentKeys: Object.keys(content),
      });
    }
    return 'rich';
  }

  // Log unknown string-content types for discovery
  if (!KNOWN_MSG_TYPE_PATTERNS.some((p) => msgType.includes(p))) {
    logger.info(`[zalo:msgType] Unknown string type: "${msgType}"`, {
      contentPreview: typeof content === 'string' ? content.slice(0, 100) : undefined,
    });
  }

  return 'text';
}

export interface AlbumInfo {
  albumKey: string | null;
  albumIndex: number | null;
  albumTotal: number | null;
}

/**
 * Extract multi-image album metadata from Zalo content payload.
 * Zalo tags each photo in an album with a shared group_layout_id and position.
 */
export function extractAlbumInfo(contentType: string, rawContent: unknown): AlbumInfo {
  const empty: AlbumInfo = { albumKey: null, albumIndex: null, albumTotal: null };
  if (contentType !== 'image' || typeof rawContent !== 'object' || rawContent === null) return empty;
  const paramsRaw = (rawContent as Record<string, unknown>).params;
  let params: Record<string, unknown> | null = null;
  try {
    params = typeof paramsRaw === 'string' ? JSON.parse(paramsRaw) : (paramsRaw as Record<string, unknown> | null);
  } catch {
    return empty;
  }
  if (!params || !params.is_group_layout || !params.group_layout_id) return empty;
  const idx = Number(params.id_in_group);
  const total = Number(params.total_item_in_group);
  return {
    albumKey: String(params.group_layout_id),
    albumIndex: Number.isFinite(idx) ? idx : null,
    albumTotal: Number.isFinite(total) ? total : null,
  };
}

/**
 * Fire-and-forget: fill in missing avatarUrl or displayName on a Contact row.
 */
export async function updateContactProfile(zaloUid: string, data: { avatarUrl?: string; displayName?: string }): Promise<void> {
  try {
    const promises = [];

    if (data.avatarUrl) {
      promises.push(
        prisma.contact.updateMany({
          where: { zaloUid, avatarUrl: null },
          data: { avatarUrl: data.avatarUrl },
        })
      );
    }

    if (data.displayName) {
      promises.push(
        prisma.contact.updateMany({
          where: {
            zaloUid,
            OR: [
              { fullName: 'Unknown' },
              { fullName: null },
              { fullName: 'Zalo User' }
            ],
          },
          data: { fullName: data.displayName },
        })
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  } catch (err) {
    logger.error('[zalo-message-helpers] updateContactProfile error:', err);
  }
}

// ── Quote Snapshot normalization ─────────────────────────────────────────────

/**
 * Normalized snapshot stored in the `quote` JSON column.
 * This structure is the single source of truth for rendering quoted messages
 * in the frontend — no additional DB lookups required.
 */
export type QuoteSnapshot = {
  msgId: string;        // Zalo message ID of the quoted message
  uidFrom: string;      // Zalo UID of the original sender
  senderName: string;   // Display name (for rendering without lookup)
  content: string;      // NFC-normalized text content
  msgType: string;      // zca-js message type (webchat, photo, file, etc.)
  previewUrl: string | null;  // Thumbnail URL for image/video/link quotes
  mentions: Array<{ uid: string; pos: number; len: number }>;  // Nested mentions in the quoted message
};

/**
 * Extracts the sender UID from a raw quote object.
 * Handles both object and stringified JSON, and alternative keys (uidFrom, ownerId).
 */
export function getQuoteUidFrom(raw: unknown): string {
  let q: Record<string, unknown>;
  if (typeof raw === 'string') {
    try { q = JSON.parse(raw); } catch { return ''; }
  } else if (raw && typeof raw === 'object') {
    q = raw as Record<string, unknown>;
  } else {
    return '';
  }
  return String(q.uidFrom ?? q.ownerId ?? q.fromUid ?? '');
}

/**
 * Normalize a raw zca-js quote object into a clean DB snapshot.
 *
 * The raw SDK quote shape is roughly:
 * ```
 * {
 *   content: string,
 *   msgType: string,     // 'webchat' | 'photo' | 'file' | ...
 *   uidFrom: string,     // Zalo UID of sender
 *   msgId: string,
 *   cliMsgId: string,
 *   ts: string,
 *   ttl: number,
 *   propertyExt: {
 *     color?: number,
 *     size?: number,
 *     subType?: number,
 *     type?: number,
 *     mentions?: { uid: string; pos: number; len: number }[],
 *   },
 *   attach?: string,     // JSON-encoded attachment payload (images, files, etc.)
 * }
 * ```
 *
 * Returns `null` if the input is falsy or missing essential fields.
 */
export function normalizeQuoteSnapshot(
  raw: unknown,
  senderNameHint?: string,
): QuoteSnapshot | null {
  let q: Record<string, unknown>;
  
  if (typeof raw === 'string') {
    try { q = JSON.parse(raw); } catch { return null; }
  } else if (raw && typeof raw === 'object') {
    q = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const msgId = String(q.globalMsgId ?? q.msgId ?? q.cliMsgId ?? '');
  const uidFrom = String(q.uidFrom ?? q.ownerId ?? q.fromUid ?? '');
  
  if (!msgId || !uidFrom) {
    logger.warn('[zalo:quote] Failed to normalize quote due to missing msgId or uidFrom', { raw: q });
    return null;
  }

  // Extract content — NFC normalize for mention offset consistency
  const rawContentStr = q.content ?? q.msg ?? q.description ?? q.title ?? '';
  const rawContent = typeof rawContentStr === 'string' ? rawContentStr : String(rawContentStr);
  const content = normalizeContent(rawContent);

  const msgType = String(q.msgType ?? 'webchat');

  // Extract sender name — quote doesn't carry name, so we use the hint
  const senderName = senderNameHint || '';

  // Extract preview URL from the attach payload (images, files, links)
  let previewUrl: string | null = null;
  try {
    const attachRaw = q.attach;
    const attach =
      typeof attachRaw === 'string' ? JSON.parse(attachRaw) :
      typeof attachRaw === 'object' ? attachRaw : null;

    if (attach && typeof attach === 'object') {
      const a = attach as Record<string, unknown>;
      previewUrl =
        (a.thumb as string) ||
        (a.href as string) ||
        (a.hdUrl as string) ||
        null;
    }
  } catch {
    // Malformed attach JSON — ignore
  }

  // Extract nested mentions from propertyExt
  let mentions: QuoteSnapshot['mentions'] = [];
  try {
    const propExt = q.propertyExt;
    if (propExt && typeof propExt === 'object') {
      const ext = propExt as Record<string, unknown>;
      if (Array.isArray(ext.mentions)) {
        mentions = (ext.mentions as Array<Record<string, unknown>>)
          .filter((m) => m.uid && typeof m.pos === 'number' && typeof m.len === 'number')
          .map((m) => ({
            uid: String(m.uid),
            pos: Number(m.pos),
            len: Number(m.len),
          }));
      }
    }
  } catch {
    // Malformed propertyExt — ignore
  }

  return { msgId, uidFrom, senderName, content, msgType, previewUrl, mentions };
}
