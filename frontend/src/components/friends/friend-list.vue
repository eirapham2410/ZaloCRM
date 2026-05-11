<template>
  <v-card class="rounded-xl" elevation="1">
    <!-- Loading -->
    <v-card-text v-if="loading" class="text-center py-12">
      <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
      <p class="text-body-2 text-medium-emphasis mt-4">Đang tải danh sách bạn bè...</p>
    </v-card-text>

    <!-- Empty state -->
    <v-card-text v-else-if="friends.length === 0" class="text-center py-16">
      <div class="empty-illustration mb-6">
        <v-avatar size="120" color="primary" variant="tonal" class="mb-4">
          <v-icon size="64" color="primary">mdi-account-group-outline</v-icon>
        </v-avatar>
      </div>
      <p class="text-h6 text-medium-emphasis">Chưa có dữ liệu bạn bè</p>
      <p class="text-body-2 text-medium-emphasis mb-6">
        Hãy đồng bộ dữ liệu từ Zalo để bắt đầu quản lý danh sách bạn bè
      </p>
      <v-btn
        color="primary"
        variant="flat"
        size="large"
        prepend-icon="mdi-sync"
        class="rounded-xl"
        @click="emit('sync')"
      >
        Đồng bộ ngay
      </v-btn>
    </v-card-text>

    <!-- Data table -->
    <v-data-table
      v-else
      :headers="headers"
      :items="friends"
      :items-per-page="15"
      :search="search"
      hover
      class="friends-table"
    >
      <!-- Avatar + Name column -->
      <template v-slot:item.displayName="{ item }">
        <div class="d-flex align-center py-3">
          <v-avatar size="40" class="friend-avatar mr-3" color="surface-variant">
            <v-img v-if="item.avatarUrl || item.avatar" :src="item.avatarUrl || item.avatar" />
            <v-icon v-else color="on-surface-variant" size="20">mdi-account</v-icon>
          </v-avatar>
          <div>
            <div class="text-body-1 font-weight-bold text-high-emphasis">
              {{ item.displayName ?? item.name ?? item.zaloUid }}
            </div>
            <div v-if="item.phone" class="text-caption text-medium-emphasis d-flex align-center">
              <v-icon size="12" class="mr-1">mdi-phone-outline</v-icon>
              {{ item.phone }}
            </div>
          </div>
        </div>
      </template>

      <!-- UID column (monospace) -->
      <template v-slot:item.zaloUid="{ item }">
        <code class="uid-code">{{ item.zaloUid ?? item.userId ?? '—' }}</code>
      </template>

      <!-- Tags column -->
      <template v-slot:item.tags="{ item }">
        <div v-if="parsedTags(item.tags).length" class="d-flex flex-wrap gap-1">
          <v-chip
            v-for="(tag, idx) in parsedTags(item.tags)"
            :key="idx"
            size="small"
            :color="tagColor(idx)"
            variant="flat"
            label
            class="font-weight-medium"
          >
            {{ tag }}
          </v-chip>
        </div>
        <span v-else class="text-medium-emphasis">—</span>
      </template>

      <!-- Synced date -->
      <template v-slot:item.syncedAt="{ item }">
        <span class="text-body-2 text-medium-emphasis">{{ formatDate(item.syncedAt) }}</span>
      </template>

      <!-- Actions column -->
      <template v-slot:item.actions="{ item }">
        <v-menu>
          <template #activator="{ props }">
            <v-btn v-bind="props" icon="mdi-dots-vertical" variant="text" size="small" />
          </template>
          <v-list density="compact" class="rounded-xl" elevation="3">
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
  </v-card>
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
  { title: '', key: 'actions', sortable: false, align: 'center' as const, width: 60 },
];

// ── Pastel tag colors (rotating) ────────────────────────────────────────────
const TAG_COLORS = ['blue-lighten-4', 'teal-lighten-4', 'purple-lighten-4', 'orange-lighten-4', 'pink-lighten-4', 'cyan-lighten-4', 'lime-lighten-4'];

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
.friend-avatar {
  border: 2px solid rgb(var(--v-theme-surface));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  flex-shrink: 0;
}

.uid-code {
  font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
  font-size: 0.8rem;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgb(var(--v-theme-surface-variant));
  padding: 2px 8px;
  border-radius: 6px;
  letter-spacing: 0.3px;
}

/* Hover effect on table rows */
.friends-table :deep(tbody tr:hover) {
  background-color: rgba(var(--v-theme-primary), 0.05) !important;
  transition: background-color 0.2s ease;
}

.friends-table :deep(tbody tr) {
  transition: background-color 0.2s ease;
}

.friends-table :deep(th) {
  white-space: nowrap;
  font-weight: 600 !important;
  text-transform: uppercase;
  font-size: 0.75rem !important;
  letter-spacing: 0.5px;
  color: rgb(var(--v-theme-on-surface-variant)) !important;
}

.empty-illustration {
  display: flex;
  justify-content: center;
}
</style>
