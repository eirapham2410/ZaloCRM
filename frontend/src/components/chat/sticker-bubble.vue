<template>
  <div class="sticker-container d-inline-block">
    <v-img
      v-if="!hasError && content?.stickerUrl"
      :src="content.stickerUrl"
      alt="Sticker"
      class="sticker-img"
      max-width="120"
      max-height="120"
      @error="hasError = true"
    >
      <template v-slot:placeholder>
        <div class="d-flex align-center justify-center fill-height">
          <v-progress-circular indeterminate color="grey-lighten-1" size="24"></v-progress-circular>
        </div>
      </template>
    </v-img>
    <div v-else class="sticker-fallback d-flex align-center justify-center bg-grey-lighten-4 rounded-lg" style="width: 80px; height: 80px;">
      <v-icon size="32" color="grey">mdi-sticker-emoji</v-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { StickerContent } from './message-content-parser';

const props = defineProps<{
  content: StickerContent | null;
}>();

const hasError = ref(false);
</script>

<style scoped>
.sticker-container {
  background: transparent;
  line-height: 0;
}
</style>
