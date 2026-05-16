import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { Server } from 'socket.io';

export async function resolveBestProfiles(
  zaloUids: string[], 
  accountId: string, 
  orgId: string
): Promise<Map<string, { displayName: string; avatarUrl: string | null }>> {
  const result = new Map<string, { displayName: string; avatarUrl: string | null }>();
  if (!zaloUids || zaloUids.length === 0) return result;

  try {
    // 1. ZaloFriend
    const friends = await prisma.zaloFriend.findMany({
      where: { zaloAccountId: accountId, zaloUid: { in: zaloUids } }
    });
    
    for (const friend of friends) {
      if (friend.displayName && !['Unknown', 'Zalo User'].includes(friend.displayName)) {
        result.set(friend.zaloUid, {
          displayName: friend.displayName,
          avatarUrl: friend.avatarUrl || null
        });
      }
    }

    const missingUids = zaloUids.filter(uid => !result.has(uid));
    if (missingUids.length === 0) return result;

    // 2. Message table (latest message from these uids)
    const recentMessages = await prisma.message.findMany({
      where: { 
        senderUid: { in: missingUids }, 
        senderType: 'contact', 
        senderName: { not: null } 
      },
      orderBy: { sentAt: 'desc' },
      select: { senderUid: true, senderName: true }
    });

    const msgFallbackNames = new Map<string, string>();
    for (const msg of recentMessages) {
      if (msg.senderUid && msg.senderName && !['Unknown', 'Zalo User'].includes(msg.senderName)) {
        if (!msgFallbackNames.has(msg.senderUid)) {
          msgFallbackNames.set(msg.senderUid, msg.senderName);
        }
      }
    }

    // 3. GroupMember table
    const groupMembers = await prisma.groupMember.findMany({
      where: { 
        orgId, 
        zaloUid: { in: missingUids }, 
        OR: [{ name: { not: null } }, { avatar: { not: null } }] 
      },
      select: { zaloUid: true, name: true, avatar: true }
    });

    const gmFallback = new Map<string, { name: string | null; avatar: string | null }>();
    for (const gm of groupMembers) {
      if (!gmFallback.has(gm.zaloUid)) {
        gmFallback.set(gm.zaloUid, { name: gm.name, avatar: gm.avatar });
      } else {
        // override if empty
        const current = gmFallback.get(gm.zaloUid)!;
        if (!current.name && gm.name) current.name = gm.name;
        if (!current.avatar && gm.avatar) current.avatar = gm.avatar;
      }
    }

    // Combine fallbacks
    for (const uid of missingUids) {
      let displayName = msgFallbackNames.get(uid);
      let avatarUrl: string | null = null;
      
      const gm = gmFallback.get(uid);
      if (gm) {
        if (!displayName && gm.name && !['Unknown', 'Zalo User'].includes(gm.name)) {
          displayName = gm.name;
        }
        if (gm.avatar) {
          avatarUrl = gm.avatar;
        }
      }

      // 4. SDK Fallback if it's a single missing UID (to avoid batch rate limits)
      if (missingUids.length === 1 && (!displayName || !avatarUrl)) {
        try {
          const { zaloPool } = await import('../zalo/zalo-pool.js');
          const instance = zaloPool.getInstance(accountId);
          if (instance?.api?.getUserInfo) {
            const sdkCall = instance.api.getUserInfo(uid);
            const timeoutCall = new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('SDK Timeout')), 800)
            );
            const sdkResult = await Promise.race([sdkCall, timeoutCall]) as any;
            
            const profiles = sdkResult?.changed_profiles || {};
            const sdkProfile = profiles[uid] || profiles[`${uid}_0`];
            
            if (sdkProfile) {
              if (!displayName && (sdkProfile.zaloName || sdkProfile.displayName)) {
                displayName = sdkProfile.zaloName || sdkProfile.displayName;
              }
              if (!avatarUrl && sdkProfile.avatar) {
                avatarUrl = sdkProfile.avatar;
              }
            }
          }
        } catch (err) {
          logger.warn(`[contact-fallback] SDK fallback failed for ${uid}:`, err instanceof Error ? err.message : String(err));
        }
      }

      if (displayName) {
        result.set(uid, { displayName, avatarUrl });
      }
    }
  } catch (err) {
    logger.error('[contact-fallback] Error resolving profiles:', err);
  }

  return result;
}

export function triggerBackgroundContactUpdate(
  updatedProfilesMap: Map<string, { displayName: string; avatarUrl: string | null }>, 
  orgId: string, 
  io?: Server
) {
  if (updatedProfilesMap.size === 0) return;

  // Run in background without await
  (async () => {
    try {
      let hasUpdates = false;
      const updatedPayloads: any[] = [];

      for (const [zaloUid, profile] of updatedProfilesMap.entries()) {
        const updated = await prisma.contact.updateMany({
          where: { orgId, zaloUid },
          data: {
            fullName: profile.displayName,
            ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {})
          }
        });
        
        if (updated.count > 0) {
          hasUpdates = true;
          updatedPayloads.push({ zaloUid, ...profile });
        }
      }

      // Phát sự kiện Socket để client tự động update Store
      if (hasUpdates && io) {
        io.emit('contact:updated', { 
          orgId, 
          updatedProfiles: updatedPayloads 
        });
      }
    } catch (err) {
      logger.error('[contact-fallback] Error in background contact update:', err);
    }
  })();
}
