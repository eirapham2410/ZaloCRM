/**
 * chat-routes.ts — REST API for conversations and messages.
 * All routes require JWT auth and are scoped to the user's org.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { logger } from '../../shared/utils/logger.js';
import { buildZaloQuote, zaloOps } from '../../shared/zalo-operations.js';
import { getImageDimensions } from '../../shared/utils/image-dimensions.js';
import { normalizeQuoteSnapshot } from '../zalo/zalo-message-helpers.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';

type QueryParams = Record<string, string>;

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── Conversation filter counts (unread, unreplied, total) ───────────────
  // NOTE: Must be registered BEFORE /api/v1/conversations/:id to avoid route conflict
  app.get('/api/v1/conversations/counts', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { accountId = '', tab = '' } = request.query as QueryParams;

    const baseWhere: any = { orgId: user.orgId };
    if (accountId) baseWhere.zaloAccountId = accountId;
    if (tab) baseWhere.tab = tab;

    // Members can only see conversations from Zalo accounts they have access to
    if (user.role === 'member') {
      const accessibleAccounts = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const accessibleIds = accessibleAccounts.map((a: any) => a.zaloAccountId);
      // Intersect with user-selected account filter if present
      if (accountId && accessibleIds.includes(accountId)) {
        baseWhere.zaloAccountId = accountId;
      } else {
        baseWhere.zaloAccountId = { in: accessibleIds };
      }
    }

    const [unread, unreplied, total] = await Promise.all([
      prisma.conversation.count({ where: { ...baseWhere, unreadCount: { gt: 0 } } }),
      prisma.conversation.count({ where: { ...baseWhere, isReplied: false } }),
      prisma.conversation.count({ where: baseWhere }),
    ]);

    return { unread, unreplied, total };
  });

  // ── List conversations (paginated, filterable) ──────────────────────────
  app.get('/api/v1/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const {
      page = '1',
      limit = '50',
      search = '',
      accountId = '',
      // Filter params
      unread = '',
      unreplied = '',
      from = '',
      to = '',
      tags = '',
      tab = '',
    } = request.query as QueryParams;

    const where: any = { orgId: user.orgId };
    if (tab) where.tab = tab;
    if (accountId) where.zaloAccountId = accountId;
    if (search) {
      where.contact = {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { crmName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      };
    }

    // Advanced filters
    if (unread === 'true') where.unreadCount = { gt: 0 };
    if (unreplied === 'true') where.isReplied = false;
    if (from || to) {
      where.lastMessageAt = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d.getTime())) where.lastMessageAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d.getTime())) where.lastMessageAt.lte = d;
      }
      // Remove empty filter if both dates invalid
      if (Object.keys(where.lastMessageAt).length === 0) delete where.lastMessageAt;
    }
    if (tags) {
      const tagList = tags.split(',').map((t: any) => t.trim()).filter(Boolean);
      if (tagList.length > 0) {
        // Merge with any existing contact filter from search
        where.contact = {
          ...where.contact,
          tags: { array_contains: tagList },
        };
      }
    }

    // Members can only see conversations from Zalo accounts they have access to
    if (user.role === 'member') {
      const accessibleAccounts = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const accessibleIds = accessibleAccounts.map((a: any) => a.zaloAccountId);
      if (accountId && accessibleIds.includes(accountId)) {
        where.zaloAccountId = accountId;
      } else {
        where.zaloAccountId = { in: accessibleIds };
      }
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          contact: { select: { id: true, fullName: true, crmName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
          pins: { select: { id: true } },
          messages: {
            take: 1,
            orderBy: { sentAt: 'desc' },
            select: { id: true, zaloMsgId: true, senderUid: true, senderName: true, content: true, contentType: true, senderType: true, sentAt: true, isDeleted: true, reactions: { select: { emoji: true, reactorId: true } } },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (parseInt(page) - 1) * Math.min(parseInt(limit), 200),
        take: Math.min(parseInt(limit), 200),
      }),
      prisma.conversation.count({ where }),
    ]);

    return {
      conversations: conversations.map((conversation: any) => ({ ...conversation, isPinned: conversation.pins.length > 0 })),
      total,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 200),
    };
  });

  // ── Get single conversation ──────────────────────────────────────────────
  app.get('/api/v1/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        contact: true,
        zaloAccount: { select: { id: true, displayName: true, zaloUid: true, status: true } },
        pins: { select: { id: true } },
      },
    });
    if (!conversation) return reply.status(404).send({ error: 'Not found' });

    return { ...conversation, isPinned: conversation.pins.length > 0 };
  });

  // ── List messages for a conversation (paginated, newest first) ──────────
  app.get('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { page = '1', limit = '50' } = request.query as QueryParams;

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, threadType: true, externalThreadId: true, zaloAccountId: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const [rawMessages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { sentAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
        select: {
          id: true,
          zaloMsgId: true,
          cliMsgId: true,
          senderUid: true,
          senderName: true,
          content: true,
          contentType: true,
          senderType: true,
          sentAt: true,
          isDeleted: true,
          quote: true,
          reactions: { select: { emoji: true, reactorId: true } },
        },
      }),
      prisma.message.count({ where: { conversationId: id } }),
    ]);

    // Resolve reactorId → reactorName and senderUid → senderAvatar
    const allReactorIds = new Set<string>();
    const allSenderUids = new Set<string>();
    for (const msg of rawMessages) {
      if (msg.senderUid) allSenderUids.add(msg.senderUid);
      for (const r of msg.reactions) allReactorIds.add(r.reactorId);
    }

    const reactorNameMap = new Map<string, string>();
    if (allReactorIds.size > 0) {
      const ids = Array.from(allReactorIds);
      // Lookup CRM users (staff who reacted via CRM)
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true, email: true },
      });
      for (const u of users) reactorNameMap.set(u.id, u.fullName || u.email);

      // Lookup contacts by zaloUid (Zalo users who reacted via Zalo app)
      const unresolvedIds = ids.filter((id: any) => !reactorNameMap.has(id));
      if (unresolvedIds.length > 0) {
        const contacts = await prisma.contact.findMany({
          where: { zaloUid: { in: unresolvedIds }, orgId: user.orgId },
          select: { zaloUid: true, fullName: true, crmName: true },
        });
        for (const c of contacts) {
          if (c.zaloUid) reactorNameMap.set(c.zaloUid, c.crmName || c.fullName || 'Người dùng Zalo');
        }
      }
    }

    // Batch fetch avatars
    const avatarMap = new Map<string, string>();
    if (allSenderUids.size > 0) {
      const senderIds = Array.from(allSenderUids);
      const avatarPromises: Promise<any>[] = [
        prisma.contact.findMany({
          where: { zaloUid: { in: senderIds }, orgId: user.orgId },
          select: { zaloUid: true, avatarUrl: true },
        }),
        prisma.zaloAccount.findMany({
          where: { zaloUid: { in: senderIds }, orgId: user.orgId },
          select: { zaloUid: true, avatarUrl: true },
        })
      ];

      if (conversation.threadType === 'group' && conversation.externalThreadId) {
        const group = await prisma.zaloGroup.findUnique({
          where: {
            zaloAccountId_zaloGroupId: {
              zaloAccountId: conversation.zaloAccountId,
              zaloGroupId: conversation.externalThreadId,
            }
          },
          select: { id: true }
        });
        
        if (group) {
          avatarPromises.push(
            prisma.groupMember.findMany({
              where: { groupId: group.id, zaloUid: { in: senderIds }, orgId: user.orgId },
              select: { zaloUid: true, avatar: true },
            })
          );
        }
      }

      const results = await Promise.all(avatarPromises);
      
      const contacts = results[0] || [];
      const accounts = results[1] || [];
      const groupMembers = results[2] || [];

      for (const c of contacts) {
        if (c.zaloUid && c.avatarUrl) avatarMap.set(c.zaloUid, c.avatarUrl);
      }
      for (const a of accounts) {
        if (a.zaloUid && a.avatarUrl) avatarMap.set(a.zaloUid, a.avatarUrl);
      }
      for (const m of groupMembers) {
        if (m.zaloUid && m.avatar) avatarMap.set(m.zaloUid, m.avatar);
      }
    }

    const messages = rawMessages.map((msg: any) => ({
      ...msg,
      senderAvatar: msg.senderUid ? avatarMap.get(msg.senderUid) : undefined,
      reactions: msg.reactions.map((r: any) => ({
        ...r,
        reactorName: reactorNameMap.get(r.reactorId) || 'Người dùng Zalo',
      })),
    }));

    return { messages: messages.reverse(), total, page: parseInt(page), limit: parseInt(limit) };
  });

  // ── Get group members ────────────────────────────────────────────────────
  app.get('/api/v1/conversations/:id/members', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        zaloAccount: true,
      },
    });

    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });
    if (conversation.threadType !== 'group' || !conversation.externalThreadId) {
      return reply.status(400).send({ error: 'Conversation is not a group' });
    }

    // Lấy thông tin ZaloGroup tương ứng
    const zaloGroup = await prisma.zaloGroup.findUnique({
      where: {
        zaloAccountId_zaloGroupId: {
          zaloAccountId: conversation.zaloAccountId,
          zaloGroupId: conversation.externalThreadId,
        },
      },
      include: {
        members: true,
      },
    });

    if (!zaloGroup) {
      return reply.status(404).send({ error: 'Group data not found' });
    }

    let members = zaloGroup.members.map(m => ({
      id: m.zaloUid,
      name: m.name || 'Người dùng Zalo',
      avatar: m.avatar || undefined,
    }));

    // Tự động đồng bộ nếu DB chưa có thành viên
    if (members.length === 0) {
      try {
        const fetchedMembers: any = await zaloOps.getGroupMembersInfo(conversation.zaloAccountId, conversation.externalThreadId);
        if (fetchedMembers && fetchedMembers.length > 0) {
          await prisma.groupMember.createMany({
            data: fetchedMembers.map((m: any) => ({
               orgId: user.orgId,
               groupId: zaloGroup.id,
               zaloUid: m.id,
               name: m.displayName || 'Người dùng Zalo',
               avatar: m.avatar,
               role: m.role || 'Member'
            })),
            skipDuplicates: true
          });
          
          members = fetchedMembers.map((m: any) => ({
             id: m.id,
             name: m.displayName || 'Người dùng Zalo',
             avatar: m.avatar || undefined,
          }));
        }
      } catch (err) {
        logger.error('[chat] Failed to sync group members on-the-fly:', err);
      }
    }

    return { members };
  });

  // ── Find message context (jump to quote) ─────────────────────────────────
  app.get('/api/v1/conversations/:id/messages/context', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { zaloMsgId } = request.query as { zaloMsgId: string };

    if (!zaloMsgId) return reply.status(400).send({ error: 'zaloMsgId is required' });

    const targetMsg = await prisma.message.findFirst({
      where: {
        conversationId: id,
        OR: [{ zaloMsgId }, { cliMsgId: zaloMsgId }],
        isDeleted: false,
      },
      select: { sentAt: true },
    });

    if (!targetMsg) return reply.status(404).send({ error: 'Message not found' });

    const countNewer = await prisma.message.count({
      where: {
        conversationId: id,
        sentAt: { gte: targetMsg.sentAt },
        isDeleted: false,
      },
    });

    return { positionFromEnd: countNewer };
  });

  // ── Send message ─────────────────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { content, replyMessageId, mentions } = request.body as { content: string; replyMessageId?: string; mentions?: any[] };

    if (!content?.trim() && !(mentions && mentions.length)) return reply.status(400).send({ error: 'Content required' });

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: { zaloAccount: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const instance = zaloPool.getInstance(conversation.zaloAccountId);
    if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

    // Rate limit check — prevent account blocking
    const limits = await zaloRateLimiter.checkLimits(conversation.zaloAccountId);
    if (!limits.allowed) {
      return reply.status(429).send({ error: limits.reason });
    }

    try {
      const threadId = conversation.externalThreadId || '';
      // zca-js sendMessage(message, threadId, type) — type: 0=User, 1=Group
      const threadType = conversation.threadType === 'group' ? 1 : 0;

      let quote: ReturnType<typeof buildZaloQuote> | null = null;
      let replySenderNameHint = '';
      if (replyMessageId) {
        const replyMessage = await prisma.message.findFirst({
          where: { id: replyMessageId, conversationId: id },
          select: { zaloMsgId: true, cliMsgId: true, senderUid: true, senderName: true, content: true, contentType: true, sentAt: true },
        });
        if (!replyMessage) {
          return reply.status(404).send({ error: 'Reply message not found' });
        }
        quote = buildZaloQuote(replyMessage);
        replySenderNameHint = replyMessage.senderName || '';
        if (!quote) {
          return reply.status(400).send({ error: 'Reply message is missing remote ids' });
        }
      }

      zaloRateLimiter.recordSend(conversation.zaloAccountId);

      // Xây dựng message object
      const messageObj: any = { msg: content };
      if (quote) messageObj.quote = quote;
      if (mentions && mentions.length > 0) messageObj.mentions = mentions;

      const sendResult = (await instance.api.sendMessage(messageObj, threadId, threadType)) as any;
      // Extract zaloMsgId from sendMessage response for dedup with selfListen
      const zaloMsgId = String(sendResult?.msgId || sendResult?.data?.msgId || '');

      const message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          zaloMsgId: zaloMsgId || null,
          senderType: 'self',
          senderUid: conversation.zaloAccount.zaloUid || '',
          senderName: 'Staff',
          content,
          contentType: 'text',
          quote: quote ? (normalizeQuoteSnapshot(quote, replySenderNameHint) ?? undefined) : undefined,
          mentions: mentions && mentions.length > 0 ? mentions : undefined,
          sentAt: new Date(),
          repliedByUserId: user.id,
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });

      const io = (app as any).io as Server;
      io?.emit('chat:message', { accountId: conversation.zaloAccountId, message, conversationId: id });

      return message;
    } catch (err) {
      logger.error('[chat] Send message error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });

  // ── Send media message (image / video / file) ───────────────────────────
  app.post('/api/v1/conversations/:id/messages/media', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    // ── 1. Parse multipart stream ───────────────────────────────────────────
    const fields: Record<string, string> = {};
    const files: Array<{ filename: string; mimetype: string; data: Buffer }> = [];

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value ?? '');
        } else if (part.type === 'file') {
          // Consume the stream into a Buffer
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          if (chunks.length > 0) {
            files.push({
              filename: part.filename || `file_${randomUUID()}`,
              mimetype: part.mimetype || 'application/octet-stream',
              data: Buffer.concat(chunks),
            });
          }
        }
      }
    } catch (err) {
      logger.error('[chat] Media upload parse error:', err);
      return reply.status(400).send({ error: 'Failed to parse multipart data' });
    }

    if (files.length === 0) {
      return reply.status(400).send({ error: 'No files uploaded' });
    }

    const content = fields.content?.trim() || '';
    const replyMessageId = fields.replyMessageId || undefined;
    let mentions: any[] | undefined;
    if (fields.mentions) {
      try { mentions = JSON.parse(fields.mentions); } catch { /* ignore */ }
    }

    // ── 2. Resolve conversation ─────────────────────────────────────────────
    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: { zaloAccount: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const threadId = conversation.externalThreadId || '';
    const threadType: 0 | 1 = conversation.threadType === 'group' ? 1 : 0;

    // ── 3. Classify files & build attachments for zca-js ────────────────────
    const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo']);

    const preparedAttachments: Array<{
      filename: string;
      data: Buffer;
      metadata: { totalSize: number; width?: number; height?: number };
    }> = [];

    for (const file of files) {
      const isImage = IMAGE_MIMES.has(file.mimetype);
      let width: number | undefined;
      let height: number | undefined;

      if (isImage) {
        const dims = getImageDimensions(file.data);
        if (dims.width > 0 && dims.height > 0) {
          width = dims.width;
          height = dims.height;
        }
      }

      preparedAttachments.push({
        filename: file.filename,
        data: file.data,
        metadata: {
          totalSize: file.data.length,
          ...(isImage && width && height ? { width, height } : {}),
        },
      });
    }

    // ── 4. Send via Zalo SDK ────────────────────────────────────────────────
    try {
      const io = (app as any).io as Server;
      const sendResult = (await zaloOps.sendAttachments(
        conversation.zaloAccountId,
        threadId,
        threadType,
        preparedAttachments,
        io,
      )) as any;

      // Extract zaloMsgId from response (may be nested)
      const zaloMsgId = String(sendResult?.msgId || sendResult?.data?.msgId || '');

      // ── 5. Determine contentType for DB record ───────────────────────────
      // Use the first file's type as the primary contentType
      const firstMime = files[0].mimetype;
      let dbContentType = 'file';
      if (IMAGE_MIMES.has(firstMime)) dbContentType = 'image';
      else if (VIDEO_MIMES.has(firstMime)) dbContentType = 'video';

      // Build attachments JSON for frontend rendering
      // (Zalo SDK may or may not return URLs — store what we know)
      const attachmentsJson = files.map((f: any, i: any) => {
        const isImg = IMAGE_MIMES.has(f.mimetype);
        const isVid = VIDEO_MIMES.has(f.mimetype);
        return {
          type: isImg ? 'image' : isVid ? 'video' : 'file',
          filename: f.filename,
          mimetype: f.mimetype,
          size: f.data.length,
          // If the SDK returned URLs, map them; otherwise these will be populated
          // when the selfListen event echoes back with Zalo-hosted URLs.
          url: sendResult?.attachments?.[i]?.url || sendResult?.attachments?.[i]?.href || null,
          ...(isImg ? { width: preparedAttachments[i].metadata.width, height: preparedAttachments[i].metadata.height } : {}),
        };
      });

      // For image messages, store the URL as content so MessageBubble can render it
      const dbContent = dbContentType === 'image'
        ? JSON.stringify({ href: attachmentsJson[0]?.url || '', width: attachmentsJson[0]?.width, height: attachmentsJson[0]?.height })
        : content || files[0].filename;

      // ── 6. Persist to DB ─────────────────────────────────────────────────
      const message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          zaloMsgId: zaloMsgId || null,
          senderType: 'self',
          senderUid: conversation.zaloAccount.zaloUid || '',
          senderName: 'Staff',
          content: dbContent,
          contentType: dbContentType,
          attachments: attachmentsJson,
          mentions: mentions && mentions.length > 0 ? mentions : undefined,
          sentAt: new Date(),
          repliedByUserId: user.id,
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });

      io?.emit('chat:message', { accountId: conversation.zaloAccountId, message, conversationId: id });

      return message;
    } catch (err: any) {
      logger.error('[chat] Send media error:', err);
      const statusCode = err?.statusCode || 500;
      const errorMsg = err?.message || 'Failed to send media';
      return reply.status(statusCode).send({ error: errorMsg });
    }
  });

  // ── Mark conversation as read ────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/mark-read', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { unreadCount: 0 },
    });

    return { success: true };
  });

  // ── Move conversation to a different tab (main / other) ────────────────
  app.patch('/api/v1/conversations/:id/tab', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { tab } = request.body as { tab: string };

    if (!tab || !['main', 'other'].includes(tab)) {
      return reply.status(400).send({ error: 'tab must be "main" or "other"' });
    }

    const updated = await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { tab },
    });

    if (updated.count === 0) return reply.status(404).send({ error: 'Conversation not found' });
    return { success: true, tab };
  });

  // ── Get User Profile ─────────────────────────────────────────────────────
  app.get('/api/v1/contacts/:zaloUid/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { zaloUid } = request.params as { zaloUid: string };
    const { accountId } = request.query as { accountId?: string };

    try {
      const queries: any[] = [
        prisma.contact.findFirst({ where: { zaloUid, orgId: user.orgId } }),
        prisma.zaloAccount.findFirst({ where: { zaloUid, orgId: user.orgId } }),
      ];

      if (accountId) {
        queries.push(prisma.zaloFriend.findFirst({ where: { zaloAccountId: accountId, zaloUid } }));
        // user requested to query FriendRequest table if available.
        if ((prisma as any).friendRequest) {
          queries.push((prisma as any).friendRequest.findFirst({
            where: { 
              zaloAccountId: accountId,
              OR: [
                { targetZaloUid: zaloUid },
                { zaloUid: zaloUid }
              ]
            },
            orderBy: { createdAt: 'desc' }
          }).catch(() => null));
        } else {
          queries.push(Promise.resolve(null));
        }
      } else {
        queries.push(Promise.resolve(null), Promise.resolve(null));
      }

      const [contact, zaloAccount, friend, friendReq] = await Promise.all(queries);

      let friendshipStatus = 'none';
      if (friend) {
        friendshipStatus = 'friend';
      } else if (friendReq) {
        if (friendReq.direction === 'outbound' || friendReq.status === 'pending') {
          friendshipStatus = 'pending_sent';
        } else if (friendReq.direction === 'inbound') {
          friendshipStatus = 'pending_received';
        } else {
          friendshipStatus = 'pending_sent'; // fallback
        }
      }

      const isSelf = !!zaloAccount;

      // ── Fallback Tier ──
      const isNameMissing = !contact?.fullName || ['Unknown', 'Zalo User'].includes(contact.fullName);
      const isAvatarMissing = !contact?.avatarUrl;

      let msgFallbackName: string | null = null;
      let msgFallbackAvatar: string | null = null;

      if ((isNameMissing || isAvatarMissing) && !friend && !zaloAccount) {
        // Tier 1: Message table fallback
        const latestMsg = await prisma.message.findFirst({
          where: {
            senderUid: zaloUid,
            senderType: 'contact',
            senderName: { not: null },
          },
          orderBy: { sentAt: 'desc' },
          select: { senderName: true },
        });
        if (latestMsg?.senderName && latestMsg.senderName !== 'Unknown') {
          msgFallbackName = latestMsg.senderName;
        }

        // Tier 2: GroupMember table fallback
        if (isAvatarMissing || !msgFallbackName) {
          const groupMember = await prisma.groupMember.findFirst({
            where: {
              zaloUid,
              OR: [
                { avatar: { not: null } },
                { name: { not: null } }
              ]
            },
            select: { avatar: true, name: true },
          });
          if (isAvatarMissing && groupMember?.avatar) {
            msgFallbackAvatar = groupMember.avatar;
          }
          if (!msgFallbackName && groupMember?.name && groupMember.name !== 'Người dùng Zalo') {
            msgFallbackName = groupMember.name;
          }
        }

        // Tier 3: Real-time SDK with Timeout Guard
        if ((!msgFallbackName || !msgFallbackAvatar) && accountId) {
          try {
            const { zaloPool } = await import('../zalo/zalo-pool.js');
            const instance = zaloPool.getInstance(accountId);
            
            if (instance?.api?.getUserInfo) {
              const sdkCall = instance.api.getUserInfo(zaloUid);
              const timeoutCall = new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('SDK Timeout')), 800)
              );
              
              const result = await Promise.race([sdkCall, timeoutCall]) as any;
              
              const profiles = result?.changed_profiles || {};
              const sdkProfile = profiles[zaloUid] || profiles[`${zaloUid}_0`];
              
              if (sdkProfile) {
                if (!msgFallbackName) {
                  msgFallbackName = sdkProfile.zaloName || sdkProfile.displayName || null;
                }
                if (!msgFallbackAvatar) {
                  msgFallbackAvatar = sdkProfile.avatar || null;
                }

                // Sync to DB for next time
                if (msgFallbackName || msgFallbackAvatar) {
                  const { updateContactProfile } = await import('../zalo/zalo-message-helpers.js');
                  updateContactProfile(zaloUid, {
                    displayName: msgFallbackName || undefined,
                    avatarUrl: msgFallbackAvatar || undefined,
                  }).catch(err => logger.error('[chat] Background profile sync failed:', err));
                }
              }
            }
          } catch (err) {
            logger.warn(`[chat] Real-time getUserInfo fallback skipped for ${zaloUid}:`, err instanceof Error ? err.message : String(err));
          }
        }
      }

      const resolvedName = contact?.fullName && !['Unknown', 'Zalo User'].includes(contact.fullName)
        ? contact.fullName
        : friend?.displayName || msgFallbackName || zaloAccount?.displayName || contact?.fullName || 'Unknown';

      const resolvedAvatar = contact?.avatarUrl || friend?.avatarUrl || msgFallbackAvatar || zaloAccount?.avatarUrl || null;

      const isUnknownProfile = !resolvedName || ['Unknown', 'Zalo User'].includes(resolvedName);

      return {
        zaloUid,
        displayName: resolvedName,
        avatarUrl: resolvedAvatar,
        isUnknownProfile,
        phone: contact?.phone || friend?.phone || null,
        email: contact?.email || null,
        source: contact?.source || null,
        isFriend: !!friend,
        friendshipStatus,
        contactStatus: contact?.status || null,
        crmName: contact?.crmName || null,
        isSelf,
      };
    } catch (err: any) {
      logger.error('[chat] Get profile error:', err);
      return reply.status(500).send({ error: 'Failed to fetch user profile' });
    }
  });

  // ── Find or Create Private Conversation ──────────────────────────────────
  app.post('/api/v1/conversations/find-or-create-private', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { targetZaloUid, accountId } = request.body as { targetZaloUid: string; accountId: string };

    if (!targetZaloUid || !accountId) {
      return reply.status(400).send({ error: 'targetZaloUid and accountId are required' });
    }

    try {
      // Verify access to account
      if (user.role === 'member') {
         const access = await prisma.zaloAccountAccess.findFirst({
           where: { userId: user.id, zaloAccountId: accountId }
         });
         if (!access) return reply.status(403).send({ error: 'Forbidden' });
      } else {
         const acc = await prisma.zaloAccount.findFirst({
           where: { id: accountId, orgId: user.orgId }
         });
         if (!acc) return reply.status(404).send({ error: 'Zalo account not found' });
      }

      // 1. Search existing conversation
      const existing = await prisma.conversation.findFirst({
        where: {
          orgId: user.orgId,
          zaloAccountId: accountId,
          threadType: 'user',
          externalThreadId: targetZaloUid,
        }
      });

      if (existing) {
        return { conversationId: existing.id, created: false };
      }

      // 2. Not found, run transaction to upsert Contact and create Conversation
      const result = await prisma.$transaction(async (tx) => {
        let contact = await tx.contact.findFirst({
          where: { orgId: user.orgId, zaloUid: targetZaloUid }
        });

        if (!contact) {
          contact = await tx.contact.create({
            data: {
              orgId: user.orgId,
              zaloUid: targetZaloUid,
              fullName: 'Zalo User',
              status: 'new'
            }
          });
        }

        const newConv = await tx.conversation.create({
          data: {
            orgId: user.orgId,
            zaloAccountId: accountId,
            contactId: contact.id,
            threadType: 'user',
            externalThreadId: targetZaloUid,
            tab: 'main',
            unreadCount: 0,
            isReplied: true,
          }
        });

        return newConv;
      });

      return { conversationId: result.id, created: true };

    } catch (err: any) {
      // Handle Unique Constraint Violation (P2002) which implies race condition
      if (err.code === 'P2002') {
        const existing = await prisma.conversation.findFirst({
          where: {
            orgId: user.orgId,
            zaloAccountId: accountId,
            threadType: 'user',
            externalThreadId: targetZaloUid,
          }
        });
        if (existing) {
          return { conversationId: existing.id, created: false };
        }
      }
      
      logger.error('[chat] find-or-create-private error:', err);
      return reply.status(500).send({ error: 'Failed to find or create conversation' });
    }
  });
}
