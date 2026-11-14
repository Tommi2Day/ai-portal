import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['node_modules/', 'dist/', 'coverage/', 'drizzle/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
    rules: {
      'no-console': 'warn', // the server logs through pino (src/logger.ts), which masks secrets
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // tests mock freely and drive the app through loosely typed JSON
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
]);
