<template>
  <div class="groups-page">
    <!-- ═══ Header ═══ -->
    <div class="d-flex align-center mb-4 flex-wrap gap-2">
      <h1 class="text-h5 mr-4">Nhóm Zalo</h1>
      <v-spacer />
      <v-btn
        v-if="selectedAccountId"
        variant="outlined"
        prepend-icon="mdi-sync"
        :loading="syncing"
        :disabled="syncing"
        class="mr-2"
        @click="syncGroupsAction"
      >
        Đồng bộ dữ liệu
      </v-btn>
    </div>

    <!-- ═══ Sync Progress ═══ -->
    <v-progress-linear
      v-if="syncing"
      indeterminate
      color="primary"
      height="3"
      class="mb-4"
      rounded
    />

    <!-- ═══ Summary Stats ═══ -->
    <div v-if="selectedAccountId && !showEmptyState" class="d-flex align-center gap-3 mb-4 flex-wrap">
      <v-chip variant="tonal" color="primary" size="small">
        <v-icon start size="16">mdi-account-group</v-icon>
        {{ totalGroups.toLocaleString() }} nhóm
      </v-chip>
      <v-chip v-if="adminCount > 0" variant="tonal" color="success" size="small">
        <v-icon start size="16">mdi-shield-crown-outline</v-icon>
        {{ adminCount }} Admin
      </v-chip>
      <v-chip v-if="memberCount > 0" variant="tonal" color="warning" size="small">
        <v-icon start size="16">mdi-account-outline</v-icon>
        {{ memberCount }} Thành viên
      </v-chip>
    </div>

    <!-- ═══ Filters ═══ -->
    <v-row dense class="mb-4 align-center">
      <v-col cols="12" sm="4">
        <v-select
          v-model="selectedAccountId"
          :items="accounts"
          item-title="displayName"
          item-value="id"
          label="Tài khoản Zalo"
          clearable
          hide-details
          prepend-inner-icon="mdi-cellphone-link"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="searchInput"
          prepend-inner-icon="mdi-magnify"
          label="Tìm kiếm nhóm theo tên"
          clearable
          hide-details
          @update:model-value="onSearchDebounced"
        />
      </v-col>
      <v-col cols="12" sm="4" class="d-flex justify-end">
        <v-chip-group v-model="viewMode" mandatory selected-class="text-primary">
          <v-chip value="grid" filter variant="outlined" size="small">
            <v-icon start size="16">mdi-view-grid-outline</v-icon>
            Lưới
          </v-chip>
          <v-chip value="list" filter variant="outlined" size="small">
            <v-icon start size="16">mdi-view-list-outline</v-icon>
            Danh sách
          </v-chip>
        </v-chip-group>
      </v-col>
    </v-row>

    <!-- ═══ No account selected ═══ -->
    <div v-if="!selectedAccountId" class="empty-state text-center py-16">
      <v-avatar size="96" color="surface-variant" class="mb-4">
        <v-icon size="48" color="medium-emphasis">mdi-account-group-outline</v-icon>
      </v-avatar>
      <p class="text-h6 text-medium-emphasis">Chọn tài khoản Zalo để bắt đầu</p>
      <p class="text-body-2 text-medium-emphasis">Sử dụng bộ lọc phía trên để chọn tài khoản cần xem</p>
    </div>

    <!-- ═══ Loading State ═══ -->
    <div v-else-if="loading && groups.length === 0" class="d-flex justify-center py-16">
      <v-progress-circular indeterminate color="primary" size="48" />
    </div>

    <!-- ═══ Empty State — chưa đồng bộ ═══ -->
    <div v-else-if="showEmptyState" class="empty-state text-center py-16">
      <v-avatar size="96" color="surface-variant" class="mb-6">
        <v-icon size="48" color="medium-emphasis">mdi-account-group-outline</v-icon>
      </v-avatar>
      <p class="text-h6 text-medium-emphasis mb-2">Chưa có dữ liệu nhóm</p>
      <p class="text-body-2 text-medium-emphasis mb-6">
        Danh sách nhóm sẽ được tải về sau khi bạn thực hiện đồng bộ lần đầu từ Zalo.
      </p>
      <v-btn
        color="primary"
        size="large"
        prepend-icon="mdi-sync"
        :loading="syncing"
        :disabled="syncing"
        @click="syncGroupsAction"
      >
        Bắt đầu đồng bộ danh sách nhóm từ Zalo
      </v-btn>
    </div>

    <!-- ═══ Grid Card View ═══ -->
    <template v-else-if="viewMode === 'grid'">
      <v-row dense>
        <v-col
          v-for="group in groups"
          :key="group.id"
          cols="12"
          sm="6"
          md="4"
          lg="3"
        >
          <v-card
            class="group-card"
            variant="outlined"
            rounded="lg"
            hover
            @click="onSelectGroup(group)"
          >
            <div class="d-flex align-center pa-4">
              <!-- Avatar -->
              <v-avatar size="48" color="primary" class="mr-3 group-avatar">
                <v-img v-if="group.avatar" :src="group.avatar" />
                <v-icon v-else size="24" color="white">mdi-account-group</v-icon>
              </v-avatar>

              <!-- Info -->
              <div class="flex-1-1 overflow-hidden">
                <div class="text-subtitle-2 font-weight-bold text-truncate">
                  {{ group.name || 'Nhóm không tên' }}
                </div>
                <div class="d-flex align-center gap-2 mt-1">
                  <v-chip size="x-small" variant="tonal" color="grey">
                    <v-icon start size="12">mdi-account-multiple</v-icon>
                    {{ group.memberCount ?? 0 }}
                  </v-chip>
                  <v-chip
                    v-if="group.role === 'Admin'"
                    size="x-small"
                    variant="tonal"
                    color="success"
                  >
                    <v-icon start size="12">mdi-shield-crown-outline</v-icon>
                    Admin
                  </v-chip>
                </div>
              </div>
            </div>
          </v-card>
        </v-col>
      </v-row>

      <!-- Pagination -->
      <div v-if="pagination.totalPages > 1" class="d-flex justify-center mt-6">
        <v-pagination
          v-model="currentPage"
          :length="pagination.totalPages"
          :total-visible="5"
          rounded
          density="comfortable"
          @update:model-value="onPageChange"
        />
      </div>
    </template>

    <!-- ═══ List View ═══ -->
    <template v-else-if="viewMode === 'list'">
      <v-data-table
        :headers="tableHeaders"
        :items="groups"
        :loading="loading"
        :items-per-page="pagination.limit"
        hover
        @click:row="(_e: Event, row: any) => onSelectGroup(row.item)"
      >
        <template v-slot:item.avatar="{ item }">
          <v-avatar size="36" color="primary">
            <v-img v-if="item.avatar" :src="item.avatar" />
            <v-icon v-else size="18" color="white">mdi-account-group</v-icon>
          </v-avatar>
        </template>

        <template v-slot:item.name="{ item }">
          <span class="font-weight-medium">{{ item.name || 'Nhóm không tên' }}</span>
        </template>

        <template v-slot:item.memberCount="{ item }">
          <v-chip size="small" variant="tonal" color="grey">
            {{ item.memberCount ?? 0 }}
          </v-chip>
        </template>

        <template v-slot:item.role="{ item }">
          <v-chip
            size="small"
            variant="tonal"
            :color="item.role === 'Admin' ? 'success' : 'grey'"
          >
            {{ item.role ?? 'Member' }}
          </v-chip>
        </template>

        <template v-slot:item.syncedAt="{ item }">
          <span class="text-caption text-medium-emphasis">{{ formatDate(item.syncedAt) }}</span>
        </template>
      </v-data-table>

      <!-- Pagination -->
      <div v-if="pagination.totalPages > 1" class="d-flex justify-center mt-4">
        <v-pagination
          v-model="currentPage"
          :length="pagination.totalPages"
          :total-visible="5"
          rounded
          density="comfortable"
          @update:model-value="onPageChange"
        />
      </div>
    </template>

    <!-- ═══ Group Detail Dialog ═══ -->
    <v-dialog v-model="showDetailDialog" max-width="600">
      <v-card v-if="selectedGroupDetail">
        <v-card-title class="d-flex align-center pa-4">
          <v-avatar size="40" color="primary" class="mr-3">
            <v-img v-if="selectedGroupDetail.avatar" :src="selectedGroupDetail.avatar" />
            <v-icon v-else size="20" color="white">mdi-account-group</v-icon>
          </v-avatar>
          <div>
            <div class="text-h6">{{ selectedGroupDetail.name }}</div>
            <div class="text-caption text-medium-emphasis">
              {{ selectedGroupDetail.memberCount ?? 0 }} thành viên
            </div>
          </div>
          <v-spacer />
          <v-btn icon variant="text" @click="showDetailDialog = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-divider />
        <v-card-text class="pa-4">
          <v-list density="compact">
            <v-list-item>
              <template #prepend><v-icon color="primary" class="mr-3">mdi-identifier</v-icon></template>
              <v-list-item-title class="text-caption text-medium-emphasis">Zalo Group ID</v-list-item-title>
              <v-list-item-subtitle>{{ selectedGroupDetail.zaloGroupId }}</v-list-item-subtitle>
            </v-list-item>
            <v-list-item>
              <template #prepend><v-icon color="primary" class="mr-3">mdi-shield-crown-outline</v-icon></template>
              <v-list-item-title class="text-caption text-medium-emphasis">Vai trò</v-list-item-title>
              <v-list-item-subtitle>
                <v-chip size="small" variant="tonal" :color="selectedGroupDetail.role === 'Admin' ? 'success' : 'grey'">
                  {{ selectedGroupDetail.role }}
                </v-chip>
              </v-list-item-subtitle>
            </v-list-item>
            <v-list-item v-if="selectedGroupDetail.ownerId">
              <template #prepend><v-icon color="primary" class="mr-3">mdi-account-key</v-icon></template>
              <v-list-item-title class="text-caption text-medium-emphasis">Owner ID</v-list-item-title>
              <v-list-item-subtitle>{{ selectedGroupDetail.ownerId }}</v-list-item-subtitle>
            </v-list-item>
            <v-list-item>
              <template #prepend><v-icon color="primary" class="mr-3">mdi-clock-outline</v-icon></template>
              <v-list-item-title class="text-caption text-medium-emphasis">Đồng bộ lần cuối</v-list-item-title>
              <v-list-item-subtitle>{{ formatDate(selectedGroupDetail.syncedAt) }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- ═══ Snackbar ═══ -->
    <v-snackbar v-model="toast" :color="toastColor" :timeout="4000" location="bottom right">
      {{ toastMessage }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSelectedAccount } from '@/composables/use-selected-account';
import { useGroups } from '@/composables/use-groups';

const { selectedAccountId, accounts } = useSelectedAccount();
const {
  groups, loading, syncing, totalGroups, pagination,
  fetchGroups, syncGroups,
} = useGroups();

const viewMode = ref('grid');
const searchInput = ref('');
const currentPage = ref(1);
const showDetailDialog = ref(false);
const selectedGroupDetail = ref<any | null>(null);

// Toast notification
const toast = ref(false);
const toastMessage = ref('');
const toastColor = ref('success');

// Table headers (list view)
const tableHeaders = [
  { title: '', key: 'avatar', sortable: false, width: '56px' },
  { title: 'Tên nhóm', key: 'name', sortable: true },
  { title: 'Thành viên', key: 'memberCount', sortable: true, width: '120px' },
  { title: 'Vai trò', key: 'role', sortable: false, width: '120px' },
  { title: 'Đồng bộ', key: 'syncedAt', sortable: true, width: '160px' },
];

// ── Computed ──────────────────────────────────────────────────────────────────
const showEmptyState = computed(() =>
  selectedAccountId.value && !loading.value && groups.value.length === 0 && !searchInput.value,
);

const adminCount = computed(() =>
  groups.value.filter(g => g.role === 'Admin').length,
);

const memberCount = computed(() =>
  groups.value.filter(g => g.role !== 'Admin').length,
);

// ── Methods ──────────────────────────────────────────────────────────────────
function showToast(message: string, color = 'success') {
  toastMessage.value = message;
  toastColor.value = color;
  toast.value = true;
}

function formatDate(dateStr: string) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearchDebounced() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    loadGroups();
  }, 400);
}

function onPageChange(page: number) {
  currentPage.value = page;
  loadGroups();
}

async function loadGroups() {
  if (!selectedAccountId.value) return;
  await fetchGroups(selectedAccountId.value, {
    page: currentPage.value,
    limit: 50,
    search: searchInput.value || undefined,
  });
}

async function syncGroupsAction() {
  if (!selectedAccountId.value) return;
  try {
    const result = await syncGroups(selectedAccountId.value);
    const synced = result?.total ?? 0;
    const deleted = result?.deleted ?? 0;
    showToast(`Đồng bộ thành công: ${synced} nhóm, ${deleted} đã xóa`, 'success');
  } catch {
    showToast('Đồng bộ thất bại. Vui lòng thử lại.', 'error');
  }
}

function onSelectGroup(group: any) {
  selectedGroupDetail.value = group;
  showDetailDialog.value = true;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(() => {
  if (selectedAccountId.value) loadGroups();
});

watch(selectedAccountId, (id) => {
  searchInput.value = '';
  currentPage.value = 1;
  if (id) loadGroups();
});
</script>

<style scoped>
.groups-page {
  min-height: 100%;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.group-card {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  cursor: pointer;
}

.group-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(var(--v-theme-on-surface), 0.08);
}

.group-avatar {
  flex-shrink: 0;
}
</style>
