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
import { buildZaloQuote } from '../../shared/zalo-operations.js';
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
      const accessibleIds = accessibleAccounts.map((a) => a.zaloAccountId);
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
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
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
      const accessibleIds = accessibleAccounts.map((a) => a.zaloAccountId);
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
      conversations: conversations.map((conversation) => ({ ...conversation, isPinned: conversation.pins.length > 0 })),
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
      select: { id: true },
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

    // Resolve reactorId → reactorName for all reactions in the batch
    const allReactorIds = new Set<string>();
    for (const msg of rawMessages) {
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
      const unresolvedIds = ids.filter(id => !reactorNameMap.has(id));
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

    const messages = rawMessages.map(msg => ({
      ...msg,
      reactions: msg.reactions.map(r => ({
        ...r,
        reactorName: reactorNameMap.get(r.reactorId) || 'Người dùng Zalo',
      })),
    }));

    return { messages: messages.reverse(), total, page: parseInt(page), limit: parseInt(limit) };
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
    const { content, replyMessageId } = request.body as { content: string; replyMessageId?: string };

    if (!content?.trim()) return reply.status(400).send({ error: 'Content required' });

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
      const sendResult = await instance.api.sendMessage(quote ? { msg: content, quote } : { msg: content }, threadId, threadType);
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
}
