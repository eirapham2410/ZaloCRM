<template>
  <div class="d-flex mb-2 align-start" :class="isSelf ? 'flex-row-reverse' : 'flex-row'">
    <!-- Avatar (Chỉ hiển thị cho người khác) -->
    <template v-if="!isSelf">
      <div v-if="!hideAvatar" class="mx-2 flex-shrink-0 mt-1">
        <v-avatar 
          size="32" 
          :color="message.senderAvatar ? 'transparent' : getDeterministicColor(message.senderUid || '')"
          class="cursor-pointer avatar-hover"
          @click.stop="onAvatarClick"
        >
          <v-img v-if="message.senderAvatar" :src="message.senderAvatar" />
          <span v-else class="text-white text-subtitle-2">{{ getFallbackChar(message.senderName) }}</span>
        </v-avatar>
      </div>
      <div v-else class="mx-2 flex-shrink-0" style="width: 32px"></div>
    </template>

    <div class="bubble-wrapper">
      <!-- Group sender name -->
      <div
        v-if="isGroup && !isSelf && !hideAvatar"
        class="text-caption mb-1"
        style="color: #00F2FF; font-weight: 500;"
        :class="isSelf ? 'text-right' : 'text-left'"
      >
        {{ message.senderName || 'Unknown' }}
      </div>

      <!-- Bubble -->
      <div
        class="message-bubble pa-2 px-3 rounded-lg"
        :class="isSelf ? 'bg-primary text-white' : 'bg-white'"
        style="word-wrap: break-word;"
        @contextmenu.prevent="emit('contextmenu', $event)"
      >
        <!-- Deleted -->
        <div v-if="message.isDeleted" class="text-decoration-line-through font-italic" style="opacity: 0.6;">
          {{ message.content || '(tin nhắn)' }}<span class="text-caption"> (đã thu hồi)</span>
        </div>

        <template v-else>
          <div v-if="reply" class="quote-block mb-2" @click="onQuoteClick">
            <div class="d-flex align-center">
              <div class="flex-grow-1" style="min-width: 0;">
                <div class="quote-sender">
                  <span class="quote-icon">{{ getQuoteIcon() }}</span>
                  {{ getQuoteSenderName() }}
                </div>
                <div class="quote-text">{{ getQuotePreview() }}</div>
              </div>
              <img
                v-if="getQuoteThumb()"
                :src="getQuoteThumb()!"
                alt=""
                class="quote-thumb"
              />
            </div>
          </div>

          <!-- Image -->
          <div v-if="getImageUrl(message)">
            <img
              :src="getImageUrl(message)!"
              alt="Hình ảnh"
              class="chat-image"
              @click="emit('preview-image', getImageUrl(message)!)"
            />
          </div>

          <!-- File/PDF -->
          <div v-else-if="getFileInfo(message)" class="file-card">
            <v-icon size="20" class="mr-2" color="info">mdi-file-document-outline</v-icon>
            <div class="flex-grow-1">
              <div class="text-body-2 font-weight-medium">{{ getFileInfo(message)!.name }}</div>
              <div class="text-caption" style="opacity: 0.6;">{{ getFileInfo(message)!.size }}</div>
            </div>
            <v-btn
              v-if="getFileInfo(message)!.href"
              icon
              size="x-small"
              variant="text"
              @click="openFile(getFileInfo(message)!.href)"
            >
              <v-icon size="16">mdi-download</v-icon>
            </v-btn>
          </div>

          <!-- Sticker / Video / Voice / GIF -->
          <div v-else-if="message.contentType === 'sticker'">🏷️ Sticker</div>
          <div v-else-if="message.contentType === 'video'">🎥 Video</div>
          <div v-else-if="message.contentType === 'voice'">🎤 Tin nhắn thoại</div>
          <div v-else-if="message.contentType === 'gif'">GIF</div>

          <!-- Reminder -->
          <div v-else-if="isReminderMessage(message)" class="reminder-card">
            <div class="d-flex align-center mb-1">
              <v-icon size="16" color="warning" class="mr-1">mdi-calendar-clock</v-icon>
              <span class="text-caption font-weight-bold" style="color: #FFB74D;">Nhắc hẹn</span>
            </div>
            <div class="text-body-2">{{ getReminderTitle(message) }}</div>
            <div v-if="getReminderTime(message)" class="text-caption mt-1" style="opacity: 0.7;">
              <v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ getReminderTime(message) }}
            </div>
          </div>

          <!-- Special types -->
          <SpecialMessageRenderer
            v-else-if="isSpecialType(message.contentType)"
            :type="message.contentType"
            :content="parseContent(message.content)"
          />

          <!-- Default text -->
          <div v-else>{{ parseDisplayContent(message.content) }}</div>
        </template>

        <!-- Timestamp -->
        <div
          class="text-caption mt-1 msg-time"
          :class="isSelf ? 'text-end' : ''"
          style="font-size: 0.7rem; opacity: 0.7;"
        >
          {{ formatTime(message.sentAt) }}
        </div>
      </div>

      <!-- Reaction display -->
      <reaction-display
        v-if="reactions && reactions.length > 0"
        :reactions="reactions"
        :class="isSelf ? 'justify-end' : 'justify-start'"
        @toggle="(emoji) => emit('toggle-reaction', emoji)"
      />

      <!-- Hover action buttons -->
      <div class="hover-actions" :class="isSelf ? 'hover-actions--left' : 'hover-actions--right'">
        <reaction-picker @react="onPickerReact" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@/composables/use-chat';
import { useChat } from '@/composables/use-chat';
import SpecialMessageRenderer from '@/components/chat/special-message-renderer.vue';
import ReactionDisplay from '@/components/chat/reaction-display.vue';
import ReactionPicker from '@/components/chat/reaction-picker.vue';

// Extend Message locally to ensure we know senderAvatar exists
type MessageWithAvatar = Message & { senderAvatar?: string };

const { openProfile } = useChat();

const props = defineProps<{
  message: MessageWithAvatar;
  isSelf: boolean;
  isGroup: boolean;
  hideAvatar?: boolean;
  accountId?: string | null;
  reply?: Message['reply'];
  reactions?: { emoji: string; count: number; reacted: boolean; reactors?: { id: string; name: string }[] }[];
}>();

function onAvatarClick() {
  const uid = props.message.senderUid;
  const accId = props.accountId;
  if (uid && accId) {
    openProfile(uid, accId);
  }
}

const emit = defineEmits<{
  contextmenu: [event: MouseEvent];
  'preview-image': [url: string];
  'toggle-reaction': [emoji: string];
  reply: [];
  'jump-to-quote': [msgId: string];
}>();

const SPECIAL_TYPES = new Set([
  'bank_transfer', 'call', 'qr_code', 'reminder', 'poll', 'note', 'forwarded', 'rich',
]);

function isSpecialType(contentType: string | null | undefined): boolean {
  return !!contentType && SPECIAL_TYPES.has(contentType);
}

function parseContent(content: string | null): unknown {
  if (!content) return null;
  try { return JSON.parse(content); } catch { return content; }
}

function getImageUrl(msg: MessageWithAvatar): string | null {
  if (msg.contentType === 'image' && msg.content) {
    if (msg.content.startsWith('http')) return msg.content;
    try { const p = JSON.parse(msg.content); return p.href || p.thumb || p.hdUrl || null; } catch {}
  }
  if (msg.content?.startsWith('{')) {
    try {
      const p = JSON.parse(msg.content);
      const href = p.href || p.thumb || '';
      if (href && /\.(jpg|jpeg|png|webp|gif)/i.test(href)) return href;
      if (href && href.includes('zdn.vn') && !p.params?.includes('fileExt')) return href;
    } catch {}
  }
  return null;
}

function getFileInfo(msg: MessageWithAvatar): { name: string; size: string; href: string } | null {
  if (!msg.content?.startsWith('{')) return null;
  try {
    const p = JSON.parse(msg.content);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    if (params?.fileExt || params?.fType === 1) {
      const bytes = parseInt(params.fileSize || '0');
      const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
      return { name: p.title || `file.${params.fileExt || 'unknown'}`, size, href: p.href || '' };
    }
  } catch {}
  return null;
}

function parseDisplayContent(content: string | null): string {
  if (!content) return '';
  if (!content.startsWith('{')) return content;
  try {
    const p = JSON.parse(content);
    if (p.title && p.href) return `🔗 ${p.title}`;
    if (p.title) return p.title;
    if (p.href) return `🔗 ${p.description || p.href}`;
    return content;
  } catch { return content; }
}

function isReminderMessage(msg: MessageWithAvatar): boolean {
  if (!msg.content) return false;
  try { const p = JSON.parse(msg.content); return p.action === 'msginfo.actionlist'; } catch { return false; }
}

function getReminderTitle(msg: MessageWithAvatar): string {
  try { return JSON.parse(msg.content!).title || ''; } catch { return msg.content || ''; }
}

function getReminderTime(msg: MessageWithAvatar): string | null {
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) return new Date(h.ts).toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
  return null;
}

function formatTime(d: string): string {
  return new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function onPickerReact(key: string) {
  emit('toggle-reaction', key);
}

function openFile(href: string) {
  window.open(href, '_blank');
}

/** Get a display-friendly sender name from the quote object */
function getQuoteSenderName(): string {
  if (!props.reply) return '';
  const r = props.reply as unknown as Record<string, unknown>;
  const senderName = r.senderName as string;
  const uidFrom = r.uidFrom as string;

  if (senderName) return senderName;
  if (uidFrom) return uidFrom;
  return 'Người dùng';
}

/** Get truncated preview text from the quote, with content-type labels */
function getQuotePreview(): string {
  if (!props.reply) return '';
  const r = props.reply as unknown as Record<string, unknown>;
  const msgType = (r.msgType as string) || '';
  const content = (r.content as string) || '';

  const labels: Record<string, string> = {
    photo: '📷 Hình ảnh', file: '📎 Tệp tin', video: '🎥 Video',
    voice: '🎤 Tin nhắn thoại', sticker: '🏷️ Nhãn dán', gif: '🎞️ GIF',
  };
  if (labels[msgType]) return labels[msgType];

  if (!content) return '(tin nhắn)';
  return content;
}

/** Get a content-type icon emoji for the quote header */
function getQuoteIcon(): string {
  if (!props.reply) return '↩';
  const r = props.reply as unknown as Record<string, unknown>;
  const msgType = (r.msgType as string) || '';
  const icons: Record<string, string> = {
    webchat: '💬', photo: '📷', file: '📎', video: '🎥',
    voice: '🎤', sticker: '🏷️', gif: '🎞️', link: '🔗',
    location: '📍', card: '👤', bank: '🏦', call: '📞',
  };
  return icons[msgType] ?? '↩';
}

/** Get thumbnail URL from the normalized quote snapshot */
function getQuoteThumb(): string | null {
  if (!props.reply) return null;
  const r = props.reply as unknown as Record<string, unknown>;
  if (r.previewUrl && typeof r.previewUrl === 'string') return r.previewUrl;
  if (r.attach) {
    try {
      const attach = typeof r.attach === 'string' ? JSON.parse(r.attach) : r.attach;
      return (attach as Record<string, string>).thumb || null;
    } catch { return null; }
  }
  return null;
}

/** Click on quote block → scroll to original message */
function onQuoteClick() {
  const r = props.reply as unknown as Record<string, unknown> | undefined;
  const msgId = (r?.msgId as string) || '';
  if (!msgId) return;
  emit('jump-to-quote', msgId);
}

/** Helper functions for Avatar fallback */
function getDeterministicColor(uid: string): string {
  const colors = [
    'primary', 'secondary', 'success', 'info', 'warning', 'error', 
    'teal', 'cyan', 'indigo', 'deep-purple', 'pink', 'deep-orange', 'brown', 'blue-grey'
  ];
  if (!uid) return colors[0];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = uid.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function getFallbackChar(name: string | null | undefined): string {
  if (!name) return 'U';
  return name.trim().charAt(0).toUpperCase();
}
</script>

<style scoped>
.bubble-wrapper {
  max-width: 70%;
  position: relative;
}

.message-bubble {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}
.reminder-card {
  padding: 8px 12px;
  border-left: 3px solid #FFB74D;
  border-radius: 8px;
  background: rgba(255, 183, 77, 0.08);
}
.file-card {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(0, 242, 255, 0.05);
  border: 1px solid rgba(0, 242, 255, 0.1);
}
.chat-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.2s;
}
.chat-image:hover {
  transform: scale(1.02);
}

/* Quote block inside bubble */
.quote-block {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(0, 242, 255, 0.06);
  border-left: 3px solid #00F2FF;
  cursor: pointer;
  transition: background 0.15s;
}
.quote-block:hover {
  background: rgba(0, 242, 255, 0.12);
}
.quote-sender {
  font-size: 0.75rem;
  font-weight: 600;
  color: #00F2FF;
  margin-bottom: 2px;
}
.quote-text {
  font-size: 0.8rem;
  opacity: 0.75;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
  white-space: normal;
  word-wrap: break-word;
}
.quote-icon {
  font-size: 0.7rem;
  margin-right: 3px;
}
.quote-thumb {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  object-fit: cover;
  margin-left: 8px;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

/* Hover action buttons (reply + reaction) */
.bubble-wrapper .hover-actions {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  align-items: center;
  gap: 0;
  background: rgba(var(--v-theme-surface), 0.8);
  backdrop-filter: blur(4px);
  border-radius: 16px;
  padding: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.bubble-wrapper:hover .hover-actions {
  opacity: 1;
}
.hover-actions--left {
  left: -35px;
}
.hover-actions--right {
  right: -35px;
}
.hover-action-btn {
  transition: background-color 0.15s;
}
.hover-action-btn:hover {
  background-color: rgba(var(--v-theme-on-surface), 0.08) !important;
}
.cursor-pointer {
  cursor: pointer;
}
.avatar-hover {
  transition: transform 0.2s, opacity 0.2s;
}
.avatar-hover:hover {
  transform: scale(1.05);
  opacity: 0.9;
}
</style>
