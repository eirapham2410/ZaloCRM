<template>
  <div>
    <v-row class="w-100 mx-0 mt-2">
      <v-col cols="12" md="10" offset-md="1">
        <v-card class="elevation-2 rounded-xl">
          <v-card-title class="text-h5 font-weight-bold pa-6 d-flex align-center">
            <v-icon icon="mdi-tag-multiple" color="primary" class="mr-3" size="large"></v-icon>
            Quản lý Tags
            <v-spacer></v-spacer>
            <v-btn
              variant="tonal"
              color="primary"
              prepend-icon="mdi-refresh"
              :loading="loading"
              @click="fetchTags"
            >
              Tải lại
            </v-btn>
          </v-card-title>

          <!-- Stats summary -->
          <v-card-text v-if="!loading && tags.length > 0" class="px-6 pt-0 pb-4">
            <v-chip color="primary" variant="tonal" class="mr-2">
              <v-icon start icon="mdi-tag"></v-icon>
              {{ tags.length }} tag
            </v-chip>
            <v-chip color="success" variant="tonal">
              <v-icon start icon="mdi-account-group"></v-icon>
              {{ totalContacts }} liên hệ được gắn tag
            </v-chip>
          </v-card-text>

          <!-- Loading -->
          <v-card-text v-if="loading" class="text-center pa-12">
            <v-progress-circular indeterminate color="primary" size="48" width="4"></v-progress-circular>
            <p class="text-body-1 mt-4 text-medium-emphasis">Đang tải danh sách Tags...</p>
          </v-card-text>

          <!-- Empty state -->
          <v-card-text v-else-if="tags.length === 0" class="text-center pa-12">
            <v-icon icon="mdi-tag-off-outline" size="64" color="grey-lighten-1"></v-icon>
            <p class="text-h6 mt-4 text-medium-emphasis">Chưa có Tag nào</p>
            <p class="text-body-2 text-medium-emphasis">
              Tag sẽ xuất hiện sau khi bạn quét nhóm Zalo hoặc gắn tag thủ công cho Khách hàng.
            </p>
          </v-card-text>

          <!-- Tag Table -->
          <v-data-table
            v-else
            :headers="headers"
            :items="tags"
            :search="search"
            item-key="tag"
            class="elevation-0"
            :items-per-page="20"
          >
            <!-- Search bar -->
            <template #top>
              <v-toolbar flat class="px-4">
                <v-text-field
                  v-model="search"
                  prepend-inner-icon="mdi-magnify"
                  label="Tìm kiếm Tag..."
                  variant="outlined"
                  density="compact"
                  hide-details
                  clearable
                  class="flex-grow-0"
                  style="max-width: 400px"
                ></v-text-field>
              </v-toolbar>
            </template>

            <!-- Tag column -->
            <template #item.tag="{ item }">
              <v-chip
                color="deep-purple"
                variant="tonal"
                size="default"
                label
                prepend-icon="mdi-tag"
              >
                {{ item.tag }}
              </v-chip>
            </template>

            <!-- Count column -->
            <template #item.count="{ item }">
              <v-chip color="blue-grey" variant="flat" size="small">
                {{ item.count }} liên hệ
              </v-chip>
            </template>

            <!-- Actions column -->
            <template #item.actions="{ item }">
              <v-btn
                icon="mdi-pencil"
                variant="text"
                size="small"
                color="primary"
                @click="openRenameDialog(item)"
              ></v-btn>
              <v-btn
                icon="mdi-delete"
                variant="text"
                size="small"
                color="error"
                @click="openDeleteDialog(item)"
              ></v-btn>
              <v-btn
                icon="mdi-rocket-launch"
                variant="text"
                size="small"
                color="success"
                @click="launchCampaign(item.tag)"
              ></v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-col>
    </v-row>

    <!-- Rename Dialog -->
    <v-dialog v-model="renameDialog" max-width="500" persistent>
      <v-card class="rounded-xl">
        <v-card-title class="text-h6 pa-6 d-flex align-center">
          <v-icon icon="mdi-pencil" color="primary" class="mr-2"></v-icon>
          Đổi tên Tag
        </v-card-title>
        <v-card-text class="px-6 pb-2">
          <p class="text-body-2 text-medium-emphasis mb-4">
            Tag hiện tại:
            <v-chip color="deep-purple" variant="tonal" size="small" label class="ml-1">
              {{ renameTarget?.tag }}
            </v-chip>
            ({{ renameTarget?.count }} liên hệ)
          </p>
          <v-text-field
            v-model="newTagName"
            label="Tên Tag mới"
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-tag-text"
            :rules="[v => !!v || 'Tên tag không được để trống', v => v !== renameTarget?.tag || 'Phải khác tên cũ']"
            autofocus
            @keyup.enter="confirmRename"
          ></v-text-field>
        </v-card-text>
        <v-card-actions class="px-6 pb-6">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="renameDialog = false" :disabled="renaming">Hủy</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="renaming"
            :disabled="!newTagName || newTagName === renameTarget?.tag"
            @click="confirmRename"
          >
            Xác nhận đổi tên
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="deleteDialog" max-width="500" persistent>
      <v-card class="rounded-xl">
        <v-card-title class="text-h6 pa-6 d-flex align-center">
          <v-icon icon="mdi-delete-alert" color="error" class="mr-2"></v-icon>
          Xác nhận xóa Tag
        </v-card-title>
        <v-card-text class="px-6">
          <v-alert type="warning" variant="tonal" class="mb-4">
            <strong>Thao tác này không thể hoàn tác.</strong><br>
            Tag <v-chip color="error" variant="tonal" size="small" label class="mx-1">{{ deleteTarget?.tag }}</v-chip>
            sẽ bị gỡ khỏi <strong>{{ deleteTarget?.count }} liên hệ</strong>.
            <br>Các liên hệ không bị xóa, chỉ gỡ tag này ra khỏi chúng.
          </v-alert>
        </v-card-text>
        <v-card-actions class="px-6 pb-6">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="deleteDialog = false" :disabled="deleting">Hủy</v-btn>
          <v-btn
            color="error"
            variant="flat"
            :loading="deleting"
            @click="confirmDelete"
          >
            Xóa Tag
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar -->
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="4000" location="top">
      {{ snackbar.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
/**
 * TagManagementView.vue — Quản lý Tags hệ thống CRM.
 *
 * - Hiển thị danh sách tag unique + số lượng contact mỗi tag (scoped by role)
 * - Hỗ trợ Đổi tên / Xóa tag hàng loạt (atomic raw SQL trên backend)
 * - Nút bấm nhanh để chạy chiến dịch kết bạn từ tag
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { contactApi, type TagInfo } from '@/api/contact.api';

const router = useRouter();

// ── State ────────────────────────────────────────────────────────────────────
const loading = ref(false);
const tags = ref<TagInfo[]>([]);
const search = ref('');

const totalContacts = computed(() =>
  tags.value.reduce((sum, t) => sum + t.count, 0)
);

const headers = [
  { title: 'Tag', key: 'tag', sortable: true },
  { title: 'Số liên hệ', key: 'count', sortable: true, align: 'center' as const },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'end' as const },
];

// ── Rename State ─────────────────────────────────────────────────────────────
const renameDialog = ref(false);
const renameTarget = ref<TagInfo | null>(null);
const newTagName = ref('');
const renaming = ref(false);

// ── Delete State ─────────────────────────────────────────────────────────────
const deleteDialog = ref(false);
const deleteTarget = ref<TagInfo | null>(null);
const deleting = ref(false);

// ── Snackbar ─────────────────────────────────────────────────────────────────
const snackbar = ref({ show: false, text: '', color: 'success' });

function showSnackbar(text: string, color = 'success') {
  snackbar.value = { show: true, text, color };
}

// ── Fetch Tags ───────────────────────────────────────────────────────────────
async function fetchTags() {
  loading.value = true;
  try {
    const res = await contactApi.getTags();
    tags.value = res.data.tags;
  } catch (err) {
    console.error('[TagManagement] Fetch tags failed:', err);
    showSnackbar('Không thể tải danh sách Tag. Vui lòng thử lại.', 'error');
  } finally {
    loading.value = false;
  }
}

// ── Rename ───────────────────────────────────────────────────────────────────
function openRenameDialog(item: TagInfo) {
  renameTarget.value = item;
  newTagName.value = item.tag;
  renameDialog.value = true;
}

async function confirmRename() {
  if (!renameTarget.value || !newTagName.value || newTagName.value === renameTarget.value.tag) return;

  renaming.value = true;
  try {
    const res = await contactApi.renameTag(renameTarget.value.tag, newTagName.value);
    showSnackbar(res.data.message);
    renameDialog.value = false;
    await fetchTags(); // Refresh
  } catch (err: any) {
    const msg = err?.response?.data?.error || 'Lỗi khi đổi tên Tag';
    showSnackbar(msg, 'error');
  } finally {
    renaming.value = false;
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────
function openDeleteDialog(item: TagInfo) {
  deleteTarget.value = item;
  deleteDialog.value = true;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;

  deleting.value = true;
  try {
    const res = await contactApi.deleteTag(deleteTarget.value.tag);
    showSnackbar(res.data.message);
    deleteDialog.value = false;
    await fetchTags(); // Refresh
  } catch (err: any) {
    const msg = err?.response?.data?.error || 'Lỗi khi xóa Tag';
    showSnackbar(msg, 'error');
  } finally {
    deleting.value = false;
  }
}

// ── Launch Campaign from Tag ─────────────────────────────────────────────────
function launchCampaign(tag: string) {
  router.push({
    path: '/campaigns/builder',
    query: { type: 'ADD_FRIEND', autoSelectTag: tag },
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
onMounted(() => {
  fetchTags();
});
</script>
