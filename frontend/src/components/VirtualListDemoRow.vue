<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'

type RowItem = {
  id: number
  label: string
}

const props = defineProps<{
  item: RowItem | null
  slotIndex: number
}>()

const emit = defineEmits<{
  mounted: []
  unmounted: []
  rebound: [payload: { fromId: number | null; toId: number | null; slotIndex: number }]
}>()

onMounted(() => {
  /**
   * 通知父组件/外部监听者：当前行组件已完成挂载。
   *
   * 调用 `emit('mounted')` 会触发名为 `mounted` 的自定义事件，通常用于：
   * - 让父组件在子组件可用（DOM 已创建）后执行后续逻辑（如测量高度、注册观察、触发初始化等）。
   *
   * 说明：
   * - `emit` 一般来自 `defineEmits()`（Composition API），事件名为字符串 `'mounted'`。
   * - 该事件仅表示“组件已挂载完成”，不携带额外参数（除非另行传入）。
   */
  emit('mounted')
})

onBeforeUnmount(() => {
  emit('unmounted')
})

watch(
  () => props.item?.id ?? null,
  (toId, fromId) => {
    if (fromId !== null && toId !== null && fromId !== toId) {
      emit('rebound', { fromId, toId, slotIndex: props.slotIndex })
    }
  }
)
</script>

<template>
  <div class="h-14 flex items-center justify-between px-3 rounded-lg border border-gray-100 bg-white shadow-sm">
    <div class="min-w-0">
      <div class="text-sm font-medium text-gray-800 truncate">
        {{ item?.label ?? '—' }}
      </div>
      <div class="text-xs text-gray-400">
        id: {{ item?.id ?? '—' }} · slot: {{ slotIndex }}
      </div>
    </div>
    <div class="text-xs text-gray-500">Row</div>
  </div>
</template>
