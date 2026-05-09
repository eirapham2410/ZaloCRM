import { api } from './index';

export const mediaApi = {
  /**
   * Upload a file to the backend's media service.
   * This streams the file to MinIO Object Storage.
   */
  async uploadMedia(file: File) {
    const formData = new FormData();
    formData.append('file', file);

    return api.post<{ success: boolean; url: string; fileName: string }>(
      '/media/upload',
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );
  },
};
