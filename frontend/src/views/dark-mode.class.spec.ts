/**
 * S24：uno darkMode:'class' 与三视图底色/主标题 dark: 源码契约（docs/test_cases.md §4.9）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(here, '../..')

const readSrc = (relFromFrontend: string) =>
  readFileSync(join(frontendRoot, relFromFrontend), 'utf8')

const settingsSrc = () => readSrc('src/views/SettingsView.vue')
const loginSrc = () => readSrc('src/views/LoginView.vue')
const layoutSrc = () => readSrc('src/layouts/BasicLayout.vue')
const unoSrc = () => readSrc('uno.config.ts')

/** 统计源码中 `dark:` 子串出现次数 */
const countDarkColon = (src: string) => (src.match(/dark:/g) ?? []).length

describe('S24 dark: 配置与三视图源码契约', () => {
  it("UT-FE-DARK-05: uno.config.ts 写明 darkMode: 'class'", () => {
    const src = unoSrc()
    expect(src).toContain("darkMode: 'class'")
    expect(src).not.toMatch(/darkMode:\s*'media'/)
  })

  it('UT-FE-DARK-06: SettingsView.vue 页面底色与主标题含 dark:', () => {
    const src = settingsSrc()
    expect(src).toMatch(/bg-\[#F8FAFC\][^\n"']*dark:bg-/)
    expect(src).toMatch(/<h1[^>]*class="[^"]*dark:text-/)
    expect(countDarkColon(src)).toBeGreaterThanOrEqual(2)
  })

  it('UT-FE-DARK-07: LoginView.vue 页面底色与主标题含 dark:', () => {
    const src = loginSrc()
    expect(src).toMatch(/bg-\[#F8FAFC\][^\n"']*dark:bg-/)
    expect(src).toMatch(/<h2[^>]*class="[^"]*dark:text-/)
    expect(countDarkColon(src)).toBeGreaterThanOrEqual(2)
  })

  it('UT-FE-DARK-08: BasicLayout.vue 页面底色与主标题含 dark:', () => {
    const src = layoutSrc()
    expect(src).toMatch(/bg-gray-50[^\n"']*dark:bg-/)
    expect(src).toMatch(/<h1[^>]*class="[^"]*dark:text-/)
    expect(countDarkColon(src)).toBeGreaterThanOrEqual(2)
  })

  it('UT-FE-DARK-09: 三视图源码均含 dark:（合取清单）', () => {
    expect(settingsSrc()).toContain('dark:')
    expect(loginSrc()).toContain('dark:')
    expect(layoutSrc()).toContain('dark:')
  })

  it('UT-FE-DARK-10: 不做：不要求审计页 / 题目详情 / 虚拟列表补 dark:', () => {
    // 本表 PASS 不要求 Audit*.vue / ProblemItem.vue / 虚拟列表含 dark:
    expect(settingsSrc()).toContain('dark:')
    expect(true).toBe(true)
  })

  it('UT-FE-DARK-11: 不做：不要求新设计 token / 默认暗色', () => {
    // 允许在现有 Uno utility 上追加 dark:；不要求默认 darkMode=true
    expect(unoSrc()).toContain("darkMode: 'class'")
    expect(true).toBe(true)
  })

  it('UT-FE-DARK-12: residual：次级页面浅色块不构成本表 FAIL', () => {
    // residual：未改到的次级页面在 html.dark 下仍可能浅色，不以全站无浅色残留为 FAIL
    expect(true).toBe(true)
  })

  it('UT-FE-DARK-14: 边界：本表不断言截图像素 / E2E 截图对比', () => {
    // PASS 以 classList、配置字段、源码 dark: 子串为据，不要求像素差分
    expect(settingsSrc()).toContain('dark:')
    expect(true).toBe(true)
  })
})
