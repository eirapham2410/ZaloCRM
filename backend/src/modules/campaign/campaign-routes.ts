/**
 * campaign-routes.ts — Fastify routes for Zalo Bulk Messaging (Campaigns).
 *
 * Exposes endpoints to:
 *   - Create a new campaign & enqueue jobs
 *   - Pause/Resume a running campaign
 *   - Get real-time campaign stats
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { getCampaignQueue, getDelayForRecipientType } from './campaign-queue.js';
import { logger } from '../../shared/utils/logger.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import type { CampaignJobData } from './campaign-queue.js';

interface RecipientInput {
  contactId?: string;
  phone?: string;
  zaloUid?: string;
  name?: string;
  recipientType?: 'stranger' | 'friend' | 'thread_exist';
}

interface CreateCampaignBody {
  name: string;
  templateId: string;
  accountIds: string[];
  activeHours?: { start: string; end: string };
  delayConfig?: { min: number; max: number };
  recipients: RecipientInput[];
}

interface UpdateCampaignStatusBody {
  status: 'running' | 'paused' | 'cancelled';
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /v1/campaigns
   * Create a new campaign and enqueue all recipients as BullMQ jobs.
   */
  app.post<{ Body: CreateCampaignBody }>('/v1/campaigns', { preHandler: authMiddleware }, async (request, reply) => {
    const user = request.user as { orgId: string };
    const orgId = user.orgId;
    const body = request.body;

    // 1. Verify template exists
    const template = await prisma.messageTemplate.findUnique({
      where: { id: body.templateId, orgId }
    });

    if (!template) {
      return reply.code(404).send({ success: false, message: 'Message template not found' });
    }

    // 2. Filter out Blacklisted users preemptively to save DB rows
    const blacklist = await prisma.blacklist.findMany({
      where: { orgId }
    });

    const blacklistedPhones = new Set(blacklist.map(b => b.phone).filter(Boolean));
    const blacklistedUids = new Set(blacklist.map(b => b.zaloUid).filter(Boolean));

    const validRecipients = body.recipients.filter(r => {
      if (r.phone && blacklistedPhones.has(r.phone)) return false;
      if (r.zaloUid && blacklistedUids.has(r.zaloUid)) return false;
      return true;
    });

    if (validRecipients.length === 0) {
      return reply.code(400).send({ success: false, message: 'All recipients are blacklisted' });
    }

    // 3. Create Campaign and related DB records within a transaction
    const activeHours = body.activeHours || { start: '08:00', end: '20:00' };
    const delayConfig = {
      min: Math.max(1, Math.floor(body.delayConfig?.min ?? 5)),
      max: Math.max(1, Math.floor(body.delayConfig?.max ?? 15)),
    };
    // Ensure max >= min
    if (delayConfig.max < delayConfig.min) delayConfig.max = delayConfig.min;

    const campaign = await prisma.$transaction(async (tx) => {
      // Create campaign
      const camp = await tx.campaign.create({
        data: {
          orgId,
          name: body.name,
          templateId: body.templateId,
          accountIds: body.accountIds,
          totalRecipients: validRecipients.length,
          status: 'running',
          activeHours,
          config: { delay_min: delayConfig.min, delay_max: delayConfig.max },
          startedAt: new Date(),
        }
      });

      // Create recipients
      await tx.campaignRecipient.createMany({
        data: validRecipients.map(r => ({
          campaignId: camp.id,
          contactId: r.contactId,
          phone: r.phone,
          zaloUid: r.zaloUid,
          name: r.name,
          recipientType: r.recipientType || 'stranger',
          status: 'pending',
        }))
      });

      // Initialize account stats
      await tx.campaignAccountStat.createMany({
        data: body.accountIds.map((accId: string) => ({
          campaignId: camp.id,
          zaloAccountId: accId,
          status: 'active',
        }))
      });

      return camp;
    });

    // 4. Enqueue Jobs into BullMQ
    // We fetch the newly created recipients to get their DB IDs
    const dbRecipients = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, phone: true, zaloUid: true, name: true, recipientType: true }
    });

    const queue = getCampaignQueue();
    let currentDelay = 0; // Stagger jobs to prevent spiking

    // Use the user-configured delay range for job staggering
    const randomDelay = () => Math.floor(Math.random() * (delayConfig.max - delayConfig.min + 1) + delayConfig.min) * 1000;

    const jobs = dbRecipients.map(r => {
      const perMsgDelay = randomDelay();
      const jobDelay = currentDelay;
      currentDelay += perMsgDelay;

      const jobData: CampaignJobData = {
        campaignId: campaign.id,
        recipientId: r.id,
        orgId,
        templateContent: template.content,
        templateAttachments: template.attachments as unknown[],
        contactData: {
          name: r.name,
          phone: r.phone,
          zaloUid: r.zaloUid,
        },
        recipientType: (r.recipientType || 'stranger') as 'stranger' | 'friend' | 'thread_exist',
        accountIds: body.accountIds,
        activeHours,
        delayConfig,
      };

      return {
        name: `campaign:${campaign.id}:recipient:${r.id}`,
        data: jobData,
        opts: {
          delay: jobDelay,
          jobId: `camp_${campaign.id}_rec_${r.id}` // Ensure uniqueness
        }
      };
    });

    // Add in bulk
    await queue.addBulk(jobs);
    logger.info(`[campaign-routes] Enqueued ${jobs.length} jobs for campaign ${campaign.id}`);

    return reply.code(200).send({
      success: true,
      campaignId: campaign.id,
      message: `Campaign started successfully with ${jobs.length} recipients`
    });
  });

  /**
   * PATCH /v1/campaigns/:id/status
   * Pause or Resume a campaign.
   */
  app.patch<{ Params: { id: string }; Body: UpdateCampaignStatusBody }>(
    '/v1/campaigns/:id/status',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const user = request.user as { orgId: string };
      const orgId = user.orgId;
      const { id } = request.params;
      const { status } = request.body;

      const campaign = await prisma.campaign.findUnique({
        where: { id, orgId }
      });

      if (!campaign) {
        return reply.code(404).send({ success: false, message: 'Campaign not found' });
      }

      if (campaign.status === 'completed') {
        return reply.code(400).send({ success: false, message: 'Cannot modify a completed campaign' });
      }

      await prisma.campaign.update({
        where: { id },
        data: { status }
      });

      if (status === 'paused' || status === 'cancelled') {
        // BullMQ's worker checks `campaign.status` before processing and will skip.
        logger.info(`[campaign-routes] Campaign ${id} ${status}. Worker will skip remaining jobs.`);
      }

      return reply.code(200).send({
        success: true,
        status,
        message: `Campaign status updated to ${status}`
      });
    }
  );

  /**
   * GET /v1/campaigns/:id/stats
   * Real-time campaign statistics.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/campaigns/:id/stats',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const user = request.user as { orgId: string };
      const orgId = user.orgId;
      const { id } = request.params;

      const campaign = await prisma.campaign.findUnique({
        where: { id, orgId },
        include: {
          accountStats: {
            select: {
              zaloAccountId: true,
              sentCount: true,
              failedCount: true,
              status: true,
              zaloAccount: {
                select: {
                  displayName: true,
                  phone: true,
                }
              }
            }
          }
        }
      });

      if (!campaign) {
        return reply.code(404).send({ success: false, message: 'Campaign not found' });
      }

      return reply.code(200).send({
        success: true,
        data: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          totalRecipients: campaign.totalRecipients,
          sentCount: campaign.sentCount,
          failedCount: campaign.failedCount,
          startedAt: campaign.startedAt,
          completedAt: campaign.completedAt,
          accountStats: campaign.accountStats
        }
      });
    }
  );

  /**
   * GET /v1/campaigns
   * List all campaigns for the current org with computed progress stats.
   */
  app.get('/v1/campaigns', { preHandler: authMiddleware }, async (request, reply) => {
    const user = request.user as { orgId: string };
    const orgId = user.orgId;

    const campaigns = await prisma.campaign.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      include: {
        template: { select: { name: true } },
        accountStats: {
          select: {
            zaloAccountId: true,
            zaloAccount: { select: { displayName: true } },
          }
        }
      }
    });

    const data = campaigns.map(c => {
      const progress = c.totalRecipients > 0
        ? Math.round(((c.sentCount + c.failedCount) / c.totalRecipients) * 100)
        : 0;
      const successRate = c.totalRecipients > 0
        ? Math.round((c.sentCount / c.totalRecipients) * 100)
        : 0;
      const accountNames = c.accountStats
        .map(a => a.zaloAccount?.displayName || a.zaloAccountId.slice(0, 8))
        .join(', ');

      return {
        id: c.id,
        name: c.name,
        templateName: c.template?.name || '—',
        status: c.status,
        totalRecipients: c.totalRecipients,
        sentCount: c.sentCount,
        failedCount: c.failedCount,
        progress,
        successRate,
        accountNames,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        createdAt: c.createdAt,
      };
    });

    // Aggregate summary stats
    const totalSent = campaigns.reduce((sum, c) => sum + c.sentCount, 0);
    const runningCount = campaigns.filter(c => c.status === 'running').length;
    const completedCampaigns = campaigns.filter(c => c.status === 'completed');
    const overallSuccessRate = completedCampaigns.length > 0
      ? Math.round(
          completedCampaigns.reduce((sum, c) =>
            sum + (c.totalRecipients > 0 ? (c.sentCount / c.totalRecipients) * 100 : 0), 0
          ) / completedCampaigns.length
        )
      : 0;

    return reply.code(200).send({
      success: true,
      data,
      summary: {
        totalSent,
        runningCount,
        overallSuccessRate,
      }
    });
  });

  /**
   * POST /v1/campaigns/:id/clone
   * Clone an existing campaign's configuration into a new draft (without starting it).
   * Returns the templateId so the frontend can redirect to /campaigns/builder.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/campaigns/:id/clone',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const user = request.user as { orgId: string };
      const orgId = user.orgId;
      const { id } = request.params;

      const original = await prisma.campaign.findUnique({
        where: { id, orgId },
        select: {
          name: true,
          templateId: true,
          accountIds: true,
          activeHours: true,
        }
      });

      if (!original) {
        return reply.code(404).send({ success: false, message: 'Campaign not found' });
      }

      return reply.code(200).send({
        success: true,
        data: {
          name: `${original.name} (Bản sao)`,
          templateId: original.templateId,
          accountIds: original.accountIds,
          activeHours: original.activeHours,
        }
      });
    }
  );
}
