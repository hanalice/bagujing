import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from './user'
import * as requestModule from '@/utils/request'

vi.mock('@/utils/request', () => ({
  get: vi.fn(),
  post: vi.fn(),
  clearCache: vi.fn(),
}))

vi.mock('@/router', () => ({
  default: {
    push: vi.fn(),
  },
}))

describe('useUserStore (Pinia)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('UT-FE-USER-01: 初始状态下从 localStorage 恢复 Token 与 Profile', () => {
    localStorage.setItem('token', 'mock-token-123')
    localStorage.setItem('user_profile', JSON.stringify({ id: 1, username: 'alice', role: 'admin' }))

    const store = useUserStore()

    expect(store.token).toBe('mock-token-123')
    expect(store.profile).toEqual({ id: 1, username: 'alice', role: 'admin' })
    expect(store.isAuthenticated).toBe(true)
    expect(store.isAdmin).toBe(true)
  })

  it('UT-FE-USER-02: 登录成功时写入 Token、Profile 与 LocalStorage', async () => {
    const mockPost = vi.mocked(requestModule.post)
    mockPost.mockResolvedValueOnce({
      token: 'jwt-new-token',
      user: { id: 2, username: 'bob', role: 'user' },
    })

    const store = useUserStore()
    const result = await store.login('bob', 'password123')

    expect(result).toBe(true)
    expect(store.token).toBe('jwt-new-token')
    expect(store.profile).toEqual({ id: 2, username: 'bob', role: 'user' })
    expect(store.isAuthenticated).toBe(true)
    expect(store.isAdmin).toBe(false)
    expect(localStorage.getItem('token')).toBe('jwt-new-token')
    expect(localStorage.getItem('user_profile')).toContain('bob')
  })

  it('UT-FE-USER-02-FAIL: 登录失败时更新 error 状态并返回 false', async () => {
    const mockPost = vi.mocked(requestModule.post)
    mockPost.mockRejectedValueOnce(new Error('Invalid credentials'))

    const store = useUserStore()
    const result = await store.login('bob', 'wrongpassword')

    expect(result).toBe(false)
    expect(store.error).toBe('Invalid credentials')
    expect(store.token).toBeNull()
    expect(store.isAuthenticated).toBe(false)
  })

  it('UT-FE-USER-03: 登出 Action 清空状态与 LocalStorage', () => {
    localStorage.setItem('token', 'token-to-be-removed')
    localStorage.setItem('user_profile', JSON.stringify({ username: 'alice' }))

    const store = useUserStore()
    store.token = 'token-to-be-removed'
    store.profile = { username: 'alice' }

    store.logout()

    expect(store.token).toBeNull()
    expect(store.profile).toBeNull()
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user_profile')).toBeNull()
  })
})
