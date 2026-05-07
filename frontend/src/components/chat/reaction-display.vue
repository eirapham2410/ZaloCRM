<template>
  <div v-if="reactions.length > 0" class="d-flex flex-wrap ga-1 mt-1">
    <v-tooltip
      v-for="r in reactions"
      :key="r.emoji"
      location="top"
    >
      <template #activator="{ props: tooltipProps }">
        <v-chip
          v-bind="tooltipProps"
          size="x-small"
          :variant="r.reacted ? 'tonal' : 'outlined'"
          :color="r.reacted ? 'primary' : undefined"
          class="reaction-chip"
          :class="{ 'reaction-chip--reacted': r.reacted }"
          @click="emit('toggle', r.emoji)"
        >
          {{ getEmojiChar(r.emoji) }}&nbsp;{{ r.count }}
        </v-chip>
      </template>
      <div class="reaction-tooltip">
        <div class="reaction-tooltip-emoji">{{ getEmojiChar(r.emoji) }}</div>
        <div
          v-for="(reactor, idx) in (r.reactors || [])"
          :key="idx"
          class="reaction-tooltip-name"
        >
          {{ reactor.name }}
        </div>
        <div v-if="!r.reactors || r.reactors.length === 0" class="reaction-tooltip-name">
          {{ r.count }} người
        </div>
      </div>
    </v-tooltip>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  reactions: { emoji: string; count: number; reacted: boolean; reactors?: { id: string; name: string }[] }[];
}>();

const emit = defineEmits<{
  toggle: [emoji: string];
}>();

const EMOJI_MAP: Record<string, string> = {
  heart: '❤️',
  like: '👍',
  haha: '😆',
  wow: '😮',
  sad: '😭',
  angry: '😡',
};

function getEmojiChar(key: string) {
  return EMOJI_MAP[key] || key;
}
</script>

<style scoped>
.reaction-chip {
  cursor: pointer;
  transition: transform 0.12s;
}
.reaction-chip:hover {
  transform: scale(1.1);
}
.reaction-chip--reacted {
  border-width: 1.5px;
}
.reaction-tooltip {
  text-align: center;
  padding: 2px 0;
}
.reaction-tooltip-emoji {
  font-size: 20px;
  margin-bottom: 2px;
}
.reaction-tooltip-name {
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
