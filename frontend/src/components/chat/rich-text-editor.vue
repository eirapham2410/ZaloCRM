<template>
  <div class="rich-text-editor" :class="{ focused: isFocused }">
    <!-- Toolbar -->
    <div v-if="showToolbar" class="editor-toolbar d-flex align-center ga-1 pa-1">
      <v-btn
        icon size="x-small" variant="text"
        title="Đính kèm tệp"
        @click="emit('attach')"
      >
        <v-icon size="16">mdi-paperclip</v-icon>
      </v-btn>
      <v-menu v-model="showEmojiMenu" :close-on-content-click="false" location="top">
        <template #activator="{ props: menuProps }">
          <v-btn
            icon size="x-small" variant="text"
            title="Chèn biểu tượng cảm xúc"
            v-bind="menuProps"
          >
            <v-icon size="16">mdi-emoticon-outline</v-icon>
          </v-btn>
        </template>
        <EmojiPicker
          :native="true"
          :theme="currentTheme"
          :disable-search="true"
          :hide-search="true"
          @select="onEmojiSelect"
        />
      </v-menu>
      <v-divider vertical class="mx-1" />
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('bold') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleBold().run()"
      >
        <v-icon size="16">mdi-format-bold</v-icon>
      </v-btn>
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('italic') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleItalic().run()"
      >
        <v-icon size="16">mdi-format-italic</v-icon>
      </v-btn>
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('underline') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleUnderline().run()"
      >
        <v-icon size="16">mdi-format-underline</v-icon>
      </v-btn>
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('strike') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleStrike().run()"
      >
        <v-icon size="16">mdi-format-strikethrough</v-icon>
      </v-btn>
      <v-divider vertical class="mx-1" />
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('bulletList') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleBulletList().run()"
      >
        <v-icon size="16">mdi-format-list-bulleted</v-icon>
      </v-btn>
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('orderedList') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleOrderedList().run()"
      >
        <v-icon size="16">mdi-format-list-numbered</v-icon>
      </v-btn>
      <v-divider vertical class="mx-1" />
      <v-btn
        icon size="x-small" variant="text"
        :color="editor?.isActive('codeBlock') ? 'primary' : undefined"
        @click="editor?.chain().focus().toggleCodeBlock().run()"
      >
        <v-icon size="16">mdi-code-braces</v-icon>
      </v-btn>
    </div>

    <!-- Editor content -->
    <EditorContent :editor="editor" class="editor-content" />
  </div>
</template>

<script setup lang="ts">
import { watch, onBeforeUnmount, ref, defineAsyncComponent, computed } from 'vue';
import { useTheme } from 'vuetify';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Mention from '@tiptap/extension-mention';
import { createSuggestion, type MentionItem } from './mention-suggestion';
// @ts-ignore
import 'vue3-emoji-picker/css';

const EmojiPicker = defineAsyncComponent(() => import('vue3-emoji-picker'));

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  showToolbar?: boolean;
  groupMembers?: MentionItem[];
}>(), {
  placeholder: 'Nhập tin nhắn...',
  showToolbar: true,
  groupMembers: () => [],
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  typing: [];
  attach: [];
  'paste-files': [files: File[]];
}>();

const isFocused = ref(false);
const showEmojiMenu = ref(false);

const editor = useEditor({
  content: props.modelValue,
  extensions: [
    StarterKit.configure({
      heading: false,
      horizontalRule: false,
      blockquote: false,
    }),
    Underline,
    Placeholder.configure({ placeholder: props.placeholder }),
    Mention.configure({
      HTMLAttributes: {
        class: 'mention',
      },
      suggestion: createSuggestion(() => props.groupMembers),
      renderText({ node }) {
        return `@${node.attrs.label} `;
      },
    }),
  ],
  editorProps: {
    handleKeyDown(_view, event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        emit('submit');
        return true;
      }
      return false;
    },
    handlePaste(_view, event, _slice) {
      const clipboardData = event.clipboardData || (window as any).clipboardData;
      if (clipboardData && clipboardData.files && clipboardData.files.length > 0) {
        const files = Array.from(clipboardData.files) as File[];
        emit('paste-files', files);
        event.preventDefault();
        return true;
      }
      return false;
    },
    attributes: { class: 'tiptap-input' },
  },
  onUpdate({ editor: ed }) {
    const text = ed.getText();
    emit('update:modelValue', text);
    emit('typing');
  },
  onFocus() { isFocused.value = true; },
  onBlur() { isFocused.value = false; },
});

const theme = useTheme();
const currentTheme = computed(() => theme.global.current.value.dark ? 'dark' : 'light');

function onEmojiSelect(emoji: any) {
  if (editor.value) {
    editor.value.chain().focus().insertContent(emoji.i).run();
  }
  showEmojiMenu.value = false;
}

// Sync external modelValue changes into editor
watch(() => props.modelValue, (val) => {
  if (!editor.value) return;
  const current = editor.value.getText();
  if (val !== current) {
    editor.value.commands.setContent(val || '');
  }
});

/** Clear editor content — called by parent after send */
function clear() {
  editor.value?.commands.clearContent(true);
}

/** Focus the editor */
function focus() {
  editor.value?.commands.focus();
}

/** Trích xuất mentions để gửi qua API Zalo */
function getMentions() {
  if (!editor.value) return [];
  let plainText = '';
  const mentions: Array<{ uid: string; pos: number; len: number }> = [];

  editor.value.state.doc.descendants((node) => {
    if (node.isText) {
      plainText += node.text || '';
    } else if (node.type.name === 'mention') {
      const label = `@${node.attrs.label} `;
      mentions.push({
        uid: node.attrs.id,
        pos: Array.from(plainText).length,
        len: Array.from(label).length,
      });
      plainText += label;
    } else if (node.isBlock && node.type.name === 'paragraph' && plainText.length > 0 && !plainText.endsWith('\n')) {
      // Tiptap getText() adds \n between paragraphs. We need to match it.
      // But only if we aren't at the very start of the doc.
      plainText += '\n';
    }
  });

  return mentions;
}

defineExpose({ clear, focus, getMentions });

onBeforeUnmount(() => { editor.value?.destroy(); });
</script>

<style scoped>
.rich-text-editor {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  transition: border-color 0.2s;
}
.rich-text-editor.focused {
  border-color: rgba(0, 242, 255, 0.4);
}
.editor-toolbar {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.editor-content :deep(.tiptap-input) {
  padding: 8px 12px;
  min-height: 36px;
  max-height: 120px;
  overflow-y: auto;
  outline: none;
  font-size: 0.875rem;
  line-height: 1.5;
}
.editor-content :deep(.tiptap-input p) {
  margin: 0;
}
.editor-content :deep(.tiptap-input p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  color: rgba(255, 255, 255, 0.3);
  pointer-events: none;
  height: 0;
}
.editor-content :deep(.tiptap-input code) {
  background: rgba(0, 242, 255, 0.08);
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 0.85em;
}
.editor-content :deep(.tiptap-input pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 8px 12px;
  border-radius: 6px;
  font-family: monospace;
  margin: 4px 0;
}
.editor-content :deep(.tiptap-input .mention) {
  background-color: rgba(0, 242, 255, 0.2);
  color: #00f2ff;
  border-radius: 4px;
  padding: 0 4px;
  font-weight: 500;
  display: inline-block;
}
</style>
