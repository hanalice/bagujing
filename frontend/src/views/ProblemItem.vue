<script setup lang="ts">
  import { computed, ref, watch } from 'vue';
  import { generateProblemAnswer, getProblemById, type Problem } from '@/api/problemItem';
    import DOMPurify from 'dompurify';
    import { useBreadcrumbStore } from '@/stores/breadcrumb'
    import LabelTag from '@/components/LabelTag.vue';
    import {
      legacyAnswerToPlainText,
      normalizeStructuredAnswer,
    } from '@/utils/normalizeStructuredAnswer';

    const props = defineProps<{
      problemId: number;
      categoryId?: number;
      categoryName?: string;
    }>();

    const emit = defineEmits<(e: 'answer-generating-change', value: boolean) => void>();

    const breadcrumbStore = useBreadcrumbStore()
    const problem = ref<Problem>();
    /** 供归一化的答案载荷（与题目标签 keyPoints 隔离） */
    const answerSource = ref<Record<string, unknown>>({})
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

    /**
     * 从详情/generate 载荷提取答案归一化输入；仅当顶层含冻约三字段时才带上 keyPoints，
     * 避免把题目标签 keyPoints 误当作解析要点。
     */
    const buildAnswerSource = (data: Record<string, unknown>): Record<string, unknown> => {
      const answer = typeof data.answer === 'string' ? data.answer : ''
      const summary = data.summary
      const nextStep = data.nextStep
      const keyPoints = data.keyPoints
      if (
        typeof summary === 'string'
        && typeof nextStep === 'string'
        && Array.isArray(keyPoints)
        && keyPoints.every((item) => typeof item === 'string')
      ) {
        return { summary, keyPoints, nextStep, answer }
      }
      return { answer }
    }

    const normalizedAnswer = computed(() => normalizeStructuredAnswer(answerSource.value))

    const structuredAnswer = computed(() =>
      normalizedAnswer.value.kind === 'structured' ? normalizedAnswer.value.value : null
    )

    const legacyAnswerText = computed(() =>
      normalizedAnswer.value.kind === 'legacy'
        ? legacyAnswerToPlainText(normalizedAnswer.value.raw)
        : ''
    )

    const hasAnswerPanel = computed(() => normalizedAnswer.value.kind !== 'empty')

    const refreshAnswerWithRetry = async (problemId: number, seq: number) => {
      // Use a slightly larger retry count but still finite
      const MAX_RETRIES = 10;
      for (let i = 0; i < MAX_RETRIES; i += 1) {
        if (seq !== fetchSeq) return false
        if (!problem.value || Number(problem.value.id) !== problemId) return false

        const refreshed = await getProblemById(problemId)
        if (seq !== fetchSeq) return false

        const refreshedRec = refreshed as unknown as Record<string, unknown>
        const nextSource = buildAnswerSource(refreshedRec)
        const nextNormalized = normalizeStructuredAnswer(nextSource)
        if (nextNormalized.kind !== 'empty') {
          answerSource.value = nextSource
          problem.value = {
            ...problem.value,
            answer: typeof refreshedRec.answer === 'string' ? refreshedRec.answer : problem.value.answer,
            summary: typeof refreshedRec.summary === 'string' ? refreshedRec.summary : problem.value.summary,
            nextStep: typeof refreshedRec.nextStep === 'string' ? refreshedRec.nextStep : problem.value.nextStep,
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
        let generatePayload: Record<string, unknown> | null = null
        try {
          const res = await generateProblemAnswer(problemId, { force })
          if (res) {
            generatePayload = res as unknown as Record<string, unknown>
          }
        } catch (error) {
          generateError = error
        }

        if (seq !== fetchSeq) return
        if (!problem.value || Number(problem.value.id) !== problemId) return

        // 优先消费 generate 顶层三字段；不得仅把 answer 整串交给 v-html
        if (generatePayload) {
          const nextSource = buildAnswerSource(generatePayload)
          const nextNormalized = normalizeStructuredAnswer(nextSource)
          if (nextNormalized.kind !== 'empty') {
            answerSource.value = nextSource
            problem.value = {
              ...problem.value,
              answer: typeof generatePayload.answer === 'string'
                ? generatePayload.answer
                : problem.value.answer,
              summary: typeof generatePayload.summary === 'string'
                ? generatePayload.summary
                : problem.value.summary,
              nextStep: typeof generatePayload.nextStep === 'string'
                ? generatePayload.nextStep
                : problem.value.nextStep,
            }
            answerGenerateError.value = null
            return
          }
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
      answerSource.value = {}
      answerGenerateError.value = null
      const data = await getProblemById(idParam);
      if (seq !== fetchSeq) return

      const dataRec = data as unknown as Record<string, unknown>
      const rawAnswer = typeof dataRec.answer === 'string' ? dataRec.answer : ''

      const next: Problem = {
        ...data,
        name: sanitizeFromKeys(dataRec, ['name', 'nameHtml', 'name_html', 'briefName', 'brief_name']),
        // 答案原文保留供归一化；禁止在此整段 DOMPurify 后当作 HTML 展示
        answer: rawAnswer,
        summary: typeof dataRec.summary === 'string' ? dataRec.summary : undefined,
        nextStep: typeof dataRec.nextStep === 'string' ? dataRec.nextStep : undefined,
        analysis: DOMPurify.sanitize(data.analysis ?? ''),
        moreAsk: sanitizeFromKeys(dataRec, ['moreAsk', 'more_ask', 'moreAskHtml', 'more_ask_html']),
        mindmap: DOMPurify.sanitize(data.mindmap ?? ''),
        options: Array.isArray(data.options) ? data.options.map(opt => DOMPurify.sanitize(opt)) : data.options,
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(kp => DOMPurify.sanitize(kp)) : data.keyPoints,
        companies: Array.isArray(data.companies) ? data.companies.map(corp => DOMPurify.sanitize(corp)) : data.companies,
        years: Array.isArray(data.years) ? data.years.map(year => DOMPurify.sanitize(year)) : data.years,
      }

      answerSource.value = buildAnswerSource({
        ...dataRec,
        answer: rawAnswer,
      })
      problem.value = next

      const noAnswer = normalizeStructuredAnswer(answerSource.value).kind === 'empty'
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
            v-if="hasAnswerPanel"
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
      <div v-if="selectedTab === 'answer'" class="relative min-h-[160px]" data-testid="answer-panel">
        <div v-if="structuredAnswer" class="answer-structured" data-testid="answer-structured">
          <p class="answer-summary" data-testid="answer-summary">{{ structuredAnswer.summary }}</p>
          <ul class="answer-keypoints list-disc pl-5 my-2" data-testid="answer-keypoints">
            <li v-for="(point, idx) in structuredAnswer.keyPoints" :key="idx">{{ point }}</li>
          </ul>
          <p class="answer-next-step" data-testid="answer-next-step">{{ structuredAnswer.nextStep }}</p>
        </div>
        <div
          v-else-if="legacyAnswerText"
          class="answer-legacy"
          data-testid="answer-legacy"
        >{{ legacyAnswerText }}</div>
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
