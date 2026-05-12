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

export interface GroupSyncResponse {
  success: boolean;
  total: number;
  updated: number;
  deleted: number;
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
};
