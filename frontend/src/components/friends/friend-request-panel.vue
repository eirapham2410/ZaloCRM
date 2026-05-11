<template>
  <!-- Loading -->
  <div v-if="loading" class="text-center py-12">
    <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
    <p class="text-body-2 text-medium-emphasis mt-4">Đang tải lời mời...</p>
  </div>

  <!-- Empty state -->
  <div v-else-if="sentRequests.length === 0" class="empty-state text-center py-16">
    <v-avatar size="96" color="surface-variant" class="mb-4">
      <v-icon size="48" color="medium-emphasis">mdi-send-clock-outline</v-icon>
    </v-avatar>
    <p class="text-h6 text-medium-emphasis">Không có lời mời nào đã gửi</p>
    <p class="text-body-2 text-medium-emphasis">
      Tìm kiếm và gửi lời mời kết bạn từ tab "Tìm kiếm"
    </p>
  </div>

  <!-- Data table -->
  <v-data-table
    v-else
    :headers="headers"
    :items="sentRequests"
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

    <template v-slot:item.status="{}">
      <v-chip size="small" color="warning" variant="tonal" label>
        <v-icon icon="mdi-clock-outline" size="14" class="mr-1"></v-icon>
        Đang chờ
      </v-chip>
    </template>

    <template v-slot:item.actions="{ item }">
      <v-btn
        size="small"
        variant="tonal"
        color="error"
        prepend-icon="mdi-close"
        @click="emit('cancel', item.userId ?? item.id)"
      >
        Hủy
      </v-btn>
    </template>
  </v-data-table>
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
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'end' as const },
];
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
