import { api } from './index';

export interface CampaignRecipientPayload {
  contactId?: string;
  phone?: string;
  zaloUid?: string;
  name?: string;
  recipientType?: 'stranger' | 'friend' | 'thread_exist' | 'group_member' | 'group';
  metadata?: Record<string, any>;
}

export interface CreateCampaignPayload {
  name: string;
  templateId?: string; // made optional for ADD_FRIEND
  campaignType?: 'BULK_MESSAGE' | 'ADD_FRIEND';
  inviteMessage?: string;
  useRotation?: boolean;
  accountIds: string[];
  activeHours: { start: string; end: string };
  delayConfig?: { min: number; max: number };
  recipients: CampaignRecipientPayload[];
}

export interface CampaignAccountStat {
  zaloAccountId: string;
  sentCount: number;
  failedCount: number;
  status: 'active' | 'quota_reached' | 'blocked' | 'error';
  zaloAccount?: {
    displayName: string | null;
    phone: string | null;
  };
}

export interface CampaignStats {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  startedAt: string | null;
  completedAt: string | null;
  accountStats: CampaignAccountStat[];
}

export interface CampaignListItem {
  id: string;
  name: string;
  templateName: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  progress: number;
  successRate: number;
  accountNames: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  content: string;
  attachments?: TemplateAttachment[];
  category?: string;
  createdAt: string;
}

export interface TemplateAttachment {
  type: 'image' | 'file';
  url: string;
  fileName?: string;
  fileSize?: number;
}

export interface TemplateDetail {
  id: string;
  name: string;
  content: string;
  attachments: TemplateAttachment[];
  category?: string;
}

export interface CampaignAnalysis {
  totalRecipients: number;
  friendCount: number;
  strangerCount: number;
  groupCount: number;
  noUidCount: number;
  strangerLimitPerAccount: number;
  totalStrangerQuotaPerDay: number;
  daysNeeded: number;
  exceedsQuota: boolean;
  estimatedTime: string;
}

export const campaignApi = {
  /** Pre-flight analysis: friend/stranger breakdown + time estimate */
  analyzeCampaign(payload: {
    accountIds: string[];
    recipients: Array<{ zaloUid?: string; phone?: string; recipientType?: string }>;
    delayConfig?: { min: number; max: number };
    campaignType?: 'BULK_MESSAGE' | 'ADD_FRIEND';
  }) {
    return api.post<{ success: boolean; data: CampaignAnalysis }>('/campaigns/analyze', payload);
  },

  createCampaign(payload: CreateCampaignPayload) {
    return api.post<{ success: boolean; campaignId: string; message: string }>('/campaigns', payload);
  },

  updateCampaignStatus(id: string, status: 'running' | 'paused' | 'cancelled') {
    return api.patch<{ success: boolean; status: string; message: string }>(`/campaigns/${id}/status`, { status });
  },

  getCampaignStats(id: string) {
    return api.get<{ success: boolean; data: CampaignStats }>(`/campaigns/${id}/stats`);
  },

  listCampaigns() {
    return api.get<{
      success: boolean;
      data: CampaignListItem[];
      summary: { totalSent: number; runningCount: number; overallSuccessRate: number };
    }>('/campaigns');
  },

  cloneCampaign(id: string) {
    return api.post<{
      success: boolean;
      data: { name: string; templateId: string; accountIds: string[]; activeHours: any };
    }>(`/campaigns/${id}/clone`);
  },

  /** Get all templates — optionally filter by category */
  getTemplates(category?: string) {
    const params = category ? { category } : {};
    return api.get<{ templates: TemplateItem[] }>('/automation/templates', { params });
  },

  /** Get marketing templates only */
  getMarketingTemplates() {
    return api.get<{ templates: TemplateItem[] }>('/automation/templates', { params: { category: 'marketing' } });
  },

  /** Get a single template by ID (with full attachments) */
  getTemplateById(id: string) {
    return api.get<TemplateDetail>(`/automation/templates/${id}`);
  },

  deleteTemplate(id: string) {
    return api.delete(`/automation/templates/${id}`);
  },
};
