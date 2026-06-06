<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';

const router = useRouter();
const userStore = useUserStore();

const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const registered = ref(false);

const handleRegister = async () => {
  if (password.value !== confirmPassword.value) {
    userStore.error = 'Passwords do not match';
    return;
  }
  const success = await userStore.register(username.value, password.value);
  if (success) {
    registered.value = true;
  }
};
</script>

<template>
  <div class="min-h-full bg-[#F8FAFC] flex flex-col justify-center px-7 py-12">
    <div class="sm:mx-auto sm:w-full sm:max-w-md" v-if="!registered">
      <div class="w-20 h-20 bg-blue-500 rounded-3xl mx-auto flex items-center justify-center shadow-lg shadow-blue-500/20 mb-8">
        <div class="i-carbon-user-follow text-4xl text-white"></div>
      </div>
      <h2 class="text-center text-3xl font-[900] text-[#0F172A] tracking-tight">Join Bagujing</h2>
      <p class="mt-2 text-center text-sm font-medium text-slate-400">
        Create an account and wait for approval
      </p>
    </div>

    <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-md">
      <div v-if="registered" class="bg-white py-12 px-8 shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] rounded-[2.5rem] border border-white/50 text-center space-y-6">
        <div class="w-16 h-16 bg-green-100 rounded-full mx-auto flex items-center justify-center">
          <div class="i-carbon-checkmark text-3xl text-green-600"></div>
        </div>
        <h2 class="text-2xl font-[800] text-[#0F172A]">Request Sent!</h2>
        <p class="text-slate-400 font-medium">
          Your account has been created and is waiting for administrator approval. We'll let you know when it's active.
        </p>
        <button
          @click="router.push('/login')"
          class="w-full py-4 px-4 rounded-2xl bg-blue-50 text-blue-500 font-bold hover:bg-blue-100 transition-all"
        >
          Back to Login
        </button>
      </div>

      <div v-else class="bg-white py-8 px-8 shadow-[0_12px_50px_-12px_rgba(0,0,0,0.05)] rounded-[2.5rem] border border-white/50 space-y-6">
        <div>
          <label for="username" class="block text-sm font-[700] text-slate-700 ml-1 mb-2">Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            required
            class="block w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-300 font-medium"
            placeholder="Choose a username"
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
            placeholder="Create a password"
          />
        </div>

        <div>
          <label for="confirm" class="block text-sm font-[700] text-slate-700 ml-1 mb-2">Confirm Password</label>
          <input
            id="confirm"
            v-model="confirmPassword"
            type="password"
            required
            class="block w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-blue-500/20 transition-all placeholder-slate-300 font-medium"
            placeholder="Repeat your password"
          />
        </div>

        <div v-if="userStore.error" class="text-red-500 text-sm font-medium px-1 flex items-center gap-2">
          <div class="i-carbon-warning text-lg"></div>
          {{ userStore.error }}
        </div>

        <button
          @click="handleRegister"
          :disabled="userStore.loading"
          class="w-full flex justify-center py-4 px-4 rounded-2xl shadow-lg shadow-blue-500/20 text-sm font-[800] text-white bg-blue-500 hover:bg-blue-600 focus:outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <span v-if="userStore.loading" class="i-carbon-circle-dash animate-spin text-xl mr-2"></span>
          {{ userStore.loading ? 'Registering...' : 'Create Account' }}
        </button>

        <div class="text-center">
          <p class="text-sm font-medium text-slate-400">
            Already have an account?
            <RouterLink to="/login" class="text-blue-500 font-bold hover:underline">Sign in</RouterLink>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
