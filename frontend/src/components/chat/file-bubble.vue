<template>
  <div 
    class="file-bubble d-flex align-center ga-3 pa-3 rounded-lg"
    :class="isSelf ? 'bg-primary text-white' : 'bg-surface border border-border text-high-emphasis'"
    style="max-width: 320px;"
  >
    <!-- File type icon -->
    <div 
      class="file-icon flex-shrink-0 d-flex align-center justify-center rounded elevation-1 bg-white" 
      style="width: 44px; height: 44px;"
    >
      <v-icon :icon="fileIconInfo.icon" size="28" :color="fileIconInfo.color" />
    </div>

    <!-- File info -->
    <div class="flex-grow-1 overflow-hidden" style="min-width: 0;">
      <div class="text-body-2 font-weight-medium text-truncate">
        {{ content?.fileName || 'Tệp đính kèm' }}
      </div>
      <div 
        class="text-caption text-truncate d-flex align-center mt-1" 
        :class="isSelf ? 'text-white opacity-80' : 'text-medium-emphasis'"
      >
        <span>{{ formattedSize }}</span>
        <span v-if="content?.extension" class="mx-1">•</span>
        <span v-if="content?.extension" class="text-uppercase">{{ content.extension }}</span>
      </div>
    </div>

    <!-- Download button -->
    <v-btn
      v-if="content?.fileUrl"
      icon 
      size="small" 
      :variant="isSelf ? 'text' : 'tonal'" 
      :color="isSelf ? 'white' : 'primary'"
      class="flex-shrink-0 ml-1"
      @click.stop="download"
    >
      <v-icon size="20">mdi-download</v-icon>
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FileContent } from './message-content-parser';
import { formatFileSize } from './message-content-parser';

const props = defineProps<{
  content: FileContent | null;
  isSelf?: boolean;
}>();

const formattedSize = computed(() => {
  return formatFileSize(props.content?.fileSize);
});

const fileIconInfo = computed(() => {
  const ext = props.content?.extension?.toLowerCase() || '';
  
  if (['pdf'].includes(ext)) {
    return { icon: 'mdi-file-pdf-box', color: 'error' };
  }
  if (['doc', 'docx'].includes(ext)) {
    return { icon: 'mdi-file-word-box', color: 'blue-darken-2' };
  }
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return { icon: 'mdi-file-excel-box', color: 'green-darken-2' };
  }
  if (['ppt', 'pptx'].includes(ext)) {
    return { icon: 'mdi-file-powerpoint-box', color: 'orange-darken-3' };
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return { icon: 'mdi-folder-zip', color: 'amber-darken-3' };
  }
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    return { icon: 'mdi-file-music', color: 'purple-darken-2' };
  }
  if (['mp4', 'avi', 'mkv', 'mov'].includes(ext)) {
    return { icon: 'mdi-file-video', color: 'pink-darken-2' };
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
    return { icon: 'mdi-file-image', color: 'teal-darken-2' };
  }
  if (['txt', 'md', 'json'].includes(ext)) {
    return { icon: 'mdi-file-document-outline', color: 'grey-darken-3' };
  }
  
  return { icon: 'mdi-file-document-outline', color: 'grey-darken-1' };
});

const download = () => {
  if (props.content?.fileUrl) {
    window.open(props.content.fileUrl, '_blank');
  }
};
</script>

<style scoped>
.opacity-80 {
  opacity: 0.8;
}
</style>
