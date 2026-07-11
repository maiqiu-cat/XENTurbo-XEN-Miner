import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  {
    ignores: [
      '.worktrees/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  ...tseslint.configs.recommended,
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser,
        sourceType: 'module'
      }
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'prefer-const': 'off',
      'preserve-caught-error': 'off',
      'vue/attributes-order': 'off',
      'vue/multi-word-component-names': 'off'
    }
  },
  eslintConfigPrettier
)
