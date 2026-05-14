import { ref } from 'vue';
import { api } from '@/api/index';

export interface ProxyItem {
  id: string;
  url: string;
  status: string;
  maxAccounts: number;
  lastCheckedAt: string | null;
  createdAt: string;
  _count: {
    zaloAccounts: number;
  };
}

export function useProxies() {
  const proxies = ref<ProxyItem[]>([]);
  const loading = ref(false);

  async function fetchProxies() {
    loading.value = true;
    try {
      const res = await api.get('/proxies');
      proxies.value = res.data;
    } catch (err: any) {
      console.error('Failed to fetch proxies:', err);
    } finally {
      loading.value = false;
    }
  }

  async function bulkAddProxies(text: string) {
    try {
      const res = await api.post('/proxies/bulk', { text });
      await fetchProxies();
      return { success: true, ...res.data };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  async function testProxy(id: string) {
    try {
      const res = await api.post(`/proxies/${id}/test`);
      await fetchProxies();
      return res.data; // { success, ip, error, message }
    } catch (err: any) {
      return { success: false, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteProxy(id: string) {
    try {
      await api.delete(`/proxies/${id}`);
      await fetchProxies();
      return true;
    } catch (err: any) {
      console.error('Delete proxy failed:', err);
      return false;
    }
  }

  return {
    proxies,
    loading,
    fetchProxies,
    bulkAddProxies,
    testProxy,
    deleteProxy,
  };
}
