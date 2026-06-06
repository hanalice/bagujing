<script setup lang="ts">
  import { ref,  watch } from 'vue';
  import { generateProblemAnswer, getProblemById, type Problem } from '@/api/problemItem';
    import DOMPurify from 'dompurify';
    import { useBreadcrumbStore } from '@/stores/breadcrumb'
    import LabelTag from '@/components/LabelTag.vue';

    const props = defineProps<{
      problemId: number;
      categoryId?: number;
      categoryName?: string;
    }>();

    const emit = defineEmits<(e: 'answer-generating-change', value: boolean) => void>();

    const breadcrumbStore = useBreadcrumbStore()
    const problem = ref<Problem>();
    const selectedTab = ref<'answer' | 'analysis' | 'more-ask'>('answer');
    const isGeneratingAnswer = ref(false)
    const answerGenerateError = ref<string | null>(null)
    const generatedForProblemIds = ref<Set<number>>(new Set())

    let fetchSeq = 0

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const sanitizeFromKeys = (source: Record<string, unknown>, keys: string[]) => {
      for (const key of keys) {
        const value = source[key]
        if (typeof value === 'string' && value.trim()) {
          return DOMPurify.sanitize(value)
        }
      }
      return ''
    }

    const refreshAnswerWithRetry = async (problemId: number, seq: number) => {
      // Use a slightly larger retry count but still finite
      const MAX_RETRIES = 10;
      for (let i = 0; i < MAX_RETRIES; i += 1) {
        if (seq !== fetchSeq) return false
        if (!problem.value || Number(problem.value.id) !== problemId) return false

        const refreshed = await getProblemById(problemId)
        if (seq !== fetchSeq) return false

        const refreshedAnswer = sanitizeFromKeys(refreshed as unknown as Record<string, unknown>, ['answer', 'answerHtml', 'answer_html'])
        if (refreshedAnswer.trim()) {
          problem.value = {
            ...problem.value,
            answer: refreshedAnswer,
          }
          return true
        }

        if (i < MAX_RETRIES - 1) {
          await sleep(1500)
        }
      }

      console.warn(`[ProblemItem] Failed to fetch answer for problem ${problemId} after multiple attempts.`);
      return false
    }

    const generateAndRefreshAnswer = async (problemId: number, seq: number, force = false) => {
      isGeneratingAnswer.value = true
      answerGenerateError.value = null
      try {
        let generateError: unknown = null
        let responseAnswer = ''
        try {
          const res = await generateProblemAnswer(problemId, { force })
          if (res && res.answer) {
            responseAnswer = res.answer
          }
        } catch (error) {
          generateError = error
        }

        if (seq !== fetchSeq) return
        if (!problem.value || Number(problem.value.id) !== problemId) return

        // If the generation call returned the answer directly (e.g., from cache),
        // update the state immediately and skip polling to avoid loops.
        if (responseAnswer) {
          problem.value = {
            ...problem.value,
            answer: responseAnswer,
          }
          answerGenerateError.value = null
          return
        }

        const updated = await refreshAnswerWithRetry(problemId, seq)

        if (!updated && generateError) {
          answerGenerateError.value = generateError instanceof Error ? generateError.message : String(generateError)
        }

        if (updated) {
          answerGenerateError.value = null
        }
      } finally {
        if (seq === fetchSeq) {
          isGeneratingAnswer.value = false
        }
      }
    }

    const handleRegenerateAnswer = async () => {
      const currentProblemId = Number(problem.value?.id)
      if (!Number.isFinite(currentProblemId)) return

      generatedForProblemIds.value.add(currentProblemId)
      const seq = fetchSeq
      await generateAndRefreshAnswer(currentProblemId, seq, true)
    }

    const fetchProblem = async (idParam: string | number) => {
      const seq = ++fetchSeq
      problem.value = undefined
      answerGenerateError.value = null
      const data = await getProblemById(idParam);
      if (seq !== fetchSeq) return

      const next: Problem = {
        ...data,
        name: sanitizeFromKeys(data as unknown as Record<string, unknown>, ['name', 'nameHtml', 'name_html', 'briefName', 'brief_name']),
        answer: sanitizeFromKeys(data as unknown as Record<string, unknown>, ['answer', 'answerHtml', 'answer_html']),
        analysis: DOMPurify.sanitize(data.analysis ?? ''),
        moreAsk: sanitizeFromKeys(data as unknown as Record<string, unknown>, ['moreAsk', 'more_ask', 'moreAskHtml', 'more_ask_html']),
        mindmap: DOMPurify.sanitize(data.mindmap ?? ''),
        options: Array.isArray(data.options) ? data.options.map(opt => DOMPurify.sanitize(opt)) : data.options,
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(kp => DOMPurify.sanitize(kp)) : data.keyPoints,
        companies: Array.isArray(data.companies) ? data.companies.map(corp => DOMPurify.sanitize(corp)) : data.companies,
        years: Array.isArray(data.years) ? data.years.map(year => DOMPurify.sanitize(year)) : data.years,
        // freq: (() => {
        //   const freq = Number(data.freq)
        //   return Number.isFinite(freq) ? Number((freq * 100).toFixed(2)) : 0
        // })(),
      }

      problem.value = next

      const noAnswer = !next.answer || !next.answer.trim()
      const nextProblemId = Number(next.id)
      if (!noAnswer || !Number.isFinite(nextProblemId) || generatedForProblemIds.value.has(nextProblemId)) return

      generatedForProblemIds.value.add(nextProblemId)
      await generateAndRefreshAnswer(nextProblemId, seq)
    };

    watch(
      () => [props.categoryId, props.categoryName] as const,
      ([categoryId, categoryName]) => {
        if (categoryId === undefined || categoryId === null) return
        breadcrumbStore.setCategoryContext({ categoryId, categoryName })
      },
      { immediate: true }
    )

    // 监听路由中动态 id 变化，切换详情时自动加载
    watch(
      () => props.problemId as number | undefined,
      (newId) => {
        if (newId !== undefined && newId !== null) {
          fetchProblem(newId)
        }
      },
      { immediate: true }
    );

    watch(
      () => isGeneratingAnswer.value,
      (value) => {
        emit('answer-generating-change', value)
      },
      { immediate: true }
    )

</script>

<template>
  <div class="text text-gray-800 problem-detail" v-if="problem">
    <h2 v-html="problem?.name || problem?.briefName || ''"></h2>
    <div class="flex flex-wrap gap-2 mb-4">
      <LabelTag type="difficulty" :items="[String(problem?.level)]" v-if="problem?.level !== undefined && problem?.level !== null"></LabelTag>
      <LabelTag type="frequency" :items="[String(problem?.freq)]" v-if="problem?.freq !== undefined && problem?.freq !== null"></LabelTag>
      <LabelTag type="key-point" :items="problem?.keyPoints ?? []" v-if="problem?.keyPoints?.length"></LabelTag>
      <LabelTag type="year" :items="problem?.years ?? []" v-if="problem?.years?.length"></LabelTag>
      <LabelTag type="company" :items="problem?.companies ?? []" v-if="problem?.companies?.length"></LabelTag>
    </div>

    <nav class="flex">
      <div role="tablist" aria-label="Problem tabs" class="w-full">
        <div class="w-full flex flex-wrap items-end gap-x-8 gap-y-2 border-b border-gray-200">
          <button
            type="button"
            role="tab"
            :aria-selected="selectedTab === 'answer'"
            :tabindex="selectedTab === 'answer' ? 0 : -1"
            :class="[
              'appearance-none bg-transparent border-0 border-b-2 -mb-px px-0 py-3 text-base font-medium leading-none transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
              selectedTab === 'answer'
                ? 'text-black border-blue-500'
                : 'text-black border-transparent hover:text-black',
            ]"
            @click="selectedTab = 'answer'"
            v-if="problem?.answer"
          >
            回答
          </button>

          <button
            type="button"
            role="tab"
            :aria-selected="selectedTab === 'analysis'"
            :tabindex="selectedTab === 'analysis' ? 0 : -1"
            :class="[
              'appearance-none bg-transparent border-0 border-b-2 -mb-px px-0 py-3 text-base font-medium leading-none transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
              selectedTab === 'analysis'
                ? 'text-black border-blue-500'
                : 'text-black border-transparent hover:text-black',
            ]"
            @click="selectedTab = 'analysis'"
            v-if="problem?.analysis"
          >
            分析
          </button>

          <button
            type="button"
            role="tab"
            :aria-selected="selectedTab === 'more-ask'"
            :tabindex="selectedTab === 'more-ask' ? 0 : -1"
            :class="[
              'appearance-none bg-transparent border-0 border-b-2 -mb-px px-0 py-3 text-base font-medium leading-none transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
              selectedTab === 'more-ask'
                ? 'text-black border-blue-500'
                : 'text-black border-transparent hover:text-black',
            ]"
            @click="selectedTab = 'more-ask'"
             v-if="problem?.moreAsk"
          >
            追问
          </button>

          <button
            type="button"
            title="重新生成答案"
            aria-label="重新生成答案"
            class="ml-auto h-8 w-8 shrink-0 rounded-md border-0 appearance-none bg-transparent hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-60 disabled:cursor-not-allowed basis-full sm:basis-auto sm:ml-auto"
            :disabled="isGeneratingAnswer"
            @click="handleRegenerateAnswer"
          >
            <span aria-hidden="true" class="inline-flex h-full w-full items-center justify-center text-base leading-none font-bold">&#x21bb;</span>
          </button>
        </div>
      </div>
    </nav>

    <section class="content">
      <div v-if="selectedTab === 'answer'" class="relative min-h-[160px]">
        <div v-if="problem?.answer" v-html="problem?.answer"></div>
        <div v-if="answerGenerateError" class="text-red-500 text-sm mt-2">{{ answerGenerateError }}</div>

        <div
          v-if="isGeneratingAnswer"
          class="absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur-[1px]"
        >
          <div class="px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-600 animate-pulse">
            AI 正在生成答案…
          </div>
        </div>
      </div>
      <div v-else-if="selectedTab === 'analysis'" v-html="problem?.analysis"></div>
      <div v-else-if="selectedTab === 'more-ask'" v-html="problem?.moreAsk"></div>
    </section>
  </div>
</template>

<style scoped>
  .problem-detail {
    display: grid;
    grid-template-rows: 1fr 1fr auto;
    row-gap: 1em;

    :deep(h1),:deep(h2),:deep(h3),:deep(h4),:deep(h5),:deep(h6) {
      font-weight: bold;
      margin: .5em 0;
      line-height: 1.4;
    }

    :deep(pre) {
      border-radius: .3em;
      margin: .5em 0;
      overflow: auto;
      padding: 1em;
      background: #eee;
    }

    :deep(pre > code[class^="language-"]) {
      color: #383a42;
      direction: ltr;
      font-family: Fira Code, Fira Mono, Menlo, Consolas, DejaVu Sans Mono, monospace;
      -webkit-hyphens: none;
      hyphens: none;
      line-height: 1.5;
      -moz-tab-size: 2;
      -o-tab-size: 2;
      tab-size: 2;
      text-align: left;
      white-space: pre;
      word-break: normal;
      word-spacing: normal;

      ::before {
        border-radius: 0 0 0 5px;
        display: inline-block;
        font-size: .9em;
        padding: 0 .5em;
        position: absolute;
        right: 0;
        text-shadow: none;
        top: 0;
      }

      .token.keyword {
        color: #a626a4;
      }

      .token.punctuation {
        color: #383a42;
      }

      .token.function, .token.operator, .token.variable {
        color: #4078f2;
      }

      .token.boolean {
        color: #b76b01;
      }
    }
  }




</style>
