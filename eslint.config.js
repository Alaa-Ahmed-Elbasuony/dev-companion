import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-e2e/**', '**/node_modules/**', '.e2e-profile/**', '**/.next/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'test-page/**/*.{js,mjs}',
      'tests/e2e/**/*.mjs',
      '*.config.{js,ts}',
      'packages/**/*.js',
      'examples/**/*.{js,mjs,jsx}',
    ],
    // E2E code passed to page.evaluate() runs in extension pages, where `chrome` exists.
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
);
