<template>
  <div class="pa-4">
    <div class="d-flex align-center mb-6">
      <v-btn icon variant="text" class="mr-2" @click="$router.back()">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <h1 class="text-h4 font-weight-bold">Quét thành viên nhóm Zalo</h1>
    </div>

    <!-- Scan Form -->
    <v-card class="mb-6 pa-4 border-thin" elevation="0">
      <v-row>
        <v-col cols="12" md="4">
          <v-select
            v-model="selectedAccountId"
            :items="connectedAccounts"
            item-title="displayName"
            item-value="id"
            label="Chọn tài khoản Zalo"
            prepend-inner-icon="mdi-account-circle"
            variant="outlined"
            density="comfortable"
            :loading="loadingAccounts"
            no-data-text="Không có tài khoản nào đã kết nối"
          >
            <template #item="{ item, props }">
              <v-list-item v-bind="props">
                <template #prepend>
                  <v-icon :color="getRaw(item).status === 'connected' ? 'success' : 'grey'" size="12" class="mr-2">mdi-circle</v-icon>
                </template>
              </v-list-item>
            </template>
          </v-select>
        </v-col>
        <v-col cols="12" md="5">
          <v-text-field
            v-model="groupLink"
            label="Link mời nhóm Zalo"
            placeholder="https://zalo.me/g/..."
            prepend-inner-icon="mdi-link-variant"
            variant="outlined"
            density="comfortable"
            :rules="[v => !v || v.includes('zalo.me/g/') || 'Link phải có dạng https://zalo.me/g/...']"
          ></v-text-field>
        </v-col>
        <v-col cols="12" md="3">
          <v-text-field
            v-model="groupName"
            label="Tên nhóm (để gắn Tag)"
            placeholder="Nhập tên nhóm"
            prepend-inner-icon="mdi-tag-outline"
            variant="outlined"
            density="comfortable"
          ></v-text-field>
        </v-col>
      </v-row>
      
      <div class="d-flex justify-end mt-2">
        <v-btn
          color="primary"
          prepend-icon="mdi-magnify"
          size="large"
          :loading="scanning"
          :disabled="!isValidForm"
          @click="startScan"
          class="px-6"
        >
          Bắt đầu quét
        </v-btn>
      </div>

      <!-- Progress Section -->
      <v-expand-transition>
        <div v-if="scanning || scanProgress" class="mt-6">
          <div class="d-flex justify-space-between mb-2">
            <span class="text-body-2 text-medium-emphasis">{{ progressText }}</span>
            <span class="text-body-2 font-weight-bold text-primary">{{ members.length }} thành viên</span>
          </div>
          <v-progress-linear
            :model-value="progressPercent"
            color="primary"
            height="8"
            rounded
            striped
            :indeterminate="scanning && members.length === 0"
          ></v-progress-linear>
        </div>
      </v-expand-transition>
    </v-card>

    <!-- Results Table -->
    <v-card v-if="members.length > 0" class="border-thin" elevation="0">
      <v-card-title class="d-flex align-center py-4 px-6 bg-surface-variant">
        <v-icon color="primary" class="mr-2">mdi-format-list-bulleted</v-icon>
        Kết quả quét ({{ selectedMembers.length }}/{{ members.length }})
        <v-spacer></v-spacer>
        <v-btn
          color="success"
          prepend-icon="mdi-content-save-outline"
          :loading="saving"
          :disabled="selectedMembers.length === 0"
          @click="saveToContacts"
        >
          Lưu {{ selectedMembers.length }} thành viên
        </v-btn>
      </v-card-title>

      <v-data-table
        v-model="selectedMembers"
        :headers="headers"
        :items="members"
        show-select
        return-object
        items-per-page="10"
        hover
      >
        <template #item.avatarUrl="{ item }">
          <v-avatar size="40" class="my-2" color="primary" variant="tonal">
            <!-- Avatar Fallback: @error hiển thị chữ cái đầu -->
            <v-img 
              v-if="item.avatarUrl && !item._avatarError" 
              :src="item.avatarUrl"
              referrerpolicy="no-referrer"
              @error="item._avatarError = true"
            ></v-img>
            <span v-else class="text-h6 text-uppercase">{{ getInitials(item.name) }}</span>
          </v-avatar>
        </template>
        <template #item.role="{ item }">
          <v-chip
            :color="getRoleColor(item.role)"
            size="small"
            class="text-uppercase"
            variant="flat"
          >
            {{ getRoleText(item.role) }}
          </v-chip>
        </template>
      </v-data-table>
    </v-card>

    <!-- Success CTA Modal -->
    <v-dialog v-model="showSuccessModal" max-width="500" persistent>
      <v-card class="text-center pa-6">
        <v-icon color="success" size="80" class="mx-auto mb-4">mdi-check-circle-outline</v-icon>
        <v-card-title class="text-h5 font-weight-bold mb-2">Nhập dữ liệu thành công!</v-card-title>
        <v-card-text class="text-body-1 mb-6">
          Đã lưu thành công <strong class="text-primary">{{ savedResult.createdCount }}</strong> liên hệ mới
          <span v-if="savedResult.updatedCount > 0">và cập nhật <strong>{{ savedResult.updatedCount }}</strong> liên hệ đã có</span>
          vào danh bạ với Tag: 
          <v-chip color="info" size="small" class="font-weight-bold mt-1">{{ savedResult.tag }}</v-chip>
        </v-card-text>
        <v-card-actions class="d-flex flex-column gap-3">
          <v-btn
            color="primary"
            variant="flat"
            size="large"
            block
            prepend-icon="mdi-rocket-launch"
            @click="goToCampaignBuilder"
          >
            🚀 Tiến hành chạy chiến dịch kết bạn ngay
          </v-btn>
          <v-btn
            color="grey-darken-1"
            variant="text"
            block
            @click="showSuccessModal = false"
          >
            Đóng
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar for notifications -->
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="4000" location="top right">
      <div class="d-flex align-center">
        <v-icon class="mr-2">{{ snackbar.icon }}</v-icon>
        {{ snackbar.text }}
      </div>
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
/**
 * GroupScannerView.vue — Màn hình quét thành viên nhóm Zalo qua Link mời.
 *
 * Luồng hoạt động:
 *   1. Chọn Account Zalo (chỉ hiện account đã connected) → Nhập link nhóm + tên nhóm
 *   2. Bấm "Quét" → POST /api/v1/zalo-accounts/:id/groups/scan-by-link
 *   3. Backend trả 202 → tiến trình quét chạy nền, emit Socket.IO vào room user:${userId}
 *   4. Frontend lắng nghe: group:scan_progress → progress bar
 *                          group:scan_complete → đổ data vào table
 *                          group:scan_error → snackbar
 *   5. User loại bỏ bot/clone → "Lưu vào CRM" → POST /contacts/bulk-import-from-scan
 *   6. Modal CTA → "Chạy chiến dịch" → redirect /campaigns/builder?type=ADD_FRIEND&autoSelectTag=...
 *
 * Data Isolation:
 *   - Socket.IO chỉ nhận event từ room user:${userId} (Backend emit riêng)
 *   - Import contacts gán assignedUserId = user.id (Backend enforce)
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';

const router = useRouter();
const authStore = useAuthStore();

// ── State: Account Selection & Input ────────────────────────────────────────
const { accounts, fetchAccounts, loading: loadingAccounts } = useZaloAccounts();
const selectedAccountId = ref('');
const groupLink = ref('');
const groupName = ref('');

const getRaw = (item: any): any => item.raw || item;

// Chỉ hiển thị tài khoản đang connected (tránh lỗi khi quét)
const connectedAccounts = computed(() =>
  accounts.value.filter(a => a.status === 'connected')
);

// ── State: Scanning Progress ────────────────────────────────────────────────
const scanning = ref(false);
const scanProgress = ref(false);
const progressText = ref('Đang chuẩn bị quét...');
const progressPercent = ref(0);
const totalMember = ref(0);

// Member data: normalized format from backend's normalizeRawMember()
interface ScannedMember {
  zaloUid: string;
  name: string;
  avatarUrl: string | null;
  role?: string;
  _avatarError?: boolean;
}
const members = ref<ScannedMember[]>([]);
const selectedMembers = ref<ScannedMember[]>([]);

// ── State: Saving & Modal ───────────────────────────────────────────────────
const saving = ref(false);
const showSuccessModal = ref(false);
const savedResult = ref({ createdCount: 0, updatedCount: 0, tag: '' });

// ── Snackbar ────────────────────────────────────────────────────────────────
const snackbar = ref({
  show: false,
  text: '',
  color: 'error',
  icon: 'mdi-alert-circle'
});

// Socket.IO instance
let socket: Socket | null = null;

// ── Computed ────────────────────────────────────────────────────────────────
const isValidForm = computed(() => {
  return selectedAccountId.value && groupLink.value.includes('zalo.me/g/');
});

const headers = [
  { title: 'Ảnh', key: 'avatarUrl', sortable: false, width: '80px' },
  { title: 'Tên Zalo', key: 'name', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid', sortable: false },
  { title: 'Vai trò', key: 'role', sortable: true, width: '120px' },
];

// ── Watchers: Reset State khi đổi Account/Link ─────────────────────────────
watch([selectedAccountId, groupLink], () => {
  members.value = [];
  selectedMembers.value = [];
  scanning.value = false;
  scanProgress.value = false;
  progressText.value = 'Đang chuẩn bị quét...';
  progressPercent.value = 0;
  totalMember.value = 0;
});

// ── Lifecycle ───────────────────────────────────────────────────────────────
onMounted(async () => {
  await fetchAccounts();
  if (connectedAccounts.value.length > 0) {
    selectedAccountId.value = connectedAccounts.value[0].id;
  }
  setupSocket();
});

onUnmounted(() => {
  // Cleanup: tránh memory leak
  if (socket) {
    socket.off('group:scan_progress');
    socket.off('group:scan_complete');
    socket.off('group:scan_error');
    socket.disconnect();
    socket = null;
  }
});

// ── Socket.IO Setup ─────────────────────────────────────────────────────────
function setupSocket() {
  const token = localStorage.getItem('token');
  if (!token) return;

  socket = io({ 
    transports: ['websocket', 'polling'],
    auth: { token }
  });

  // Join user room để nhận private emit từ Backend
  socket.on('connect', () => {
    const orgId = authStore.user?.orgId;
    if (orgId) {
      socket?.emit('org:join', { orgId });
    }
  });

  // ── Event: Tiến độ quét (mỗi trang) ──────────────────────────────────
  socket.on('group:scan_progress', (data: {
    accountId: string;
    groupLink: string;
    groupName: string;
    groupId: string | null;
    totalMember: number;
    scannedCount: number;
    page: number;
    members: ScannedMember[];
  }) => {
    // Guard: chỉ xử lý event thuộc phiên quét hiện tại
    if (data.accountId !== selectedAccountId.value) return;

    scanProgress.value = true;
    totalMember.value = data.totalMember || 0;
    progressText.value = `Đang quét dữ liệu trang ${data.page}... Thu thập được ${data.scannedCount} thành viên`;

    // Cập nhật progress bar
    if (data.totalMember > 0) {
      progressPercent.value = Math.min(Math.round((data.scannedCount / data.totalMember) * 100), 99);
    }

    // Cập nhật tên nhóm nếu user chưa nhập
    if (!groupName.value && data.groupName && data.groupName !== 'Nhóm Zalo') {
      groupName.value = data.groupName;
    }

    // Append members (deduplicate by zaloUid)
    const existingUids = new Set(members.value.map(m => m.zaloUid));
    const newMembers = (data.members || [])
      .filter(m => m.zaloUid && !existingUids.has(m.zaloUid))
      .map(m => ({ ...m, _avatarError: false }));

    members.value = [...members.value, ...newMembers];

    // Auto-select tất cả member mới (mặc định chọn hết)
    selectedMembers.value = [...selectedMembers.value, ...newMembers];
  });

  // ── Event: Hoàn tất quét ──────────────────────────────────────────────
  socket.on('group:scan_complete', (data: {
    accountId: string;
    groupLink: string;
    groupName: string;
    totalScanned: number;
    totalMember: number;
    members: ScannedMember[];
  }) => {
    if (data.accountId !== selectedAccountId.value) return;

    scanning.value = false;
    progressPercent.value = 100;
    progressText.value = `Hoàn tất! Quét được ${data.totalScanned}/${data.totalMember} thành viên.`;

    // Nếu event complete chứa full member list (fallback), đổ lại toàn bộ
    if (data.members && data.members.length > 0 && members.value.length === 0) {
      members.value = data.members.map(m => ({ ...m, _avatarError: false }));
      selectedMembers.value = [...members.value];
    }

    showToast(`Quét thành công ${data.totalScanned} thành viên!`, 'success');
  });

  // ── Event: Lỗi quét ──────────────────────────────────────────────────
  socket.on('group:scan_error', (data: {
    accountId: string;
    error: string;
  }) => {
    if (data.accountId !== selectedAccountId.value) return;

    scanning.value = false;
    showToast(data.error || 'Đã xảy ra lỗi khi quét nhóm.', 'error');
  });
}

// ── Methods ─────────────────────────────────────────────────────────────────
async function startScan() {
  if (!isValidForm.value) return;
  
  // Reset previous data
  members.value = [];
  selectedMembers.value = [];
  scanProgress.value = true;
  scanning.value = true;
  progressPercent.value = 0;
  totalMember.value = 0;
  progressText.value = 'Đang khởi tạo luồng quét...';

  try {
    await api.post(`/zalo-accounts/${selectedAccountId.value}/groups/scan-by-link`, {
      groupLink: groupLink.value
    });
    // 202 Accepted: tiến trình quét đã bắt đầu, Socket.IO sẽ gửi progress
  } catch (error: any) {
    scanning.value = false;
    scanProgress.value = false;

    if (error.response?.status === 429) {
      showToast(
        'Tài khoản Zalo này đang bận quét dữ liệu. Vui lòng đợi trong giây lát hoặc chọn tài khoản khác.',
        'warning',
      );
    } else {
      showToast(error.response?.data?.error || 'Lỗi hệ thống khi khởi tạo quét.', 'error');
    }
  }
}

async function saveToContacts() {
  if (selectedMembers.value.length === 0) return;
  
  saving.value = true;
  try {
    const payload = {
      groupName: groupName.value,
      contacts: selectedMembers.value.map(m => ({
        zaloUid: m.zaloUid,
        name: m.name,
        avatarUrl: m.avatarUrl,
      })),
    };
    
    const res = await api.post('/contacts/bulk-import-from-scan', payload);
    
    savedResult.value = {
      createdCount: res.data?.createdCount || 0,
      updatedCount: res.data?.updatedCount || 0,
      tag: res.data?.tag || `Từ nhóm: ${groupName.value || 'Không tên'}`,
    };
    showSuccessModal.value = true;
  } catch (error: any) {
    showToast(error.response?.data?.error || 'Không thể lưu danh sách thành viên.', 'error');
  } finally {
    saving.value = false;
  }
}

function goToCampaignBuilder() {
  showSuccessModal.value = false;
  const tag = savedResult.value.tag || `Từ nhóm: ${groupName.value || 'Không tên'}`;
  router.push(`/campaigns/builder?type=ADD_FRIEND&autoSelectTag=${encodeURIComponent(tag)}`);
}

function showToast(text: string, type: 'success' | 'error' | 'warning' = 'error') {
  snackbar.value.text = text;
  snackbar.value.color = type;
  snackbar.value.icon = type === 'success' ? 'mdi-check-circle' : (type === 'warning' ? 'mdi-alert' : 'mdi-alert-circle');
  snackbar.value.show = true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getInitials(name: string) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

function getRoleColor(role: string | undefined) {
  if (!role) return 'default';
  const r = role.toLowerCase();
  if (r === 'creator' || r === 'owner') return 'error';
  if (r === 'admin') return 'warning';
  return 'default';
}

function getRoleText(role: string | undefined) {
  if (!role) return 'Thành viên';
  const r = role.toLowerCase();
  if (r === 'creator' || r === 'owner') return 'Trưởng nhóm';
  if (r === 'admin') return 'Phó nhóm';
  return 'Thành viên';
}
</script>
