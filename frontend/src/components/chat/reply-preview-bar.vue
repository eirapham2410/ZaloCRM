<template>
  <div
    v-if="message"
    class="reply-preview-bar d-flex align-center pa-2 px-3"
    :class="mode === 'edit' ? 'bar--edit' : 'bar--reply'"
  >
    <v-icon size="16" class="mr-2" :color="mode === 'edit' ? 'warning' : 'cyan'">
      {{ mode === 'edit' ? 'mdi-pencil-outline' : 'mdi-reply-outline' }}
    </v-icon>

    <div class="flex-grow-1 text-truncate text-body-2">
      <template v-if="mode === 'reply'">
        <span class="reply-sender">{{ message.senderName || 'Ẩn danh' }}</span>
        <span class="reply-content">
          <template v-if="contentTypeLabel">{{ contentTypeLabel }}</template>
          <template v-else>{{ truncate(message.content) }}</template>
        </span>
      </template>
      <template v-else>
        <span class="font-weight-medium">Chỉnh sửa tin nhắn</span>
        <span v-if="message.content" class="text-grey-darken-1 ml-1">— {{ truncate(message.content) }}</span>
      </template>
    </div>

    <!-- Thumbnail preview for image messages -->
    <img
      v-if="mode === 'reply' && thumbUrl"
      :src="thumbUrl"
      alt="preview"
      class="reply-thumb"
    />

    <v-btn icon size="x-small" variant="text" @click="emit('cancel')" class="ml-1">
      <v-icon size="16">mdi-close</v-icon>
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  message: {
    senderName: string | null;
    content: string | null;
    contentType?: string;
  } | null;
  mode: 'reply' | 'edit';
}>();

const emit = defineEmits<{
  cancel: [];
}>();

/** Human-readable label for non-text content types */
const contentTypeLabel = computed<string | null>(() => {
  const ct = props.message?.contentType;
  if (!ct || ct === 'text') return null;
  const labels: Record<string, string> = {
    image:     '📷 Hình ảnh',
    video:     '🎥 Video',
    file:      '📎 Tài liệu',
    sticker:   '🏷️ Nhãn dán',
    voice:     '🎤 Tin nhắn thoại',
    gif:       '🎞️ GIF',
    link:      '🔗 Liên kết',
    location:  '📍 Vị trí',
  };
  return labels[ct] ?? null;
});

/** Extract thumbnail URL for image messages */
const thumbUrl = computed<string | null>(() => {
  if (props.message?.contentType !== 'image' || !props.message.content) return null;
  const c = props.message.content;
  if (c.startsWith('http')) return c;
  try {
    const p = JSON.parse(c);
    return p.thumb || p.href || p.hdUrl || null;
  } catch {
    return null;
  }
});

function truncate(text: string | null, max = 60): string {
  if (!text) return '';
  // Don't show raw JSON
  if (text.startsWith('{')) {
    try {
      const p = JSON.parse(text);
      return truncate(p.title || p.description || '', max);
    } catch { /* fall through */ }
  }
  return text.length > max ? text.slice(0, max) + '…' : text;
}
</script>

<style scoped>
.reply-preview-bar {
  border-radius: 8px 8px 0 0;
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(8px);
  transition: background 0.2s;
}
.reply-preview-bar:hover {
  background: rgba(255, 255, 255, 0.06);
}
.bar--reply {
  border-left: 3px solid #00F2FF;
}
.bar--edit {
  border-left: 3px solid #FF9800;
}
.reply-sender {
  font-weight: 600;
  color: #00F2FF;
  margin-right: 6px;
}
.reply-content {
  opacity: 0.7;
}
.reply-thumb {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  margin-left: 8px;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
</style>
