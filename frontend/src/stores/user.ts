import { defineStore } from 'pinia';
import { get, post, clearCache } from '@/utils/request';
import { useSettingsStore } from './settings';


export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    profile: JSON.parse(localStorage.getItem('user_profile') || 'null'),
    loading: false,
    error: null as string | null,
  }),
  getters: {
    isAuthenticated: (state) => !!state.token,
    isAdmin: (state) => state.profile?.role === 'admin',
    isPending: (state) => state.profile?.status === 'pending',
  },
  actions: {
    async login(username: string, password: string) {
      clearCache();
      this.loading = true;
      this.error = null;
      try {
        const data: any = await post('/auth/login', { username, password });
        const { token, user } = data;
        this.token = token;
        this.profile = user;
        localStorage.setItem('token', token);
        localStorage.setItem('user_profile', JSON.stringify(user));
        
        const settingsStore = useSettingsStore();
        settingsStore.initializeForUser(user.username);
        
        return true;

      } catch (err: any) {
        this.error = err.message || 'Login failed';
        return false;
      } finally {
        this.loading = false;
      }
    },
    async register(username: string, password: string) {
      this.loading = true;
      this.error = null;
      try {
        await post('/auth/register', { username, password });
        return true;
      } catch (err: any) {
        this.error = err.message || 'Registration failed';
        return false;
      } finally {
        this.loading = false;
      }
    },
    async fetchProfile() {
      try {
        const data = await get('/user/profile');
        this.profile = data;
        localStorage.setItem('user_profile', JSON.stringify(this.profile));
        
        const settingsStore = useSettingsStore();
        if (this.profile?.username) {
          settingsStore.initializeForUser(this.profile.username);
        }

      } catch (err) {
        // If profile fetch fails (e.g. 401), logout
        this.logout();
      }
    },
    logout() {
      clearCache();
      this.token = null;
      this.profile = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user_profile');
      
      const settingsStore = useSettingsStore();
      settingsStore.clear();

      
      // Redirect to login
      import('@/router').then(m => m.default.push('/login'));
    },
    async syncPreferences(preferences: any) {
      if (!this.isAuthenticated) return;
      try {
        await post('/user/preferences', preferences);
      } catch (err) {
        console.error('Failed to sync preferences:', err);
      }
    }
  },
});
