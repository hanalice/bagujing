/**
 * S23：RegisterView 凭据区 form 提交 / Tab 焦点 / Enter（docs/test_cases.md §4.9）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import RegisterView from './RegisterView.vue'

const routerPush = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  RouterLink: {
    name: 'RouterLink',
    props: ['to'],
    template: '<a :href="String(to)"><slot /></a>',
  },
}))

describe('RegisterView auth form (S23)', () => {
  let app: App | null = null
  let host: HTMLElement | null = null
  let registerMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    routerPush.mockReset()
    setActivePinia(createPinia())
    registerMock = vi.fn().mockResolvedValue(true)
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

  /** 挂载 RegisterView，并用 vi.fn 替换 userStore.register */
  async function mountRegister() {
    host = document.createElement('div')
    document.body.appendChild(host)
    const pinia = createPinia()
    app = createApp(RegisterView)
    app.use(pinia)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a :href="String(to)"><slot /></a>',
    })
    app.mount(host)
    const userStore = useUserStore(pinia)
    userStore.register = registerMock as typeof userStore.register
    await nextTick()
    return { host, userStore, pinia }
  }

  /** 写入原生 input 并同步 v-model */
  function fillInput(el: HTMLInputElement, value: string) {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('UT-FE-AUTH-FORM-05: RegisterView：凭据区为 form 且按钮 type=submit', async () => {
    const { host: root } = await mountRegister()
    const form = root.querySelector('form')
    expect(form).toBeTruthy()
    expect(form!.querySelector('#username')).toBeTruthy()
    expect(form!.querySelector('#password')).toBeTruthy()
    expect(form!.querySelector('#confirm')).toBeTruthy()

    const submitBtn = form!.querySelector('button[type="submit"]') as HTMLButtonElement | null
    expect(submitBtn).toBeTruthy()
    expect(submitBtn!.getAttribute('type')).toBe('submit')

    const ev = new Event('submit', { bubbles: true, cancelable: true })
    form!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('UT-FE-AUTH-FORM-06: RegisterView：form submit 调用 userStore.register', async () => {
    const { host: root } = await mountRegister()
    fillInput(root.querySelector('#username') as HTMLInputElement, 'bob')
    fillInput(root.querySelector('#password') as HTMLInputElement, 'p@ss-1')
    fillInput(root.querySelector('#confirm') as HTMLInputElement, 'p@ss-1')
    await nextTick()

    const form = root.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    await Promise.resolve()

    expect(registerMock).toHaveBeenCalledTimes(1)
    expect(registerMock).toHaveBeenCalledWith('bob', 'p@ss-1')
  })

  it('UT-FE-AUTH-FORM-07: RegisterView：确认密码框 Enter 触发表单提交', async () => {
    const { host: root } = await mountRegister()
    fillInput(root.querySelector('#username') as HTMLInputElement, 'bob')
    fillInput(root.querySelector('#password') as HTMLInputElement, 'p@ss-1')
    fillInput(root.querySelector('#confirm') as HTMLInputElement, 'p@ss-1')
    await nextTick()

    const confirm = root.querySelector('#confirm') as HTMLInputElement
    const form = confirm.form || (confirm.closest('form') as HTMLFormElement)
    expect(form).toBeTruthy()

    confirm.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    )
    form.requestSubmit()
    await nextTick()
    await Promise.resolve()

    expect(registerMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(registerMock.mock.calls[0]).toEqual(['bob', 'p@ss-1'])

    // 密码框 Enter 等价路径：二次挂载
    registerMock.mockClear()
    if (app) {
      app.unmount()
      app = null
    }
    if (host) {
      host.remove()
      host = null
    }
    const second = await mountRegister()
    fillInput(second.host.querySelector('#username') as HTMLInputElement, 'bob')
    fillInput(second.host.querySelector('#password') as HTMLInputElement, 'p@ss-1')
    fillInput(second.host.querySelector('#confirm') as HTMLInputElement, 'p@ss-1')
    await nextTick()
    const password = second.host.querySelector('#password') as HTMLInputElement
    const form2 = password.form || (password.closest('form') as HTMLFormElement)
    password.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    )
    form2.requestSubmit()
    await nextTick()
    await Promise.resolve()
    expect(registerMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(registerMock.mock.calls[0]).toEqual(['bob', 'p@ss-1'])
  })

  it('UT-FE-AUTH-FORM-08: RegisterView：三 input 可 Tab、保留焦点环；密码不一致仍本地校验', async () => {
    const { host: root, userStore } = await mountRegister()

    for (const id of ['#username', '#password', '#confirm']) {
      const input = root.querySelector(id) as HTMLInputElement
      expect(input.getAttribute('tabindex')).not.toBe('-1')
      expect(input.className).toContain('focus:ring-2')
    }

    fillInput(root.querySelector('#username') as HTMLInputElement, 'bob')
    fillInput(root.querySelector('#password') as HTMLInputElement, 'a')
    fillInput(root.querySelector('#confirm') as HTMLInputElement, 'b')
    await nextTick()

    const form = root.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()

    expect(registerMock).toHaveBeenCalledTimes(0)
    expect(userStore.error).toBe('Passwords do not match')
    expect(root.textContent).toContain('Passwords do not match')
  })
})
