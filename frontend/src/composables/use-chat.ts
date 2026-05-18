import { ref, computed } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';
import type { Contact } from '@/composables/use-contacts';
import { useAuthStore } from '@/stores/auth';

interface ZaloAccount {
  id: string;
  displayName: string | null;
}

export interface AiSentiment {
  label: 'positive' | 'neutral' | 'negative';
  confidence: number;
  reason: string;
}

export interface UserProfile {
  zaloUid: string;
  displayName: string;
  avatarUrl: string | null;
  isUnknownProfile?: boolean;
  phone: string | null;
  email: string | null;
  source: string | null;
  isFriend: boolean;
  friendshipStatus: string;
  contactStatus: string | null;
  crmName: string | null;
  isSelf: boolean;
}


export interface AiConfig {
  provider: string;
  model: string;
  maxDaily: number;
  enabled: boolean;
  hasAnthropicKey?: boolean;
  hasGeminiKey?: boolean;
}

interface ConversationMessage {
  content: string | null;
  contentType: string;
  senderType: string;
  sentAt: string;
  isDeleted: boolean;
}

export interface ReplyMessageRef {
  msgId: string;
  cliMsgId?: string;
  content: string;
  msgType: string;
  uidFrom: string;
  ts: string;
  propertyExt?: Record<string, unknown>;
  ttl?: number;
}

interface RawMessage extends Omit<Message, 'reactions' | 'reply'> {
  quote?: ReplyMessageRef | null;
  reactions?: Array<{ emoji: string; reactorId: string; reactorName?: string; count?: number; reacted?: boolean }>;
}

export interface Conversation {
  id: string;
  threadType: 'user' | 'group';
  contact: Contact | null;
  zaloAccount: ZaloAccount | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isReplied: boolean;
  isPinned?: boolean;
  messages?: ConversationMessage[];
}

export interface MessageReactionView {
  emoji: string;
  count: number;
  reacted: boolean;
  reactors: { id: string; name: string }[];
}

export interface Message {
  id: string;
  content: string | null;
  contentType: string;
  senderType: string;
  senderUid: string | null;
  senderName: string | null;
  sentAt: string;
  isDeleted: boolean;
  zaloMsgId: string | null;
  cliMsgId: string | null;
  albumKey: string | null;
  albumIndex: number | null;
  albumTotal: number | null;
  reply?: ReplyMessageRef | null;
  reactions?: MessageReactionView[];
}

const isProfileOpen = ref(false);
const profileZaloUid = ref<string | null>(null);
const profileAccountId = ref<string | null>(null);

export function getConversationDisplayName(conversation: any): string {
  if (!conversation) return 'Người dùng Zalo';
  
  // 1. Lấy tên từ contact
  let name = conversation.contact?.fullName || conversation.contact?.crmName;
  
  // 2. Fallback nếu tên bị lỗi (Zalo User / Unknown / rỗng)
  if (!name || ['Zalo User', 'Unknown'].includes(name)) {
    if (conversation.title) {
      name = conversation.title;
    } else if (conversation.threadType === 'group') {
      // Vì không còn access đến groupMembers của useChat instance, ta fallback tên nhóm
      name = 'Nhóm chưa đặt tên';
    }
  }
  
  if (!name || ['Zalo User', 'Unknown'].includes(name)) {
    return 'Người dùng Zalo';
  }
  
  return name;
}

export function useChat() {
  const conversations = ref<Conversation[]>([]);
  const selectedConvId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const groupMembers = ref<{ id: string; name: string; avatar?: string }[]>([]);
  const loadingConvs = ref(false);
  const loadingMsgs = ref(false);
  const sendingMsg = ref(false);
  const searchQuery = ref('');
  const accountFilter = ref<string | null>(null);
  const aiSuggestion = ref('');
  const aiSuggestionLoading = ref(false);
  const aiSuggestionError = ref('');
  const aiSummary = ref('');
  const aiSummaryLoading = ref(false);
  const aiSentiment = ref<AiSentiment | null>(null);
  const aiSentimentLoading = ref(false);
  
  const aiUsage = ref({ usedToday: 0, maxDaily: 500, remaining: 500, enabled: true });
  const aiConfig = ref<AiConfig>({ provider: 'anthropic', model: 'claude-sonnet-4-6', maxDaily: 500, enabled: true });
  let socket: Socket | null = null;

  const selectedConv = computed(() =>
    conversations.value.find(c => c.id === selectedConvId.value) || null,
  );

  function clearAiState() {
    aiSuggestion.value = '';
    aiSuggestionError.value = '';
    aiSummary.value = '';
    aiSentiment.value = null;
  }

  const extraFilters = ref<Record<string, string>>({});

  async function fetchConversations() {
    loadingConvs.value = true;
    try {
      const res = await api.get('/conversations', {
        params: {
          limit: 100,
          search: searchQuery.value,
          accountId: accountFilter.value || undefined,
          ...extraFilters.value,
        },
      });
      conversations.value = res.data.conversations;
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      loadingConvs.value = false;
    }
  }

  function openProfile(zaloUid: string, accountId: string) {
    profileZaloUid.value = zaloUid;
    profileAccountId.value = accountId;
    isProfileOpen.value = true;
  }

  async function fetchUserProfile(zaloUid: string, accountId: string): Promise<UserProfile | null> {
    try {
      const res = await api.get(`/contacts/${zaloUid}/profile`, { params: { accountId } });
      return res.data;
    } catch (err) {
      console.error('Failed to fetch user profile:', err);
      return null;
    }
  }

  async function getOrCreatePrivateChat(targetZaloUid: string, accountId: string): Promise<string | null> {
    try {
      const res = await api.post('/conversations/find-or-create-private', { targetZaloUid, accountId });
      const conversationId = res.data.conversationId;
      if (conversationId) {
        await fetchConversations();
        selectConversation(conversationId);
        return conversationId;
      }
      return null;
    } catch (err) {
      console.error('Failed to find or create private chat:', err);
      return null;
    }
  }


  function normalizeMessage(message: RawMessage): Message {
    const authStore = useAuthStore();
    const currentUserId = authStore.user?.id;
    const counts = new Map<string, number>();
    const reactorsMap = new Map<string, { id: string; name: string }[]>();
    for (const reaction of message.reactions || []) {
      counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
      const list = reactorsMap.get(reaction.emoji) || [];
      list.push({ id: reaction.reactorId, name: reaction.reactorName || 'Người dùng Zalo' });
      reactorsMap.set(reaction.emoji, list);
    }
    const { reactions, quote, ...base } = message;
    return {
      ...base,
      reply: quote ?? null,
      reactions: Array.from(counts.entries()).map(([emoji, count]) => ({
        emoji,
        count,
        reacted: reactorsMap.get(emoji)?.some(r => r.id === currentUserId) || false,
        reactors: reactorsMap.get(emoji) || [],
      })),
    };
  }

  async function fetchMessages(convId: string, limit: number = 100) {
    loadingMsgs.value = true;
    try {
      const res = await api.get(`/conversations/${convId}/messages`, {
        params: { limit },
      });
      messages.value = (res.data.messages as RawMessage[]).map(normalizeMessage);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      loadingMsgs.value = false;
    }
  }

  async function fetchAiConfig() {
    try {
      const res = await api.get('/ai/config');
      aiConfig.value = {
        provider: res.data.provider,
        model: res.data.model,
        maxDaily: res.data.maxDaily,
        enabled: res.data.enabled,
        hasAnthropicKey: res.data.hasAnthropicKey,
        hasGeminiKey: res.data.hasGeminiKey,
      };
    } catch (err) {
      console.error('Failed to fetch AI config:', err);
    }
  }

  async function saveAiConfig(payload: AiConfig) {
    const res = await api.put('/ai/config', payload);
    aiConfig.value = {
      provider: res.data.provider,
      model: res.data.model,
      maxDaily: res.data.maxDaily,
      enabled: res.data.enabled,
      hasAnthropicKey: aiConfig.value.hasAnthropicKey,
      hasGeminiKey: aiConfig.value.hasGeminiKey,
    };
  }

  async function fetchAiUsage() {
    try {
      const res = await api.get('/ai/usage');
      aiUsage.value = res.data;
    } catch (err) {
      console.error('Failed to fetch AI usage:', err);
    }
  }

  async function generateAiSuggestion() {
    if (!selectedConvId.value) return;
    aiSuggestionLoading.value = true;
    aiSuggestionError.value = '';
    try {
      const res = await api.post('/ai/suggest', { conversationId: selectedConvId.value });
      aiSuggestion.value = res.data.content || '';
      await fetchAiUsage();
    } catch (err: any) {
      aiSuggestionError.value = err.response?.data?.error || 'Không thể tạo gợi ý AI';
    } finally {
      aiSuggestionLoading.value = false;
    }
  }

  async function generateAiSummary() {
    if (!selectedConvId.value) return;
    aiSummaryLoading.value = true;
    try {
      const res = await api.post(`/ai/summarize/${selectedConvId.value}`);
      aiSummary.value = res.data.content || '';
      await fetchAiUsage();
    } catch (err) {
      console.error('Failed to summarize conversation:', err);
    } finally {
      aiSummaryLoading.value = false;
    }
  }

  async function generateAiSentiment() {
    if (!selectedConvId.value) return;
    aiSentimentLoading.value = true;
    try {
      const res = await api.post(`/ai/sentiment/${selectedConvId.value}`);
      aiSentiment.value = res.data;
      await fetchAiUsage();
    } catch (err) {
      console.error('Failed to analyze sentiment:', err);
    } finally {
      aiSentimentLoading.value = false;
    }
  }

  async function initializeChatFromUrl(convId: string) {
    // Check if conversation is already in the list
    let conv = conversations.value.find(c => c.id === convId);
    
    if (!conv) {
      try {
        // Fetch conversation metadata if it's new (e.g. from friends page)
        const res = await api.get(`/conversations/${convId}`);
        conversations.value.unshift(res.data);
      } catch (err) {
        console.error('Failed to initialize conversation from URL:', err);
      }
    }
    
    // Select the conversation to load messages and other data
    await selectConversation(convId);
  }

  async function selectConversation(convId: string) {
    selectedConvId.value = convId;
    clearAiState();
    groupMembers.value = [];
    await fetchMessages(convId);
    try {
      const convDetail = await api.get(`/conversations/${convId}`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv && convDetail.data.contact) {
        conv.contact = convDetail.data.contact;
      }
      if (convDetail.data.threadType === 'group') {
        const memRes = await api.get(`/conversations/${convId}/members`);
        groupMembers.value = memRes.data.members || [];
      }
    } catch {
      // Non-critical
    }
    try {
      await api.post(`/conversations/${convId}/mark-read`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv) conv.unreadCount = 0;
    } catch {
      // Ignore mark-read errors
    }
    await Promise.allSettled([generateAiSummary(), generateAiSentiment(), fetchAiUsage()]);
  }

  async function sendMessage(content: string, replyMessageId?: string | null, mentions?: any[]) {
    if (!selectedConvId.value || (!content.trim() && !(mentions && mentions.length))) return;
    await sendMessageTo(selectedConvId.value, content, replyMessageId, mentions);
  }

  async function sendMessageTo(conversationId: string, content: string, replyMessageId?: string | null, mentions?: any[]) {
    if (!content.trim() && !(mentions && mentions.length)) return;
    sendingMsg.value = true;
    try {
      const payload: any = { content };
      if (replyMessageId) payload.replyMessageId = replyMessageId;
      if (mentions && mentions.length > 0) payload.mentions = mentions;
      
      const res = await api.post(`/conversations/${conversationId}/messages`, payload);
      if (conversationId === selectedConvId.value) {
        const existingMsg = messages.value.find(m => 
          m.id === res.data.id || 
          (m.zaloMsgId && res.data.zaloMsgId && m.zaloMsgId === res.data.zaloMsgId) ||
          (m.cliMsgId && res.data.cliMsgId && m.cliMsgId === res.data.cliMsgId)
        );
        
        if (!existingMsg) {
          messages.value.push(normalizeMessage(res.data as RawMessage));
        } else {
          // Update message state if needed instead of duplicating
          if (res.data.zaloMsgId && !existingMsg.zaloMsgId) existingMsg.zaloMsgId = res.data.zaloMsgId;
          if (res.data.id && existingMsg.id !== res.data.id) existingMsg.id = res.data.id;
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      throw err;
    } finally {
      sendingMsg.value = false;
    }
  }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('chat:message', (data: { message: Message; conversationId: string }) => {
      if (data.conversationId === selectedConvId.value) {
        const existingMsg = messages.value.find(m => 
          m.id === data.message.id || 
          (m.zaloMsgId && data.message.zaloMsgId && m.zaloMsgId === data.message.zaloMsgId) ||
          (m.cliMsgId && data.message.cliMsgId && m.cliMsgId === data.message.cliMsgId)
        );
        
        if (!existingMsg) {
          messages.value.push(normalizeMessage(data.message as RawMessage));
        } else {
          // Update existing message instead of duplicating
          if (data.message.zaloMsgId && !existingMsg.zaloMsgId) existingMsg.zaloMsgId = data.message.zaloMsgId;
        }
      }
      fetchConversations();
    });

    socket.on('chat:message_id_synced', (data: { id: string; zaloMsgId: string }) => {
      const existingMsg = messages.value.find(m => m.id === data.id);
      if (existingMsg) {
        existingMsg.zaloMsgId = data.zaloMsgId;
      }
    });

    socket.on('chat:new-conversation', () => {
      fetchConversations();
    });

    socket.on('contact:updated', (data: { orgId: string; updatedProfiles: { zaloUid: string; displayName: string; avatarUrl: string | null }[] }) => {
      if (data?.updatedProfiles) {
        let needsUpdate = false;
        for (const profile of data.updatedProfiles) {
          // Cập nhật trong danh sách conversations
          for (const conv of conversations.value) {
            if (conv.contact?.zaloUid === profile.zaloUid) {
              conv.contact.fullName = profile.displayName;
              if (profile.avatarUrl) conv.contact.avatarUrl = profile.avatarUrl;
              needsUpdate = true;
            }
          }
          // Cập nhật trong conversation đang mở
          if (selectedConv.value?.contact?.zaloUid === profile.zaloUid) {
             selectedConv.value.contact.fullName = profile.displayName;
             if (profile.avatarUrl) selectedConv.value.contact.avatarUrl = profile.avatarUrl;
             needsUpdate = true;
          }
        }
        
        // Kích hoạt reactivity Vue bằng cách tạo object mới nếu cần thiết
        if (needsUpdate) {
          conversations.value = [...conversations.value];
        }
      }
    });

    socket.on('chat:deleted', (data: { messageId?: string; zaloMsgId?: string }) => {
      const msg = messages.value.find(m => m.id === data.messageId || m.zaloMsgId === data.zaloMsgId);
      if (msg) msg.isDeleted = true;
    });

    socket.on('chat:message-edited', (data: { messageId?: string; zaloMsgId?: string; content: string }) => {
      const msg = messages.value.find(m => m.id === data.messageId || m.zaloMsgId === data.zaloMsgId);
      if (msg) msg.content = data.content;
    });

    socket.on('chat:reactions', (data: { messageId?: string; msgId?: string; zaloMsgId?: string; reactions: { userId: string; userName: string; reaction: string; action: 'add' | 'remove' }[] }) => {
      const msg = messages.value.find(m => m.id === data.messageId || m.id === data.msgId || m.zaloMsgId === data.zaloMsgId);
      if (!msg) return;
      // Build on top of existing reactions
      const existing = msg.reactions || [];
      const counts = new Map<string, number>();
      const reactorsMap = new Map<string, { id: string; name: string }[]>();
      for (const r of existing) {
        counts.set(r.emoji, r.count);
        reactorsMap.set(r.emoji, [...(r.reactors || [])]);
      }
      for (const reaction of data.reactions) {
        const emoji = reaction.reaction;

        if (reaction.action === 'add') {
          // Xóa reaction cũ của user (nếu có) trên tất cả emoji khác để đảm bảo 1 user = 1 reaction
          for (const [existingEmoji, existingReactors] of reactorsMap.entries()) {
            const filtered = existingReactors.filter(r => r.id !== reaction.userId);
            if (filtered.length !== existingReactors.length) {
              reactorsMap.set(existingEmoji, filtered);
              counts.set(existingEmoji, filtered.length);
              if (filtered.length === 0) {
                counts.delete(existingEmoji);
                reactorsMap.delete(existingEmoji);
              }
            }
          }

          const list = reactorsMap.get(emoji) || [];
          counts.set(emoji, (counts.get(emoji) || 0) + 1);
          if (!list.find(r => r.id === reaction.userId)) {
            list.push({ id: reaction.userId, name: reaction.userName || 'Người dùng Zalo' });
          }
          reactorsMap.set(emoji, list);
        }

        if (reaction.action === 'remove') {
          const list = reactorsMap.get(emoji) || [];
          const filtered = list.filter(r => r.id !== reaction.userId);
          if (filtered.length !== list.length) {
            reactorsMap.set(emoji, filtered);
            counts.set(emoji, filtered.length);
            if (filtered.length === 0) {
              counts.delete(emoji);
              reactorsMap.delete(emoji);
            }
          }
        }
      }
      const authStore = useAuthStore();
      const currentUserId = authStore.user?.id;
      msg.reactions = Array.from(counts.entries()).map(([emoji, count]) => ({
        emoji,
        count,
        reacted: reactorsMap.get(emoji)?.some(r => r.id === currentUserId) || false,
        reactors: reactorsMap.get(emoji) || [],
      }));
    });

    socket.on('chat:pinned', () => {
      fetchConversations();
    });

    socket.on('chat:unpinned', () => {
      fetchConversations();
    });
  }

  function destroySocket() {
    socket?.disconnect();
    socket = null;
  }

  return {
    conversations,
    selectedConvId,
    selectedConv,
    messages,
    groupMembers,
    loadingConvs,
    loadingMsgs,
    sendingMsg,
    searchQuery,
    accountFilter,
    extraFilters,
    aiSuggestion,
    aiSuggestionLoading,
    aiSuggestionError,
    aiSummary,
    aiSummaryLoading,
    aiSentiment,
    aiSentimentLoading,
    aiUsage,
    aiConfig,
    fetchConversations,
    fetchAiConfig,
    saveAiConfig,
    fetchAiUsage,
    fetchMessages,
    selectConversation,
    sendMessage,
    sendMessageTo,
    generateAiSuggestion,
    generateAiSummary,
    generateAiSentiment,
    clearAiState,
    isProfileOpen,
    profileZaloUid,
    profileAccountId,
    openProfile,
    fetchUserProfile,
    getOrCreatePrivateChat,
    initializeChatFromUrl,
    initSocket,
    destroySocket,
    getSocket: () => socket,
  };
}
