import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,js}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    // 默认在 GitHub Actions 会追加 github-actions reporter，把「Vitest Test Report」写入 Job Summary；
    // 本仓库 Summary 只保留 qa-report.sh 生成的报告，因此钉死 default。
    reporters: ['default'],
    // E14：行覆盖率只统计 frontend/src，不含 e2e / Playwright
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,vue,js}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/e2e/**',
        '**/*.{test,spec}.{ts,js}',
      ],
      reporter: ['text', 'text-summary'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
