/**
 * S24：设置页暗色开关联动 documentElement.dark（docs/test_cases.md §4.9）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useSettingsStore } from './settings'

describe('S24 settings 暗色 class 联动', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    setActivePinia(createPinia())
  })

  it('UT-FE-DARK-01: toggleDarkMode 后 documentElement 含 dark', async () => {
    const store = useSettingsStore()
    expect(store.darkMode).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    store.toggleDarkMode()
    await nextTick()

    expect(store.darkMode).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('UT-FE-DARK-02: 再次 toggle 关闭：去掉根节点 dark', async () => {
    const store = useSettingsStore()
    store.toggleDarkMode()
    await nextTick()
    expect(store.darkMode).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    store.toggleDarkMode()
    await nextTick()

    expect(store.darkMode).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('UT-FE-DARK-03: 默认与 resetAll 保持浅色（不做改默认）', async () => {
    const storeA = useSettingsStore()
    expect(storeA.darkMode).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    storeA.toggleDarkMode()
    await nextTick()
    expect(storeA.darkMode).toBe(true)
    storeA.resetAll()

    expect(storeA.darkMode).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('UT-FE-DARK-04: initializeForUser 恢复 darkMode: true 时根节点含 dark', () => {
    localStorage.setItem(
      'settings:alice',
      JSON.stringify({
        darkMode: true,
        fontSize: 16,
        aiAssistant: true,
        selectedPreferences: [],
      })
    )
    const store = useSettingsStore()
    store.initializeForUser('alice')

    expect(store.darkMode).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('UT-FE-DARK-13: 与设置页开关 UI 触发路径对齐（直接调 store 等价）', async () => {
    // 挂载成本高时与 UT-FE-DARK-01 合测：SettingsView 按钮 @click 即 toggleDarkMode()
    const store = useSettingsStore()
    document.documentElement.classList.remove('dark')

    store.toggleDarkMode()
    await nextTick()

    expect(store.darkMode).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
