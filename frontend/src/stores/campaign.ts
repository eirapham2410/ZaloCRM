import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import { campaignApi } from '@/api/campaign.api';
import type { CampaignStats, CampaignAccountStat } from '@/api/campaign.api';
import { useAuthStore } from '@/stores/auth';

export const useCampaignStore = defineStore('campaign', {
  state: () => ({
    currentCampaign: null as CampaignStats | null,
    loading: false,
    error: null as string | null,
    liveLogs: [] as Array<{ time: string; type: 'info' | 'success' | 'error' | 'warning'; message: string }>,
    socket: null as Socket | null,
    _initialSyncDone: false, // Guard against duplicate syncCampaign on first connect
  }),

  getters: {
    progressPercent: (state) => {
      if (!state.currentCampaign || state.currentCampaign.totalRecipients === 0) return 0;
      const totalProcessed = state.currentCampaign.sentCount + state.currentCampaign.failedCount;
      return Math.round((totalProcessed / state.currentCampaign.totalRecipients) * 100);
    },
    isCompleted: (state) => {
      return state.currentCampaign?.status === 'completed';
    },
    isPaused: (state) => {
      return state.currentCampaign?.status === 'paused';
    },
  },

  actions: {
    addLog(type: 'info' | 'success' | 'error' | 'warning', message: string) {
      this.liveLogs.push({
        time: new Date().toLocaleTimeString(),
        type,
        message,
      });
      // Keep only last 100 logs to prevent memory leak
      if (this.liveLogs.length > 100) {
        this.liveLogs.shift();
      }
    },

    async syncCampaign(campaignId: string) {
      this.loading = true;
      this.error = null;
      try {
        const res = await campaignApi.getCampaignStats(campaignId);
        this.currentCampaign = res.data.data;
      } catch (err: any) {
        this.error = err.response?.data?.message || 'Failed to fetch campaign stats';
        console.error('syncCampaign error:', err);
      } finally {
        this.loading = false;
      }
    },

    async updateStatus(status: 'running' | 'paused' | 'cancelled') {
      if (!this.currentCampaign) return;
      try {
        await campaignApi.updateCampaignStatus(this.currentCampaign.id, status);
        this.currentCampaign.status = status;
        this.addLog('info', `Campaign status changed to ${status}`);
      } catch (err: any) {
        console.error('updateStatus error:', err);
        throw err;
      }
    },

    initSocket(campaignId: string) {
      if (this.socket) {
        this.socket.disconnect();
      }

      // Reset the sync guard — a fresh socket connection hasn't synced yet
      this._initialSyncDone = false;

      const authStore = useAuthStore();
      const orgId = authStore.user?.orgId;

      this.socket = io({ transports: ['websocket', 'polling'] });

      // ── FIX C1: Join org room on connect so Worker events reach this client ──
      this.socket.on('connect', () => {
        // Join the organization room — required for receiving campaign:progress
        if (orgId) {
          this.socket?.emit('org:join', { orgId });
        }

        // On reconnect (not first connect), re-sync to catch missed events
        if (this._initialSyncDone) {
          this.addLog('info', 'Socket reconnected. Resyncing progress...');
          this.syncCampaign(campaignId);
        } else {
          this.addLog('info', 'Socket connected.');
          this._initialSyncDone = true;
        }
      });

      this.socket.on('disconnect', () => {
        this.addLog('warning', 'Socket disconnected. Trying to reconnect...');
      });

      // Lắng nghe tiến trình gửi
      this.socket.on('campaign:progress', (data: any) => {
        if (!this.currentCampaign || data.campaignId !== this.currentCampaign.id) return;

        // Cập nhật log
        if (data.status === 'sent') {
          this.addLog('success', `Sent to ${data.recipientId} via account ${data.usedAccountId || 'unknown'}`);
        } else if (data.status === 'failed') {
          this.addLog('error', `Failed to send to ${data.recipientId}`);
        } else if (data.status === 'delayed') {
          this.addLog('warning', `Đang nghỉ ngẫu nhiên trước khi gửi cho ${data.recipientId}...`);
        }

        // Cập nhật số tổng
        if (data.sentCount !== undefined) this.currentCampaign.sentCount = data.sentCount;
        if (data.failedCount !== undefined) this.currentCampaign.failedCount = data.failedCount;

        // Cập nhật account stats
        if (data.usedAccountId && this.currentCampaign.accountStats) {
          const accStat = this.currentCampaign.accountStats.find((s: CampaignAccountStat) => s.zaloAccountId === data.usedAccountId);
          if (accStat) {
            if (data.status === 'sent') accStat.sentCount++;
            if (data.status === 'failed') accStat.failedCount++;
          }
        }
      });

      // Lắng nghe các cảnh báo từ Worker (bị chặn, hết quota)
      this.socket.on('campaign:account_blocked', (data: any) => {
        if (!this.currentCampaign || data.campaignId !== this.currentCampaign.id) return;
        
        this.addLog('error', `Account ${data.accountId} blocked! Reason: ${data.reason}`);
        
        // Update account stat UI
        if (this.currentCampaign.accountStats) {
          const accStat = this.currentCampaign.accountStats.find((s: CampaignAccountStat) => s.zaloAccountId === data.accountId);
          if (accStat) accStat.status = 'blocked';
        }
      });

      this.socket.on('campaign:quota_reached', (data: any) => {
        if (!this.currentCampaign || data.campaignId !== this.currentCampaign.id) return;
        
        this.addLog('warning', `Account ${data.accountId} reached daily quota.`);
        
        // Update account stat UI
        if (this.currentCampaign.accountStats) {
          const accStat = this.currentCampaign.accountStats.find((s: CampaignAccountStat) => s.zaloAccountId === data.accountId);
          if (accStat) accStat.status = 'quota_reached';
        }
      });

      // Stranger quota exhausted — all accounts hit stranger daily limit
      this.socket.on('campaign:stranger_quota_hit', (data: any) => {
        if (!this.currentCampaign || data.campaignId !== this.currentCampaign.id) return;
        
        this.addLog('error', `⚠ Stranger quota hit! Limit: ${data.strangerLimit}/day. ${data.bulkPaused} stranger recipients paused.`);
        
        if (this.currentCampaign.accountStats) {
          const accStat = this.currentCampaign.accountStats.find((s: CampaignAccountStat) => s.zaloAccountId === data.accountId);
          if (accStat) accStat.status = 'quota_reached';
        }
      });
    },

    // ── FIX I1: Remove all listeners before disconnect to prevent memory leaks ──
    cleanup() {
      if (this.socket) {
        this.socket.off('connect');
        this.socket.off('disconnect');
        this.socket.off('campaign:progress');
        this.socket.off('campaign:account_blocked');
        this.socket.off('campaign:quota_reached');
        this.socket.off('campaign:stranger_quota_hit');
        this.socket.disconnect();
        this.socket = null;
      }
      this.currentCampaign = null;
      this.liveLogs = [];
      this._initialSyncDone = false;
    },
  },
});

