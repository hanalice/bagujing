/**
 * S22：axios 响应 401 清会话并导航登录；403 / 网络错误不清（docs/test_cases.md §4.9）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'

vi.mock('@/monitoring', () => ({
  captureApiError: vi.fn(),
  captureApiTiming: vi.fn(),
}))

const routerPush = vi.fn(async () => undefined)
const routerReplace = vi.fn(async () => undefined)
const routerState = { path: '/settings' }

vi.mock('@/router', () => ({
  default: {
    get currentRoute() {
      return { value: { path: routerState.path, name: routerState.path.slice(1) || 'home' } }
    },
    push: (...args: unknown[]) => routerPush(...args),
    replace: (...args: unknown[]) => routerReplace(...args),
  },
}))

import service, { clearCache, get } from '@/utils/request'
import { useUserStore } from '@/stores/user'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

/** 构造 axios adapter：按 status 拒答；status 为 null 表示无 response 的网络错误。 */
const makeErrorAdapter = (status: number | null): AxiosAdapter => {
  return async (config: InternalAxiosRequestConfig) => {
    if (status === null) {
      const err: Record<string, unknown> = {
        config,
        message: 'Network Error',
        code: 'ERR_NETWORK',
        isAxiosError: true,
        name: 'AxiosError',
        toJSON: () => ({}),
      }
      return Promise.reject(err)
    }
    return Promise.reject({
      config,
      response: {
        status,
        data: { code: status, message: status === 401 ? 'Unauthorized' : 'Forbidden' },
        headers: {},
        config,
        statusText: '',
      },
      isAxiosError: true,
      name: 'AxiosError',
      message: `Request failed with status code ${status}`,
      toJSON: () => ({}),
    })
  }
}

/** 成功 HTTP 200 adapter（可自定义业务 body）。 */
const makeOkAdapter = (body: unknown): AxiosAdapter => {
  return async (config: InternalAxiosRequestConfig) => ({
    data: body,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
}

/** 写入 S22 用例约定的过期会话凭证。 */
const seedStaleSession = () => {
  localStorage.setItem('token', 'jwt-stale-s22')
  localStorage.setItem('user_profile', JSON.stringify({ id: 1, username: 'alice' }))
}

describe('S22 request 401 清会话 (request.auth-401)', () => {
  beforeEach(() => {
    localStorage.clear()
    clearCache()
    setActivePinia(createPinia())
    routerState.path = '/settings'
    routerPush.mockClear()
    routerReplace.mockClear()
    // 重置 adapter，避免用例间串扰
    delete (service.defaults as { adapter?: AxiosAdapter }).adapter
  })

  afterEach(() => {
    delete (service.defaults as { adapter?: AxiosAdapter }).adapter
    clearCache()
  })

  it('UT-FE-401-01: 401 清掉 token 并触发去登录的导航', async () => {
    // 先以 guest 键写入 GET 缓存，证明 401 路径调用了 clearCache（键名不因清 profile 而变）
    let hits = 0
    service.defaults.adapter = async (config) => {
      hits += 1
      const url = String(config.url || '')
      if (url.includes('probe-cache')) {
        return {
          data: { code: 0, message: 'ok', data: { ok: true } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      return makeErrorAdapter(401)(config)
    }
    await get('/probe-cache')
    expect(hits).toBe(1)

    seedStaleSession()
    const store = useUserStore()
    store.token = 'jwt-stale-s22'
    store.profile = { id: 1, username: 'alice' }
    routerState.path = '/settings'

    await expect(service.get('/user/profile')).rejects.toBeTruthy()

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user_profile')).toBeNull()
    expect(store.token).toBeNull()
    expect(store.isAuthenticated).toBe(false)
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush.mock.calls[0]?.[0]).toBe('/login')
    expect(routerReplace).not.toHaveBeenCalled()

    const hitsAfter401 = hits
    await get('/probe-cache')
    expect(hits).toBeGreaterThan(hitsAfter401) // clearCache ≥1 的行为证据
  })

  it('UT-FE-401-02: 403 不清 token、不导航', async () => {
    seedStaleSession()
    routerState.path = '/settings'
    service.defaults.adapter = makeErrorAdapter(403)

    await expect(service.get('/user/profile')).rejects.toBeTruthy()

    expect(localStorage.getItem('token')).toBe('jwt-stale-s22')
    expect(localStorage.getItem('user_profile')).toContain('alice')
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('UT-FE-401-03: 无响应的网络错误不清 token、不导航', async () => {
    seedStaleSession()
    routerState.path = '/settings'
    service.defaults.adapter = makeErrorAdapter(null)

    await expect(service.get('/user/profile')).rejects.toBeTruthy()

    expect(localStorage.getItem('token')).toBe('jwt-stale-s22')
    expect(localStorage.getItem('user_profile')).toContain('alice')
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('UT-FE-401-04: 已在 /login：401 清凭证但不再跳一次', async () => {
    seedStaleSession()
    routerState.path = '/login'
    service.defaults.adapter = makeErrorAdapter(401)

    await expect(service.get('/user/profile')).rejects.toBeTruthy()

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user_profile')).toBeNull()
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('UT-FE-401-05: 已在 /register：401 清凭证但不再跳一次', async () => {
    seedStaleSession()
    routerState.path = '/register'
    service.defaults.adapter = makeErrorAdapter(401)

    await expect(service.get('/user/profile')).rejects.toBeTruthy()

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user_profile')).toBeNull()
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('UT-FE-401-06: 实现用动态 import，禁止与 user store 顶层静态环依', async () => {
    const src = readFileSync(join(SRC_DIR, 'request.ts'), 'utf8')
    const topLevel = src.split('service.interceptors.response')[0] ?? src

    expect(topLevel).not.toMatch(/from\s+['"]@\/stores\/user['"]/)
    expect(topLevel).not.toMatch(/from\s+['"]@\/router['"]/)
    expect(src).toMatch(/import\(['"]@\/router['"]\)/)
    expect(src).toMatch(/import\(['"]@\/stores\/user['"]\)/)
    await expect(import('@/utils/request')).resolves.toBeTruthy()
  })

  it('UT-FE-401-08: 不做：HTTP 200 且 code !== 0 不走 401 清会话', async () => {
    seedStaleSession()
    routerState.path = '/settings'
    service.defaults.adapter = makeOkAdapter({ code: 1001, message: 'biz-fail-s22', data: null })

    await expect(service.get('/user/profile')).rejects.toThrow(/biz-fail-s22/)

    expect(localStorage.getItem('token')).toBe('jwt-stale-s22')
    expect(routerPush).not.toHaveBeenCalled()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('UT-FE-401-09: 不做：不改登录成功落点仍为 /settings', () => {
    const loginSrc = readFileSync(join(SRC_DIR, '../views/LoginView.vue'), 'utf8')
    expect(loginSrc).toMatch(/router\.push\(['"]\/settings['"]\)/)
  })

  it('UT-FE-401-10: 不做：不改后端 401 文案 / fetchProfile 非 401 logout', () => {
    const userSrc = readFileSync(join(SRC_DIR, '../stores/user.ts'), 'utf8')
    expect(userSrc).toMatch(/fetchProfile/)
    expect(userSrc).toMatch(/this\.logout\(\)/)
    // 本表不断言后端 message 精确文案；仅锁 fetchProfile 失败仍 logout 的既有行为未被本项删除
  })

  it('UT-FE-401-12: 401 后 GET 内存缓存已空（clearCache 生效）', async () => {
    // 用 guest 缓存键：无 user_profile，避免 401 清 profile 后键名变化掩盖 clearCache
    localStorage.setItem('token', 'jwt-stale-s22')
    routerState.path = '/settings'

    let hits = 0
    service.defaults.adapter = async (config) => {
      hits += 1
      const url = String(config.url || '')
      if (url.includes('probe-cache')) {
        return {
          data: { code: 0, message: 'ok', data: { ok: true } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      return makeErrorAdapter(401)(config)
    }

    await get('/probe-cache')
    expect(hits).toBe(1)
    await get('/probe-cache')
    expect(hits).toBe(1) // 命中内存缓存

    await expect(service.get('/force-401')).rejects.toBeTruthy()
    expect(localStorage.getItem('token')).toBeNull()

    const hitsAfter401 = hits
    await get('/probe-cache')
    expect(hits).toBeGreaterThan(hitsAfter401) // clearCache 后必须再次打网络
  })

})
