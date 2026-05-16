<template>
  <v-card
    class="poll-bubble cursor-pointer"
    rounded="xl"
    elevation="2"
    color="grey-darken-4"
    @click.stop="onPollClick"
  >
    <div class="d-flex align-center ga-3 pa-3">
      <div class="poll-icon-wrapper rounded-circle d-flex align-center justify-center bg-blue-grey-darken-3">
        <v-icon color="info" size="32">mdi-chart-bar</v-icon>
      </div>
      <div class="poll-content-wrapper flex-grow-1">
        <div class="text-body-1 font-weight-medium text-white mb-1">
          {{ content?.title || 'Bình chọn' }}
        </div>
        <div v-if="content?.totalVotes" class="text-caption text-grey-lighten-1">
          {{ content.totalVotes }} người đã tham gia
        </div>
      </div>
    </div>
    
    <!-- Snackbar for click notification -->
    <v-snackbar
      v-model="snackbar"
      timeout="3000"
      location="top"
      color="info"
    >
      Tính năng xem chi tiết và tham gia bình chọn trực tiếp trên CRM đang được phát triển.
      <template v-slot:actions>
        <v-btn
          color="white"
          variant="text"
          @click="snackbar = false"
        >
          Đóng
        </v-btn>
      </template>
    </v-snackbar>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { PollContent } from '@/components/chat/message-content-parser';

defineProps<{
  content: PollContent | null;
  isSelf?: boolean;
}>();

const snackbar = ref(false);

function onPollClick() {
  snackbar.value = true;
}
</script>

<style scoped>
.poll-bubble {
  min-width: 250px;
  max-width: 320px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  transition: transform 0.2s, background-color 0.2s;
}

.poll-bubble:hover {
  background-color: #333333 !important;
  transform: translateY(-1px);
}

.poll-icon-wrapper {
  width: 48px;
  height: 48px;
}
</style>
