/**
 * group-routes.ts — Group info, CRUD, and membership management.
 * Routes: /api/v1/zalo-accounts/:accountId/groups
 *
 * GET  .../groups          → read from local DB (ZaloGroup table) with pagination & search
 * POST .../groups/sync     → pull from Zalo SDK → chunked upsert into DB
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { resolveAccount, checkAccess, handleError } from './zalo-route-helpers.js';
import { syncGroupsFromZalo } from './group.service.js';

export async function groupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  const BASE = '/api/v1/zalo-accounts/:accountId/groups';

  // ── Cross-Account Group Deduplication ─────────────────────────────────────

  app.post('/api/v1/zalo-groups/deduplicate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountIds } = request.body as { accountIds?: string[] };
    
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return { data: [] };
    }

    try {
      const user = request.user!;
      
      const groups = await prisma.zaloGroup.findMany({
        where: {
          zaloAccountId: { in: accountIds },
          zaloAccount: { orgId: user.orgId } // Ensure security
        },
        orderBy: {
          syncedAt: 'desc' // Prioritize most recent data
        }
      });

      const map = new Map<string, any>();
      
      for (const g of groups) {
        const key = g.fingerprint || g.zaloGroupId;
        
        if (!map.has(key)) {
          map.set(key, {
            fingerprint: key,
            name: g.name,
            avatar: g.avatar,
            memberCount: g.memberCount,
            accounts: []
          });
        }
        
        map.get(key).accounts.push({
          accountId: g.zaloAccountId,
          groupId: g.zaloGroupId
        });
      }
      
      return { data: Array.from(map.values()) };
    } catch (err) {
      return handleError(reply, err, 'deduplicate-groups');
    }
  });

  // ── Group List (from DB) ──────────────────────────────────────────────────

  app.get(BASE, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const { page = '1', limit = '50', search = '' } = request.query as {
      page?: string; limit?: string; search?: string;
    };
    const user = request.user!;

    try {
      await resolveAccount(accountId, user.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (pageNum - 1) * limitNum;

      const where: any = { zaloAccountId: accountId };
      if (search.trim()) {
        where.name = { contains: search.trim(), mode: 'insensitive' };
      }

      const [data, total] = await Promise.all([
        prisma.zaloGroup.findMany({
          where,
          orderBy: { name: 'asc' },
          skip,
          take: limitNum,
        }),
        prisma.zaloGroup.count({ where }),
      ]);

      return {
        data,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      };
    } catch (err) {
      return handleError(reply, err, 'group-list');
    }
  });

  // ── Sync Groups from Zalo SDK ─────────────────────────────────────────────

  app.post(`${BASE}/sync`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const user = request.user!;

    try {
      await resolveAccount(accountId, user.orgId);
      if (!(await checkAccess(request, reply, accountId, 'chat'))) return;

      const result = await syncGroupsFromZalo(accountId);

      return {
        success: true,
        ...result,
      };
    } catch (err) {
      logger.error(`[group-sync] account=${accountId} — Lỗi đồng bộ:`, err);
      return handleError(reply, err, 'group-sync');
    }
  });

  app.get<{ Params: { accountId: string; groupId: string } }>(`${BASE}/:groupId`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;
      return { group: await zaloOps.getGroupInfo(accountId, groupId) };
    } catch (err) { return handleError(reply, err, 'getGroupInfo'); }
  });

  app.get<{ Params: { accountId: string; groupId: string } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    console.log('[member-debug] Fetching members for Group:', groupId, 'Account:', accountId);
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;

      const rawResult = await zaloOps.getGroupMembersInfo(accountId, groupId);
      console.log('[member-debug] Raw SDK result type:', typeof rawResult, '| isArray:', Array.isArray(rawResult));

      // ── Flatten: SDK may return { data: [...] } or [...] directly ──────
      const rawResultAny: any = rawResult;
      const rawArray = Array.isArray(rawResultAny)
        ? rawResultAny
        : (Array.isArray(rawResultAny?.data) ? rawResultAny.data : []);

      // ── Normalize: ensure consistent field names for Frontend ──────────
      const ROLE_MAP: Record<string, string> = { '-1': 'creator', '0': 'member', '1': 'admin', '2': 'creator' };

      const members = rawArray.map((m: any) => ({
        id:          String(m.id || m.uid || m.zaloUid || m.userId || ''),
        displayName: m.displayName || m.dName || m.name || m.zaloName || 'Không tên',
        avatar:      m.avatar || m.avt || m.thumbAvatar || null,
        role:        ROLE_MAP[String(m.role)] || (typeof m.role === 'string' ? m.role.toLowerCase() : 'member'),
      }));

      console.log('[member-debug] Normalized members count:', members.length);
      return { members };
    } catch (err) { return handleError(reply, err, 'getGroupMembersInfo'); }
  });

  app.get<{ Params: { accountId: string; groupId: string } }>(`${BASE}/:groupId/debug`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      
      const rawRes = await zaloOps.exec({ accountId, category: 'group_read', operation: 'getGroupInfo' }, async (api) => {
         return await api.getGroupInfo(groupId);
      });
      
      const groupInfo = (rawRes as any)?.gridInfoMap?.[groupId] || (rawRes as any)?.data?.gridInfoMap?.[groupId] || (rawRes as any)?.[groupId];
      
      const keys = groupInfo ? Object.keys(groupInfo) : [];
      let potentialMembers: any = {};
      
      if (groupInfo) {
        const memberIdsKeys = keys.filter(k => k.toLowerCase().includes('member') || k.toLowerCase().includes('uid') || k.toLowerCase().includes('list'));
        for (const k of memberIdsKeys) {
           potentialMembers[k] = {
             type: typeof groupInfo[k],
             isArray: Array.isArray(groupInfo[k]),
             length: Array.isArray(groupInfo[k]) ? groupInfo[k].length : 'N/A'
           };
        }
      }
      
      return { 
        rawResKeys: Object.keys(rawRes || {}),
        groupInfoKeys: keys,
        potentialMembers,
        groupInfoDump: groupInfo
      };
    } catch (err) { return handleError(reply, err, 'getGroupInfo Debug'); }
  });

  // ── Group CRUD ──────────────────────────────────────────────────────────────

  app.post<{ Params: { accountId: string }; Body: { name: string; memberIds: string[] } }>(BASE, async (request, reply) => {
    const { accountId } = request.params;
    const { name, memberIds } = request.body ?? {};
    if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
      return reply.status(400).send({ error: 'name and memberIds are required' });
    }
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return reply.status(201).send({ group: await zaloOps.createGroup(accountId, { name, memberIds }) });
    } catch (err) { return handleError(reply, err, 'createGroup'); }
  });

  app.patch<{ Params: { accountId: string; groupId: string }; Body: { name: string } }>(`${BASE}/:groupId/name`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { name } = request.body ?? {};
    if (!name) return reply.status(400).send({ error: 'name is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.renameGroup(accountId, name, groupId) };
    } catch (err) { return handleError(reply, err, 'renameGroup'); }
  });

  app.patch<{ Params: { accountId: string; groupId: string }; Body: Record<string, unknown> }>(`${BASE}/:groupId/settings`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.updateGroupSettings(accountId, request.body ?? {}, groupId) };
    } catch (err) { return handleError(reply, err, 'updateGroupSettings'); }
  });

  // ── Membership ──────────────────────────────────────────────────────────────

  app.post<{ Params: { accountId: string; groupId: string }; Body: { userIds: string[] } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userIds } = request.body ?? {};
    if (!Array.isArray(userIds) || userIds.length === 0) return reply.status(400).send({ error: 'userIds array is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.addUserToGroup(accountId, userIds, groupId) };
    } catch (err) { return handleError(reply, err, 'addUserToGroup'); }
  });

  app.delete<{ Params: { accountId: string; groupId: string }; Body: { userIds: string[] } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userIds } = request.body ?? {};
    if (!Array.isArray(userIds) || userIds.length === 0) return reply.status(400).send({ error: 'userIds array is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.removeUserFromGroup(accountId, userIds, groupId) };
    } catch (err) { return handleError(reply, err, 'removeUserFromGroup'); }
  });

  app.post<{ Params: { accountId: string; groupId: string }; Body: { userId: string } }>(`${BASE}/:groupId/deputies`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userId } = request.body ?? {};
    if (!userId) return reply.status(400).send({ error: 'userId is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.addGroupDeputy(accountId, userId, groupId) };
    } catch (err) { return handleError(reply, err, 'addGroupDeputy'); }
  });

  app.delete<{ Params: { accountId: string; groupId: string; userId: string } }>(`${BASE}/:groupId/deputies/:userId`, async (request, reply) => {
    const { accountId, groupId, userId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.removeGroupDeputy(accountId, userId, groupId) };
    } catch (err) { return handleError(reply, err, 'removeGroupDeputy'); }
  });

  app.post<{ Params: { accountId: string; groupId: string }; Body: { newOwnerId: string } }>(`${BASE}/:groupId/transfer`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { newOwnerId } = request.body ?? {};
    if (!newOwnerId) return reply.status(400).send({ error: 'newOwnerId is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.changeGroupOwner(accountId, newOwnerId, groupId) };
    } catch (err) { return handleError(reply, err, 'changeGroupOwner'); }
  });
}
