<template>
  <v-dialog v-model="isOpen" max-width="600px" persistent>
    <v-card>
      <v-card-title class="d-flex justify-space-between align-center px-6 py-4 border-b">
        <span class="text-h6 font-weight-bold">Phân quyền tài khoản Zalo</span>
        <v-btn icon="mdi-close" variant="text" size="small" @click="close"></v-btn>
      </v-card-title>

      <v-card-text class="pt-6 px-6">
        <!-- Error Alert -->
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          closable
          class="mb-4"
          @click:close="error = ''"
        >
          {{ error }}
        </v-alert>

        <!-- Loading Overlay -->
        <div v-if="loading" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary"></v-progress-circular>
        </div>

        <template v-else>
          <!-- Search & Add User -->
          <div class="mb-6">
            <div class="text-subtitle-2 mb-2 font-weight-medium">Thêm nhân viên mới</div>
            <v-autocomplete
              v-model="selectedUser"
              :items="availableUsers"
              item-title="fullName"
              item-value="id"
              placeholder="Tìm kiếm theo tên hoặc email..."
              variant="outlined"
              density="comfortable"
              prepend-inner-icon="mdi-magnify"
              hide-details
              return-object
              @update:model-value="onUserSelected"
            >
              <template v-slot:item="{ props, item }">
                <v-list-item v-bind="props" :subtitle="(item as any).raw?.email || item.email">
                  <template v-slot:prepend>
                    <v-avatar color="primary" variant="tonal" size="32" class="mr-2">
                      <span class="text-caption font-weight-medium">{{ getInitials((item as any).raw?.fullName || item.fullName) }}</span>
                    </v-avatar>
                  </template>
                </v-list-item>
              </template>
            </v-autocomplete>
          </div>

          <!-- Assigned Users List -->
          <div>
            <div class="text-subtitle-2 mb-2 font-weight-medium">
              Danh sách được cấp quyền ({{ accessList.length }})
            </div>
            
            <v-card variant="outlined" class="rounded-lg">
              <v-list lines="two" v-if="accessList.length > 0" bg-color="transparent" class="py-0">
                <template v-for="(item, index) in accessList" :key="item.userId">
                  <v-divider v-if="index > 0"></v-divider>
                  <v-list-item>
                    <template v-slot:prepend>
                      <v-avatar color="primary" variant="tonal" size="40" class="mr-3">
                        <span class="text-body-2 font-weight-medium">{{ getInitials(item.user.fullName || item.user.email) }}</span>
                      </v-avatar>
                    </template>
                    
                    <v-list-item-title class="font-weight-medium">{{ item.user.fullName || 'Chưa cập nhật tên' }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.user.email }}</v-list-item-subtitle>
                    
                    <template v-slot:append>
                      <div class="d-flex align-center gap-2">
                        <v-select
                          v-model="item.permission"
                          :items="permissionOptions"
                          item-title="title"
                          item-value="value"
                          variant="outlined"
                          density="compact"
                          hide-details
                          style="min-width: 140px;"
                        ></v-select>
                        <v-btn
                          icon="mdi-trash-can-outline"
                          variant="text"
                          color="error"
                          size="small"
                          @click="removeUser(index)"
                        ></v-btn>
                      </div>
                    </template>
                  </v-list-item>
                </template>
              </v-list>
              <div v-else class="text-center py-8 text-medium-emphasis">
                <v-icon icon="mdi-account-off-outline" size="48" class="mb-2 opacity-50"></v-icon>
                <div>Chưa có nhân viên nào được phân quyền</div>
              </div>
            </v-card>
          </div>
        </template>
      </v-card-text>

      <v-card-actions class="px-6 py-4 border-t">
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="close" :disabled="saving">Hủy</v-btn>
        <v-btn
          color="primary"
          variant="elevated"
          :loading="saving"
          @click="saveChanges"
          prepend-icon="mdi-check"
          class="px-6"
        >
          Lưu cấu hình
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';
import { useUsers, type OrgUser } from '@/composables/use-users';

const props = defineProps<{
  modelValue: boolean;
  accountId: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved'): void;
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const { fetchAccountAccessList, saveAccountAccessList } = useZaloAccounts();
const { users, fetchUsers } = useUsers();

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const selectedUser = ref<OrgUser | null>(null);

// Local state for access list
type AccessItem = {
  userId: string;
  permission: string;
  user: {
    id: string;
    fullName: string;
    email: string;
  };
};
const accessList = ref<AccessItem[]>([]);

const permissionOptions = [
  { title: 'Chỉ đọc', value: 'read' },
  { title: 'Đọc & Chat', value: 'chat' },
  { title: 'Quản trị viên', value: 'admin' },
];

// Computed list of users that aren't already assigned
const availableUsers = computed(() => {
  const assignedIds = new Set(accessList.value.map(a => a.userId));
  return users.value.filter(u => !assignedIds.has(u.id));
});

function getInitials(name: string) {
  if (!name) return 'U';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

async function loadData() {
  if (!props.accountId) return;
  
  loading.value = true;
  error.value = '';
  
  try {
    // Fetch both users list and current access list in parallel
    const [, currentAccess] = await Promise.all([
      fetchUsers(),
      fetchAccountAccessList(props.accountId)
    ]);
    
    // Map existing access data
    accessList.value = currentAccess.map((item: any) => ({
      userId: item.userId,
      permission: item.permission,
      user: item.user
    }));
  } catch (err: any) {
    error.value = 'Lỗi khi tải dữ liệu phân quyền';
    console.error(err);
  } finally {
    loading.value = false;
  }
}

watch(() => props.modelValue, (newVal) => {
  if (newVal && props.accountId) {
    loadData();
    selectedUser.value = null;
  } else {
    // Reset state on close
    accessList.value = [];
    error.value = '';
  }
});

function onUserSelected(user: OrgUser | null) {
  if (!user) return;
  
  // Add to local list with default permission
  accessList.value.unshift({
    userId: user.id,
    permission: 'chat', // Default to chat permission
    user: {
      id: user.id,
      fullName: user.fullName || '',
      email: user.email,
    }
  });
  
  // Clear selection
  selectedUser.value = null;
}

function removeUser(index: number) {
  accessList.value.splice(index, 1);
}

async function saveChanges() {
  if (!props.accountId) return;
  
  saving.value = true;
  error.value = '';
  
  try {
    const payload = accessList.value.map(item => ({
      userId: item.userId,
      permission: item.permission
    }));
    
    const result = await saveAccountAccessList(props.accountId, payload);
    
    if (result.success) {
      emit('saved');
      close();
    } else {
      error.value = result.error || 'Đã xảy ra lỗi khi lưu cấu hình';
    }
  } catch (err: any) {
    error.value = 'Đã xảy ra lỗi không xác định';
    console.error(err);
  } finally {
    saving.value = false;
  }
}

function close() {
  isOpen.value = false;
}
</script>

<style scoped>
.gap-2 {
  gap: 8px;
}
</style>
