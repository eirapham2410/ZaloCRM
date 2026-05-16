<template>
  <v-dialog v-model="isOpen" max-width="500">
    <v-card rounded="xl">
      <v-card-title class="text-h6 pt-6 px-6 font-weight-bold d-flex align-center">
        <v-icon start color="primary" class="mr-2">mdi-account-search</v-icon>
        Tìm bạn qua số điện thoại
        <v-spacer></v-spacer>
        <v-btn icon="mdi-close" variant="text" size="small" @click="isOpen = false"></v-btn>
      </v-card-title>

      <v-card-text class="px-6 pt-2 pb-6">
        <!-- Search Input -->
        <v-form @submit.prevent="onSearch" ref="form">
          <div class="d-flex align-center gap-2 mb-4">
            <v-text-field
              v-model="phone"
              :rules="phoneRules"
              label="Số điện thoại"
              placeholder="0912 345 678"
              prepend-inner-icon="mdi-phone"
              variant="outlined"
              density="comfortable"
              hide-details="auto"
              class="flex-grow-1"
              autofocus
            ></v-text-field>
            <v-btn
              color="primary"
              height="48"
              type="submit"
              :loading="searchState === 'searching'"
              :disabled="!phone"
              class="ml-2"
            >
              Tìm kiếm
            </v-btn>
          </div>
        </v-form>

        <!-- Loading State -->
        <div v-if="searchState === 'searching'" class="text-center py-8">
          <v-progress-circular indeterminate color="primary" size="40"></v-progress-circular>
          <div class="mt-3 text-body-2 text-medium-emphasis">Đang tìm kiếm người dùng...</div>
        </div>

        <!-- Error State -->
        <div v-else-if="searchState === 'error'" class="text-center py-8">
          <v-avatar size="64" color="error" variant="tonal" class="mb-3">
            <v-icon size="32" color="error">mdi-alert-circle-outline</v-icon>
          </v-avatar>
          <div class="text-body-1 font-weight-medium text-error mb-1">Lỗi tìm kiếm</div>
          <div class="text-body-2 text-medium-emphasis">{{ errorMessage }}</div>
        </div>

        <!-- Not Found State -->
        <div v-else-if="searchState === 'not_found'" class="text-center py-8">
          <v-avatar size="64" color="grey-lighten-3" class="mb-3">
            <v-icon size="32" color="grey-darken-1">mdi-emoticon-sad-outline</v-icon>
          </v-avatar>
          <div class="text-body-1 font-weight-medium mb-1">Không tìm thấy tài khoản</div>
          <div class="text-body-2 text-medium-emphasis">Số điện thoại chưa kích hoạt Zalo hoặc người dùng đã chặn tìm kiếm bằng số điện thoại.</div>
        </div>

        <!-- Found State -->
        <v-card v-else-if="searchState === 'found' && searchResult" variant="outlined" class="mt-2 pa-4 rounded-lg">
          <div class="d-flex align-center">
            <v-avatar size="60" color="primary" class="mr-4">
              <v-img v-if="searchResult.avatarUrl" :src="searchResult.avatarUrl" />
              <span v-else class="text-h5 text-white">{{ searchResult.displayName.charAt(0).toUpperCase() }}</span>
            </v-avatar>
            
            <div>
              <div class="text-subtitle-1 font-weight-bold d-flex align-center">
                {{ searchResult.displayName }}
                <v-chip v-if="searchResult.isPrivateProfile" size="x-small" color="grey" variant="tonal" class="ml-2">
                  <v-icon start size="12">mdi-shield-lock-outline</v-icon> Hồ sơ riêng tư
                </v-chip>
              </div>
              <div class="text-body-2 text-medium-emphasis d-flex align-center mt-1">
                <v-icon size="14" class="mr-1">mdi-phone</v-icon> {{ searchResult.phone }}
              </div>
              <div v-if="searchResult.contact" class="text-caption text-grey mt-1">
                <v-icon size="12" class="mr-1">mdi-card-account-details-outline</v-icon>
                CRM: {{ searchResult.contact.fullName }}
              </div>
            </div>
          </div>

          <v-divider class="my-4"></v-divider>

          <!-- Actions -->
          <div v-if="searchResult.friendshipStatus === 'friend'" class="d-flex align-center justify-space-between">
            <div class="text-success text-body-2 d-flex align-center font-weight-medium">
              <v-icon size="18" class="mr-1">mdi-check-circle</v-icon> Đã là bạn bè
            </div>
            <v-btn color="info" variant="flat" prepend-icon="mdi-message-text" @click="startChat">
              Nhắn tin
            </v-btn>
          </div>

          <div v-else-if="searchResult.friendshipStatus === 'pending_sent'" class="d-flex align-center justify-space-between">
            <div class="text-warning text-body-2 d-flex align-center font-weight-medium">
              <v-icon size="18" class="mr-1">mdi-clock-outline</v-icon> Chờ chấp nhận
            </div>
            <v-btn color="grey" variant="flat" disabled prepend-icon="mdi-account-clock">
              Đã gửi lời mời
            </v-btn>
          </div>
          
          <div v-else-if="searchResult.friendshipStatus === 'pending_received'" class="d-flex align-center justify-space-between">
            <div class="text-warning text-body-2 d-flex align-center font-weight-medium">
              <v-icon size="18" class="mr-1">mdi-alert-circle-outline</v-icon> Đang chờ bạn duyệt
            </div>
            <v-btn color="success" variant="flat" prepend-icon="mdi-account-check">
              Chấp nhận (Từ danh sách)
            </v-btn>
          </div>

          <div v-else-if="searchResult.friendshipStatus === 'none'">
            <v-textarea
              v-model="inviteMessage"
              label="Lời nhắn kết bạn"
              variant="outlined"
              density="compact"
              rows="2"
              auto-grow
              hide-details
              class="mb-3"
            ></v-textarea>
            
            <v-btn
              color="primary"
              variant="flat"
              block
              prepend-icon="mdi-account-plus"
              :loading="sendingRequest"
              @click="sendFriendRequest"
            >
              Gửi lời mời kết bạn
            </v-btn>
          </div>
        </v-card>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useFriends } from '@/composables/use-friends';

const props = defineProps<{
  modelValue: boolean;
  accountId: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'friend-request-sent': [zaloUid: string];
  'start-chat': [zaloUid: string];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
});

const form = ref<any>(null);
const phone = ref('');
const searchState = ref<'idle' | 'searching' | 'found' | 'not_found' | 'error'>('idle');
const errorMessage = ref('');
const inviteMessage = ref('Xin chào, mình kết bạn nhé!');
const sendingRequest = ref(false);

const searchResult = ref<{
  zaloUid: string;
  displayName: string;
  avatarUrl: string | null;
  phone: string;
  friendshipStatus: 'friend' | 'pending_sent' | 'pending_received' | 'none';
  isPrivateProfile?: boolean;
  contact: { id: string; fullName: string; status: string } | null;
} | null>(null);

const phoneRules = [
  (v: string) => !!v || 'Vui lòng nhập số điện thoại',
  (v: string) => /^[\d\s+\-().]+$/.test(v) || 'Chỉ được nhập số',
  (v: string) => {
    const digits = v.replace(/\D/g, '');
    return (digits.length >= 9 && digits.length <= 11) || 'Số điện thoại phải từ 9-11 chữ số';
  },
];

const { searchByPhone, sendRequest } = useFriends();

// Reset state when dialog opens
watch(isOpen, (newVal) => {
  if (newVal) {
    phone.value = '';
    searchState.value = 'idle';
    searchResult.value = null;
    errorMessage.value = '';
    inviteMessage.value = 'Xin chào, mình kết bạn nhé!';
  }
});

async function onSearch() {
  if (!form.value) return;
  const { valid } = await form.value.validate();
  if (!valid) return;

  searchState.value = 'searching';
  errorMessage.value = '';
  searchResult.value = null;

  try {
    const result = await searchByPhone(props.accountId, phone.value);
    if (result.success && result.data) {
      searchResult.value = result.data;
      searchState.value = 'found';
    } else {
      if (result.code === 'USER_NOT_FOUND') {
        searchState.value = 'not_found';
      } else {
        searchState.value = 'error';
        errorMessage.value = result.message || 'Lỗi không xác định';
      }
    }
  } catch (err: any) {
    const errorData = err.response?.data;
    if (errorData?.code === 'USER_NOT_FOUND') {
      searchState.value = 'not_found';
    } else if (errorData?.code === 'TEMP_BLOCKED' || errorData?.code === 'RATE_LIMITED') {
      searchState.value = 'error';
      errorMessage.value = errorData.message;
    } else {
      searchState.value = 'error';
      errorMessage.value = errorData?.message || errorData?.error || 'Lỗi kết nối máy chủ';
    }
  }
}

async function sendFriendRequest() {
  if (!searchResult.value || !props.accountId) return;
  
  sendingRequest.value = true;
  try {
    await sendRequest(props.accountId, searchResult.value.zaloUid, inviteMessage.value);
    searchResult.value.friendshipStatus = 'pending_sent';
    emit('friend-request-sent', searchResult.value.zaloUid);
  } catch (err: any) {
    console.error('Failed to send friend request:', err);
  } finally {
    sendingRequest.value = false;
  }
}

function startChat() {
  if (!searchResult.value) return;
  emit('start-chat', searchResult.value.zaloUid);
  isOpen.value = false;
}
</script>

<style scoped>
</style>
