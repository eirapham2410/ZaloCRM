<template>
  <div>
    <!-- Loading state -->
    <div v-if="loading && !campaign" class="d-flex align-center justify-center" style="min-height: 400px;">
      <v-progress-circular indeterminate color="primary" size="64"></v-progress-circular>
    </div>

    <!-- Error state -->
    <v-alert v-else-if="error" type="error" variant="tonal" class="mt-4">{{ error }}</v-alert>

    <!-- Campaign content -->
    <template v-if="campaign">
      <!-- HEADER & PROGRESS -->
      <v-card class="elevation-2 rounded-xl mb-4">
        <v-card-title class="pa-6 d-flex justify-space-between align-start">
          <div>
            <div class="text-h5 font-weight-bold d-flex align-center">
              <v-icon icon="mdi-rocket-launch" color="primary" class="mr-3"></v-icon>
              {{ campaign.name }}
              <v-chip :color="statusColor" size="small" class="ml-4 font-weight-medium text-uppercase">
                {{ campaign.status }}
              </v-chip>
            </div>
            <div class="text-body-2 text-medium-emphasis mt-1 ml-10">
              Bắt đầu: {{ new Date(campaign.startedAt || '').toLocaleString('vi-VN') }}
            </div>
          </div>

          <div class="d-flex align-center">
            <v-btn
              v-if="campaign.status === 'paused' || campaign.status === 'draft'"
              color="success"
              variant="flat"
              prepend-icon="mdi-play"
              @click="updateStatus('running')"
            >
              Tiếp tục
            </v-btn>
            <v-btn
              v-if="campaign.status === 'running'"
              color="warning"
              variant="flat"
              prepend-icon="mdi-pause"
              @click="updateStatus('paused')"
            >
              Tạm dừng
            </v-btn>
            <v-btn
              v-if="['running', 'paused'].includes(campaign.status)"
              color="error"
              variant="tonal"
              prepend-icon="mdi-stop"
              class="ml-3"
              @click="updateStatus('cancelled')"
            >
              Hủy bỏ
            </v-btn>
          </div>
        </v-card-title>

        <v-card-text class="px-6 pb-6 pt-0">
          <!-- Quota Reached Warning -->
          <v-alert
            v-if="hasQuotaReachedAccounts && campaign.status === 'paused'"
            type="error"
            variant="tonal"
            class="mb-4"
            icon="mdi-alert-octagon"
          >
            <div class="d-flex justify-space-between align-center">
              <div>
                <strong>Chiến dịch bị tạm dừng!</strong> Một số tài khoản đã đạt giới hạn gửi 200 tin/ngày.
              </div>
              <v-btn color="error" variant="flat" size="small" @click="updateStatus('running')">
                Tiếp tục gửi bằng tài khoản khác
              </v-btn>
            </div>
          </v-alert>

          <div class="d-flex justify-space-between text-body-2 mb-2 font-weight-medium">
            <span>Tiến độ gửi tin: {{ campaign.sentCount }} / {{ campaign.totalRecipients }}</span>
            <span :class="{'text-error': campaign.failedCount > 0}">Lỗi: {{ campaign.failedCount }}</span>
          </div>
          <v-progress-linear
            :model-value="store.progressPercent"
            color="primary"
            height="20"
            rounded
            striped
            :active="campaign.status === 'running'"
          >
            <template v-slot:default>
              <strong>{{ store.progressPercent }}%</strong>
            </template>
          </v-progress-linear>
        </v-card-text>
      </v-card>

      <!-- ACCOUNT STATS & LOGS -->
      <v-row>
        <v-col cols="12" md="6">
          <v-card class="elevation-2 rounded-xl h-100">
            <v-card-title class="pa-4 border-b">
              <v-icon icon="mdi-account-group" class="mr-2"></v-icon>
              Trạng thái Tài khoản Zalo
            </v-card-title>
            <v-list lines="two" class="bg-transparent pa-0">
              <v-list-item
                v-for="acc in campaign.accountStats"
                :key="acc.zaloAccountId"
                class="border-b"
              >
                <template v-slot:prepend>
                  <v-avatar :color="getAccountColor(acc.status)" size="40">
                    <v-icon icon="mdi-account" color="white"></v-icon>
                  </v-avatar>
                </template>
                <v-list-item-title class="font-weight-bold">
                  {{ acc.zaloAccount?.displayName || acc.zaloAccount?.phone || 'Tài khoản không xác định' }}
                </v-list-item-title>
                <v-list-item-subtitle>
                  Đã gửi: <strong>{{ acc.sentCount }}</strong> | Lỗi: <strong class="text-error">{{ acc.failedCount }}</strong>
                </v-list-item-subtitle>
                <template v-slot:append>
                  <v-chip :color="getAccountColor(acc.status)" size="x-small" class="text-uppercase font-weight-bold">
                    {{ acc.status }}
                  </v-chip>
                </template>
              </v-list-item>
            </v-list>
          </v-card>
        </v-col>

        <v-col cols="12" md="6">
          <v-card class="elevation-2 rounded-xl h-100 d-flex flex-column logs-card">
            <v-card-title class="pa-4 border-b font-family-mono text-subtitle-1">
              <v-icon icon="mdi-console-line" class="mr-2 text-medium-emphasis"></v-icon>
              Live Logs
            </v-card-title>
            <v-card-text class="pa-4 overflow-y-auto font-family-mono text-body-2 flex-grow-1" style="max-height: 400px;" id="logs-container">
              <div v-if="store.liveLogs.length === 0" class="text-medium-emphasis text-center mt-10">
                Đang chờ sự kiện...
              </div>
              <div
                v-for="(log, idx) in store.liveLogs"
                :key="idx"
                class="mb-1 pb-1 log-entry"
              >
                <span class="text-medium-emphasis mr-2">[{{ log.time }}]</span>
                <span :class="getLogColorClass(log.type)">{{ log.message }}</span>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { useCampaignStore } from '@/stores/campaign';

const route = useRoute();
const store = useCampaignStore();

const campaignId = computed(() => route.params.id as string);
const campaign = computed(() => store.currentCampaign);
const loading = computed(() => store.loading);
const error = computed(() => store.error);

const statusColor = computed(() => {
  if (!campaign.value) return 'grey';
  switch (campaign.value.status) {
    case 'running': return 'primary';
    case 'completed': return 'success';
    case 'paused': return 'warning';
    case 'cancelled': return 'error';
    default: return 'grey';
  }
});

const hasQuotaReachedAccounts = computed(() => {
  if (!campaign.value?.accountStats) return false;
  return campaign.value.accountStats.some(s => s.status === 'quota_reached');
});

onMounted(async () => {
  if (campaignId.value) {
    await store.syncCampaign(campaignId.value);
    store.initSocket(campaignId.value);
  }
});

onUnmounted(() => {
  store.cleanup();
});

// Auto scroll logs
watch(() => store.liveLogs.length, async () => {
  await nextTick();
  const container = document.getElementById('logs-container');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
});

function getAccountColor(status: string) {
  switch (status) {
    case 'active': return 'success';
    case 'quota_reached': return 'warning';
    case 'blocked': return 'error';
    default: return 'grey';
  }
}

function getLogColorClass(type: string) {
  switch (type) {
    case 'info': return 'text-info';
    case 'success': return 'text-success';
    case 'warning': return 'text-warning';
    case 'error': return 'text-error';
    default: return '';
  }
}

async function updateStatus(status: 'running' | 'paused' | 'cancelled') {
  try {
    await store.updateStatus(status);
  } catch (err) {
    // Error handled in store
  }
}
</script>

<style scoped>
.font-family-mono {
  font-family: 'Consolas', 'Monaco', monospace !important;
}
.logs-card {
  background: rgb(var(--v-theme-surface-variant)) !important;
}
.log-entry {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
