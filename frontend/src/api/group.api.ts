import { api } from './index';

export interface ZaloGroup {
  id: string;
  zaloAccountId: string;
  zaloGroupId: string;
  name: string;
  avatar?: string | null;
  memberCount: number;
  ownerId?: string | null;
  role: string;
  metadata: Record<string, any>;
  syncedAt: string;
}

export interface GroupPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface GroupListResponse {
  data: ZaloGroup[];
  pagination: GroupPagination;
}

export interface DeduplicatedGroup {
  fingerprint: string;
  name: string;
  avatar: string | null;
  memberCount: number;
  accounts: { accountId: string; groupId: string }[];
}

export interface GroupSyncResponse {
  success: boolean;
  total: number;
  updated: number;
  deleted: number;
}

/** Thành viên của một nhóm Zalo (trả về từ zca-js getGroupMembersInfo) */
export interface GroupMember {
  id: string;           // Zalo UID of the member
  displayName: string;
  avatar?: string | null;
  role?: string;        // 'admin' | 'creator' | 'member' (or similar from Zalo SDK)
  [key: string]: any;   // zca-js may return extra fields
}

export const groupApi = {
  /** Lấy danh sách nhóm từ Database (đã đồng bộ), hỗ trợ phân trang & tìm kiếm */
  getGroups: (accountId: string, params?: { page?: number; limit?: number; search?: string }) => {
    return api.get<GroupListResponse>(`/zalo-accounts/${accountId}/groups`, { params });
  },

  /** Kích hoạt đồng bộ nhóm từ Zalo SDK → Database */
  syncGroups: (accountId: string) => {
    return api.post<GroupSyncResponse>(`/zalo-accounts/${accountId}/groups/sync`);
  },

  /** Lấy chi tiết 1 nhóm (realtime từ Zalo SDK) */
  getGroupDetail: (accountId: string, groupId: string) => {
    return api.get<{ group: any }>(`/zalo-accounts/${accountId}/groups/${groupId}`);
  },

  /** Lấy danh sách thành viên nhóm (realtime từ Zalo SDK) */
  getGroupMembers: (accountId: string, groupId: string) => {
    return api.get<{ members: GroupMember[] }>(`/zalo-accounts/${accountId}/groups/${groupId}/members`);
  },

  /** Lấy danh sách nhóm đã được deduplicate từ nhiều tài khoản */
  getDeduplicatedGroups: (accountIds: string[]) => {
    return api.post<{ data: DeduplicatedGroup[] }>('/zalo-groups/deduplicate', { accountIds });
  },
};
