<script setup lang="ts">
  import { ref, watch, onMounted, onBeforeUnmount, toRef, computed } from 'vue'
  import { getProblemCompanies, getProblemKeyPoints, getProblems, type ProblemListResponse } from '../api/problemList'
  import { useBreadcrumbStore } from '@/stores/breadcrumb'

  const props = defineProps<{
      categoryId?: number;
      categoryName?: string;
    }>();

  const breadcrumbStore = useBreadcrumbStore()

  const categoryIdRef = toRef(props, 'categoryId')
  const categoryNameRef = toRef(props, 'categoryName')

  const goToProblemItem = (id: number) => {
    breadcrumbStore.setProblemContext({ problemId: id });
  }

  watch(
    [categoryIdRef, categoryNameRef],
    ([categoryId, categoryName]) => {
      if (!categoryId) {
        breadcrumbStore.clear()
        return
      }
      breadcrumbStore.setCategoryContext({ categoryId: categoryId as number, categoryName: categoryName as string })
    },
    { immediate: true }
  )

  const questionList = ref<ProblemListResponse>()
  const pageSize = 10
  const cursor = ref<number | null>(null)
  const isLoading = ref(false)
  const hasMore = ref(true)
  const loadMoreTrigger = ref<HTMLElement | null>(null)
  let observer: IntersectionObserver | null = null
  let keywordDebounceTimer: ReturnType<typeof setTimeout> | null = null
  const searchKeyword = ref('');
  const companyOptions = ref<string[]>([])
  const selectedCompany = ref('')
  const selectedLevel = ref<number | null>(null)
  const selectedFreqRange = ref<'low' | 'medium' | 'high' | ''>('')
  const keyPointOptions = ref<string[]>([])
  const selectedKeyPoint = ref('')

  const appendProblems = (incoming?: ProblemListResponse) => {
    if (!incoming) return
    const current = questionList.value ?? { list: [], total: 0, pageSize }
    const seen = new Set((current.list ?? []).map(item => item.id))
    const incomingList = (incoming.list ?? []).filter(item => !seen.has(item.id))
    questionList.value = {
      ...incoming,
      list: [...(current.list ?? []), ...incomingList],
    }

    cursor.value = incoming.nextCursor ?? null

    const totalLoaded = questionList.value.list?.length ?? 0
    const totalAvailable = incoming.total ?? totalLoaded
    hasMore.value = totalLoaded < totalAvailable && cursor.value !== null
  }

  const loadMore = async (category?: number, searchKeyword?: string, company?: string, level?: number | null, freqRange?: string, keyPoint?: string) => {
    if (isLoading.value || !hasMore.value) return
    isLoading.value = true
    try {
      const search = searchKeyword ? searchKeyword?.trim() : '';
      const data = await getProblems({
        category: category,
        company: company || undefined,
        keyword: search || undefined,
        level: level ?? undefined,
        freqRange: (freqRange as any) || undefined,
        keyPoint: keyPoint || undefined,
        cursor: cursor.value ?? undefined,
        pageSize,
      })
      appendProblems(data)
    } catch (err) {
      console.error('Failed to load problems:', err)
      hasMore.value = false
    } finally {
      isLoading.value = false
    }
  }

  const resetAndLoad = async (category?: number, searchKeyword?: string, company?: string, level?: number | null, freqRange?: string, keyPoint?: string) => {
    questionList.value = { list: [], total: 0, pageSize }
    cursor.value = null
    hasMore.value = true
    await loadMore(category, searchKeyword, company, level, freqRange, keyPoint)
    
    if (questionList.value?.list?.[0]?.id) {
      goToProblemItem(questionList.value.list[0].id)
    }
  }

  const loadCompanyOptions = async (category?: number) => {
    try {
      const list = await getProblemCompanies({ category })
      companyOptions.value = list ?? []
      if (!selectedCompany.value || (selectedCompany.value && !companyOptions.value.includes(selectedCompany.value))) {
        selectedCompany.value = ''
      }
    } catch (err) {
      console.error('Failed to load companies:', err)
      companyOptions.value = []
      selectedCompany.value = ''
    }
  }

  const loadKeyPointOptions = async (category?: number) => {
    try {
      const list = await getProblemKeyPoints({ category })
      keyPointOptions.value = list ?? []
      if (!selectedKeyPoint.value || (selectedKeyPoint.value && !keyPointOptions.value.includes(selectedKeyPoint.value))) {
        selectedKeyPoint.value = ''
      }
    } catch (err) {
      console.error('Failed to load key points:', err)
      keyPointOptions.value = []
      selectedKeyPoint.value = ''
    }
  }

  const firstQuestionId = computed(() => questionList.value?.list?.[0]?.id)
  const problemIds = computed(() => (questionList.value?.list ?? []).map((item) => item.id))
  const totalProblems = computed(() => questionList.value?.total ?? 0)
  const currentIndex = computed(() => {
    const activeId = breadcrumbStore.problemId
    if (!activeId) return -1
    return problemIds.value.indexOf(activeId)
  })
  const canGoPrev = computed(() => currentIndex.value > 0)
  const canGoNext = computed(() => {
    if (currentIndex.value < 0) return false
    if (currentIndex.value < problemIds.value.length - 1) return true
    return hasMore.value && !isLoading.value
  })

  // this is used to click the first question from outside
  const clickFirstQuestion = () => {
    const id = firstQuestionId.value
    if (id) {
      goToProblemItem(id)
    }
  }

  const goPrevQuestion = () => {
    const index = currentIndex.value
    if (index <= 0) return
    const prevId = problemIds.value[index - 1]
    if (prevId) goToProblemItem(prevId)
  }

  const goNextQuestion = async () => {
    const index = currentIndex.value
    if (index < 0) return

    if (index < problemIds.value.length - 1) {
      const nextId = problemIds.value[index + 1]
      if (nextId) goToProblemItem(nextId)
      return
    }

    if (!hasMore.value || isLoading.value) return

    const prevLength = problemIds.value.length
    await loadMore(categoryIdRef.value, searchKeyword.value, selectedCompany.value, selectedLevel.value, selectedFreqRange.value, selectedKeyPoint.value)
    const hasLoadedNewItem = problemIds.value.length > prevLength
    if (!hasLoadedNewItem) return

    const nextId = problemIds.value[prevLength]
    if (nextId) goToProblemItem(nextId)
  }

  watch(
    categoryIdRef,
    async (categoryId) => {
      await Promise.all([
        loadCompanyOptions(categoryId),
        loadKeyPointOptions(categoryId)
      ])
      resetAndLoad(categoryId, searchKeyword.value, selectedCompany.value, selectedLevel.value, selectedFreqRange.value, selectedKeyPoint.value)
    },
    { immediate: true }
  )

  watch(
    searchKeyword,
    (search) => {
      if (keywordDebounceTimer) clearTimeout(keywordDebounceTimer)
      keywordDebounceTimer = setTimeout(() => {
        resetAndLoad(categoryIdRef.value, search, selectedCompany.value, selectedLevel.value, selectedFreqRange.value, selectedKeyPoint.value)
      }, 400)
    }
  )

  watch(
    [selectedCompany, selectedLevel, selectedFreqRange, selectedKeyPoint],
    () => {
      resetAndLoad(categoryIdRef.value, searchKeyword.value, selectedCompany.value, selectedLevel.value, selectedFreqRange.value, selectedKeyPoint.value)
    }
  )

  onMounted(() => {
    observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting) loadMore(props.categoryId, searchKeyword.value, selectedCompany.value, selectedLevel.value, selectedFreqRange.value, selectedKeyPoint.value)
    })
    if (loadMoreTrigger.value && observer) observer.observe(loadMoreTrigger.value)
  })

  onBeforeUnmount(() => {
    if (loadMoreTrigger.value && observer) observer.unobserve(loadMoreTrigger.value)
    observer?.disconnect()
    if (keywordDebounceTimer) {
      clearTimeout(keywordDebounceTimer)
      keywordDebounceTimer = null
    }
  })

  defineExpose({
    clickFirstQuestion,
    firstQuestionId,
    currentIndex,
    totalProblems,
    canGoPrev,
    canGoNext,
    goPrevQuestion,
    goNextQuestion,
  })

</script>

<template>
  <div class="space-y-4">
    <!-- 过滤器面板 -->
    <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 space-y-4">
      <!-- 搜索框 -->
      <div class="relative">
        <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <div class="i-carbon-search text-gray-400"></div>
        </div>
        <input
          v-model="searchKeyword"
          type="search"
          placeholder="Search problems..."
          class="block w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-100 focus:border-blue-400 transition-all outline-none text-sm placeholder:text-gray-400"
        />
      </div>

      <!-- 选项过滤 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- 难度 -->
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">难度</label>
          <div class="grid grid-cols-3 gap-2">
            <button 
              v-for="opt in [{label:'容易', val:1}, {label:'中等', val:2}, {label:'困难', val:3}]" 
              :key="opt.val"
              @click="selectedLevel = selectedLevel === opt.val ? null : opt.val"
              :class="[
                'w-full py-1.5 rounded-lg text-sm border transition-all',
                selectedLevel === opt.val 
                  ? 'bg-blue-50 border-blue-400 text-blue-600 shadow-sm' 
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              ]"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <!-- 频次 -->
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">出现频次</label>
          <div class="grid grid-cols-3 gap-2">
            <button 
              v-for="opt in [{label:'低频', val:'low'}, {label:'中频', val:'medium'}, {label:'高频', val:'high'}]" 
              :key="opt.val"
              @click="selectedFreqRange = selectedFreqRange === opt.val ? '' : (opt.val as any)"
              :class="[
                'w-full py-1.5 rounded-lg text-sm border transition-all',
                selectedFreqRange === opt.val 
                  ? 'bg-blue-50 border-blue-400 text-blue-600 shadow-sm' 
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              ]"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <!-- 公司 -->
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">公司</label>
          <select
            v-model="selectedCompany"
            class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236B7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem_1.25rem] bg-[right_0.5rem_center] bg-no-repeat"
          >
            <option value="">所有公司</option>
            <option v-for="c in companyOptions" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>

        <!-- 考点 -->
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">考察点</label>
          <select
            v-model="selectedKeyPoint"
            class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236B7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem_1.25rem] bg-[right_0.5rem_center] bg-no-repeat"
          >
            <option value="">所有考察点</option>
            <option v-for="k in keyPointOptions" :key="k" :value="k">{{ k }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 列表 -->
    <div class="space-y-3">
      <button
        v-for="q in questionList?.list"
        :key="q.id"
        type="button"
        @click="goToProblemItem(q.id)"
        class="w-full text-left bg-white p-4 rounded-xl shadow-sm border border-gray-100 hover:border-blue-200 hover:shadow-md active:bg-gray-50 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-100 group"
      >
        <div class="flex justify-between items-start gap-3">
          <h3 class="text-gray-800 font-medium line-clamp-2 leading-relaxed flex-1 group-hover:text-blue-600 transition-colors">{{ q?.briefName }}</h3>
          <div class="i-carbon-chevron-right text-gray-300 mt-1 shrink-0 group-hover:text-blue-400 group-hover:translate-x-0.5 transition-all"></div>
        </div>
        
        <div class="flex items-center justify-between mt-3">
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex items-center gap-1.5 overflow-hidden">
              <span
                v-for="p in q?.keyPoints?.slice(0, 2)"
                :key="p"
                class="px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-500 text-[10px] font-medium whitespace-nowrap"
              >
                {{ p }}
              </span>
              <span v-if="q?.keyPoints && q.keyPoints.length > 2" class="text-[10px] text-gray-400">+{{ q.keyPoints.length - 2 }}</span>
            </div>
          </div>
        </div>
      </button>
    </div>
    <div ref="loadMoreTrigger" class="py-4 text-center text-xs text-gray-400">
      <span v-if="isLoading">加载中...</span>
      <span v-else-if="!hasMore">没有更多了</span>
    </div>
  </div>
</template>
