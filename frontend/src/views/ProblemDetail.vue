<script setup lang="ts">
import ProblemList from './ProblemList.vue';
import ProblemItem from './ProblemItem.vue';
import AiAssistant from './AiAssistant.vue';
import { useSettingsStore } from '@/stores/settings';
import { useUserStore } from '@/stores/user';
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useBreadcrumbStore } from '@/stores/breadcrumb'

const settingsStore = useSettingsStore()
const userStore = useUserStore()
const route = useRoute()
const breadcrumbStore = useBreadcrumbStore()
const problemId = ref<number>();

  type ProblemListExposed = {
    clickFirstQuestion: () => void
    firstQuestionId?: number
    currentIndex?: number
    totalProblems?: number
    canGoPrev?: boolean
    canGoNext?: boolean
    goPrevQuestion: () => void
    goNextQuestion: () => Promise<void>
  }

  type AiAssistantExposed = {
    abortStream: () => void
  }

  const problemListRef = ref<ProblemListExposed | null>(null);
  const aiAssistantRef = ref<AiAssistantExposed | null>(null)
  const isAssistantOpen = ref(false)
  const isProblemGeneratingAnswer = ref(false)
  const hasAutoClickedFirst = ref(false)

  const firstQueryValue = (value: unknown): string | number | undefined => {
    if (typeof value === 'string') {
      const n = Number(value)
      return Number.isNaN(n) ? value : n
    }

    if (Array.isArray(value)) {
      const first = value[0]
      if (typeof first !== 'string') return undefined;

      const n = Number(first)
      return Number.isNaN(n) ? first : n
    }

    return undefined
  }

  const categoryIdFromRoute = computed(() => firstQueryValue(route.query.categoryId))
  const categoryNameFromRoute = computed(() => firstQueryValue(route.query.categoryName))
  const assistantContext = computed(() => ({
    categoryId: categoryIdFromRoute.value,
    problemId: problemId.value,
  }))
  const assistantResetKey = computed(() => `${String(categoryIdFromRoute.value ?? '')}:${String(problemId.value ?? '')}`)
  const currentProgress = computed(() => {
    const idx = problemListRef.value?.currentIndex
    if (typeof idx !== 'number' || idx < 0) return 0
    return idx + 1
  })
  const totalProgress = computed(() => {
    const total = problemListRef.value?.totalProblems
    return typeof total === 'number' && total >= 0 ? total : 0
  })
  const canGoPrev = computed(() => Boolean(problemListRef.value?.canGoPrev))
  const canGoNext = computed(() => Boolean(problemListRef.value?.canGoNext))

  const handlePrev = () => {
    problemListRef.value?.goPrevQuestion?.()
  }

  const handleNext = async () => {
    await problemListRef.value?.goNextQuestion?.()
  }

  watch(
    [categoryIdFromRoute, categoryNameFromRoute],
    ([categoryId, categoryName]) => {
      if (!categoryId) {
        breadcrumbStore.clear()
        hasAutoClickedFirst.value = false
        return;
      }
      hasAutoClickedFirst.value = false
      breadcrumbStore.setCategoryContext({ categoryId: categoryId as number, categoryName: categoryName as string })
    },
    { immediate: true }
  )

  watch(
    () => breadcrumbStore.problemId,
    (newId, oldId) => {
      if (newId !== oldId) {
        problemId.value = newId as number;
      }
    }
  )

  watch(
    [() => categoryIdFromRoute.value, () => problemId.value],
    ([nextCategoryId, nextProblemId], [prevCategoryId, prevProblemId]) => {
      if (nextCategoryId === prevCategoryId && nextProblemId === prevProblemId) return
      aiAssistantRef.value?.abortStream()
      isAssistantOpen.value = false
    }
  )

  watch(
    () => isProblemGeneratingAnswer.value,
    (isGenerating) => {
      if (!isGenerating) return
      aiAssistantRef.value?.abortStream()
      isAssistantOpen.value = false
    }
  )

  // Auto click the first question after ProblemList data ready, only when no problemId in store.
  watch(
    [() => problemListRef.value?.firstQuestionId, () => breadcrumbStore.problemId],
    ([firstQuestionId, storeProblemId]) => {
      if (hasAutoClickedFirst.value) return
      if (storeProblemId) return
      if (!firstQuestionId) return
      problemListRef.value?.clickFirstQuestion()
      hasAutoClickedFirst.value = true
    },
    { immediate: true }
  )

  // 离开详情页，category 和problem 的信息就没有用了，所以销毁掉。
  onUnmounted(() => {
    aiAssistantRef.value?.abortStream()
    breadcrumbStore.clear()
  })

</script>

<template>
  <div class="h-full min-h-0 flex gap-4 overflow-hidden bg-gray-100 p-2 md:p-4">
    <aside class="w-80 shrink-0 border-r border-gray-200 h-full min-h-0 overflow-y-auto scroll-smooth">
        <ProblemList ref="problemListRef" :category-id="categoryIdFromRoute as number" :category-name="categoryNameFromRoute as string"/>
    </aside>
    <main class="relative flex-1 min-w-0 h-full min-h-0 p-4 overflow-y-auto scroll-smooth bg-white">
      <div
        v-if="problemId"
        class="sticky top-0 z-20 mb-3 border border-gray-200 rounded-lg bg-white/95 backdrop-blur p-2 sm:p-3"
      >
        <div class="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            type="button"
            class="px-2.5 py-1.5 text-xs sm:text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!canGoPrev"
            @click="handlePrev"
          >
            上一题
          </button>

          <button
            type="button"
            class="px-2.5 py-1.5 text-xs sm:text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!canGoNext"
            @click="handleNext"
          >
            下一题
          </button>

          <p class="ml-auto text-xs sm:text-sm text-gray-500">
            刷题进度：第 {{ currentProgress }} 题 / 共 {{ totalProgress }} 题
          </p>
        </div>
      </div>

      <template v-if="problemId">
        <ProblemItem
          :key="problemId"
          :problem-id="problemId as number"
          :category-id="categoryIdFromRoute as number"
          :category-name="categoryNameFromRoute as string"
          @answer-generating-change="isProblemGeneratingAnswer = $event"
        />
      </template>
      <template v-else>
        <div class="flex items-center justify-center text-gray-400">
          请选择一个题目查看详情
        </div>
      </template>

      <div
        v-if="settingsStore.aiAssistant && userStore.profile?.permissions?.includes('chat_ai') && problemId && !isProblemGeneratingAnswer"
        class="pointer-events-none sticky bottom-4 z-40 mt-4 flex w-full justify-end"
      >
        <div class="pointer-events-auto flex max-w-full flex-col items-end gap-2">
          <section
            id="ai-assistant-panel"
            v-show="isAssistantOpen"
            class="w-[min(100%,480px)] rounded-2xl border border-gray-200 bg-white p-3 shadow-lg"
            aria-label="AI assistant panel"
          >
            <div class="mb-2 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-gray-800">AI 小助手</h2>
              <button
                type="button"
                class="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                @click="isAssistantOpen = false"
              >
                关闭
              </button>
            </div>
            <AiAssistant
              v-if="isAssistantOpen"
              ref="aiAssistantRef"
              :context="assistantContext"
              :reset-key="assistantResetKey"
              class="max-h-[70vh] overflow-hidden"
            />
          </section>

          <button
            type="button"
            class="h-14 w-14 rounded-full border border-gray-200 bg-white shadow-lg transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
            :aria-expanded="isAssistantOpen"
            aria-controls="ai-assistant-panel"
            @click="isAssistantOpen = !isAssistantOpen"
          >
            <span class="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">AI</span>
          </button>
        </div>
      </div>
    </main>
  </div>
</template>

<style lang="css" scoped>
  /* < 768px: sidebar 浮动在左侧（覆盖主内容） */
  @media (max-width: 767.98px) {
    .text {
      gap: 0;
    }

    aside {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 50;
      width: 0;
      transition: width 0.3s ease;
    }

    main {
      width: 100%;
      min-width: 0;
    }
  }

  /* >= 768px: sidebar + main 两栏布局 */
  @media (min-width: 768px) {
    aside {
      position: static;
      z-index: auto;
    }

    main {
      min-width: 0;
    }
  }
</style>
