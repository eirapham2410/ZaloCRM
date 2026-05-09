<template>
  <v-container fluid class="pa-4 pa-md-6">
    <!-- ═══ Header ═══ -->
    <div class="d-flex align-center justify-space-between mb-6">
      <div>
        <h1 class="text-h5 font-weight-bold">Quản lý Chiến dịch</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">
          Tạo, theo dõi và quản lý các chiến dịch gửi tin nhắn hàng loạt
        </p>
      </div>
      <v-btn color="primary" size="large" prepend-icon="mdi-plus" @click="$router.push('/campaigns/builder')">
        Tạo chiến dịch mới
      </v-btn>
    </div>

    <!-- ═══ Summary Cards ═══ -->
    <v-row class="mb-6">
      <v-col cols="12" sm="4">
        <v-card variant="tonal" color="primary" class="rounded-lg">
          <v-card-text class="d-flex align-center">
            <v-avatar color="primary" size="48" class="mr-4">
              <v-icon icon="mdi-send-check" size="24"></v-icon>
            </v-avatar>
            <div>
              <div class="text-h5 font-weight-bold">{{ summary.totalSent.toLocaleString() }}</div>
              <div class="text-caption text-medium-emphasis">Tổng tin đã gửi</div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="4">
        <v-card variant="tonal" color="warning" class="rounded-lg">
          <v-card-text class="d-flex align-center">
            <v-avatar color="warning" size="48" class="mr-4">
              <v-icon icon="mdi-progress-clock" size="24"></v-icon>
            </v-avatar>
            <div>
              <div class="text-h5 font-weight-bold">{{ summary.runningCount }}</div>
              <div class="text-caption text-medium-emphasis">Chiến dịch đang chạy</div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="4">
        <v-card variant="tonal" color="success" class="rounded-lg">
          <v-card-text class="d-flex align-center">
            <v-avatar color="success" size="48" class="mr-4">
              <v-icon icon="mdi-check-circle" size="24"></v-icon>
            </v-avatar>
            <div>
              <div class="text-h5 font-weight-bold">{{ summary.overallSuccessRate }}%</div>
              <div class="text-caption text-medium-emphasis">Tỷ lệ thành công</div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- ═══ Tabs ═══ -->
    <v-card class="rounded-lg" elevation="1">
      <v-tabs v-model="activeTab" color="primary" grow>
        <v-tab value="history">
          <v-icon icon="mdi-history" class="mr-2"></v-icon>
          Lịch sử Chiến dịch
          <v-badge v-if="campaigns.length > 0" :content="campaigns.length" color="primary" inline class="ml-2"></v-badge>
        </v-tab>
        <v-tab value="templates">
          <v-icon icon="mdi-file-document-outline" class="mr-2"></v-icon>
          Mẫu tin nhắn đã lưu
          <v-badge v-if="templates.length > 0" :content="templates.length" color="secondary" inline class="ml-2"></v-badge>
        </v-tab>
      </v-tabs>

      <v-divider></v-divider>

      <v-tabs-window v-model="activeTab">
        <!-- ═══ Tab 1: Campaign History ═══ -->
        <v-tabs-window-item value="history">
          <v-card-text v-if="loadingCampaigns" class="text-center py-12">
            <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
            <p class="text-body-2 text-medium-emphasis mt-4">Đang tải danh sách chiến dịch...</p>
          </v-card-text>

          <v-card-text v-else-if="campaigns.length === 0" class="text-center py-12">
            <v-icon icon="mdi-bullhorn-outline" size="64" color="grey-lighten-1" class="mb-4"></v-icon>
            <p class="text-h6 text-medium-emphasis">Chưa có chiến dịch nào</p>
            <p class="text-body-2 text-medium-emphasis mb-4">Bắt đầu tạo chiến dịch đầu tiên của bạn!</p>
            <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="$router.push('/campaigns/builder')">
              Tạo chiến dịch
            </v-btn>
          </v-card-text>

          <v-data-table
            v-else
            :headers="campaignHeaders"
            :items="campaigns"
            :items-per-page="10"
            class="campaigns-table"
            hover
          >
            <template v-slot:item.name="{ item }">
              <div>
                <div class="font-weight-medium">{{ item.name }}</div>
                <div class="text-caption text-medium-emphasis">{{ item.templateName }}</div>
              </div>
            </template>

            <template v-slot:item.accountNames="{ item }">
              <span class="text-body-2">{{ item.accountNames || '—' }}</span>
            </template>

            <template v-slot:item.status="{ item }">
              <v-chip :color="statusColor(item.status)" size="small" label>
                <v-icon :icon="statusIcon(item.status)" size="14" class="mr-1"></v-icon>
                {{ statusText(item.status) }}
              </v-chip>
            </template>

            <template v-slot:item.progress="{ item }">
              <div style="min-width: 140px;">
                <div class="d-flex justify-space-between text-caption mb-1">
                  <span>{{ item.sentCount }}/{{ item.totalRecipients }}</span>
                  <span class="font-weight-medium">{{ item.successRate }}%</span>
                </div>
                <v-progress-linear
                  :model-value="item.progress"
                  :color="item.successRate >= 80 ? 'success' : item.successRate >= 50 ? 'warning' : 'error'"
                  height="6"
                  rounded
                ></v-progress-linear>
              </div>
            </template>

            <template v-slot:item.createdAt="{ item }">
              <span class="text-body-2">{{ formatDate(item.createdAt) }}</span>
            </template>

            <template v-slot:item.actions="{ item }">
              <v-btn icon="mdi-eye" size="small" variant="text" color="primary"
                @click="$router.push(`/campaigns/${item.id}/monitor`)">
                <v-icon icon="mdi-eye"></v-icon>
                <v-tooltip activator="parent" location="top">Xem chi tiết</v-tooltip>
              </v-btn>
              <v-btn icon="mdi-content-copy" size="small" variant="text" color="secondary"
                @click="cloneCampaign(item.id)" :loading="cloningId === item.id">
                <v-icon icon="mdi-content-copy"></v-icon>
                <v-tooltip activator="parent" location="top">Nhân bản</v-tooltip>
              </v-btn>
            </template>
          </v-data-table>
        </v-tabs-window-item>

        <!-- ═══ Tab 2: Saved Marketing Templates ═══ -->
        <v-tabs-window-item value="templates">
          <v-card-text v-if="loadingTemplates" class="text-center py-12">
            <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
            <p class="text-body-2 text-medium-emphasis mt-4">Đang tải mẫu tin nhắn...</p>
          </v-card-text>

          <v-card-text v-else-if="templates.length === 0" class="text-center py-12">
            <v-icon icon="mdi-file-document-outline" size="64" color="grey-lighten-1" class="mb-4"></v-icon>
            <p class="text-h6 text-medium-emphasis">Chưa có mẫu nào được lưu</p>
            <p class="text-body-2 text-medium-emphasis mb-4">
              Tạo mẫu mới từ trang Tạo Chiến dịch khi tích chọn "Lưu nội dung này thành mẫu mới".
            </p>
          </v-card-text>

          <v-data-table
            v-else
            :headers="templateHeaders"
            :items="templates"
            :items-per-page="10"
            class="templates-table"
            hover
          >
            <template v-slot:item.name="{ item }">
              <span class="font-weight-medium">{{ item.name }}</span>
            </template>

            <template v-slot:item.content="{ item }">
              <span class="text-body-2 text-medium-emphasis">{{ truncate(item.content, 80) }}</span>
            </template>

            <template v-slot:item.attachments="{ item }">
              <v-chip v-if="item.attachments && item.attachments.length > 0" size="small" color="primary" variant="tonal">
                <v-icon icon="mdi-paperclip" size="14" class="mr-1"></v-icon>
                {{ item.attachments.length }} file
              </v-chip>
              <span v-else class="text-medium-emphasis">—</span>
            </template>

            <template v-slot:item.createdAt="{ item }">
              <span class="text-body-2">{{ formatDate(item.createdAt) }}</span>
            </template>

            <template v-slot:item.actions="{ item }">
              <v-btn size="small" variant="text" color="primary" @click="useTemplate(item.id)">
                <v-icon icon="mdi-play-circle-outline" class="mr-1"></v-icon>
                Sử dụng
                <v-tooltip activator="parent" location="top">Dùng mẫu này để tạo chiến dịch</v-tooltip>
              </v-btn>
              <v-btn icon="mdi-delete-outline" size="small" variant="text" color="error"
                @click="confirmDeleteTemplate(item)">
                <v-icon icon="mdi-delete-outline"></v-icon>
                <v-tooltip activator="parent" location="top">Xóa mẫu</v-tooltip>
              </v-btn>
            </template>
          </v-data-table>
        </v-tabs-window-item>
      </v-tabs-window>
    </v-card>

    <!-- ═══ Delete Confirmation Dialog ═══ -->
    <v-dialog v-model="showDeleteDialog" max-width="420">
      <v-card class="rounded-lg">
        <v-card-title class="text-h6 d-flex align-center">
          <v-icon icon="mdi-alert-circle" color="error" class="mr-2"></v-icon>
          Xóa mẫu tin nhắn
        </v-card-title>
        <v-card-text>
          Bạn có chắc chắn muốn xóa mẫu "<strong>{{ deleteTarget?.name }}</strong>"?
          Hành động này không thể hoàn tác.
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" variant="flat" :loading="deleting" @click="deleteTemplate">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ═══ Snackbar ═══ -->
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="3000" location="bottom right">
      {{ snackbar.text }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { campaignApi } from '@/api/campaign.api';
import type { CampaignListItem, TemplateItem } from '@/api/campaign.api';

const router = useRouter();

// ── State ───────────────────────────────────────────────────────────────────
const activeTab = ref('history');
const loadingCampaigns = ref(false);
const loadingTemplates = ref(false);
const campaigns = ref<CampaignListItem[]>([]);
const templates = ref<TemplateItem[]>([]);
const summary = ref({ totalSent: 0, runningCount: 0, overallSuccessRate: 0 });
const cloningId = ref<string | null>(null);
const showDeleteDialog = ref(false);
const deleteTarget = ref<TemplateItem | null>(null);
const deleting = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });
let pollingTimer: ReturnType<typeof setInterval> | null = null;

// ── Table headers ───────────────────────────────────────────────────────────
const campaignHeaders = [
  { title: 'Tên chiến dịch', key: 'name', sortable: true },
  { title: 'Tài khoản gửi', key: 'accountNames', sortable: false },
  { title: 'Trạng thái', key: 'status', sortable: true, align: 'center' as const },
  { title: 'Tiến độ', key: 'progress', sortable: true },
  { title: 'Ngày tạo', key: 'createdAt', sortable: true },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'center' as const },
];

const templateHeaders = [
  { title: 'Tên mẫu', key: 'name', sortable: true },
  { title: 'Nội dung', key: 'content', sortable: false },
  { title: 'Đính kèm', key: 'attachments', sortable: false, align: 'center' as const },
  { title: 'Ngày lưu', key: 'createdAt', sortable: true },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'center' as const },
];

// ── Data fetching ───────────────────────────────────────────────────────────
async function fetchCampaigns() {
  loadingCampaigns.value = true;
  try {
    const res = await campaignApi.listCampaigns();
    campaigns.value = res.data.data;
    summary.value = res.data.summary;
  } catch (err) {
    console.error('Failed to load campaigns:', err);
  } finally {
    loadingCampaigns.value = false;
  }
}

async function fetchTemplates() {
  loadingTemplates.value = true;
  try {
    // Only fetch marketing templates (saved by user via checkbox)
    const res = await campaignApi.getMarketingTemplates();
    templates.value = res.data.templates || [];
  } catch (err) {
    console.error('Failed to load templates:', err);
  } finally {
    loadingTemplates.value = false;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function cloneCampaign(id: string) {
  cloningId.value = id;
  try {
    const res = await campaignApi.cloneCampaign(id);
    const data = res.data.data;
    router.push({ path: '/campaigns/builder', query: { templateId: data.templateId, cloneName: data.name } });
  } catch {
    showSnackbar('Không thể nhân bản chiến dịch', 'error');
  } finally {
    cloningId.value = null;
  }
}

function useTemplate(templateId: string) {
  router.push({ path: '/campaigns/builder', query: { templateId } });
}

function confirmDeleteTemplate(item: TemplateItem) {
  deleteTarget.value = item;
  showDeleteDialog.value = true;
}

async function deleteTemplate() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await campaignApi.deleteTemplate(deleteTarget.value.id);
    templates.value = templates.value.filter(t => t.id !== deleteTarget.value!.id);
    showSnackbar('Đã xóa mẫu tin nhắn thành công', 'success');
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || 'Không thể xóa mẫu tin nhắn';
    showSnackbar(errorMsg, 'error');
  } finally {
    deleting.value = false;
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function statusColor(status: string): string {
  return ({ draft: 'grey', running: 'info', paused: 'warning', completed: 'success', cancelled: 'error' } as Record<string, string>)[status] || 'grey';
}

function statusIcon(status: string): string {
  return ({ draft: 'mdi-pencil-outline', running: 'mdi-play-circle', paused: 'mdi-pause-circle', completed: 'mdi-check-circle', cancelled: 'mdi-close-circle' } as Record<string, string>)[status] || 'mdi-help-circle';
}

function statusText(status: string): string {
  return ({ draft: 'Nháp', running: 'Đang chạy', paused: 'Tạm dừng', completed: 'Hoàn thành', cancelled: 'Đã hủy' } as Record<string, string>)[status] || status;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function truncate(text: string, maxLen: number): string {
  if (!text) return '—';
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

function showSnackbar(text: string, color: string) {
  snackbar.value = { show: true, text, color };
}

// ── Polling ─────────────────────────────────────────────────────────────────
function startPolling() {
  pollingTimer = setInterval(async () => {
    if (summary.value.runningCount > 0) {
      try {
        const res = await campaignApi.listCampaigns();
        campaigns.value = res.data.data;
        summary.value = res.data.summary;
      } catch { /* silent */ }
    }
  }, 10_000);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([fetchCampaigns(), fetchTemplates()]);
  startPolling();
});

onUnmounted(() => {
  if (pollingTimer) clearInterval(pollingTimer);
});
</script>

<style scoped>
.campaigns-table :deep(th),
.templates-table :deep(th) {
  white-space: nowrap;
}
</style>
