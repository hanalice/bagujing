/**
 * 后端 ESLint 9 flat config（A81 / P2-6）。
 * 规则集：@eslint/js recommended；语言环境为 Node ESM，不额外加严 error 规则。
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
