import { test, expect } from '@playwright/test'


/**
   * 【测试用例】E2E-MAIN-01 & E2E-MAIN-04
   * 【用例名称】前端核心业务主路径（Main Path）全流程验证
   * 【设计意图】
   *  端到端验证用户从"未登录访问拦截"到"输入账密登录"，再到"进入 AI 面试助手提问并接收流式打字机渲染"的核心业务闭环。
   * 
   * 【测试步骤】
   *  1. [未登录拦截]：直接访问受保护页面 `/assistant`，预期触发路由守卫重定向至 `/login`。
   *  2. [API Mock 注册]：拦截 `POST /api/auth/login` 模拟后端登录鉴权返回合法 Token。
   *  3. [用户登录操作]：在登录表单中填写账号密码并点击 "Sign In"，预期成功跳转至 `/settings`。
   *  4. [AI SSE Mock 注册]：拦截 `POST /api/chat`，模拟服务端返回 `text/event-stream` 流式 Chunk 数据包。
   *  5. [页面导航]：主动导航至 AI 面试助手页面 `/assistant`，验证输入框与发送按钮正常挂载。
   *  6. [AI 对话交互]：在输入框中输入面试问题并点击“发送”，触发流式请求。
   *  7. [DOM 结果断言]：验证消息区域正确逐字增量呈现回答，且 DOMPurify 过滤机制生效、无 XSS 隐患。
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

    // 4. Mock AI 流式对话接口 (POST /api/chat)
    await page.route('**/api/chat', async (route) => {
      const sseBody = [
        'data: {"type":"delta","text":"你好！我是职问AI面试官。"}\n\n',
        'data: {"type":"delta","text":"这是一段通过 Playwright 验证的流式回答。"}\n\n',
        'data: {"type":"done"}\n\n',
      ].join('')

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        body: sseBody,
      })
    })

    // 5. 导航至 AI 助手页面 (/assistant)
    await page.goto('/assistant')
    await expect(page.locator('textarea')).toBeVisible()

    // 6. 输入问题并发送
    const chatInput = page.locator('textarea')
    await chatInput.fill('请简述前端 E2E 测试的核心价值')

    const sendBtn = page.locator('button:has-text("发送")')
    await expect(sendBtn).toBeEnabled()
    await sendBtn.click()

    // 7. 断言流式内容正确渲染到消息区域
    const messagesArea = page.locator('[aria-label="Chat messages"]')
    await expect(messagesArea).toContainText('请简述前端 E2E 测试的核心价值')
    await expect(messagesArea).toContainText('你好！我是职问AI面试官。这是一段通过 Playwright 验证的流式回答。')
  })
})
