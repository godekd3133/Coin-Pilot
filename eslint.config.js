import js from '@eslint/js';
import globals from 'globals';

const noUnusedVars = [
  'error',
  {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    ignoreRestSiblings: true,
  },
];

export default [
  {
    ignores: [
      'node_modules/',
      'logs/',
      'docs/',
      '.paper-*/',
      '.staging-runtime/',
      'coverage/',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-duplicate-imports': 'error',
      'no-unused-vars': noUnusedVars,
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': noUnusedVars,
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
];
