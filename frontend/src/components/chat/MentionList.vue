<template>
  <div class="mention-list elevation-3">
    <v-list density="compact" bg-color="surface" class="pa-0">
      <template v-if="items.length">
        <v-list-item
          v-for="(item, index) in items"
          :key="item.id"
          :class="{ 'bg-primary-lighten-1': index === selectedIndex }"
          @click="selectItem(index)"
          style="min-height: 40px"
        >
          <template #prepend>
            <v-avatar size="24" class="mr-2" color="primary">
              <v-img v-if="item.avatar" :src="item.avatar"></v-img>
              <span v-else class="text-caption text-white">{{ item.name.charAt(0) }}</span>
            </v-avatar>
          </template>
          <v-list-item-title class="text-body-2">{{ item.name }}</v-list-item-title>
        </v-list-item>
      </template>
      <v-list-item v-else>
        <v-list-item-title class="text-body-2 text-grey">Không tìm thấy</v-list-item-title>
      </v-list-item>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  items: { id: string; name: string; avatar?: string }[];
  command: (item: { id: string; label: string }) => void;
}>();

const selectedIndex = ref(0);

watch(() => props.items, () => {
  selectedIndex.value = 0;
});

function onKeyDown({ event }: { event: KeyboardEvent }) {
  if (event.key === 'ArrowUp') {
    upHandler();
    return true;
  }
  if (event.key === 'ArrowDown') {
    downHandler();
    return true;
  }
  if (event.key === 'Enter') {
    enterHandler();
    return true;
  }
  return false;
}

function upHandler() {
  selectedIndex.value = ((selectedIndex.value + props.items.length) - 1) % props.items.length;
}

function downHandler() {
  selectedIndex.value = (selectedIndex.value + 1) % props.items.length;
}

function enterHandler() {
  selectItem(selectedIndex.value);
}

function selectItem(index: number) {
  const item = props.items[index];
  if (item) {
    props.command({ id: item.id, label: item.name });
  }
}

defineExpose({
  onKeyDown,
});
</script>

<style scoped>
.mention-list {
  background: rgb(var(--v-theme-surface));
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  min-width: 200px;
  max-height: 250px;
  overflow-y: auto;
}
.bg-primary-lighten-1 {
  background-color: rgba(var(--v-theme-primary), 0.2) !important;
}
</style>
