<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import VirtualListDemoRow from '@/components/VirtualListDemoRow.vue'

type Mode = 'slice-id-key' | 'recycle-slot-key'

const mode = ref<Mode>('slice-id-key')

const totalCount = ref(10000)
const itemHeight = ref(56) // px (matches row height)
const viewportHeight = ref(520) // px
const buffer = ref(6)

const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)

const mounts = ref(0)
const unmounts = ref(0)
const rebounds = ref(0)

const resetCounters = () => {
  mounts.value = 0
  unmounts.value = 0
  rebounds.value = 0
}

const onScroll = () => {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0
}

const visibleCount = computed(() => Math.ceil(viewportHeight.value / itemHeight.value))

const startIndex = computed(() => {
  const raw = Math.floor(scrollTop.value / itemHeight.value) - buffer.value
  return Math.max(0, raw)
})

const endIndex = computed(() => {
  const raw = startIndex.value + visibleCount.value + buffer.value * 2
  return Math.min(totalCount.value, raw)
})

const totalHeight = computed(() => totalCount.value * itemHeight.value)

const makeItem = (id: number) => ({ id, label: `Item #${id}` })

// Mode A: slice the data and render with :key=item.id
const slicedItems = computed(() => {
  const items: Array<{ id: number; label: string }> = []
  for (let i = startIndex.value; i < endIndex.value; i += 1) items.push(makeItem(i))
  return items
})

// Mode B: render a fixed number of slots with :key=slotIndex (DOM reuse)
const slotCount = computed(() => visibleCount.value + buffer.value * 2)
const effectiveSlotCount = computed(() => {
  const remaining = totalCount.value - startIndex.value
  return Math.max(0, Math.min(slotCount.value, remaining))
})
const slotIndices = computed(() => Array.from({ length: effectiveSlotCount.value }, (_, i) => i))

const slotItemAt = (slotIndex: number) => {
  const itemIndex = startIndex.value + slotIndex
  if (itemIndex < 0 || itemIndex >= totalCount.value) return null
  return makeItem(itemIndex)
}

const rowStyleForIndex = (itemIndex: number) => ({
  transform: `translateY(${itemIndex * itemHeight.value}px)`,
})

const handleMounted = () => {
  mounts.value += 1
}

const handleUnmounted = () => {
  unmounts.value += 1
}

const handleRebound = () => {
  rebounds.value += 1
}

const scrollToTop = async () => {
  if (!scrollEl.value) return
  scrollEl.value.scrollTop = 0
  await nextTick()
  onScroll()
}

const scrollToMiddle = async () => {
  if (!scrollEl.value) return
  scrollEl.value.scrollTop = Math.floor(totalHeight.value / 2)
  await nextTick()
  onScroll()
}

onMounted(() => {
  onScroll()
})
</script>

<template>
  <section class="space-y-3">
    <header class="space-y-2">
      <h2 class="text-base font-semibold text-gray-800">Virtual List Demo (fixed height)</h2>
      <p class="text-xs text-gray-500">
        Toggle modes and scroll. Watch counters to see whether rows mount/unmount (slice + id key) or mainly reuse
        DOM with updates (recycle + slot key).
      </p>

      <div class="flex flex-wrap gap-2 items-center">
        <label class="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="mode"
            value="slice-id-key"
            :checked="mode === 'slice-id-key'"
            @change="mode = 'slice-id-key'; resetCounters()"
          />
          <span>Slice render + <span class="font-mono">key=item.id</span></span>
        </label>

        <label class="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="mode"
            value="recycle-slot-key"
            :checked="mode === 'recycle-slot-key'"
            @change="mode = 'recycle-slot-key'; resetCounters()"
          />
          <span>Recycle slots + <span class="font-mono">key=slotIndex</span></span>
        </label>

        <button
          type="button"
          class="ml-auto px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 active:bg-blue-800"
          @click="resetCounters"
        >
          Reset counters
        </button>
      </div>

      <div class="grid grid-cols-2 gap-2 text-xs text-gray-600">
        <div class="bg-white border border-gray-100 rounded-lg p-2">mounts: <b>{{ mounts }}</b></div>
        <div class="bg-white border border-gray-100 rounded-lg p-2">unmounts: <b>{{ unmounts }}</b></div>
        <div class="bg-white border border-gray-100 rounded-lg p-2">rebind/updates: <b>{{ rebounds }}</b></div>
        <div class="bg-white border border-gray-100 rounded-lg p-2">
          rendered nodes:
          <b>{{ mode === 'slice-id-key' ? slicedItems.length : effectiveSlotCount }}</b>
        </div>
      </div>

      <div class="flex gap-2">
        <button
          type="button"
          class="px-3 py-1.5 rounded-md bg-gray-100 text-gray-700 text-xs hover:bg-gray-200"
          @click="scrollToTop"
        >
          Scroll top
        </button>
        <button
          type="button"
          class="px-3 py-1.5 rounded-md bg-gray-100 text-gray-700 text-xs hover:bg-gray-200"
          @click="scrollToMiddle"
        >
          Scroll middle
        </button>
      </div>
    </header>

    <div
      ref="scrollEl"
      class="bg-white border border-gray-200 rounded-xl overflow-y-auto relative"
      :style="{ height: viewportHeight + 'px' }"
      @scroll.passive="onScroll"
      aria-label="Virtual list scroll area"
    >
      <!-- This spacer makes the scrollbar behave like there are totalCount items -->
      <div class="relative w-full" :style="{ height: totalHeight + 'px' }">
        <!-- Mode A: slice + key=item.id (will mount/unmount as you scroll) -->
        <template v-if="mode === 'slice-id-key'">
          <div
            v-for="item in slicedItems"
            :key="item.id"
            class="absolute left-0 right-0 px-2 py-1"
            :style="rowStyleForIndex(item.id)"
          >
            <VirtualListDemoRow
              :item="item"
              :slot-index="-1"
              @mounted="handleMounted"
              @unmounted="handleUnmounted"
              @rebound="handleRebound"
            />
          </div>
        </template>

        <!-- Mode B: recycle slots + key=slotIndex (DOM reuse) -->
        <template v-else>
          <div
            v-for="slotIndex in slotIndices"
            :key="slotIndex"
            class="absolute left-0 right-0 px-2 py-1"
            :style="rowStyleForIndex(startIndex + slotIndex)"
          >
            <VirtualListDemoRow
              :item="slotItemAt(slotIndex)"
              :slot-index="slotIndex"
              @mounted="handleMounted"
              @unmounted="handleUnmounted"
              @rebound="handleRebound"
            />
          </div>
        </template>
      </div>
    </div>

    <footer class="text-xs text-gray-500">
      Notes: In recycle mode, the same row components stay mounted; their props change as you scroll. In slice mode,
      keys change with data, so Vue will create/destroy row subtrees more often.
    </footer>
  </section>
</template>
