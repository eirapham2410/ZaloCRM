import { api } from './index';

export interface ZaloFriend {
  id: string;
  zaloAccountId: string;
  zaloUid: string;
  displayName?: string;
  avatarUrl?: string;
  phone?: string;
  tags: string[];
  syncedAt: string;
}

export const friendApi = {
  // Lấy danh sách bạn bè của 1 tài khoản Zalo (đã đồng bộ trong DB)
  getFriendsList: (accountId: string) => {
    return api.get<{ data: ZaloFriend[] }>(`/zalo-accounts/${accountId}/friends`);
  },

  // Dò tìm SĐT trên Zalo thông qua realtime SDK
  findUserOnZalo: (accountId: string, phone: string) => {
    return api.get<{ data: any }>(`/zalo-accounts/${accountId}/friends/find`, { params: { q: phone } });
  },

  // Tìm kiếm bằng SĐT với hệ thống anti-spam
  searchByPhone: (accountId: string, phone: string) => {
    return api.post(`/zalo-accounts/${accountId}/friends/search-by-phone`, { phone });
  },

  // Lưu ngược (write-back) danh sách UID đã resolve xuống Database
  bulkUpsertFriends: (accountId: string, items: Array<{ zaloUid: string; phone?: string; name?: string }>) => {
    return api.post<{ success: boolean; totalUpserted: number }>(`/zalo-accounts/${accountId}/friends/bulk-upsert`, items);
  },
};
