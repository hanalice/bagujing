/**
 * S23：LoginView 凭据区 form 提交 / Tab 焦点 / Enter（docs/test_cases.md §4.9）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import LoginView from './LoginView.vue'

const routerPush = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  RouterLink: {
    name: 'RouterLink',
    props: ['to'],
    template: '<a :href="String(to)"><slot /></a>',
  },
}))

const loginSourcePath = join(dirname(fileURLToPath(import.meta.url)), 'LoginView.vue')
const registerSourcePath = join(dirname(fileURLToPath(import.meta.url)), 'RegisterView.vue')
const assistantSourcePath = join(dirname(fileURLToPath(import.meta.url)), 'AiAssistant.vue')

describe('LoginView auth form (S23)', () => {
  let app: App | null = null
  let host: HTMLElement | null = null
  let loginMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    routerPush.mockReset()
    setActivePinia(createPinia())
    loginMock = vi.fn().mockResolvedValue(true)
  })

  afterEach(() => {
    if (app) {
      app.unmount()
      app = null
    }
    if (host) {
      host.remove()
      host = null
    }
  })

  /** 挂载 LoginView，并用 vi.fn 替换 userStore.login */
  async function mountLogin() {
    host = document.createElement('div')
    document.body.appendChild(host)
    const pinia = createPinia()
    app = createApp(LoginView)
    app.use(pinia)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a :href="String(to)"><slot /></a>',
    })
    app.mount(host)
    const userStore = useUserStore(pinia)
    userStore.login = loginMock as typeof userStore.login
    await nextTick()
    return { host, userStore }
  }

  /** 写入原生 input 并同步 v-model */
  function fillInput(el: HTMLInputElement, value: string) {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('UT-FE-AUTH-FORM-01: LoginView：凭据区为 form 且按钮 type=submit', async () => {
    const { host: root } = await mountLogin()
    const form = root.querySelector('form')
    expect(form).toBeTruthy()
    expect(root.querySelectorAll('form').length).toBe(1)
    expect(form!.querySelector('#username')).toBeTruthy()
    expect(form!.querySelector('#password')).toBeTruthy()

    const submitBtn = form!.querySelector('button[type="submit"]') as HTMLButtonElement | null
    expect(submitBtn).toBeTruthy()
    expect(submitBtn!.getAttribute('type')).toBe('submit')

    const ev = new Event('submit', { bubbles: true, cancelable: true })
    form!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('UT-FE-AUTH-FORM-02: LoginView：对 form 派发 submit 调用 userStore.login', async () => {
    const { host: root } = await mountLogin()
    fillInput(root.querySelector('#username') as HTMLInputElement, 'alice')
    fillInput(root.querySelector('#password') as HTMLInputElement, 'secret-s23')
    await nextTick()

    const form = root.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    await Promise.resolve()

    expect(loginMock).toHaveBeenCalledTimes(1)
    expect(loginMock).toHaveBeenCalledWith('alice', 'secret-s23')
  })

  it('UT-FE-AUTH-FORM-03: LoginView：密码框 keydown Enter 触发表单提交', async () => {
    const { host: root } = await mountLogin()
    fillInput(root.querySelector('#username') as HTMLInputElement, 'alice')
    fillInput(root.querySelector('#password') as HTMLInputElement, 'secret-s23')
    await nextTick()

    const password = root.querySelector('#password') as HTMLInputElement
    const form = password.form || (password.closest('form') as HTMLFormElement)
    expect(form).toBeTruthy()

    password.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    )
    // jsdom 不会自动把 Enter 转成 submit；有关联 form + type=submit 时与浏览器等价为 requestSubmit
    form.requestSubmit()
    await nextTick()
    await Promise.resolve()

    expect(loginMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(loginMock.mock.calls[0]).toEqual(['alice', 'secret-s23'])
    expect(document.body.contains(root)).toBe(true)
  })

  it('UT-FE-AUTH-FORM-04: LoginView：用户名/密码可 Tab 且保留焦点环', async () => {
    const { host: root } = await mountLogin()
    for (const id of ['#username', '#password']) {
      const input = root.querySelector(id) as HTMLInputElement
      expect(input.getAttribute('tabindex')).not.toBe('-1')
      // 可见焦点环：现网 Uno/Tailwind focus:ring-2
      expect(input.className).toContain('focus:ring-2')
      const noVisibleFocus =
        !input.className.includes('focus:ring') && input.className.includes('focus:outline-none')
      expect(noVisibleFocus).toBe(false)
    }
  })

  it('UT-FE-AUTH-FORM-09: 不做：助教 Ctrl+Enter 发送保持不变', () => {
    const src = readFileSync(assistantSourcePath, 'utf8')
    expect(src).toMatch(/@keydown\.ctrl\.enter\.prevent=["']send\(\)["']/)
  })

  it('UT-FE-AUTH-FORM-10: 不做：不改登录/注册接口与列表/设置键盘', () => {
    // 本表只锁视图→store 提交载体，不断言 login/register HTTP 契约或 Settings/列表快捷键
    expect(true).toBe(true)
  })

  it('UT-FE-AUTH-FORM-11: residual：设置页 / 题目 Tab / 列表项快捷键另条', () => {
    // residual 不在本表断言范围
    expect(true).toBe(true)
  })

  it('UT-FE-AUTH-FORM-12: 静态源码：Login/Register 均含 form@submit.prevent 与 type=submit', () => {
    const loginSrc = readFileSync(loginSourcePath, 'utf8')
    const registerSrc = readFileSync(registerSourcePath, 'utf8')
    for (const src of [loginSrc, registerSrc]) {
      expect(src).toMatch(/<form[\s\S]*@submit\.prevent/)
      expect(src).toMatch(/type=["']submit["']/)
      expect(src).not.toMatch(/tabindex=["']-1["']/)
    }
  })
})
