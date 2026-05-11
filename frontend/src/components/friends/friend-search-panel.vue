<template>
  <div>
    <!-- Search bar -->
    <v-row dense class="mb-4 align-center">
      <v-col cols="12" sm="8" md="6">
        <v-text-field
          v-model="query"
          prepend-inner-icon="mdi-magnify"
          label="Tìm theo tên hoặc số điện thoại"
          clearable
          hide-details
          @keyup.enter="onSearch"
        />
      </v-col>
      <v-col cols="auto">
        <v-btn
          color="primary"
          :loading="loading"
          @click="onSearch"
        >
          Tìm
        </v-btn>
      </v-col>
    </v-row>

    <!-- Results table -->
    <v-data-table
      v-if="results.length"
      :headers="headers"
      :items="results"
      :items-per-page="10"
      hover
    >
      <template v-slot:item.name="{ item }">
        <div class="d-flex align-center py-2">
          <v-avatar size="32" color="grey-lighten-2" class="mr-3">
            <v-img v-if="item.avatar" :src="item.avatar" />
            <v-icon v-else size="18">mdi-account</v-icon>
          </v-avatar>
          <div>
            <span class="font-weight-medium">{{ item.displayName ?? item.name ?? item.userId }}</span>
            <div v-if="item.phone" class="text-caption text-medium-emphasis">{{ item.phone }}</div>
          </div>
        </div>
      </template>

      <template v-slot:item.actions="{ item }">
        <div class="d-flex align-center gap-1 justify-end">
          <template v-if="!pendingId[item.userId ?? item.id]">
            <v-btn
              size="small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-account-plus-outline"
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
            />
            <v-btn size="small" color="primary" variant="flat" @click="onSend(item.userId ?? item.id)">Gửi</v-btn>
            <v-btn size="small" variant="text" @click="closeMessage(item.userId ?? item.id)">Hủy</v-btn>
          </template>
        </div>
      </template>
    </v-data-table>

    <!-- Empty / no search -->
    <div v-else-if="!loading && searched" class="empty-state text-center py-16">
      <v-avatar size="96" color="surface-variant" class="mb-4">
        <v-icon size="48" color="medium-emphasis">mdi-account-search-outline</v-icon>
      </v-avatar>
      <p class="text-h6 text-medium-emphasis">Không tìm thấy kết quả</p>
      <p class="text-body-2 text-medium-emphasis">Thử tìm với tên hoặc số điện thoại khác</p>
    </div>

    <div v-else-if="!searched" class="empty-state text-center py-16">
      <v-avatar size="96" color="surface-variant" class="mb-4">
        <v-icon size="48" color="medium-emphasis">mdi-account-search-outline</v-icon>
      </v-avatar>
      <p class="text-h6 text-medium-emphasis">Tìm kiếm người dùng Zalo</p>
      <p class="text-body-2 text-medium-emphasis">Nhập tên hoặc số điện thoại để tìm kiếm</p>
    </div>
  </div>
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
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
