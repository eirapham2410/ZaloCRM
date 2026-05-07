import { api } from './index';

export interface CampaignRecipientPayload {
  contactId?: string;
  phone?: string;
  zaloUid?: string;
  name?: string;
  recipientType?: 'stranger' | 'friend' | 'thread_exist';
}

export interface CreateCampaignPayload {
  name: string;
  templateId: string;
  accountIds: string[];
  activeHours: { start: string; end: string };
  recipients: CampaignRecipientPayload[];
}

export interface CampaignAccountStat {
  zaloAccountId: string;
  sentCount: number;
  failedCount: number;
  status: 'active' | 'quota_reached' | 'blocked' | 'error';
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

export const campaignApi = {
  createCampaign(payload: CreateCampaignPayload) {
    return api.post<{ success: boolean; campaignId: string; message: string }>('/campaigns', payload);
  },

  updateCampaignStatus(id: string, status: 'running' | 'paused' | 'cancelled') {
    return api.patch<{ success: boolean; status: string; message: string }>(`/campaigns/${id}/status`, { status });
  },

  getCampaignStats(id: string) {
    return api.get<{ success: boolean; data: CampaignStats }>(`/campaigns/${id}/stats`);
  },
};
