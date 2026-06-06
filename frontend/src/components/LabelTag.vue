<script setup lang="ts">
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    type?: 'company' | 'year' | 'key-point'|'frequency'|'difficulty';
    items?: string[];
  }>(),
  {
    items: () => []
  }
);

const isExpanded = ref(false);
function toggleExpanded() {
  isExpanded.value = !isExpanded.value;
}

const displayedItems = computed(() => {
  const items = props.items;

  if (isExpanded.value && items.length > 0) {
    return items.join(', ');
  }

  if (props?.type === 'frequency') {
    const val = items?.[0];
    if (!val) return '';
    const freq = Number(val);
    if (!Number.isFinite(freq)) return val;
    
    if (freq >= 0.05) return '高频';
    if (freq >= 0.01) return '中频';
    return '低频';
  }

  if (props?.type === 'difficulty') {
    const val = items?.[0];
    if (val === '1') return '简单';
    if (val === '2') return '中等';
    if (val === '3') return '困难';
    return val;
  }

  let suffix = '';
  if (props?.type === 'company') {
    suffix = `(等${items.length}家公司)`;
  } else if (props?.type === 'year') {
    suffix = `(等${items.length}个年份)`;
  } else if (props?.type === 'key-point') {
    suffix = `(等${items.length}个要点)`;
  }

  const shown = items.slice(0, 3).join(', ');
  return items.length > 3 ? `${shown}${suffix}` : shown;
});
</script>

<template>
  <div class="label-tag inline-flex h-5 max-w-full items-center whitespace-nowrap px-2 bg-blue-50 text-blue-500 text-xs leading-none font-medium rounded-full" @click="toggleExpanded">
    <span>{{ displayedItems }}</span>
  </div>
</template>

<style scoped>
.label-tag {
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
</style>
