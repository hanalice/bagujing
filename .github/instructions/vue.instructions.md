---
applyTo: '**/.vue'
---
Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.

<!-- # Vue 单文件组件（SFC）最佳实践规范

- 基础与结构
  - 优先使用 Composition API（<script setup>）与 ES Modules；启用严格模式。
  - 组件单一职责；文件命名使用 PascalCase，目录按 components/pages/composables/services 分层。
  - SFC 三段规范：<template> 语义化与可访问性、<script> 逻辑、<style scoped> 样式（支持 CSS Modules/vars）。

- 模板与可访问性（WCAG）
  - 使用语义化标签与原生控件；表单配对 label、aria-describedby。
  - 为交互元素提供键盘可用性与明显焦点样式；避免仅用颜色传达信息。
  - 列表使用 key，稳定且唯一；避免 index 作为 key（除非静态列表）。

- 组件 API
  - 使用 defineProps/defineEmits 定义边界；props 校验类型、默认值与只读。
  - 事件命名使用小写短横线（update:model-value）；遵循 v-model 约定（modelValue + update:modelValue）。
  - 避免在 DOM 上存放业务状态；通过 props/emit/slots 组合而非隐式耦合。

- 状态与数据流
  - 局部状态使用 ref/reactive；派生状态用 computed，副作用用 watch/watchEffect。
  - 避免在 watch 中做业务核心逻辑；优先使用显式方法与 computed。
  - 全局状态优先 Pinia；模块化 store，持久化需加版本与校验。

- 性能优化
  - 合理拆分组件；使用 defineAsyncComponent 懒加载路由/大型组件。
  - 避免不必要的响应式依赖；在大型列表使用虚拟滚动。
  - 使用 v-once/v-memo/v-bind 缓存与冻结静态区域；合理使用 keep-alive。
  - 图片/视频懒加载；资源使用现代格式与按需打包。

- 路由与页面
  - 使用 Vue Router；路由懒加载与命名路由，避免硬编码路径。
  - 路由守卫中处理鉴权、数据预取与错误；确保取消未完成请求。
  - 为动态内容提供可访问公告（aria-live）与错误边界页面。

- 样式与布局
  - 使用 BEM/ITCSS 与 CSS 变量；限制选择器嵌套（≤3 层），避免 !important。
  - 样式优先 scoped；跨组件样式通过设计系统/全局 tokens。
  - 支持暗色模式（prefers-color-scheme）与响应式媒体查询。

- 异步与资源管理
  - 使用 async/await；统一错误处理与空态/加载态（Skeleton/Spinner）。
  - 在 onUnmounted 释放事件与取消订阅；避免内存泄漏。
  - HTTP 客户端封装 services，拦截器统一处理鉴权/重试/错误。

- 安全
  - 避免危险的 v-html；如需使用，进行内容净化与 CSP 配置。
  - 不信任外部输入；前端校验与编码；防止开放重定向与 CSRF。
  - 仅使用 HTTPS；严格 SameSite/Cookie 属性与安全头。

- 可维护性与质量
  - 统一代码风格（ESLint + Prettier + TypeScript）；开启 vue/no-xxx 规则。
  - 组件与公共 API 注释；故事/示例与文档同步。
  - 测试：组件使用 Vitest + Vue Testing Library；端到端使用 Playwright。
  - 可访问性与性能基准：使用 Lighthouse 与 axe。

- 构建与发布
  - 使用 Vite；代码分割与预加载关键资源；tree-shaking 与依赖最小化。
  - 环境变量分层（dev/staging/prod），不在仓库存放密钥；Service Worker 与缓存策略合理配置。
  - 生成并保护源码映射；版本化与回滚策略。

- 其他约定
  - 组件输入输出稳定；避免隐式依赖与全局事件总线。
  - 使用 i18n（vue-i18n），避免硬编码文案；处理 RTL、日期/数字使用 Intl。
  - 渐进增强与特性检测；为旧环境提供合理降级与 polyfill。 -->