/**
 * zalo-listener-factory.ts — sets up zca-js listener events for one Zalo account.
 * Handles message routing, user-info caching, group detection, and undo events.
 * Extracted from ZaloAccountPool to keep zalo-pool.ts under 200 lines.
 */
import type { Server } from 'socket.io';
import { logger } from '../../shared/utils/logger.js';
import { handleIncomingMessage, handleMessageUndo, handleIncomingReaction } from '../chat/message-handler.js';
import { detectContentType, extractAlbumInfo, updateContactAvatar, normalizeQuoteSnapshot, getQuoteUidFrom } from './zalo-message-helpers.js';
import { prisma } from '../../shared/database/prisma-client.js';

// Cached user info entry with 5-minute TTL
export interface UserInfoCacheEntry {
  zaloName: string;
  avatar: string;
  phone?: string;
  cachedAt: number;
}

const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch zaloName + avatar from API with a per-pool in-memory cache
async function resolveZaloName(
  api: any,
  uid: string,
  cache: Map<string, UserInfoCacheEntry>,
): Promise<{ zaloName: string; avatar: string }> {
  const cached = cache.get(uid);
  if (cached && Date.now() - cached.cachedAt < USER_INFO_CACHE_TTL_MS) {
    return { zaloName: cached.zaloName, avatar: cached.avatar };
  }

  try {
    const result = await api.getUserInfo(uid);
    const profiles = result?.changed_profiles || {};
    const profile = profiles[uid] || profiles[`${uid}_0`];
    if (profile) {
      const entry: UserInfoCacheEntry = {
        zaloName:
          profile.zaloName ||
          profile.zalo_name ||
          profile.displayName ||
          profile.display_name ||
          '',
        avatar: profile.avatar || '',
        phone: profile.phoneNumber || '',
        cachedAt: Date.now(),
      };
      cache.set(uid, entry);
      return { zaloName: entry.zaloName, avatar: entry.avatar };
    }
  } catch (err) {
    logger.warn(`[zalo] getUserInfo failed for ${uid}:`, err);
  }
  return { zaloName: '', avatar: '' };
}

// ── Group name cache (5-minute TTL) to avoid hammering getGroupInfo ──────────
const groupNameCache = new Map<string, { name: string; expiresAt: number }>();
const GROUP_NAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch group display name from the zca-js API (with TTL cache)
async function resolveGroupName(api: any, groupId: string): Promise<string> {
  // Check cache first
  const cached = groupNameCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }

  try {
    const result = await api.getGroupInfo(groupId);
    const info = result?.gridInfoMap?.[groupId];
    const name = info?.name || '';
    groupNameCache.set(groupId, { name, expiresAt: Date.now() + GROUP_NAME_CACHE_TTL_MS });
    return name;
  } catch (err) {
    logger.warn(`[zalo] getGroupInfo failed for ${groupId}:`, err);
    // Cache the failure too (with shorter TTL) to avoid repeated failing calls
    groupNameCache.set(groupId, { name: '', expiresAt: Date.now() + 60_000 });
    return '';
  }
}

export interface ListenerContext {
  accountId: string;
  api: any;
  io: Server | null;
  userInfoCache: Map<string, UserInfoCacheEntry>;
  onDisconnected: (accountId: string) => void;
}

/**
 * Attach all zca-js listener events for the given account.
 * Calls listener.start() with retryOnClose at the end.
 */
export function attachZaloListener(ctx: ListenerContext): void {
  const { accountId, api, io, userInfoCache, onDisconnected } = ctx;
  const listener = api.listener;

  listener.on('connected', () => {
    logger.info(`[zalo:${accountId}] Listener connected`);
  });

  listener.on('message', async (message: any) => {
    try {
      // ThreadType in zca-js: 0 = User, 1 = Group
      const isGroup = message.type === 1;
      const senderUid = String(message.data?.uidFrom || '');

      // Resolve display name — prefer zaloName from API over dName
      let senderName: string = message.data?.dName || '';
      let senderAvatar: string | undefined;
      if (senderUid && api.getUserInfo) {
        // For self messages, resolve recipient name using threadId
        // For contact messages, resolve sender name using senderUid
        const resolveUid = message.isSelf ? (message.threadId || '') : senderUid;
        if (resolveUid) {
          const userInfo = await resolveZaloName(api, resolveUid, userInfoCache);
          if (!message.isSelf) {
            if (userInfo.zaloName) senderName = userInfo.zaloName;
            if (userInfo.avatar) {
              senderAvatar = userInfo.avatar;
              updateContactAvatar(senderUid, userInfo.avatar);
            }
          }
        }
        // For self messages, fetch our own avatar
        if (message.isSelf) {
          const selfInfo = await resolveZaloName(api, senderUid, userInfoCache);
          if (selfInfo.avatar) senderAvatar = selfInfo.avatar;
        }
      }

      // Resolve group name for group threads
      let groupName: string | undefined;
      if (isGroup && message.threadId) {
        groupName = await resolveGroupName(api, message.threadId);
      }

      const rawContent = message.data?.content;
      const content =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
      const contentType = detectContentType(message.data?.msgType, rawContent);
      const album = extractAlbumInfo(contentType, rawContent);

      // Normalize quote snapshot — resolve sender name from cache for richer rendering
      let normalizedQuote = null;
      if (message.data?.quote) {
        let quoteSenderName = '';
        const quoteUidFrom = getQuoteUidFrom(message.data.quote);
        if (quoteUidFrom && api.getUserInfo) {
          const quoteUserInfo = await resolveZaloName(api, quoteUidFrom, userInfoCache);
          quoteSenderName = quoteUserInfo.zaloName;
        }
        normalizedQuote = normalizeQuoteSnapshot(message.data.quote, quoteSenderName);
      }

      const result = await handleIncomingMessage({
        accountId,
        senderUid,
        senderName,
        senderAvatar,
        content,
        contentType,
        msgId: String(message.data?.msgId || ''),
        cliMsgId: String(message.data?.cliMsgId || ''),
        timestamp: parseInt(message.data?.ts || String(Date.now())),
        isSelf: message.isSelf || false,
        threadId: message.threadId || '',
        threadType: isGroup ? 'group' : 'user',
        groupName,
        attachments: [],
        quote: normalizedQuote ?? message.data?.quote,
        albumKey: album.albumKey,
        albumIndex: album.albumIndex,
        albumTotal: album.albumTotal,
      });

      logger.info(`[zalo:${accountId}] NEW MESSAGE RECEIVED: msgId=${message.data?.msgId}, cliMsgId=${message.data?.cliMsgId}`);

      if (result) {
        io?.emit('chat:message', {
          accountId,
          message: {
            ...result.message,
            senderAvatar
          },
          conversationId: result.conversationId,
        });
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Message handler error:`, err);
    }
  });

  listener.on('undo', async (data: any) => {
    const msgId = data.data?.msgId || data.msgId;
    if (msgId) {
      await handleMessageUndo(accountId, String(msgId));
      io?.emit('chat:deleted', { accountId, msgId: String(msgId) });
    }
  });

  // Handle incoming reactions (real-time)
  listener.on('reaction', async (reaction: any) => {
    try {
      const { uidFrom, content } = reaction.data || {};
      const rMsg = content?.rMsg?.[0]; // Array of reacted messages, usually length 1
      if (!rMsg || !uidFrom) return;

      let senderName: string | undefined;
      if (api.getUserInfo) {
        const userInfo = await resolveZaloName(api, String(uidFrom), userInfoCache);
        if (userInfo.zaloName) senderName = userInfo.zaloName;
      }

      const result = await handleIncomingReaction({
        accountId,
        senderUid: String(uidFrom),
        senderName,
        msgId: String(rMsg.gMsgID || ''),
        cliMsgId: String(rMsg.cMsgID || ''),
        emoji: String(content.rIcon || ''), // '' means removed
        threadId: String(reaction.threadId || ''),
      });

      if (result) {
        io?.emit('chat:reactions', {
          accountId,
          ...result
        });
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Reaction handler error:`, err);
    }
  });

  // Backfill reactions delivered on reconnect
  listener.on('old_reactions', async (reactions: any[], isGroup: boolean) => {
    const threadType = isGroup ? 'group' : 'user';
    logger.info(`[zalo:${accountId}] Received ${reactions.length} old ${threadType} reactions`);

    for (const reaction of reactions) {
      try {
        const { uidFrom, content } = reaction.data || {};
        const rMsg = content?.rMsg?.[0];
        if (!rMsg || !uidFrom) continue;

        let senderName: string | undefined;
        if (api.getUserInfo) {
          const userInfo = await resolveZaloName(api, String(uidFrom), userInfoCache);
          if (userInfo.zaloName) senderName = userInfo.zaloName;
        }

        const result = await handleIncomingReaction({
          accountId,
          senderUid: String(uidFrom),
          senderName,
          msgId: String(rMsg.gMsgID || ''),
          cliMsgId: String(rMsg.cMsgID || ''),
          emoji: String(content.rIcon || ''),
          threadId: String(reaction.threadId || ''),
        });

        if (result) {
          io?.emit('chat:reactions', {
            accountId,
            ...result
          });
        }
      } catch (err) {
        logger.warn(`[zalo:${accountId}] old_reactions processing error:`, err);
      }
    }
  });

  // Backfill messages delivered on reconnect (missed while disconnected)
  listener.on('old_messages', async (messages: any[], type: number) => {
    const threadType = type === 1 ? 'group' : 'user';
    logger.info(`[zalo:${accountId}] Received ${messages.length} old ${threadType} messages`);

    for (const message of messages) {
      try {
        const senderUid = String(message.data?.uidFrom || '');
        let senderName = message.data?.dName || '';
        let senderAvatar: string | undefined;

        // Resolve display name and avatar
        if (!message.isSelf && senderUid && api.getUserInfo) {
          const userInfo = await resolveZaloName(api, senderUid, userInfoCache);
          if (userInfo.zaloName) senderName = userInfo.zaloName;
          if (userInfo.avatar) senderAvatar = userInfo.avatar;
        } else if (message.isSelf && senderUid && api.getUserInfo) {
          const selfInfo = await resolveZaloName(api, senderUid, userInfoCache);
          if (selfInfo.avatar) senderAvatar = selfInfo.avatar;
        }

        let groupName: string | undefined;
        if (threadType === 'group' && message.threadId) {
          groupName = await resolveGroupName(api, message.threadId);
        }

        const rawContent = message.data?.content;
        const content =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
        const contentType = detectContentType(message.data?.msgType, rawContent);
        const album = extractAlbumInfo(contentType, rawContent);

        // Normalize quote snapshot for backfilled messages
        let normalizedQuote = null;
        if (message.data?.quote) {
          const quoteUidFrom = getQuoteUidFrom(message.data.quote);
          let quoteSenderName = '';
          if (quoteUidFrom && !message.isSelf && api.getUserInfo) {
            const quoteUserInfo = await resolveZaloName(api, quoteUidFrom, userInfoCache);
            quoteSenderName = quoteUserInfo.zaloName;
          }
          normalizedQuote = normalizeQuoteSnapshot(message.data.quote, quoteSenderName);
        }

        const result = await handleIncomingMessage({
          accountId,
          senderUid,
          senderName,
          senderAvatar,
          content,
          contentType,
          msgId: String(message.data?.msgId || ''),
          cliMsgId: String(message.data?.cliMsgId || ''),
          timestamp: parseInt(message.data?.ts || String(Date.now())),
          isSelf: message.isSelf || false,
          threadId: message.threadId || '',
          threadType,
          groupName,
          attachments: [],
          quote: normalizedQuote ?? message.data?.quote,
          albumKey: album.albumKey,
          albumIndex: album.albumIndex,
          albumTotal: album.albumTotal,
          isBackfill: true,
        });

        if (result) {
          io?.emit('chat:message', {
            accountId,
            message: {
              ...result.message,
              senderAvatar
            },
            conversationId: result.conversationId,
          });
        }
      } catch (err) {
        logger.warn(`[zalo:${accountId}] old_messages processing error:`, err);
      }
    }
  });

  // Group system events: member join/leave/kick, name change, etc.
  listener.on('group_event', async (event: any) => {
    logger.info(`[zalo:${accountId}] Group event: type=${event?.type ?? 'unknown'}`, {
      groupId: event?.groupId,
      actorId: event?.actorId,
      members: event?.members,
    });
    
    // Đồng bộ thành viên nhóm
    if (event?.groupId && Array.isArray(event?.members)) {
      try {
        const group = await prisma.zaloGroup.findUnique({
          where: {
            zaloAccountId_zaloGroupId: {
              zaloAccountId: accountId,
              zaloGroupId: String(event.groupId),
            },
          },
          select: { 
            id: true, 
            zaloAccount: { select: { orgId: true } } 
          },
        });

        if (group) {
          // Các members trong event thường là [{ id: "...", dName: "...", avatar: "..." }]
          // Tuỳ vào API event của zca-js (remove/add), chúng ta update hoặc insert
          for (const m of event.members) {
            const uid = String(m.id || m.uid || '');
            if (!uid) continue;

            if (event.type === 'join' || event.type === 'add_member') {
              let name = m.dName || m.name || m.displayName || 'Người dùng Zalo';
              let avatar = m.avatar || m.avt || null;
              
              if (api.getUserInfo && (!name || !avatar)) {
                const info = await resolveZaloName(api, uid, userInfoCache);
                if (info.zaloName) name = info.zaloName;
                if (info.avatar) avatar = info.avatar;
              }

              await prisma.groupMember.upsert({
                where: {
                  groupId_zaloUid: {
                    groupId: group.id,
                    zaloUid: uid,
                  },
                },
                update: { name, avatar },
                create: {
                  orgId: group.zaloAccount.orgId,
                  groupId: group.id,
                  zaloUid: uid,
                  name,
                  avatar,
                  role: 'Member',
                },
              });
            } else if (event.type === 'leave' || event.type === 'remove_member' || event.type === 'kick') {
              await prisma.groupMember.deleteMany({
                where: {
                  groupId: group.id,
                  zaloUid: uid,
                },
              });
            }
          }
        }
      } catch (err) {
        logger.error(`[zalo:${accountId}] Sync group members from event failed:`, err);
      }
    }
  });

  // Friend lifecycle events: request sent/accepted/blocked
  listener.on('friend_event', async (event: any) => {
    logger.info(`[zalo:${accountId}] Friend event: type=${event?.type ?? 'unknown'}`, {
      fromId: event?.fromId,
      toId: event?.toId,
    });
    
    // Xử lý khi có người đồng ý kết bạn
    if (event?.type === 'accepted' || event?.type === 'new_friend') {
      const friendUid = String(event.fromId) === accountId ? String(event.toId) : String(event.fromId);
      
      try {
        // 1. Update CRM Contact (isZaloFriend: true)
        const account = await prisma.zaloAccount.findUnique({ where: { id: accountId }, select: { orgId: true } });
        if (account) {
          await prisma.contact.updateMany({
            where: { orgId: account.orgId, zaloUid: friendUid },
            data: { isZaloFriend: true }
          });
        }

        // 2. Update CampaignRecipient status from 'sent_request' to 'sent'
        const recipient = await prisma.campaignRecipient.findFirst({
          where: {
            zaloUid: friendUid,
            status: 'sent_request',
            campaign: {
              accountIds: { has: accountId }
            }
          }
        });

        if (recipient) {
          await prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'sent' }
          });

          // 3. Phát event Socket.IO về Frontend
          io?.emit('campaign:friend_accepted', {
            accountId,
            zaloUid: friendUid,
            campaignId: recipient.campaignId,
            recipientId: recipient.id
          });
        }
      } catch (err) {
        logger.error(`[zalo:${accountId}] Error handling friend_event:`, err);
      }
    }
  });

  listener.on('closed', (code: number, reason: string) => {
    logger.warn(`[zalo:${accountId}] Listener closed: ${code} ${reason}`);
    onDisconnected(accountId);
    io?.emit('zalo:disconnected', { accountId, code, reason });
  });

  listener.on('error', (err: any) => {
    logger.error(`[zalo:${accountId}] Listener error:`, err);
  });

  listener.start({ retryOnClose: true });
}
