<template>
  <!-- Loading -->
  <div v-if="loading" class="text-center py-12">
    <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
    <p class="text-body-2 text-medium-emphasis mt-4">Đang tải danh sách bạn bè...</p>
  </div>

  <!-- Empty state -->
  <div v-else-if="friends.length === 0" class="empty-state text-center py-16">
    <v-avatar size="96" color="surface-variant" class="mb-4">
      <v-icon size="48" color="medium-emphasis">mdi-account-group-outline</v-icon>
    </v-avatar>
    <p class="text-h6 text-medium-emphasis">Chưa có dữ liệu bạn bè</p>
    <p class="text-body-2 text-medium-emphasis mb-6">
      Hãy đồng bộ dữ liệu từ Zalo để bắt đầu quản lý danh sách bạn bè
    </p>
    <v-btn
      color="primary"
      variant="flat"
      size="large"
      prepend-icon="mdi-sync"
      @click="emit('sync')"
    >
      Đồng bộ ngay
    </v-btn>
  </div>

  <!-- Data table (flat, matching Contacts style) -->
  <v-data-table
    v-else
    :headers="headers"
    :items="friends"
    :items-per-page="15"
    :search="search"
    item-value="zaloUid"
    hover
  >
    <!-- Avatar + Name column (same sizing as Contacts) -->
    <template #item.displayName="{ item }">
      <div class="d-flex align-center py-2">
        <v-avatar size="32" color="grey-lighten-2" class="mr-3">
          <v-img v-if="item.avatarUrl || item.avatar" :src="item.avatarUrl || item.avatar" />
          <v-icon v-else size="18">mdi-account</v-icon>
        </v-avatar>
        <div>
          <span class="font-weight-medium">{{ item.displayName ?? item.name ?? item.zaloUid }}</span>
          <div v-if="item.phone" class="text-caption text-medium-emphasis">{{ item.phone }}</div>
        </div>
      </div>
    </template>

    <!-- UID column -->
    <template #item.zaloUid="{ item }">
      <span class="text-body-2 text-medium-emphasis">{{ item.zaloUid ?? item.userId ?? '—' }}</span>
    </template>

    <!-- Tags column -->
    <template #item.tags="{ item }">
      <div v-if="parsedTags(item.tags).length" class="d-flex flex-wrap gap-1">
        <v-chip
          v-for="(tag, idx) in parsedTags(item.tags)"
          :key="idx"
          size="small"
          :color="tagColor(idx)"
          variant="tonal"
          label
        >
          {{ tag }}
        </v-chip>
      </div>
      <span v-else class="text-grey">—</span>
    </template>

    <!-- Synced date -->
    <template #item.syncedAt="{ item }">
      <span class="text-body-2">{{ formatDate(item.syncedAt) }}</span>
    </template>

    <!-- Actions column -->
    <template #item.actions="{ item }">
      <v-menu>
        <template #activator="{ props }">
          <v-btn v-bind="props" icon="mdi-dots-vertical" variant="text" size="small" />
        </template>
        <v-list density="compact" elevation="3">
          <v-list-item
            prepend-icon="mdi-pencil-outline"
            title="Đặt biệt danh"
            @click="emit('set-alias', friendUid(item))"
          />
          <v-list-item
            prepend-icon="mdi-tag-off-outline"
            title="Xóa biệt danh"
            @click="emit('remove-alias', friendUid(item))"
          />
          <v-divider class="my-1" />
          <v-list-item
            prepend-icon="mdi-account-remove-outline"
            title="Xóa bạn"
            base-color="error"
            @click="emit('remove', friendUid(item))"
          />
          <v-list-item
            prepend-icon="mdi-block-helper"
            title="Chặn"
            base-color="error"
            @click="emit('block', friendUid(item))"
          />
        </v-list>
      </v-menu>
    </template>
  </v-data-table>
</template>

<script setup lang="ts">
defineProps<{
  friends: any[];
  loading: boolean;
  search?: string;
}>();

const emit = defineEmits<{
  remove: [userId: string];
  block: [userId: string];
  'set-alias': [userId: string];
  'remove-alias': [userId: string];
  sync: [];
}>();

// ── Table headers ───────────────────────────────────────────────────────────
const headers = [
  { title: 'Bạn bè', key: 'displayName', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid', sortable: true },
  { title: 'Phân loại', key: 'tags', sortable: false },
  { title: 'Đồng bộ lúc', key: 'syncedAt', sortable: true },
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: 60 },
];

// ── Pastel tag colors (rotating) ────────────────────────────────────────────
const TAG_COLORS = ['blue', 'teal', 'purple', 'orange', 'pink', 'cyan'];

function tagColor(index: number): string {
  return TAG_COLORS[index % TAG_COLORS.length];
}

/** Parse tags — hỗ trợ cả Json array string lẫn native array */
function parsedTags(tags: any): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function friendUid(item: any): string {
  return item.zaloUid ?? item.userId ?? item.id;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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
