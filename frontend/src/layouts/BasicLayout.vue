<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, RouterLink, useRoute } from 'vue-router'
import { useBreadcrumbStore } from '@/stores/breadcrumb'
import { formatBreadcrumbCategoryName } from '@/utils/breadcrumb'

const route = useRoute()
const breadcrumbStore = useBreadcrumbStore()

const showBreadcrumb = computed(() => route.name === 'problem-detail')

const contentClass = computed(() => {
  // Split-pane pages (like problem-detail) should manage their own scroll areas.
  // Other pages keep a single scroll container here.
  return showBreadcrumb.value ? 'overflow-hidden p-0' : 'overflow-y-auto p-4'
})

const categoryLabel = computed(() => {
  const rawName = breadcrumbStore.categoryName ?? ''
  if (!rawName.trim()) return '分类'
  return formatBreadcrumbCategoryName(rawName, 2, 2)
})

const categoryClickable = computed(() => {
  return Boolean(breadcrumbStore.categoryId && breadcrumbStore.categoryName && breadcrumbStore.categoryName.trim())
})

const homeTo = computed(() => ({ name: 'category-list' }))
const categoryTo = computed(() => ({
  name: 'problem-detail',
  query: {
    category: breadcrumbStore.categoryId ?? undefined,
    categoryName: breadcrumbStore.categoryName ?? undefined,
  },
}))
</script>

<template>
  <!-- 最外层容器：处理 PC 端适配 -->
  <!-- 去除了md:, 配置这个是说，只有宽度>=md 时生效 -->
  <!-- md:mx-auto: 在 PC 端居中 -->
  <!-- md:my-4: 在 PC 端上下留白 -->
  <!-- md:shadow-2xl: 在 PC 端添加阴影，增加立体感 -->
  <!-- md:rounded-xl: 在 PC 端添加圆角 -->
  <!-- md:h-[calc(100vh-2rem)]: 在 PC 端限制高度 -->
  <!-- overflow-hidden: 防止圆角溢出 -->
   <!-- 外层容器固定视口为h-full -->
  <div
    class="bg-gray-50 w-full h-full md:max-w-[1280px] md:mx-auto md:my-4 md:h-[calc(100vh-2rem)] shadow-2xl rounded-xl overflow-hidden flex flex-col relative border-x border-gray-100"
  >

    <!-- 顶部导航栏 (Header) -->
    <header v-if="route.name !== 'settings'" class="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div class="h-12 flex items-center justify-center px-4">
        <h1 class="text-lg font-bold text-gray-800">面试题库</h1>
      </div>

      <div v-if="showBreadcrumb" class="h-8 border-t border-gray-100 flex items-center justify-center px-4">
        <nav aria-label="Breadcrumb" class="w-full overflow-hidden">
          <ul class="flex items-center justify-center gap-1 text-xs text-gray-500 overflow-hidden list-none bread-padding-none">
            <li class="shrink-0">
              <RouterLink
                :to="homeTo"
                class="rounded px-1 text-blue-500 hover:bg-blue-100 hover:text-blue-600 active:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
              >
                首页
              </RouterLink>
            </li>

            <li aria-hidden="true" class="shrink-0">
              <span class="text-gray-300">></span>
            </li>

            <li class="min-w-0">
              <RouterLink
                v-if="categoryClickable"
                :to="categoryTo"
                class="block rounded px-1 text-blue-500 hover:bg-blue-100 hover:text-blue-600 active:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
              >
                <span class="block overflow-hidden text-ellipsis whitespace-nowrap">{{ categoryLabel }}</span>
              </RouterLink>
              <span v-else class="block px-1 text-gray-400 cursor-not-allowed">
                <span class="block overflow-hidden text-ellipsis whitespace-nowrap">{{ categoryLabel }}</span>
              </span>
            </li>
          </ul>
        </nav>
      </div>
    </header>

    <!-- 中间内容区域 (Content) -->
    <!-- flex-1: 占据剩余空间 -->
    <!-- overflow-y-auto: 允许垂直滚动 -->
    <main :class="['flex-1 min-h-0 scroll-smooth', contentClass]">
      <div class="h-full min-h-0">
        <RouterView />
      </div>
    </main>

    <!-- Footer Tabbar -->
    <nav aria-label="Tabbar" class="h-16 bg-white border-t border-gray-100 flex items-center justify-around pb-safe">
      <!-- Home Link -->
      <RouterLink
        to="/"
        class="flex flex-col items-center justify-center w-full h-full transition-colors duration-200"
        :class="route.name === 'category-list' ? 'text-blue-500' : 'text-gray-400 hover:text-blue-500'"
      >
        <div class="i-carbon-home text-2xl mb-1"></div>
        <span class="text-[10px] font-semibold">Home</span>
      </RouterLink>

      <!-- Settings Link -->
      <RouterLink
        to="/settings"
        class="flex flex-col items-center justify-center w-full h-full transition-colors duration-200"
        :class="route.name === 'settings' ? 'text-blue-500' : 'text-gray-400 hover:text-blue-500'"
      >
        <div class="i-carbon-settings text-2xl mb-1"></div>
        <span class="text-[10px] font-semibold">Settings</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style>
/* 适配 iPhone X 等全面屏底部小黑条 */
.pb-safe {
  padding-bottom: env(safe-area-inset-bottom);
}

/* 开启硬件加速滚动，平滑滚动效果 */
.scroll-smooth {
  -webkit-overflow-scrolling: touch; /* 关键 */
}

ul.bread-padding-none {
  padding-inline-start: 0;
}
</style>
