import { VueRenderer } from '@tiptap/vue-3';
import tippy from 'tippy.js';
import MentionList from './MentionList.vue';

export interface MentionItem {
  id: string;
  name: string;
  avatar?: string;
}

export function createSuggestion(itemsProvider: () => MentionItem[]): any {
  return {
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase();
      const allItems = itemsProvider();
      return allItems.filter(item => item.name.toLowerCase().includes(q)).slice(0, 5);
    },

    render: () => {
      let component: VueRenderer;
      let popup: any;

      return {
        onStart: (props: any) => {
          component = new VueRenderer(MentionList, {
            props,
            editor: props.editor,
          });

          if (!props.clientRect) {
            return;
          }

          popup = tippy(document.body, {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element as Element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'top-start',
            theme: 'light',
          });
        },

        onUpdate(props: any) {
          component.updateProps(props);

          if (!props.clientRect) {
            return;
          }

          popup[0].setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },

        onKeyDown(props: any) {
          if (props.event.key === 'Escape') {
            popup[0].hide();
            return true;
          }

          return component.ref?.onKeyDown(props);
        },

        onExit() {
          if (popup && popup[0]) {
            popup[0].destroy();
          }
          if (component) {
            component.destroy();
          }
        },
      };
    },
  };
}
