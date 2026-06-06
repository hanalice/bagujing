---
name: vue-best-practices
description: Vue 3 and Vue.js best practices for TypeScript, vue-tsc, and Volar. This skill should be used when writing, reviewing, or refactoring Vue components to ensure correct typing patterns. Triggers on tasks involving Vue components, props extraction, wrapper components, template type checking, or Volar configuration.
license: MIT
metadata:
  author: hyf0
  version: "8.0.0"
---

## Capability Rules

| Rule | Keywords | Description |
|------|----------|-------------|
| [extract-component-props](rules/extract-component-props.md) | get props type, wrapper component, extend props, inherit props, ComponentProps | Extract types from .vue components |
| [vue-tsc-strict-templates](rules/vue-tsc-strict-templates.md) | undefined component, template error, strictTemplates | Catch undefined components in templates |
| [deep-watch-numeric](rules/deep-watch-numeric.md) | watch, deep, array, Vue 3.5 | Efficient array watching |
| [vue-directive-comments](rules/vue-directive-comments.md) | @vue-ignore, @vue-skip, template | Control template type checking |
| [script-setup-jsdoc](rules/script-setup-jsdoc.md) |jsdoc, script-setup, documentation, composition-api, component | enables proper documentation for composition API components |

<!-- ## Efficiency Rules

| Rule | Keywords | Description |
|------|----------|-------------|
| [hmr-vue-ssr](rules/hmr-vue-ssr.md) | hmr, ssr, hot reload | Fix HMR in SSR apps |
| [pinia-store-mocking](rules/pinia-store-mocking.md) | pinia, mock, vitest, store | Mock Pinia stores | -->

## Reference

- [Vue Language Tools](https://github.com/vuejs/language-tools)
- [vue-component-type-helpers](https://github.com/vuejs/language-tools/tree/master/packages/component-type-helpers)
- [Vue 3 Documentation](https://vuejs.org/)