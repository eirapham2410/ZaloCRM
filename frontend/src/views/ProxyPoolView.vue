<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Proxy Pool</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-import" @click="showBulkDialog = true">
        Import Hàng Loạt
      </v-btn>
    </div>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="proxies"
        :loading="loading"
        no-data-text="Chưa có proxy nào trong pool"
      >
        <template #item.url="{ item }">
          <div class="d-flex align-center">
            <span class="text-body-2 font-weight-medium">{{ maskUrl(item.url) }}</span>
            <v-chip
              size="x-small"
              class="ml-2 text-uppercase font-weight-bold"
              :color="getProtocolColor(item.url)"
            >
              {{ getProtocol(item.url) }}
            </v-chip>
          </div>
        </template>
        <template #item.status="{ item }">
          <v-chip :color="item.status === 'active' ? 'success' : 'error'" size="small" variant="flat">
            {{ item.status === 'active' ? 'Hoạt động' : 'Chết / Lỗi' }}
          </v-chip>
        </template>
        <template #item.usage="{ item }">
          <v-chip
            size="small"
            :color="item._count.zaloAccounts >= item.maxAccounts ? 'warning' : 'primary'"
            variant="tonal"
          >
            {{ item._count.zaloAccounts }} / {{ item.maxAccounts }} Acc
          </v-chip>
        </template>
        <template #item.lastCheckedAt="{ item }">
          {{ item.lastCheckedAt ? new Date(item.lastCheckedAt).toLocaleString('vi-VN') : 'Chưa test' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            icon
            size="small"
            color="info"
            title="Kiểm tra kết nối"
            :loading="testingId === item.id"
            @click="handleTestProxy(item.id)"
          >
            <v-icon>mdi-shield-check</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            color="error"
            title="Xóa proxy"
            class="ml-2"
            @click="confirmDelete(item)"
          >
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Bulk Import Dialog -->
    <v-dialog v-model="showBulkDialog" max-width="600">
      <v-card>
        <v-card-title>Import Proxy Hàng Loạt</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2 text-medium-emphasis">
            Dán danh sách proxy vào đây. Hệ thống sẽ tự động quét các định dạng URL hợp lệ 
            (http://..., https://..., socks5://...) và lưu vào hệ thống.
          </p>
          <v-textarea
            v-model="bulkText"
            label="Danh sách Proxy"
            placeholder="http://user:pass@ip:port&#10;socks5://user:pass@ip:port"
            rows="10"
            variant="outlined"
            hide-details
          ></v-textarea>
          
          <v-alert v-if="importResult" :type="importResult.success ? 'success' : 'error'" class="mt-4" density="compact">
            <template v-if="importResult.success">
              Đã thêm thành công: <strong>{{ importResult.imported }}</strong> proxy.
              <br/> Bỏ qua (lỗi/trùng): <strong>{{ importResult.skipped }}</strong> proxy.
            </template>
            <template v-else>
              Lỗi: {{ importResult.error }}
            </template>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="closeBulkDialog" :disabled="importing">Đóng</v-btn>
          <v-btn color="primary" @click="handleBulkImport" :loading="importing">Import</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xóa</v-card-title>
        <v-card-text>
          Bạn có chắc muốn xóa proxy này?
          <div v-if="deleteTarget && deleteTarget._count.zaloAccounts > 0" class="mt-2 text-error">
            <strong>Cảnh báo:</strong> Đang có {{ deleteTarget._count.zaloAccounts }} tài khoản Zalo liên kết với proxy này. Xóa sẽ làm các tài khoản này mất cấu hình proxy!
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="handleDeleteProxy">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useProxies, type ProxyItem } from '@/composables/use-proxies';

const { proxies, loading, fetchProxies, bulkAddProxies, testProxy, deleteProxy } = useProxies();

const showBulkDialog = ref(false);
const bulkText = ref('');
const importing = ref(false);
const importResult = ref<any>(null);

const testingId = ref<string | null>(null);

const showDeleteDialog = ref(false);
const deleteTarget = ref<ProxyItem | null>(null);
const deleting = ref(false);

const headers = [
  { title: 'Proxy URL', key: 'url' },
  { title: 'Trạng thái', key: 'status' },
  { title: 'Sử dụng', key: 'usage' },
  { title: 'Kiểm tra cuối', key: 'lastCheckedAt' },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

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

function getProtocol(url: string) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'unknown';
  }
}

function getProtocolColor(url: string) {
  const p = getProtocol(url);
  if (p.includes('socks')) return 'purple';
  if (p.includes('https')) return 'teal';
  return 'blue';
}

async function handleBulkImport() {
  if (!bulkText.value.trim()) return;
  importing.value = true;
  importResult.value = null;
  const res = await bulkAddProxies(bulkText.value);
  importResult.value = res;
  importing.value = false;
  if (res.success && res.imported > 0) {
    bulkText.value = '';
  }
}

function closeBulkDialog() {
  showBulkDialog.value = false;
  importResult.value = null;
  bulkText.value = '';
}

async function handleTestProxy(id: string) {
  testingId.value = id;
  const res = await testProxy(id);
  testingId.value = null;
  if (res.success) {
    alert(`Kết nối thành công! Public IP: ${res.ip}`);
  } else {
    alert(`Lỗi: ${res.error}`);
  }
}

function confirmDelete(item: ProxyItem) {
  deleteTarget.value = item;
  showDeleteDialog.value = true;
}

async function handleDeleteProxy() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  const ok = await deleteProxy(deleteTarget.value.id);
  deleting.value = false;
  if (ok) {
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

onMounted(() => {
  fetchProxies();
});
</script>
