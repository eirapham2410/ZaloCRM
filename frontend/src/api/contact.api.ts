import { api } from './index';

export interface ContactItem {
  id: string;
  fullName?: string;
  phone?: string;
  email?: string;
  zaloUid?: string;
  avatarUrl?: string;
  tags?: string[];
  assignedUser?: { id: string; fullName: string; email: string };
}

export interface TagInfo {
  tag: string;
  count: number;
}

export const contactApi = {
  getContacts(params: {
    page?: number;
    limit?: number;
    search?: string;
    source?: string;
    status?: string;
    assignedUserId?: string;
    tags?: string;
  }) {
    return api.get<{ contacts: ContactItem[]; total: number; page: number; limit: number }>('/contacts', { params });
  },

  /** Lấy danh sách tag unique + số lượng contact mỗi tag (scoped by role) */
  getTags() {
    return api.get<{ success: boolean; tags: TagInfo[] }>('/contacts/tags');
  },

  /** Đổi tên tag hàng loạt trên tất cả contact thuộc quyền sở hữu */
  renameTag(oldTag: string, newTag: string) {
    return api.post<{ success: boolean; affectedCount: number; message: string }>(
      '/contacts/tags/rename',
      { oldTag, newTag },
    );
  },

  /** Xóa tag khỏi tất cả contact thuộc quyền sở hữu */
  deleteTag(tag: string) {
    return api.post<{ success: boolean; affectedCount: number; message: string }>(
      '/contacts/tags/delete',
      { tag },
    );
  },
};
