<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';

const router = useRouter();
const userStore = useUserStore();

const username = ref('');
const password = ref('');

const handleLogin = async () => {
  const success = await userStore.login(username.value, password.value);
  if (success) {
    router.push('/settings');
  }
};
</script>

<template>
  <div class="min-h-full bg-[#F8FAFC] flex flex-col justify-center px-7 py-12">
    <div class="sm:mx-auto sm:w-full sm:max-w-md">
      <div class="w-20 h-20 bg-blue-500 rounded-3xl mx-auto flex items-center justify-center shadow-lg shadow-blue-500/20 mb-8">
        <div class="i-carbon-user-avatar text-4xl text-white"></div>
      </div>
      <h2 class="text-center text-3xl font-[900] text-[#0F172A] tracking-tight">Welcome Back</h2>
      <p class="mt-2 text-center text-sm font-medium text-slate-400">
        Login to sync your study progress
      </p>
    </div>

    <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-md">
      <div class="bg-white py-8 px-8 shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] rounded-[2.5rem] border border-white/50 space-y-6">
        <div>
          <label for="username" class="block text-sm font-[700] text-slate-700 ml-1 mb-2">Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            required
            class="block w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-300 font-medium"
            placeholder="Enter your username"
          />
        </div>

        <div>
          <label for="password" class="block text-sm font-[700] text-slate-700 ml-1 mb-2">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            class="block w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-300 font-medium"
            placeholder="••••••••"
          />
        </div>

        <div v-if="userStore.error" class="text-red-500 text-sm font-medium px-1 flex items-center gap-2">
          <div class="i-carbon-warning text-lg"></div>
          {{ userStore.error }}
        </div>

        <button
          @click="handleLogin"
          :disabled="userStore.loading"
          class="w-full flex justify-center py-4 px-4 rounded-2xl shadow-lg shadow-blue-500/20 text-sm font-[800] text-white bg-blue-500 hover:bg-blue-600 focus:outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <span v-if="userStore.loading" class="i-carbon-circle-dash animate-spin text-xl mr-2"></span>
          {{ userStore.loading ? 'Logging in...' : 'Sign In' }}
        </button>

        <div class="text-center">
          <p class="text-sm font-medium text-slate-400">
            Don't have an account?
            <RouterLink to="/register" class="text-blue-500 font-bold hover:underline">Register now</RouterLink>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
