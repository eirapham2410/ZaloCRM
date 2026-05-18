import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { validateProxyUrl, createProxyAgent } from '../../shared/utils/proxy-parser.js';
import https from 'https';

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
      const proxyRegex = /(?:http|https|socks4|socks5|socks):\/\/[^\s]+/g;
      const urlMatches = text.match(proxyRegex) || [];

      // Regex to extract raw IP:Port or IP:Port:User:Pass
      const rawRegex = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}(?::[^\s:]+:[^\s:]+)?\b/g;
      const rawMatches = text.match(rawRegex) || [];

      const parsedUrls = new Set<string>([...urlMatches]);

      for (const raw of rawMatches) {
        // If it's already part of a matched URL, skip it
        if (urlMatches.some(url => url.includes(raw))) continue;

        const parts = raw.split(':');
        if (parts.length === 2) {
          parsedUrls.add(`http://${parts[0]}:${parts[1]}`);
        } else if (parts.length === 4) {
          // IP:Port:User:Pass -> protocol://User:Pass@IP:Port
          parsedUrls.add(`http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`);
        }
      }

      const matches = Array.from(parsedUrls);

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
        
        const originIp = await new Promise<string>((resolve, reject) => {
          const req = https.get('https://httpbin.org/ip', { agent, timeout: 10_000 }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed.origin || '');
              } catch (e) {
                reject(e);
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout (>10s)')); });
        });

        await prisma.proxy.update({
          where: { id },
          data: { status: 'active', lastCheckedAt: new Date() },
        });

        return { success: true, ip: originIp, message: 'Kết nối proxy thành công!' };
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
