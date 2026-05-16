<template>
  <div class="gif-container d-inline-block position-relative">
    <v-img
      v-if="!hasError && content?.gifUrl"
      :src="content.gifUrl"
      alt="GIF"
      class="gif-img rounded-lg"
      max-width="250"
      @error="hasError = true"
    >
      <template v-slot:placeholder>
        <div class="d-flex align-center justify-center fill-height bg-grey-lighten-4" style="min-height: 100px;">
          <v-progress-circular indeterminate color="grey-lighten-1" size="24"></v-progress-circular>
        </div>
      </template>
    </v-img>
    <div v-else class="gif-fallback d-flex align-center justify-center bg-grey-lighten-4 rounded-lg" style="width: 150px; height: 100px;">
      <v-icon size="40" color="grey">mdi-gif</v-icon>
    </div>
    
    <!-- GIF Badge Overlay -->
    <v-chip
      v-if="!hasError && content?.gifUrl"
      size="x-small"
      color="black"
      variant="flat"
      class="position-absolute font-weight-bold"
      style="top: 8px; left: 8px; opacity: 0.6; pointer-events: none;"
    >
      GIF
    </v-chip>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { GifContent } from './message-content-parser';

const props = defineProps<{
  content: GifContent | null;
}>();

const hasError = ref(false);
</script>

<style scoped>
.gif-container {
  background: transparent;
  line-height: 0;
}
</style>
