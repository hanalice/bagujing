import { defineConfig, presetUno, presetAttributify, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons(),
  ],
  theme: {
    colors: {
      primary: {
        DEFAULT: '#3b82f6', // blue-500
        soft: '#eff6ff',    // blue-50
        border: '#bfdbfe',  // blue-200
      },
      success: {
        DEFAULT: '#22c55e', // green-500
        soft: '#f0fdf4',    // green-50
      },
      error: {
        DEFAULT: '#ef4444', // red-500
        soft: '#fef2f2',    // red-50
      },
      warning: {
        DEFAULT: '#f59e0b', // amber-500
        soft: '#fffbeb',    // amber-50
      }
    }
  }
})
