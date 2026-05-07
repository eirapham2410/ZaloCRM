import { api } from './index';

export interface Attachment {
  type: 'image' | 'file';
  url: string;
  fileName?: string;
  fileSize?: number;
  mediaId?: string; // Zalo media cache ID — populated after first successful send
}

export interface Template {
  id: string;
  name: string;
  content: string;
  attachments?: Attachment[];
  category?: string;
  isPersonal: boolean;
  createdAt: string;
}

export const templateApi = {
  getTemplates() {
    return api.get<{ templates: Template[] }>('/automation/templates');
  },

  createTemplate(payload: {
    name: string;
    content: string;
    attachments?: Attachment[];
    category?: string;
    isPersonal?: boolean;
  }) {
    return api.post<Template>('/automation/templates', payload);
  },
};
