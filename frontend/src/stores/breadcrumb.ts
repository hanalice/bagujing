import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useBreadcrumbStore = defineStore('breadcrumb', () => {
  const categoryId = ref<number>()
  const categoryName = ref<string>()
  const problemId = ref<number>()

  const setCategoryContext = (payload: { categoryId: number; categoryName?: string }) => {
    categoryId.value = payload.categoryId
    categoryName.value = payload.categoryName
  }

  const setProblemContext = (payload: { problemId: number; }) => {
    problemId.value = payload.problemId
  }

  const clear = () => {
    categoryId.value = undefined
    categoryName.value = undefined
    problemId.value = undefined
  }

  return {
    categoryId,
    categoryName,
    problemId,
    setCategoryContext,
    setProblemContext,
    clear,
  }
})
