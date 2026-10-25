import { test, expect, type Page } from '@playwright/test'

/** SSE 响应头（助教 POST /api/chat）。 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const

/** 登录成功后进入助手页前的公共 API Mock（beforeEach 已覆盖 profile 等）。 */
async function mockLoginAndEnterAssistant(page: Page) {
  await page.goto('/assistant')
  await expect(page).toHaveURL(/.*\/login/)

  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          token: 'mock-e2e-jwt-token',
          user: { id: 101, username: 'tester', role: 'user' },
        },
      }),
    })
  })

  await page.fill('#username', 'tester')
  await page.fill('#password', 'password123')
  await page.click('button:has-text("Sign In")')
  await expect(page).toHaveURL(/.*\/settings/)
}

/** 用固定 SSE 正文拦截 POST /api/chat。 */
async function mockChatSse(page: Page, sseBody: string) {
  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...SSE_HEADERS },
      body: sseBody,
    })
  })
}

/**
 * 【测试用例】E2E-MAIN-01 & E2E-MAIN-04 + E2E-CHAT-MD-01/02/03
 * S6：助手气泡 Markdown + DOMPurify；用户气泡纯文本。
 */
test.describe('前端业务主路径端到端测试 (Main Path E2E)', () => {
  test.beforeEach(async ({ page }) => {
    // 统一配置基础 API 的 Mock 返回，避免因后端未启动导致 fetchProfile 触发 logout 拦截
    await page.route('**/api/user/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { id: 101, username: 'tester', role: 'user' },
        }),
      })
    })

    await page.route('**/api/category-groups', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: ['JavaScript', 'Vue', 'Node.js', '算法'],
        }),
      })
    })

    await page.route('**/api/categories**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            list: [
              { id: 1, name: 'Vue3 响应式原理', group: 'Vue', count: 12 },
              { id: 2, name: 'EventLoop 机制', group: 'JavaScript', count: 8 },
            ],
            total: 2,
            pageSize: 10,
          },
        }),
      })
    })

    await page.route('**/api/user/preferences', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { success: true },
        }),
      })
    })
  })

  test('E2E-MAIN-01 & E2E-MAIN-04: 路由鉴权拦截 -> 登录 -> AI 面试助手流式打字机问答', async ({ page }) => {
    // 步骤 1: 未登录状态下访问受保护的 AI 助手页面，验证路由守卫重定向至登录页
    await page.goto('/assistant')
    await expect(page).toHaveURL(/.*\/login/)
    await expect(page.locator('h2')).toContainText('Welcome Back')

    // 2. Mock 登录接口 (POST /api/auth/login)
    await page.route('**/api/auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            token: 'mock-e2e-jwt-token',
            user: {
              id: 101,
              username: 'tester',
              role: 'user',
            },
          },
        }),
      })
    })

    // 3. 填写登录表单并提交
    await page.fill('#username', 'tester')
    await page.fill('#password', 'password123')
    await page.click('button:has-text("Sign In")')

    // 登录成功后跳转至 /settings
    await expect(page).toHaveURL(/.*\/settings/)

    // 4. Mock AI 流式对话接口 (POST /api/chat)：分帧 Markdown，验证全文缓冲重解析（S6 / E2E-MAIN-04）
    // 用 gate 卡住 SSE，避免 fulfill 瞬时结束导致「生成中…」加载态不可观测
    let releaseChat!: () => void
    const chatHeld = new Promise<void>((resolve) => {
      releaseChat = resolve
    })
    await page.route('**/api/chat', async (route) => {
      await chatHeld
      // 主路径亦夹带消毒目标：断言无未消毒 XSS（细断言见 E2E-CHAT-MD-02）
      const sseBody = [
        'data: {"type":"delta","text":"你好！这是**加"}\n\n',
        'data: {"type":"delta","text":"粗**。<script>window.__s6main=1</script>流式回答结束。"}\n\n',
        'data: {"type":"done"}\n\n',
      ].join('')

      await route.fulfill({
        status: 200,
        headers: { ...SSE_HEADERS },
        body: sseBody,
      })
    })

    // 5. 导航至 AI 助手页面 (/assistant)
    await page.goto('/assistant')
    await expect(page.locator('textarea')).toBeVisible()

    // 6. 输入问题并发送（含字面 **，用户侧不得 Markdown 化）
    const chatInput = page.locator('textarea')
    const userQuestion = '请简述 **字面** E2E 价值'
    await chatInput.fill(userQuestion)

    const sendBtn = page.locator('button:has-text("发送")')
    await expect(sendBtn).toBeEnabled()
    await sendBtn.click()

    // 加载态：发送中 textarea 禁用、按钮文案为「生成中…」（SSE 仍被 gate 挂起）
    await expect(chatInput).toBeDisabled()
    await expect(page.locator('button:has-text("生成中…")')).toBeVisible()
    releaseChat()

    // 7. 断言助手 Markdown 加粗 + 用户纯文本 + 助手侧无未消毒 XSS（S6）
    const messagesArea = page.locator('[aria-label="Chat messages"]')
    await expect(messagesArea).toContainText(userQuestion)
    const assistantBold = messagesArea.locator('.text-left strong, .text-left b').filter({ hasText: '加粗' })
    await expect(assistantBold.first()).toBeVisible()
    await expect(messagesArea.locator('.text-right strong, .text-right b')).toHaveCount(0)
    await expect(messagesArea.locator('.text-left script')).toHaveCount(0)
    const mainXss = await page.evaluate(() => (window as unknown as { __s6main?: unknown }).__s6main)
    expect(mainXss).toBeUndefined()
    await expect(chatInput).toBeEnabled()
  })

  test('E2E-CHAT-MD-01: 助手气泡 Markdown 加粗与围栏代码', async ({ page }) => {
    await mockLoginAndEnterAssistant(page)

    const mdPayload =
      '你好 **粗体**\n\n```js\nconst x=1\n```'
    const sseBody = [
      `data: ${JSON.stringify({ type: 'delta', text: mdPayload })}\n\n`,
      'data: {"type":"done"}\n\n',
    ].join('')
    await mockChatSse(page, sseBody)

    await page.goto('/assistant')
    const chatInput = page.locator('textarea')
    await expect(chatInput).toBeVisible()
    await chatInput.fill('渲染-MD')
    await page.locator('button:has-text("发送")').click()

    const messagesArea = page.locator('[aria-label="Chat messages"]')
    const assistant = messagesArea.locator('.text-left').last()
    await expect(assistant.locator('strong, b').filter({ hasText: '粗体' }).first()).toBeVisible()
    await expect(assistant.locator('pre')).toBeVisible()
    await expect(assistant.locator('pre code, code')).toContainText('const x=1')

    const userBubble = messagesArea.locator('.text-right').last()
    await expect(userBubble).toContainText('渲染-MD')
    await expect(userBubble.locator('strong, b')).toHaveCount(0)
  })

  test('E2E-CHAT-MD-02: 助手气泡消毒 script 与 javascript: 不进 DOM', async ({ page }) => {
    await mockLoginAndEnterAssistant(page)

    const dirty =
      '安全正文<script>window.__s6e2e=1</script>与链接 [x](javascript:alert(1))'
    const sseBody = [
      `data: ${JSON.stringify({ type: 'delta', text: dirty })}\n\n`,
      'data: {"type":"done"}\n\n',
    ].join('')
    await mockChatSse(page, sseBody)

    await page.goto('/assistant')
    await page.evaluate(() => {
      delete (window as unknown as { __s6e2e?: unknown }).__s6e2e
    })
    const chatInput = page.locator('textarea')
    await chatInput.fill('消毒-MD')
    await page.locator('button:has-text("发送")').click()

    const messagesArea = page.locator('[aria-label="Chat messages"]')
    const assistant = messagesArea.locator('.text-left').last()
    await expect(assistant).toContainText('安全正文')
    await expect(assistant.locator('script')).toHaveCount(0)

    const flag = await page.evaluate(() => (window as unknown as { __s6e2e?: unknown }).__s6e2e)
    expect(flag).toBeUndefined()

    const hrefs = await assistant.locator('a').evaluateAll((nodes) =>
      nodes.map((n) => (n.getAttribute('href') || '').toLowerCase())
    )
    for (const href of hrefs) {
      expect(href.startsWith('javascript:')).toBe(false)
    }

    await expect(chatInput).toBeEnabled()
  })

  test('E2E-CHAT-MD-03: 用户气泡纯文本、不做 Markdown', async ({ page }) => {
    await mockLoginAndEnterAssistant(page)

    const sseBody = [
      'data: {"type":"delta","text":"ok"}\n\n',
      'data: {"type":"done"}\n\n',
    ].join('')
    await mockChatSse(page, sseBody)

    await page.goto('/assistant')
    const userText = '用户侧 **不该加粗** 与 <b>字面</b>'
    const chatInput = page.locator('textarea')
    await chatInput.fill(userText)
    await page.locator('button:has-text("发送")').click()

    const messagesArea = page.locator('[aria-label="Chat messages"]')
    const userBubble = messagesArea.locator('.text-right').last()
    await expect(userBubble).toContainText('**不该加粗**')
    await expect(userBubble).toContainText('<b>字面</b>')
    await expect(userBubble.locator('strong, b')).toHaveCount(0)

    const assistant = messagesArea.locator('.text-left').last()
    await expect(assistant).toContainText('ok')
  })
})
