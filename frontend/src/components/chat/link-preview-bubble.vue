<template>
  <a 
    :href="content?.url" 
    target="_blank" 
    rel="noopener noreferrer" 
    class="link-preview-card d-block text-decoration-none"
  >
    <div class="d-flex rounded-lg overflow-hidden border border-border bg-surface transition-swing hover-lift">
      <!-- Thumbnail -->
      <div v-if="content?.imageUrl" class="link-thumb flex-shrink-0 bg-grey-lighten-4" style="width: 90px; min-height: 90px;">
        <v-img 
          :src="content.imageUrl" 
          width="100%" 
          height="100%" 
          cover 
        >
          <template v-slot:placeholder>
            <div class="d-flex align-center justify-center fill-height">
              <v-icon color="grey-lighten-1">mdi-image-outline</v-icon>
            </div>
          </template>
        </v-img>
      </div>

      <!-- Text content -->
      <div class="pa-3 flex-grow-1 d-flex flex-column justify-center overflow-hidden" style="min-width: 0;">
        <div class="text-body-2 font-weight-bold text-high-emphasis text-truncate mb-1">
          {{ content?.title || content?.url || 'Liên kết' }}
        </div>
        
        <div 
          v-if="content?.description" 
          class="text-caption text-medium-emphasis mb-2 line-clamp-2"
        >
          {{ content.description }}
        </div>
        
        <div class="text-caption text-disabled d-flex align-center mt-auto">
          <v-icon size="12" class="mr-1 flex-shrink-0">mdi-link-variant</v-icon>
          <span class="text-truncate">{{ content?.domain || content?.url }}</span>
        </div>
      </div>
    </div>
  </a>
</template>

<script setup lang="ts">
import type { LinkContent } from './message-content-parser';

const props = defineProps<{
  content: LinkContent | null;
}>();
</script>

<style scoped>
.link-preview-card {
  max-width: 350px;
}

.hover-lift {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.hover-lift:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08) !important;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
}
</style>
