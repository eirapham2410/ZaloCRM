<template>
  <v-card class="rounded-xl" elevation="1">
    <v-card-text>
      <div class="d-flex gap-2 mb-4">
        <v-text-field
          v-model="query"
          placeholder="Tìm theo tên hoặc số điện thoại..."
          prepend-inner-icon="mdi-magnify"
          variant="solo-filled"
          flat
          density="compact"
          hide-details
          clearable
          class="rounded-xl"
          @keyup.enter="onSearch"
        />
        <v-btn
          color="primary"
          :loading="loading"
          class="rounded-xl"
          @click="onSearch"
        >
          Tìm
        </v-btn>
      </div>
    </v-card-text>

    <!-- Results table -->
    <v-data-table
      v-if="results.length"
      :headers="headers"
      :items="results"
      :items-per-page="10"
      hover
      class="search-table"
    >
      <template v-slot:item.name="{ item }">
        <div class="d-flex align-center py-2">
          <v-avatar color="surface-variant" size="36" class="friend-avatar mr-3">
            <v-img v-if="item.avatar" :src="item.avatar" />
            <v-icon v-else color="on-surface-variant">mdi-account</v-icon>
          </v-avatar>
          <div>
            <div class="font-weight-medium text-high-emphasis">{{ item.displayName ?? item.name ?? item.userId }}</div>
            <div v-if="item.phone" class="text-caption text-medium-emphasis">{{ item.phone }}</div>
          </div>
        </div>
      </template>

      <template v-slot:item.actions="{ item }">
        <div class="d-flex align-center gap-1">
          <template v-if="!pendingId[item.userId ?? item.id]">
            <v-btn
              size="small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-account-plus-outline"
              class="rounded-xl"
              @click="openMessage(item.userId ?? item.id)"
            >
              Gửi lời mời
            </v-btn>
          </template>
          <template v-else>
            <v-text-field
              v-model="messageMap[item.userId ?? item.id]"
              placeholder="Lời nhắn (tuỳ chọn)"
              variant="outlined"
              density="compact"
              hide-details
              style="min-width: 160px"
              class="rounded-xl"
            />
            <v-btn size="small" color="primary" variant="flat" class="rounded-xl" @click="onSend(item.userId ?? item.id)">Gửi</v-btn>
            <v-btn size="small" variant="text" @click="closeMessage(item.userId ?? item.id)">Hủy</v-btn>
          </template>
        </div>
      </template>
    </v-data-table>

    <!-- Empty / no search -->
    <v-card-text v-else-if="!loading && searched" class="text-center py-12">
      <v-icon size="64" color="grey-lighten-1" class="mb-4">mdi-account-search-outline</v-icon>
      <p class="text-h6 text-medium-emphasis">Không tìm thấy kết quả</p>
      <p class="text-body-2 text-medium-emphasis">Thử tìm với tên hoặc số điện thoại khác</p>
    </v-card-text>

    <v-card-text v-else-if="!searched" class="text-center py-12">
      <v-icon size="64" color="grey-lighten-1" class="mb-4">mdi-account-search-outline</v-icon>
      <p class="text-h6 text-medium-emphasis">Tìm kiếm người dùng Zalo</p>
      <p class="text-body-2 text-medium-emphasis">Nhập tên hoặc số điện thoại để tìm kiếm</p>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';

defineProps<{
  results: any[];
  loading: boolean;
}>();

const emit = defineEmits<{
  search: [query: string];
  'send-request': [userId: string, message?: string];
}>();

const query = ref('');
const searched = ref(false);
const pendingId = reactive<Record<string, boolean>>({});
const messageMap = reactive<Record<string, string>>({});

const headers = [
  { title: 'Người dùng', key: 'name', sortable: false },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'end' as const },
];

function onSearch() {
  if (!query.value.trim()) return;
  searched.value = true;
  emit('search', query.value.trim());
}

function openMessage(userId: string) {
  pendingId[userId] = true;
  messageMap[userId] = '';
}

function closeMessage(userId: string) {
  pendingId[userId] = false;
}

function onSend(userId: string) {
  emit('send-request', userId, messageMap[userId] || undefined);
  pendingId[userId] = false;
}
</script>

<style scoped>
.friend-avatar {
  border: 2px solid rgb(var(--v-theme-surface));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}

.search-table :deep(tbody tr:hover) {
  background-color: rgba(var(--v-theme-primary), 0.05) !important;
  transition: background-color 0.2s ease;
}

.search-table :deep(tbody tr) {
  transition: background-color 0.2s ease;
}

.search-table :deep(th) {
  white-space: nowrap;
  font-weight: 600 !important;
  text-transform: uppercase;
  font-size: 0.75rem !important;
  letter-spacing: 0.5px;
  color: rgb(var(--v-theme-on-surface-variant)) !important;
}

:deep(.v-field) {
  border-radius: 12px !important;
}
</style>
