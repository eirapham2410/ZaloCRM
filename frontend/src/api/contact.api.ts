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
  }
};
