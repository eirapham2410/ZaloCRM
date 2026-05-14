<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Tài khoản Zalo</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="showAddDialog = true">Thêm Zalo</v-btn>
    </div>

    <v-card>
      <v-data-table :headers="headers" :items="accounts" :loading="loading" no-data-text="Chưa có tài khoản Zalo nào">
        <template #item.zaloUid="{ item }">
          <div class="d-flex align-center">
            <span>{{ item.zaloUid || 'Chưa có' }}</span>
            <v-icon
              v-if="item.proxyId"
              color="success"
              size="small"
              class="ml-2"
              :title="`Proxy: ${item.proxyConfig?.url || 'Đã thiết lập'}`"
            >
              mdi-shield-check-outline
            </v-icon>
          </div>
        </template>
        <template #item.status="{ item }">
          <v-chip :color="statusColor(item.liveStatus || item.status)" size="small" variant="flat">
            {{ statusText(item.liveStatus || item.status) }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn v-if="authStore.isAdmin" icon size="small" color="cyan" title="Phân quyền truy cập" @click="openAccess(item)">
            <v-icon>mdi-shield-account</v-icon>
          </v-btn>
          <v-btn icon size="small" color="success" @click="syncContacts(item.id)" title="Đồng bộ danh bạ Zalo" :loading="syncing === item.id">
            <v-icon>mdi-account-sync</v-icon>
          </v-btn>
          <v-btn icon size="small" color="blue-grey" title="Cấu hình Proxy" @click="openProxyConfig(item)">
            <v-icon>mdi-shield-link-variant</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus !== 'connected'" icon size="small" color="primary" @click="loginAccount(item.id)" title="Đăng nhập QR">
            <v-icon>mdi-qrcode</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus === 'disconnected' && item.sessionData" icon size="small" color="info" @click="reconnectAccount(item.id)" title="Kết nối lại">
            <v-icon>mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon size="small" color="error" @click="confirmDelete(item)" title="Xóa">
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Add account dialog -->
    <v-dialog v-model="showAddDialog" max-width="400">
      <v-card>
        <v-card-title>Thêm tài khoản Zalo</v-card-title>
        <v-card-text>
          <v-text-field v-model="newAccountName" label="Tên hiển thị (VD: Zalo Sale Hương)" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showAddDialog = false">Hủy</v-btn>
          <v-btn color="primary" :loading="adding" @click="handleAddAccount">Thêm</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- QR Code dialog -->
    <v-dialog v-model="showQRDialog" max-width="400" persistent>
      <v-card class="text-center pa-4">
        <v-card-title>Quét QR để đăng nhập Zalo</v-card-title>
        <v-card-text>
          <div v-if="qrImage" class="mb-4">
            <img :src="'data:image/png;base64,' + qrImage" alt="QR Code" style="max-width: 280px;" />
          </div>
          <div v-else-if="qrScanned" class="mb-4">
            <v-icon icon="mdi-check-circle" size="64" color="success" />
            <p class="text-h6 mt-2">Đã quét! Xác nhận trên điện thoại...</p>
            <p v-if="scannedName" class="text-body-2">{{ scannedName }}</p>
          </div>
          <div v-else class="mb-4">
            <v-progress-circular indeterminate color="primary" size="64" />
            <p class="mt-2">Đang tạo QR code...</p>
          </div>
          <v-alert v-if="qrError" type="error" density="compact" class="mt-2">{{ qrError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelQR">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xóa</v-card-title>
        <v-card-text>Bạn có chắc muốn xóa tài khoản "{{ deleteTarget?.displayName || deleteTarget?.id }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="handleDeleteAccount">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Access control dialog -->
    <ZaloAccessDialog
      v-model="showAccessDialog"
      :account-id="accessTarget?.id ?? ''"
      :account-name="accessTarget?.displayName ?? accessTarget?.id ?? ''"
    />

    <!-- Proxy configuration dialog -->
    <v-dialog v-model="showProxyDialog" max-width="500">
      <v-card>
        <v-card-title>Cấu hình Proxy</v-card-title>
        <v-card-subtitle class="mt-1">
          Thiết lập proxy riêng cho tài khoản: <strong>{{ proxyTarget?.displayName || proxyTarget?.id }}</strong>
        </v-card-subtitle>
        <v-card-text>
          <v-autocomplete
            v-model="selectedProxyId"
            :items="proxies"
            item-value="id"
            label="Chọn Proxy"
            placeholder="Tìm theo URL..."
            clearable
            class="mb-4 mt-2"
          >
            <template #item="{ props, item }">
              <v-list-item v-bind="props" :title="maskUrl(getProxyItem(item).url)">
                <template #append>
                  <v-chip
                    size="small"
                    :color="getProxyItem(item)._count.zaloAccounts >= getProxyItem(item).maxAccounts ? 'warning' : 'primary'"
                    class="ml-2"
                  >
                    {{ getProxyItem(item)._count.zaloAccounts }} / {{ getProxyItem(item).maxAccounts }}
                  </v-chip>
                </template>
              </v-list-item>
            </template>
            <template #selection="{ item }">
              {{ maskUrl(getProxyItem(item).url) }} ({{ getProxyItem(item)._count.zaloAccounts }}/{{ getProxyItem(item).maxAccounts }})
            </template>
          </v-autocomplete>
          
          <v-alert v-if="selectedProxy && selectedProxy._count.zaloAccounts >= selectedProxy.maxAccounts && selectedProxy.id !== proxyTarget?.proxyId" type="warning" density="compact" class="mb-4">
            Proxy này đã đạt giới hạn {{ selectedProxy.maxAccounts }} tài khoản. Nếu tiếp tục lưu, có thể bị lỗi giới hạn kết nối!
          </v-alert>
          <v-alert v-if="selectedProxy && selectedProxy.status === 'dead'" type="error" density="compact" class="mb-4">
            Proxy này hiện đang bị ngưng hoạt động (dead).
          </v-alert>

          <div class="d-flex justify-end">
            <v-btn
              color="info"
              variant="tonal"
              :loading="testingProxy"
              :disabled="!selectedProxy"
              @click="handleTestProxy"
            >
              Test kết nối Proxy này
            </v-btn>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showProxyDialog = false">Hủy</v-btn>
          <v-btn color="primary" :loading="savingProxy" @click="handleSaveProxy">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useZaloAccounts, type ZaloAccount } from '@/composables/use-zalo-accounts';
import { useProxies } from '@/composables/use-proxies';
import { useAuthStore } from '@/stores/auth';
import ZaloAccessDialog from '@/components/settings/ZaloAccessDialog.vue';
import { api } from '@/api/index';

const {
  accounts, loading, adding, deleting,
  showQRDialog, qrImage, qrScanned, scannedName, qrError,
  statusColor, statusText,
  fetchAccounts, addAccount, loginAccount, reconnectAccount, deleteAccount,
  updateProxy,
  cancelQR, setupSocket,
} = useZaloAccounts();

const { proxies, fetchProxies, testProxy } = useProxies();

const authStore = useAuthStore();

const showAddDialog = ref(false);
const syncing = ref<string | null>(null);
const showDeleteDialog = ref(false);
const showAccessDialog = ref(false);
const newAccountName = ref('');
const deleteTarget = ref<ZaloAccount | null>(null);
const accessTarget = ref<ZaloAccount | null>(null);

// Proxy state
const showProxyDialog = ref(false);
const proxyTarget = ref<ZaloAccount | null>(null);
const selectedProxyId = ref<string | null>(null);
const testingProxy = ref(false);
const savingProxy = ref(false);

const selectedProxy = computed(() => {
  return proxies.value.find(p => p.id === selectedProxyId.value);
});

function getProxyItem(item: any): any {
  return item.raw || item;
}

function maskUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const headers = [
  { title: 'Tên', key: 'displayName', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid' },
  { title: 'SĐT', key: 'phone' },
  { title: 'Trạng thái', key: 'status', sortable: true },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

async function syncContacts(accountId: string) {
  syncing.value = accountId;
  try {
    const res = await api.post(`/zalo-accounts/${accountId}/sync-contacts`);
    alert(`Đồng bộ thành công: ${res.data.created} mới, ${res.data.updated} cập nhật`);
  } catch (err: any) {
    alert('Đồng bộ thất bại: ' + (err.response?.data?.error || err.message));
  } finally {
    syncing.value = null;
  }
}

async function handleAddAccount() {
  const ok = await addAccount(newAccountName.value);
  if (ok) {
    showAddDialog.value = false;
    newAccountName.value = '';
  }
}

function confirmDelete(account: ZaloAccount) {
  deleteTarget.value = account;
  showDeleteDialog.value = true;
}

function openAccess(account: ZaloAccount) {
  accessTarget.value = account;
  showAccessDialog.value = true;
}

async function handleDeleteAccount() {
  if (!deleteTarget.value) return;
  const ok = await deleteAccount(deleteTarget.value);
  if (ok) {
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

function openProxyConfig(account: ZaloAccount) {
  proxyTarget.value = account;
  selectedProxyId.value = account.proxyId || null;
  showProxyDialog.value = true;
}

async function handleTestProxy() {
  if (!selectedProxyId.value) return;
  testingProxy.value = true;
  const res = await testProxy(selectedProxyId.value);
  testingProxy.value = false;
  if (res.success) {
    alert(`Kết nối proxy OK! Public IP: ${res.ip}`);
  } else {
    alert(`Lỗi proxy: ${res.error}`);
  }
}

async function handleSaveProxy() {
  if (!proxyTarget.value) return;
  savingProxy.value = true;
  const res = await updateProxy(proxyTarget.value.id, selectedProxyId.value);
  savingProxy.value = false;

  if (res.success) {
    showProxyDialog.value = false;
    // Ask user to reconnect if the account is currently connected
    if (proxyTarget.value.liveStatus === 'connected') {
      if (confirm(res.message + '\n\nBạn có muốn khởi động lại tài khoản để áp dụng Proxy ngay không?')) {
        reconnectAccount(proxyTarget.value.id);
      }
    } else {
      alert('Đã cập nhật cấu hình Proxy.');
    }
    proxyTarget.value = null;
    fetchProxies(); // Refresh usage count
  } else {
    alert('Lỗi: ' + res.message);
  }
}

onMounted(() => {
  fetchAccounts();
  fetchProxies();
  setupSocket();
});
</script>
