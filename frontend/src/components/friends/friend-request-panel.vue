<template>
  <v-card class="rounded-xl" elevation="1">
    <!-- Loading -->
    <v-card-text v-if="loading" class="text-center py-12">
      <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
      <p class="text-body-2 text-medium-emphasis mt-4">Đang tải lời mời...</p>
    </v-card-text>

    <!-- Empty state -->
    <v-card-text v-else-if="sentRequests.length === 0" class="text-center py-12">
      <v-icon size="64" color="grey-lighten-1" class="mb-4">mdi-send-clock-outline</v-icon>
      <p class="text-h6 text-medium-emphasis">Không có lời mời nào đã gửi</p>
      <p class="text-body-2 text-medium-emphasis">
        Tìm kiếm và gửi lời mời kết bạn từ tab "Tìm kiếm"
      </p>
    </v-card-text>

    <!-- Data table -->
    <v-data-table
      v-else
      :headers="headers"
      :items="sentRequests"
      :items-per-page="10"
      hover
      class="requests-table"
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

      <template v-slot:item.status="{}">
        <v-chip size="small" color="warning" variant="flat" label>
          <v-icon icon="mdi-clock-outline" size="14" class="mr-1"></v-icon>
          Đang chờ
        </v-chip>
      </template>

      <template v-slot:item.actions="{ item }">
        <v-btn
          size="small"
          variant="outlined"
          color="error"
          prepend-icon="mdi-close"
          class="rounded-xl"
          @click="emit('cancel', item.userId ?? item.id)"
        >
          Hủy
        </v-btn>
      </template>
    </v-data-table>
  </v-card>
</template>

<script setup lang="ts">
defineProps<{
  sentRequests: any[];
  loading: boolean;
}>();

const emit = defineEmits<{
  cancel: [userId: string];
  accept: [userId: string];
  reject: [userId: string];
}>();

const headers = [
  { title: 'Người dùng', key: 'name', sortable: false },
  { title: 'Trạng thái', key: 'status', sortable: false, align: 'center' as const },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'center' as const },
];
</script>

<style scoped>
.friend-avatar {
  border: 2px solid rgb(var(--v-theme-surface));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}

.requests-table :deep(tbody tr:hover) {
  background-color: rgba(var(--v-theme-warning), 0.05) !important;
  transition: background-color 0.2s ease;
}

.requests-table :deep(tbody tr) {
  transition: background-color 0.2s ease;
}

.requests-table :deep(th) {
  white-space: nowrap;
  font-weight: 600 !important;
  text-transform: uppercase;
  font-size: 0.75rem !important;
  letter-spacing: 0.5px;
  color: rgb(var(--v-theme-on-surface-variant)) !important;
}
</style>
