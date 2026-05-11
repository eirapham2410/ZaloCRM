<template>
  <div class="friends-page">
    <!-- ═══ Header ═══ -->
    <div class="d-flex align-center mb-4 flex-wrap gap-2">
      <h1 class="text-h5 mr-4">Bạn bè Zalo</h1>
      <v-spacer />
      <v-btn
        v-if="selectedAccountId"
        variant="outlined"
        prepend-icon="mdi-sync"
        :loading="syncing"
        :disabled="syncing"
        class="mr-2"
        @click="syncFriendsAction"
      >
        Đồng bộ dữ liệu
      </v-btn>
    </div>

    <!-- ═══ Sync Progress ═══ -->
    <v-progress-linear
      v-if="syncing"
      indeterminate
      color="primary"
      height="3"
      class="mb-4"
      rounded
    />

    <!-- ═══ Summary Stats (inline chips, like Contacts toolbar) ═══ -->
    <div v-if="selectedAccountId" class="d-flex align-center gap-3 mb-4 flex-wrap">
      <v-chip variant="tonal" color="primary" size="small">
        <v-icon start size="16">mdi-account-multiple</v-icon>
        {{ friends.length.toLocaleString() }} bạn bè
      </v-chip>
      <v-chip variant="tonal" color="success" size="small">
        <v-icon start size="16">mdi-circle-small</v-icon>
        {{ onlineFriends.length.toLocaleString() }} online
      </v-chip>
      <v-chip variant="tonal" color="warning" size="small">
        <v-icon start size="16">mdi-account-clock</v-icon>
        {{ sentRequests.length }} lời mời
      </v-chip>
    </div>

    <!-- ═══ Filters (flat row, same as ContactFilters) ═══ -->
    <v-row dense class="mb-2 align-center">
      <v-col cols="12" sm="4">
        <v-select
          v-model="selectedAccountId"
          :items="accounts"
          item-title="displayName"
          item-value="id"
          label="Tài khoản Zalo"
          clearable
          hide-details
          prepend-inner-icon="mdi-cellphone-link"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          label="Tìm kiếm tên / SĐT / UID"
          clearable
          hide-details
        />
      </v-col>
      <v-col cols="12" sm="4" class="d-flex justify-end">
        <v-chip-group v-model="tab" mandatory selected-class="text-primary">
          <v-chip value="all" filter variant="outlined" size="small">Tất cả</v-chip>
          <v-chip value="online" filter variant="outlined" size="small" color="success">Online</v-chip>
          <v-chip value="requests" filter variant="outlined" size="small">Lời mời</v-chip>
          <v-chip value="search" filter variant="outlined" size="small">Tìm kiếm</v-chip>
          <v-chip value="recommendations" filter variant="outlined" size="small">Gợi ý</v-chip>
        </v-chip-group>
      </v-col>
    </v-row>

    <!-- ═══ No account selected (Empty State) ═══ -->
    <div v-if="!selectedAccountId" class="empty-state text-center py-16">
      <v-avatar size="96" color="surface-variant" class="mb-4">
        <v-icon size="48" color="medium-emphasis">mdi-account-multiple-outline</v-icon>
      </v-avatar>
      <p class="text-h6 text-medium-emphasis">Chọn tài khoản Zalo để bắt đầu</p>
      <p class="text-body-2 text-medium-emphasis">Sử dụng bộ lọc phía trên để chọn tài khoản cần xem</p>
    </div>

    <!-- ═══ Tab Content ═══ -->
    <template v-else>
      <v-window v-model="tab">
        <!-- All friends -->
        <v-window-item value="all">
          <FriendDataTable
            :friends="filteredFriends"
            :loading="loading"
            :search="search"
            @remove="onRemove"
            @block="onBlock"
            @set-alias="openAliasDialog"
            @remove-alias="onRemoveAlias"
            @sync="syncFriendsAction"
          />
        </v-window-item>

        <!-- Online -->
        <v-window-item value="online">
          <FriendDataTable
            :friends="filteredOnline"
            :loading="loading"
            :search="search"
            @remove="onRemove"
            @block="onBlock"
            @set-alias="openAliasDialog"
            @remove-alias="onRemoveAlias"
            @sync="syncFriendsAction"
          />
        </v-window-item>

        <!-- Requests -->
        <v-window-item value="requests">
          <FriendRequestPanel
            :sent-requests="sentRequests"
            :loading="loading"
            @cancel="onCancelRequest"
            @accept="onAcceptRequest"
            @reject="onRejectRequest"
          />
        </v-window-item>

        <!-- Search -->
        <v-window-item value="search">
          <FriendSearchPanel
            :results="searchResults"
            :loading="loading"
            @search="onSearch"
            @send-request="onSendRequest"
          />
        </v-window-item>

        <!-- Recommendations -->
        <v-window-item value="recommendations">
          <!-- Loading -->
          <div v-if="loading" class="text-center py-12">
            <v-progress-circular indeterminate color="primary" size="48"></v-progress-circular>
            <p class="text-body-2 text-medium-emphasis mt-4">Đang tải gợi ý...</p>
          </div>

          <!-- Empty -->
          <div v-else-if="!recommendations.length" class="empty-state text-center py-16">
            <v-avatar size="96" color="surface-variant" class="mb-4">
              <v-icon size="48" color="medium-emphasis">mdi-account-star-outline</v-icon>
            </v-avatar>
            <p class="text-h6 text-medium-emphasis">Không có gợi ý nào</p>
            <p class="text-body-2 text-medium-emphasis">Zalo chưa có gợi ý kết bạn mới cho tài khoản này</p>
          </div>

          <!-- Data table -->
          <v-data-table
            v-else
            :headers="recommendHeaders"
            :items="recommendations"
            :items-per-page="10"
            hover
          >
            <template v-slot:item.name="{ item }">
              <div class="d-flex align-center py-2">
                <v-avatar size="32" color="grey-lighten-2" class="mr-3">
                  <v-img v-if="item.avatar" :src="item.avatar" />
                  <v-icon v-else size="18">mdi-account</v-icon>
                </v-avatar>
                <div>
                  <div class="font-weight-medium">{{ item.displayName ?? item.name ?? item.userId }}</div>
                  <div v-if="item.phone" class="text-caption text-medium-emphasis">{{ item.phone }}</div>
                </div>
              </div>
            </template>
            <template v-slot:item.actions="{ item }">
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-account-plus-outline"
                @click="onSendRequest(item.userId ?? item.id)"
              >
                Thêm bạn
              </v-btn>
            </template>
          </v-data-table>
        </v-window-item>
      </v-window>
    </template>

    <!-- ═══ Alias Dialog ═══ -->
    <v-dialog v-model="aliasDialog" max-width="420">
      <v-card>
        <v-card-title class="text-h6 d-flex align-center">
          <v-icon icon="mdi-pencil-outline" color="primary" class="mr-2"></v-icon>
          Đặt biệt danh
        </v-card-title>
        <v-card-text>
          <v-text-field
            v-model="aliasInput"
            label="Biệt danh"
            variant="outlined"
            density="compact"
            autofocus
            @keyup.enter="confirmAlias"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="aliasDialog = false">Hủy</v-btn>
          <v-btn color="primary" variant="flat" @click="confirmAlias">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ═══ Snackbar ═══ -->
    <v-snackbar v-model="toast" :color="toastColor" :timeout="4000" location="bottom right">
      {{ toastMessage }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useSelectedAccount } from '@/composables/use-selected-account';
import { useFriends } from '@/composables/use-friends';
import FriendDataTable from '@/components/friends/friend-list.vue';
import FriendRequestPanel from '@/components/friends/friend-request-panel.vue';
import FriendSearchPanel from '@/components/friends/friend-search-panel.vue';

const { selectedAccountId, accounts } = useSelectedAccount();
const {
  friends, onlineFriends, sentRequests, recommendations, searchResults, loading, syncing,
  fetchFriends, syncFriends, fetchOnlineFriends, fetchSentRequests, fetchRecommendations,
  searchFriends, sendRequest, acceptRequest, rejectRequest, cancelRequest,
  removeFriend, blockUser, setAlias, removeAlias,
} = useFriends();

const tab = ref('all');
const search = ref('');
const aliasDialog = ref(false);
const aliasInput = ref('');
const aliasPendingUserId = ref('');

// Toast notification
const toast = ref(false);
const toastMessage = ref('');
const toastColor = ref('success');

// Recommendation table headers
const recommendHeaders = [
  { title: 'Người dùng', key: 'name', sortable: false },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'center' as const },
];

function showToast(message: string, color = 'success') {
  toastMessage.value = message;
  toastColor.value = color;
  toast.value = true;
}

/** Lọc bạn bè theo search query (ở tầng View) */
function filterBySearch(list: any[]): any[] {
  if (!search.value) return list;
  const q = search.value.toLowerCase();
  return list.filter((f) => {
    const name = (f.displayName ?? f.name ?? '').toLowerCase();
    const phone = (f.phone ?? '').toLowerCase();
    const uid = (f.zaloUid ?? f.userId ?? '').toLowerCase();
    return name.includes(q) || phone.includes(q) || uid.includes(q);
  });
}

const filteredFriends = computed(() => filterBySearch(friends.value));
const filteredOnline = computed(() => filterBySearch(onlineFriends.value));

async function loadAll(accountId: string) {
  await Promise.all([
    fetchFriends(accountId),
    fetchOnlineFriends(accountId),
    fetchSentRequests(accountId),
    fetchRecommendations(accountId),
  ]);
}

onMounted(() => {
  if (selectedAccountId.value) loadAll(selectedAccountId.value);
});

watch(selectedAccountId, (id) => {
  if (id) loadAll(id);
});

/** Đồng bộ bạn bè từ Zalo SDK → Database */
async function syncFriendsAction() {
  if (!selectedAccountId.value) return;
  try {
    const result = await syncFriends(selectedAccountId.value);
    const synced = result?.totalSynced ?? 0;
    const removed = result?.removed ?? 0;
    showToast(`Đồng bộ thành công: ${synced} bạn bè, ${removed} đã xóa`, 'success');
  } catch {
    showToast('Đồng bộ thất bại. Vui lòng thử lại.', 'error');
  }
}

async function onRemove(userId: string) {
  if (selectedAccountId.value) await removeFriend(selectedAccountId.value, userId);
}

async function onBlock(userId: string) {
  if (selectedAccountId.value) await blockUser(selectedAccountId.value, userId);
}

function openAliasDialog(userId: string) {
  aliasPendingUserId.value = userId;
  aliasInput.value = '';
  aliasDialog.value = true;
}

async function confirmAlias() {
  if (selectedAccountId.value && aliasPendingUserId.value && aliasInput.value.trim()) {
    await setAlias(selectedAccountId.value, aliasPendingUserId.value, aliasInput.value.trim());
  }
  aliasDialog.value = false;
}

async function onRemoveAlias(userId: string) {
  if (selectedAccountId.value) await removeAlias(selectedAccountId.value, userId);
}

async function onCancelRequest(userId: string) {
  if (selectedAccountId.value) {
    await cancelRequest(selectedAccountId.value, userId);
    await fetchSentRequests(selectedAccountId.value);
  }
}

async function onAcceptRequest(userId: string) {
  if (selectedAccountId.value) {
    await acceptRequest(selectedAccountId.value, userId);
    await fetchFriends(selectedAccountId.value);
  }
}

async function onRejectRequest(userId: string) {
  if (selectedAccountId.value) {
    await rejectRequest(selectedAccountId.value, userId);
  }
}

async function onSearch(query: string) {
  if (selectedAccountId.value) await searchFriends(selectedAccountId.value, query);
}

async function onSendRequest(userId: string, message?: string) {
  if (selectedAccountId.value) await sendRequest(selectedAccountId.value, userId, message);
}
</script>

<style scoped>
.friends-page {
  min-height: 100%;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>
