<template>
  <v-dialog v-model="isProfileOpen" max-width="400">
    <v-card rounded="xl">
      <!-- Loading Skeleton -->
      <v-skeleton-loader v-if="loading" type="avatar, text, text, actions" class="pa-4" />

      <!-- Profile Content -->
      <template v-else-if="profile">
        <!-- Header -->
        <div class="text-center pa-6 pb-2">
          <v-avatar size="80" :color="avatarColor" class="mb-3">
            <v-img v-if="profile.avatarUrl" :src="profile.avatarUrl" />
            <span v-else class="text-h4 text-white">{{ initial }}</span>
          </v-avatar>
          <h3 class="text-h6 font-weight-bold mb-1">{{ profile.displayName }}</h3>
          
          <div v-if="profile.crmName" class="text-caption text-grey">CRM: {{ profile.crmName }}</div>
          
          <v-chip v-if="profile.friendshipStatus === 'friend'" color="success" size="small" class="mt-2" variant="flat">
            <v-icon start size="14">mdi-check-circle</v-icon> Đã là bạn bè
          </v-chip>
        </div>

        <!-- Info List -->
        <v-list density="compact" class="px-2">
          <v-list-item v-if="profile.phone" prepend-icon="mdi-phone" :title="profile.phone" />
          <v-list-item v-if="profile.email" prepend-icon="mdi-email" :title="profile.email" />
          <v-list-item v-if="profile.contactStatus" prepend-icon="mdi-tag" :title="profile.contactStatus" />
          <v-list-item v-if="profile.source" prepend-icon="mdi-source-branch" :title="profile.source" />
        </v-list>

        <!-- Actions -->
        <v-card-actions v-if="!profile.isSelf" class="justify-center pa-4 pt-2">
          <!-- Friend Status Button -->
          <v-btn
            v-if="profile.friendshipStatus === 'pending_sent'"
            color="grey"
            variant="flat"
            disabled
          >
            <v-icon start>mdi-clock-outline</v-icon> Đã gửi lời mời
          </v-btn>
          
          <v-btn
            v-else-if="profile.friendshipStatus === 'pending_received'"
            color="warning"
            variant="flat"
            :loading="actionLoading"
            @click="acceptFriendRequest"
          >
            <v-icon start>mdi-account-check</v-icon> Chấp nhận kết bạn
          </v-btn>

          <v-btn
            v-else-if="profile.friendshipStatus === 'none'"
            color="primary"
            variant="flat"
            :loading="actionLoading"
            @click="sendFriendRequest"
          >
            <v-icon start>mdi-account-plus</v-icon> Kết bạn
          </v-btn>

          <!-- Private Chat Button -->
          <v-btn
            color="info"
            variant="tonal"
            :loading="chatLoading"
            @click="startPrivateChat"
          >
            <v-icon start>mdi-message-text</v-icon> Nhắn tin riêng
          </v-btn>
        </v-card-actions>
      </template>
      
      <!-- Error State -->
      <div v-else class="pa-6 text-center text-error">
        Không thể tải thông tin hồ sơ
      </div>
    </v-card>

    <!-- Snackbar for notifications -->
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" :timeout="3000" location="bottom right">
      {{ snackbar.text }}
    </v-snackbar>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useChat, type UserProfile } from '@/composables/use-chat';
import { api } from '@/api/index';

const { isProfileOpen, profileZaloUid, profileAccountId, fetchUserProfile, getOrCreatePrivateChat } = useChat();

const snackbar = ref({ show: false, text: '', color: 'success' });
const showSnackbar = (text: string, color: string = 'success') => {
  snackbar.value = { show: true, text, color };
};

const profile = ref<UserProfile | null>(null);
const loading = ref(false);
const actionLoading = ref(false);
const chatLoading = ref(false);

// Fallback avatar color based on UID
function getDeterministicColor(uid: string): string {
  const colors = ['primary', 'teal', 'orange', 'purple', 'indigo', 'cyan', 'deep-orange', 'brown'];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = uid.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

const avatarColor = computed(() => {
  if (profile.value?.avatarUrl) return 'transparent';
  return profile.value?.zaloUid ? getDeterministicColor(profile.value.zaloUid) : 'primary';
});

const initial = computed(() => {
  return profile.value?.displayName?.charAt(0).toUpperCase() || '?';
});

watch(isProfileOpen, async (isOpen) => {
  if (isOpen && profileZaloUid.value && profileAccountId.value) {
    loading.value = true;
    profile.value = await fetchUserProfile(profileZaloUid.value, profileAccountId.value);
    loading.value = false;
  } else if (!isOpen) {
    profile.value = null; // Clear data when closing
  }
});

async function sendFriendRequest() {
  if (!profileZaloUid.value || !profileAccountId.value) return;
  actionLoading.value = true;
  try {
    await api.post(`/friends/requests`, {
      userId: profileZaloUid.value,
      message: 'Xin chào, mình kết bạn nhé!' // Or open a dialog to input message
    }, {
      params: { accountId: profileAccountId.value } // Depending on how friend-routes is registered. Actually it's /api/v1/friends/:accountId/requests
    });
    // For friend-routes.ts, the route is:
    // app.post(`${BASE}/requests`, ... ) where BASE is /api/v1/friends/:accountId
  } catch (err: any) {
    // Actually the friend route is: POST /api/v1/friends/:accountId/requests
    try {
      await api.post(`/friends/${profileAccountId.value}/requests`, {
        userId: profileZaloUid.value,
        message: 'Xin chào, mình kết bạn nhé!'
      });
      showSnackbar('Đã gửi lời mời kết bạn', 'success');
      // Refresh profile to update button status
      profile.value = await fetchUserProfile(profileZaloUid.value, profileAccountId.value);
    } catch (innerErr: any) {
      console.error('Failed to send friend request:', innerErr);
      showSnackbar(innerErr.response?.data?.error || 'Lỗi khi gửi lời mời kết bạn', 'error');
    }
  }
  actionLoading.value = false;
}

async function acceptFriendRequest() {
  if (!profileZaloUid.value || !profileAccountId.value) return;
  actionLoading.value = true;
  try {
    // Implement accept endpoint if it exists, or just send a friend request back
    await api.post(`/friends/${profileAccountId.value}/requests/${profileZaloUid.value}/accept`);
    showSnackbar('Đã chấp nhận kết bạn', 'success');
    profile.value = await fetchUserProfile(profileZaloUid.value, profileAccountId.value);
  } catch (err: any) {
    console.error('Failed to accept friend request:', err);
    showSnackbar(err.response?.data?.error || 'Lỗi khi chấp nhận kết bạn', 'error');
  }
  actionLoading.value = false;
}

async function startPrivateChat() {
  if (!profileZaloUid.value || !profileAccountId.value) return;
  chatLoading.value = true;
  
  const conversationId = await getOrCreatePrivateChat(profileZaloUid.value, profileAccountId.value);
  
  chatLoading.value = false;
  if (conversationId) {
    isProfileOpen.value = false;
  } else {
    showSnackbar('Lỗi khi mở cuộc trò chuyện', 'error');
  }
}
</script>

<style scoped>
/* Optional specific styling for the profile card */
</style>
