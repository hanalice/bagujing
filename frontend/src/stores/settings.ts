import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
    const darkMode = ref(false)
    const fontSize = ref(16)
    const aiAssistant = ref(true)
    const selectedPreferences = ref<string[]>([])
    const currentUsername = ref<string | null>(null)

    // Apply dark mode class to document root
    const applyDarkMode = (enabled: boolean) => {
        document.documentElement.classList.toggle('dark', enabled)
    }

    // Apply font size to document root
    const applyFontSize = (size: number) => {
        document.documentElement.style.fontSize = `${size}px`
    }

    const saveToStorage = () => {
        if (!currentUsername.value) return
        try {
            const settings = {
                darkMode: darkMode.value,
                fontSize: fontSize.value,
                aiAssistant: aiAssistant.value,
                selectedPreferences: selectedPreferences.value,
            }
            localStorage.setItem(`settings:${currentUsername.value}`, JSON.stringify(settings))
        } catch (e) {
            console.error('Failed to save settings', e)
        }
    }

    const initializeForUser = (username: string) => {
        currentUsername.value = username
        const raw = localStorage.getItem(`settings:${username}`)
        if (raw) {
            try {
                const parsed = JSON.parse(raw)
                darkMode.value = parsed.darkMode ?? false
                fontSize.value = parsed.fontSize ?? 16
                aiAssistant.value = parsed.aiAssistant ?? true
                selectedPreferences.value = parsed.selectedPreferences ?? []
                
                applyDarkMode(darkMode.value)
                applyFontSize(fontSize.value)
                return
            } catch (e) {
                console.error('Failed to parse settings', e)
            }
        }
        // Fallback to defaults if no saved settings
        resetAll()
    }

    const resetAll = () => {
        darkMode.value = false
        fontSize.value = 16
        aiAssistant.value = true
        selectedPreferences.value = []
        applyDarkMode(false)
        applyFontSize(16)
    }

    const clear = () => {
        resetAll()
        currentUsername.value = null
    }

    // Watch and persist
    watch([darkMode, fontSize, aiAssistant, selectedPreferences], () => {
        saveToStorage()
    }, { deep: true })

    watch(darkMode, (val) => applyDarkMode(val), { immediate: true })
    watch(fontSize, (val) => applyFontSize(val), { immediate: true })

    const toggleDarkMode = () => {
        darkMode.value = !darkMode.value
    }

    const toggleAiAssistant = () => {
        aiAssistant.value = !aiAssistant.value
    }

    const togglePreference = (pref: string) => {
        if (selectedPreferences.value.includes(pref)) {
            selectedPreferences.value = selectedPreferences.value.filter((p) => p !== pref)
        } else {
            selectedPreferences.value.push(pref)
        }
    }

    const clearPreferences = () => {
        selectedPreferences.value = []
    }

    const setFontSize = (size: number) => {
        fontSize.value = Math.max(14, Math.min(22, size))
    }

    return {
        darkMode,
        fontSize,
        aiAssistant,
        selectedPreferences,
        toggleDarkMode,
        toggleAiAssistant,
        togglePreference,
        clearPreferences,
        setFontSize,
        resetAll,
        initializeForUser,
        clear
    }
})

