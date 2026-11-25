/**
 * S22：无 token 访问 /settings 进登录；有 token 且无 401 时守卫仍放行（docs/test_cases.md §4.9）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/monitoring', () => ({
  captureApiError: vi.fn(),
  captureApiTiming: vi.fn(),
  captureAiEvent: vi.fn(),
  captureUiError: vi.fn(),
}))

import router from '@/router'
import { useUserStore } from '@/stores/user'

describe('S22 router beforeEach 守卫 (auth-guard)', () => {
  beforeEach(async () => {
    localStorage.clear()
    setActivePinia(createPinia())
    // 先落到公开页，避免残留受保护路由状态
    await router.push('/login')
  })

  it('UT-FE-401-07: 无 token 时路由守卫把 /settings 送到 login', async () => {
    const store = useUserStore()
    expect(store.isAuthenticated).toBe(false)

    await router.push('/settings')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.name).not.toBe('settings')
  })

  it('UT-FE-401-11: residual：有 token 且无 401 时守卫仍放行 /settings', async () => {
    localStorage.setItem('token', 'still-present')
    setActivePinia(createPinia())
    const store = useUserStore()
    expect(store.isAuthenticated).toBe(true)

    await router.push('/settings')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('settings')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(router.currentRoute.value.name).not.toBe('login')
  })
})
