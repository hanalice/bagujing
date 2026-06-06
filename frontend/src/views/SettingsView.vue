<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useUserStore } from '@/stores/user'
import { get, post } from '@/utils/request'

const settingsStore = useSettingsStore()
const userStore = useUserStore()

const dynamicCategories = ref<string[]>([])
const pendingUsers = ref<any[]>([])
const isAdminLoading = ref(false)

const handleTogglePreference = (pref: string) => {
  settingsStore.togglePreference(pref)
}

const handleClearPreferences = () => {
  settingsStore.clearPreferences()
}

const fetchCategoryGroups = async () => {
  try {
    const data = await get<string[]>('/category-groups')
    dynamicCategories.value = data || []
  } catch (err) {
    console.error('Failed to fetch category groups', err)
  }
}

const fetchPendingUsers = async () => {
  if (!userStore.isAdmin) return
  isAdminLoading.value = true
  try {
    const data = await get<any[]>('/admin/pending-users')
    pendingUsers.value = data || []
  } catch (err) {
    console.error('Failed to fetch pending users', err)
  } finally {
    isAdminLoading.value = false
  }
}

const approveUser = async (userId: number) => {
  try {
    await post('/admin/approve-user', { userId })
    await fetchPendingUsers()
  } catch (err) {
    console.error('Failed to approve user', err)
  }
}

// Preference Sync
watch(() => settingsStore.$state, (newVal) => {
  if (userStore.isAuthenticated) {
    userStore.syncPreferences(newVal)
  }
}, { deep: true })

onMounted(() => {
  fetchCategoryGroups()
  if (userStore.isAuthenticated) {
    userStore.fetchProfile()
    if (userStore.isAdmin) {
      fetchPendingUsers()
    }
  }
})
</script>

<template>
  <div class="px-7 py-8 space-y-9 bg-[#F8FAFC] min-h-full pb-20">
    <!-- Header -->
    <header class="flex items-center justify-between">
      <h1 class="text-3xl font-[900] text-[#0F172A] tracking-tight">Settings</h1>
    </header>

    <!-- User Information Card -->
    <section class="bg-white rounded-[2rem] p-7 shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] border border-white/50">
      <div v-if="userStore.isAuthenticated" class="flex items-center gap-6">
        <div class="relative">
          <div class="w-18 h-18 rounded-full overflow-hidden bg-gradient-to-tr from-blue-500 to-indigo-600 flex items-center justify-center border-4 border-white shadow-lg shadow-blue-500/10">
            <span class="text-2xl font-[900] text-white uppercase">{{ userStore.profile?.username?.charAt(0) }}</span>
          </div>
          <div v-if="userStore.profile?.status === 'active'" class="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 border-[3px] border-white rounded-full shadow-sm"></div>
        </div>
        <div class="flex-1 space-y-1">
          <div class="flex items-center gap-2">
            <h2 class="text-2xl font-[800] text-[#0F172A] tracking-tight">{{ userStore.profile?.username }}</h2>
            <span v-if="userStore.isAdmin" class="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-black rounded-lg border border-blue-100 uppercase tracking-widest">Admin</span>
          </div>
          <p class="text-sm font-medium text-slate-400">Status: {{ userStore.profile?.status }}</p>
        </div>
        <button @click="userStore.logout()" class="p-4 rounded-2xl bg-slate-50 text-slate-400 hover:text-primary hover:bg-primary-soft border border-slate-100 hover:border-primary-border transition-all active:scale-95">
          <div class="i-carbon-logout text-xl"></div>
        </button>
      </div>
      <div v-else class="text-center py-4 space-y-6">
        <div class="w-16 h-16 bg-blue-50 rounded-2xl mx-auto flex items-center justify-center">
          <div class="i-carbon-user-identification text-3xl text-blue-500"></div>
        </div>
        <div>
          <h2 class="text-xl font-[800] text-[#0F172A]">Sync Your Progress</h2>
          <p class="text-sm font-medium text-slate-400 mt-1">Login to save your settings across devices</p>
        </div>
        <div class="flex gap-4">
          <RouterLink to="/login" class="flex-1 py-4 bg-blue-500 text-white rounded-2xl font-[800] shadow-lg shadow-blue-500/20 active:scale-[0.98] transition-all">Sign In</RouterLink>
          <RouterLink to="/register" class="flex-1 py-4 bg-white border border-slate-100 text-[#0F172A] rounded-2xl font-[800] active:scale-[0.98] transition-all">Register</RouterLink>
        </div>
      </div>
    </section>

    <!-- Admin Console -->
    <section v-if="userStore.isAdmin" class="space-y-5">
      <div class="flex items-center justify-between px-1">
        <h3 class="text-lg font-[800] text-[#0F172A] tracking-tight">Admin Console</h3>
        <span v-if="pendingUsers.length > 0" class="px-2.5 py-1 bg-red-500 text-white text-[10px] font-black rounded-full">{{ pendingUsers.length }} PENDING</span>
      </div>
      <div class="bg-white rounded-[2rem] shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] border border-white/50 overflow-hidden">
        <div v-if="pendingUsers.length === 0" class="p-8 text-center">
          <div class="i-carbon-task-complete text-4xl text-slate-200 mx-auto mb-3"></div>
          <p class="text-slate-400 font-medium">All clear! No pending approvals.</p>
        </div>
        <div v-else class="divide-y divide-slate-50">
          <div v-for="user in pendingUsers" :key="user.id" class="p-6 flex items-center justify-between group">
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center font-bold text-slate-400">
                {{ user.username.charAt(0).toUpperCase() }}
              </div>
              <div class="space-y-0.5">
                <p class="font-[700] text-[#0F172A]">{{ user.username }}</p>
                <p class="text-[10px] font-medium text-slate-400">Requested: {{ new Date(user.created_at).toLocaleDateString() }}</p>
              </div>
            </div>
            <button @click="approveUser(user.id)" class="px-5 py-2.5 bg-blue-500 text-white text-xs font-black rounded-xl shadow-lg shadow-blue-500/10 hover:bg-blue-600 transition-all opacity-0 group-hover:opacity-100">
              APPROVE
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- General Settings -->
    <section class="space-y-5">
      <div class="flex items-center justify-between px-1">
        <h3 class="text-lg font-[800] text-[#0F172A] tracking-tight">General Settings</h3>
      </div>
      <div class="bg-white rounded-[2rem] shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] overflow-hidden border border-white/50">
        <!-- Dark Mode -->
        <div class="p-6 flex items-center justify-between border-b border-slate-50">
          <div class="flex items-center gap-5">
            <div class="w-12 h-12 rounded-2xl bg-slate-50/80 flex items-center justify-center border border-slate-100/50">
              <div class="i-carbon-moon text-xl text-slate-600"></div>
            </div>
            <div>
              <p class="font-[700] text-[#0F172A]">Dark Mode</p>
              <p class="text-xs font-medium text-slate-400 mt-0.5">Enable dark theme personalization</p>
            </div>
          </div>
          <button
            @click="settingsStore.toggleDarkMode()"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300 focus:outline-none border-none outline-none p-0',
              settingsStore.darkMode ? 'bg-blue-500 shadow-[0_0_15px_-3px_rgba(59,130,246,0.4)]' : 'bg-slate-200'
            ]"
          >
            <span
              :class="[
                'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-300 ring-0',
                settingsStore.darkMode ? 'translate-x-[22px]' : 'translate-x-[2px]'
              ]"
            />
          </button>
        </div>

        <!-- AI Assistant -->
        <div v-if="userStore.profile?.permissions?.includes('chat_ai')" class="p-6 flex items-center justify-between">
          <div class="flex items-center gap-5">
            <div class="w-12 h-12 rounded-2xl bg-blue-50/80 flex items-center justify-center border border-blue-100/30">
              <div class="i-carbon-chat text-xl text-blue-600"></div>
            </div>
            <div>
              <p class="font-[700] text-[#0F172A]">AI Assistant</p>
              <p class="text-xs font-medium text-slate-400 mt-0.5">Smart helper for problem analysis</p>
            </div>
          </div>
          <button
            @click="settingsStore.toggleAiAssistant()"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300 focus:outline-none border-none outline-none p-0',
              settingsStore.aiAssistant ? 'bg-blue-500 shadow-[0_0_15px_-3px_rgba(59,130,246,0.4)]' : 'bg-slate-200'
            ]"
          >
            <span
              :class="[
                'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-300 ring-0',
                settingsStore.aiAssistant ? 'translate-x-[22px]' : 'translate-x-[2px]'
              ]"
            />
          </button>
        </div>
      </div>
    </section>

    <!-- Problem Preferences -->
    <section class="space-y-5">
      <div class="flex items-center justify-between px-1">
        <h3 class="text-lg font-[800] text-[#0F172A] tracking-tight">Problem Preferences</h3>
        <p class="text-[10px] font-black text-slate-300 uppercase tracking-widest">Global Filter</p>
      </div>
      <div class="flex flex-wrap gap-2.5">
        <!-- All Categories Toggle -->
        <button
          @click="handleClearPreferences()"
          :class="[
            'px-6 py-2.5 rounded-2xl border transition-all duration-300 text-[13px] font-[800] shadow-sm active:scale-95',
            settingsStore.selectedPreferences.length === 0
              ? 'bg-blue-500 border-blue-500 text-white shadow-blue-500/20'
              : 'bg-white border-slate-100 text-slate-400 hover:border-slate-200'
          ]"
        >
          All Categories
        </button>

        <button
          v-for="pref in dynamicCategories"
          :key="pref"
          @click="handleTogglePreference(pref)"
          :class="[
            'px-6 py-2.5 rounded-2xl border transition-all duration-300 text-[13px] font-[800] shadow-sm active:scale-95',
            settingsStore.selectedPreferences.includes(pref)
              ? 'bg-blue-50 border-blue-100 text-blue-500'
              : 'bg-white border-slate-100 text-slate-400 hover:border-slate-200'
          ]"
        >
          {{ pref }}
        </button>
      </div>
    </section>

    <!-- Footer Spacer -->
    <div class="h-12"></div>
  </div>
</template>

<style scoped>
/* Hidden scrollbar but keeps functionality */
.pb-20 {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.pb-20::-webkit-scrollbar {
  display: none;
}
</style>

<style scoped>
/* Hidden scrollbar but keeps functionality */
.min-h-full {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.min-h-full::-webkit-scrollbar {
  display: none;
}
</style>
