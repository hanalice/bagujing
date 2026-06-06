<script setup lang="ts">
  import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useSettingsStore } from '@/stores/settings'
  import { getCategories, getCategoryGroups, type CategoryListResponse } from '../api/categoryList'

  const settingsStore = useSettingsStore()
  const dataList = ref<CategoryListResponse>();
  const pageSize = 10;
  const cursor = ref<number | null>(null)
  const isLoading = ref(false);
  const hasMore = ref(true);
  const loadMoreTrigger = ref<HTMLElement | null>(null);
  let observer: IntersectionObserver | null = null;
  let keywordDebounceTimer: ReturnType<typeof setTimeout> | null = null
  const searchKeyword = ref('');
  const groupNames = ref<string[]>([])
  const localSelectedGroups = ref<string[]>([])

  // Computed to sort group names: selected first, then alphabetical
  const sortedGroupNames = computed(() => {
    const selected = localSelectedGroups.value;
    const all = [...groupNames.value];
    return all.sort((a, b) => {
      const aSel = selected.includes(a);
      const bSel = selected.includes(b);
      if (aSel && !bSel) return -1;
      if (!aSel && bSel) return 1;
      return a.localeCompare(b);
    });
  });

  const toggleLocalPreference = (group: string) => {
    if (localSelectedGroups.value.includes(group)) {
      localSelectedGroups.value = localSelectedGroups.value.filter(g => g !== group);
    } else {
      localSelectedGroups.value.push(group);
    }
    resetAndLoad(searchKeyword.value);
  }

  const clearLocalPreferences = () => {
    localSelectedGroups.value = [];
    resetAndLoad(searchKeyword.value);
  }

  const appendCategories = (incoming?: CategoryListResponse) => {
    if (!incoming) return;
    const current = dataList.value ?? { list: [], total: 0, pageSize };
    const seen = new Set((current.list ?? []).map(item => item.id))
    const incomingList = (incoming.list ?? []).filter(item => !seen.has(item.id))
    dataList.value = {
      ...incoming,
      list: [...(current.list ?? []), ...incomingList],
    };
    cursor.value = incoming.nextCursor ?? null
    const totalLoaded = dataList.value.list?.length ?? 0;
    const totalAvailable = incoming.total ?? totalLoaded;
    hasMore.value = totalLoaded < totalAvailable && cursor.value !== null;
  };

  const loadMore = async (keyword?: string) => {
    if (isLoading.value || !hasMore.value) return;
    isLoading.value = true;
    try {
      const trimmedKeyword = keyword ? keyword.trim() : '';
      const data = await getCategories({ 
        keyword: trimmedKeyword, 
        groupNames: localSelectedGroups.value.length > 0 ? localSelectedGroups.value : undefined, 
        cursor: cursor.value !== null ? String(cursor.value) : undefined, 
        pageSize 
      });
      appendCategories(data);
    } catch (err) {
      console.error('Failed to load categories:', err);
      hasMore.value = false;
    } finally {
      isLoading.value = false;
    }
  };

  const resetAndLoad = (keyword?: string) => {
    dataList.value = { list: [], total: 0, pageSize }
    cursor.value = null
    hasMore.value = true
    loadMore(keyword);
  }

  const router = useRouter();

  const goToProblemList = (categoryId: number, categoryName?: string) => {
    router.push({ name: 'problem-detail', query: { categoryId, categoryName } })
  }

  onMounted(() => {
    // Initialize local groups from global settings
    localSelectedGroups.value = [...settingsStore.selectedPreferences];

    observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting) loadMore(searchKeyword.value);
    });
    if (loadMoreTrigger.value && observer) observer.observe(loadMoreTrigger.value);

    getCategoryGroups()
      .then((groups) => {
        groupNames.value = groups ?? []
        resetAndLoad(searchKeyword.value)
      })
      .catch((err) => {
        console.error('Failed to load category groups:', err)
        resetAndLoad(searchKeyword.value)
      })
  });

  watch(
    searchKeyword,
    (search) => {
      if (keywordDebounceTimer) clearTimeout(keywordDebounceTimer)
      keywordDebounceTimer = setTimeout(() => {
        resetAndLoad(search)
      }, 400)
    }
  )

  onBeforeUnmount(() => {
    if (loadMoreTrigger.value && observer) observer.unobserve(loadMoreTrigger.value);
    observer?.disconnect();
  });
</script>

<template>
  <div class="space-y-4">
    <!-- 搜索与多选过滤 -->
    <div class="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 space-y-3">
      <div class="flex items-center gap-3">
        <label for="category-search" class="flex-1 flex items-center bg-slate-50 rounded-xl px-3 py-2 border border-slate-100 focus-within:border-blue-300 transition-all">
          <div class="i-carbon-search text-slate-400 mr-2"></div>
          <input
            id="category-search"
            v-model="searchKeyword"
            type="search"
            placeholder="搜索题库标签..."
            class="flex-1 bg-transparent border-none outline-none text-sm text-slate-600 placeholder:text-slate-400"
          />
        </label>
        <button 
          v-if="localSelectedGroups.length > 0"
          @click="clearLocalPreferences"
          class="text-[11px] font-[800] text-slate-400 hover:text-primary bg-slate-50 hover:bg-primary-soft px-3 py-1.5 rounded-xl border border-slate-100 hover:border-primary-border transition-all active:scale-95"
        >
          清除全部
        </button>
      </div>

      <!-- 多选标签区域 -->
      <div class="flex flex-wrap gap-2">
        <button
          v-for="group in sortedGroupNames"
          :key="group"
          @click="toggleLocalPreference(group)"
          :class="[
            'px-3.5 py-1.5 rounded-full text-xs font-bold transition-all duration-300 border',
            localSelectedGroups.includes(group)
              ? 'bg-primary-soft border-primary-border text-primary shadow-sm'
              : 'bg-white border-slate-100 text-slate-400 hover:border-slate-200'
          ]"
        >
          {{ group }}
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <button
      v-for="d in dataList?.list"
      :key="d.id"
      type="button"
      @click="goToProblemList(d.id, d?.name)"
      class="w-full text-left bg-white p-4 rounded-lg shadow-sm border border-gray-100 active:bg-gray-50 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-300"
    >
      <h3 class="text-gray-800 font-medium mb-2 line-clamp-2">{{ d?.name }}</h3>
      <div class="flex items-center justify-between text-xs text-gray-400">
        <div class="flex items-center space-x-2">
          <span
            class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-500"
          >
            {{ d?.groupName }}
          </span>
          <span
            class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-500"
          >
            {{ d?.count }} 题目
          </span>
        </div>
        <div class="i-carbon-chevron-right text-gray-300"> </div>
      </div>
    </button>
    <div ref="loadMoreTrigger" class="py-4 text-center text-xs text-gray-400">
      <span v-if="isLoading">加载中...</span>
      <span v-else-if="!hasMore">没有更多了</span>
    </div>
  </div>
</template>
