import './assets/main.css'
import 'virtual:uno.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { useSettingsStore } from './stores/settings'


import App from './App.vue'
import router from './router'
import { initMonitoring } from './monitoring'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
app.use(router)

// Initialize settings from localStorage if user exists
const userProfileStr = localStorage.getItem('user_profile')
if (userProfileStr) {
  try {
    const profile = JSON.parse(userProfileStr)
    if (profile && profile.username) {
      const settingsStore = useSettingsStore(pinia)
      settingsStore.initializeForUser(profile.username)
    }
  } catch (e) {
    console.error('Failed to initialize settings on startup', e)
  }
}


initMonitoring({ app, router })

app.mount('#app')
