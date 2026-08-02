import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/build/**', '**/.next/**', '**/node_modules/**', '**/.turbo/**'],
  },
  {
    rules: {
      // args: 'all' (not the default 'after-used') so an unused parameter
      // is flagged regardless of position, not just trailing ones.
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'all', argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // React prop-usage checking, scoped to the two frontends — no-unused-vars
    // only catches an unused local BINDING; a prop declared in an interface
    // but never destructured at all (see CLAUDE.md's TotpVerify tempToken
    // incident) has no binding to flag, so it's invisible to that rule.
    // no-unused-prop-types checks the prop TYPE itself against what the
    // component body actually reads.
    files: ['apps/web/**/*.tsx', 'apps/portal/**/*.tsx'],
    plugins: { react },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/no-unused-prop-types': 'warn',
    },
  },
);
