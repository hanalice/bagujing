<!-- ---
applyTo: '**'
---
Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes. -->

<!-- # 前端代码规范最佳实践（遵循 W3C 标准）

- 语义化 HTML
  - 使用正确的语义标签（header, nav, main, section, article, aside, footer）。
  - 表单与交互元素使用原生控件并正确设置标签、name、type、value。
  - 图片提供合理的 alt；装饰性图片使用空 alt 或 CSS 背景。
  - 使用标题层级 h1–h6 合理组织文档结构。

- 可访问性与可用性（WCAG）
  - 所有交互元素可通过键盘操作（tab、enter、space）。
  - 提供可见的焦点样式；避免移除 outline 而不提供替代。
  - 使用 ARIA 仅在必要时补充语义，避免与原生语义冲突。
  - 表单控件配对 label；错误信息与提示关联到控件（aria-describedby）。
  - 对比度符合标准（文本与背景对比度 ≥ 4.5:1）。
  - 为动态内容提供可访问公告（aria-live），避免仅依赖颜色传达信息。

- HTML 规范
  - HTML5 文档类型与语言属性：<!doctype html> 和 <html lang="...">。
  - 统一字符编码：<meta charset="utf-8">。
  - 合理设置 viewport：<meta name="viewport" content="width=device-width, initial-scale=1">。
  - 属性使用双引号，布尔属性无需赋值（disabled、required）。
  - 避免内联事件与内联样式，分离结构与行为。

- CSS 规范
  - 使用 BEM/ITCSS 等命名与分层方法，避免选择器过度嵌套（≤3 层）。
  - 优先使用现代布局（Flex、Grid），避免浮动布局。
  - 组件化、原子化样式，减少全局污染；限制使用 !important。
  - 使用自定义属性（CSS Variables）与媒体查询进行响应式设计。
  - 统一单位与盒模型（box-sizing: border-box）；字体使用 rem/em。
  - 提供打印样式与暗色模式支持（prefers-color-scheme）。
  - 兼容性与前缀通过 PostCSS/Autoprefixer 管理。

- JavaScript 规范
  - 遵循 ES6+，启用严格模式；模块化（ES Modules）。
  - 禁止污染全局命名空间；避免在 DOM 上存放业务状态。
  - DOM 操作最小化，使用委托与批处理；优先无框架或轻量依赖。
  - 异步流程使用 async/await；处理错误与边界条件。
  - 事件解绑与资源释放，防止内存泄漏。
  - 不信任外部输入，进行校验与编码；避免内联脚本。
  - 统一代码风格（例如 ESLint + Prettier）。

- 性能优化
  - 资源按需加载（code splitting、lazy loading、route-based chunk）。
  - 使用现代格式（WebP/AVIF、SVG）；图像与视频懒加载。
  - 合理缓存策略（HTTP 缓存、ETag、Service Worker）。
  - 最小化与压缩（HTML/CSS/JS）；移除未使用代码（tree-shaking）。
  - 预加载关键资源（preload、prefetch）；减少阻塞渲染。
  - 减少重排与重绘；使用 transform/opacity 动画并启用合成层。

- 安全
  - 启用 CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy。
  - 仅使用 HTTPS；严格 SameSite/Cookie 安全属性。
  - 输出内容进行转义与防 XSS；避免危险的 innerHTML。
  - 验证与清理用户输入；防止开放重定向与 CSRF。

- 国际化与本地化
  - 使用 i18n 框架与资源文件；避免硬编码文案。
  - 处理方向性（dir="ltr/rtl"）；日期、数字、货币使用 Intl。
  - 文案可替换、长度可变，布局具备适应性。

- 兼容性与渐进增强
  - 面向标准开发，利用特性检测（@supports、feature detection）。
  - 为旧环境提供合理降级与 polyfill；避免 UA sniffing。

- 测试与质量
  - 单元、集成与端到端测试（Jest/Vitest、Testing Library、Playwright）。
  - 无障碍与性能基准（Lighthouse、axe）。
  - 代码审查与静态分析（ESLint、TypeScript）。

- 构建与发布
  - 统一依赖版本与锁定文件；最小权限原则。
  - 环境变量分层管理（dev/staging/prod），不在仓库存放密钥。
  - 版本化与回滚策略；生成源码映射并保护访问。

- 文档与注释
  - 组件/模块说明、公共 API 注释与使用示例。
  - 变更日志与迁移指南；架构与约定在 README/手册中维护。

- 目录与资源组织
  - 清晰的 src 分层（components、pages、services、styles、assets）。
  - 静态资源命名规范与体积控制；按需打包与复用。

- 提交与协作
  - 规范提交信息（Conventional Commits）；自动化 CI 检查。
  - 代码评审与分支策略（feature、release、hotfix）。 -->
