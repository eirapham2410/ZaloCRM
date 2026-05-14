import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { validateProxyUrl, createProxyAgent } from '../../shared/utils/proxy-parser.js';

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/proxies — list all proxies for the org
  app.get('/api/v1/proxies', async (request, reply) => {
    const user = request.user!;
    const proxies = await prisma.proxy.findMany({
      where: { orgId: user.orgId },
      include: {
        _count: {
          select: { zaloAccounts: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return proxies;
  });

  // POST /api/v1/proxies/bulk — bulk import proxies from text block
  app.post<{ Body: { text: string } }>(
    '/api/v1/proxies/bulk',
    async (request, reply) => {
      const user = request.user!;
      const { text } = request.body ?? {};
      if (!text) {
        return reply.status(400).send({ error: 'Text input is required' });
      }

      // Regex to extract URLs (http/https/socks4/socks5)
      // Matches basic structure: protocol://[user:pass@]ip:port
      const proxyRegex = /(?:http|https|socks4|socks5|socks):\/\/[^\s]+/g;
      const matches = text.match(proxyRegex) || [];

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const url of matches) {
        const check = validateProxyUrl(url);
        if (!check.valid) {
          skipped++;
          errors.push(`${url}: ${check.reason}`);
          continue;
        }

        try {
          await prisma.proxy.upsert({
            where: {
              orgId_url: { orgId: user.orgId, url: url.trim() },
            },
            update: {}, // Do nothing if it already exists
            create: {
              orgId: user.orgId,
              url: url.trim(),
              status: 'active',
            },
          });
          imported++;
        } catch (err) {
          skipped++;
        }
      }

      return { imported, skipped, errors };
    },
  );

  // DELETE /api/v1/proxies/:id
  app.delete<{ Params: { id: string } }>(
    '/api/v1/proxies/:id',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const proxy = await prisma.proxy.findFirst({
        where: { id, orgId: user.orgId },
      });

      if (!proxy) {
        return reply.status(404).send({ error: 'Proxy not found' });
      }

      await prisma.proxy.delete({ where: { id } });
      return reply.status(204).send();
    },
  );

  // POST /api/v1/proxies/:id/test — test a specific proxy from the pool
  app.post<{ Params: { id: string } }>(
    '/api/v1/proxies/:id/test',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const proxy = await prisma.proxy.findFirst({
        where: { id, orgId: user.orgId },
      });

      if (!proxy) {
        return reply.status(404).send({ error: 'Proxy not found' });
      }

      try {
        const agent = await createProxyAgent(proxy.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch('https://httpbin.org/ip', {
          signal: controller.signal,
          // @ts-ignore
          agent,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          await prisma.proxy.update({
            where: { id },
            data: { status: 'dead', lastCheckedAt: new Date() },
          });
          return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const data = await response.json() as { origin?: string };
        await prisma.proxy.update({
          where: { id },
          data: { status: 'active', lastCheckedAt: new Date() },
        });

        return { success: true, ip: data.origin, message: 'Kết nối proxy thành công!' };
      } catch (err: any) {
        const msg = err.name === 'AbortError' ? 'Timeout (>10s)' : String(err.message || err);
        await prisma.proxy.update({
          where: { id },
          data: { status: 'dead', lastCheckedAt: new Date() },
        });
        return { success: false, error: msg };
      }
    },
  );
}
