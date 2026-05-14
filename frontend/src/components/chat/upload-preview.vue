<template>
  <div v-if="files.length > 0" class="upload-preview">
    <div class="upload-preview__header">
      <span class="upload-preview__title">
        <v-icon size="14" class="mr-1">mdi-paperclip</v-icon>
        {{ files.length }} tệp đính kèm
      </span>
      <v-btn
        icon
        size="x-small"
        variant="text"
        color="grey"
        @click="emit('clear-all')"
        title="Xóa tất cả"
      >
        <v-icon size="14">mdi-close-circle</v-icon>
      </v-btn>
    </div>
    <div class="upload-preview__list">
      <div
        v-for="(file, index) in files"
        :key="index"
        class="upload-preview__item"
      >
        <!-- Image thumbnail -->
        <img
          v-if="isImage(file)"
          :src="getObjectUrl(file)"
          alt=""
          class="upload-preview__thumb"
        />
        <!-- Video thumbnail -->
        <div v-else-if="isVideo(file)" class="upload-preview__icon upload-preview__icon--video">
          <v-icon size="24" color="white">mdi-video</v-icon>
        </div>
        <!-- Generic file icon -->
        <div v-else class="upload-preview__icon upload-preview__icon--file">
          <v-icon size="24" color="white">{{ getFileIcon(file) }}</v-icon>
        </div>

        <!-- File name & size -->
        <div class="upload-preview__info">
          <div class="upload-preview__name">{{ file.name }}</div>
          <div class="upload-preview__size">{{ formatSize(file.size) }}</div>
        </div>

        <!-- Remove button -->
        <v-btn
          icon
          size="x-small"
          variant="text"
          class="upload-preview__remove"
          @click="emit('remove', index)"
          title="Xóa tệp"
        >
          <v-icon size="14">mdi-close</v-icon>
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';

const props = defineProps<{
  files: File[];
}>();

const emit = defineEmits<{
  remove: [index: number];
  'clear-all': [];
}>();

// Cache object URLs to avoid re-creating them on every render
const urlCache = new Map<File, string>();

function getObjectUrl(file: File): string {
  if (urlCache.has(file)) return urlCache.get(file)!;
  const url = URL.createObjectURL(file);
  urlCache.set(file, url);
  return url;
}

// Revoke all cached URLs on unmount
onBeforeUnmount(() => {
  for (const url of urlCache.values()) {
    URL.revokeObjectURL(url);
  }
  urlCache.clear();
});

function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

function isVideo(file: File): boolean {
  return file.type.startsWith('video/');
}

function getFileIcon(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, string> = {
    pdf: 'mdi-file-pdf-box',
    doc: 'mdi-file-word-box',
    docx: 'mdi-file-word-box',
    xls: 'mdi-file-excel-box',
    xlsx: 'mdi-file-excel-box',
    ppt: 'mdi-file-powerpoint-box',
    pptx: 'mdi-file-powerpoint-box',
    zip: 'mdi-zip-box',
    rar: 'mdi-zip-box',
    '7z': 'mdi-zip-box',
    mp3: 'mdi-file-music',
    wav: 'mdi-file-music',
  };
  return iconMap[ext] || 'mdi-file-document-outline';
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
</script>

<style scoped>
.upload-preview {
  border: 1px solid rgba(0, 242, 255, 0.15);
  border-radius: 10px;
  background: rgba(0, 242, 255, 0.03);
  padding: 8px;
  margin-bottom: 8px;
  animation: slideUp 0.2s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.upload-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  padding: 0 4px;
}

.upload-preview__title {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
}

.upload-preview__list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px;
}

.upload-preview__item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 90px;
  max-width: 110px;
  padding: 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  transition: background 0.15s, border-color 0.15s;
}

.upload-preview__item:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(0, 242, 255, 0.2);
}

.upload-preview__thumb {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 6px;
  margin-bottom: 4px;
}

.upload-preview__icon {
  width: 72px;
  height: 72px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}

.upload-preview__icon--video {
  background: linear-gradient(135deg, #e040fb 0%, #7c4dff 100%);
}

.upload-preview__icon--file {
  background: linear-gradient(135deg, #26c6da 0%, #00838f 100%);
}

.upload-preview__info {
  text-align: center;
  width: 100%;
  min-width: 0;
}

.upload-preview__name {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.upload-preview__size {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.4);
}

.upload-preview__remove {
  position: absolute;
  top: -4px;
  right: -4px;
  background: rgba(40, 40, 50, 0.9) !important;
  border: 1px solid rgba(255, 255, 255, 0.1);
  opacity: 0;
  transition: opacity 0.15s;
}

.upload-preview__item:hover .upload-preview__remove {
  opacity: 1;
}
</style>
