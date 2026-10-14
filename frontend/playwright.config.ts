import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'list',
  use: {
    baseURL: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    // E2E 不连真实 Guard。CI 没有 gitignore 的 .env.local，缺密钥时 chat 会在 fetch 前抛错，mock 的 SSE 到不了页面。
    env: {
      VITE_AI_CLIENT_ID: 'web',
      VITE_AI_CLIENT_SECRET: 'e2e-client-secret',
    },
  },
});
