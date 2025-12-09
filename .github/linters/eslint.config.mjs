import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022
      },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname + '/../..'
      }
    },
    rules: {
      // Possible Errors
      'no-cond-assign': [
        'error',
        'always'
      ],
      'no-constant-condition': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty-character-class': 'error',
      'no-extra-boolean-cast': 'error',
      'no-func-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-unsafe-negation': 'error',
      'no-obj-calls': 'error',
      'no-unreachable': 'error',
      'no-dupe-else-if': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unexpected-multiline': 'error',

      // Best Practices
      eqeqeq: [
        'error',
        'always',
        { null: 'ignore' }],
      'no-implicit-coercion': [
        'error',
        {
          allow: [
            '-',
            '- -'
          ]
        }
      ],
      'no-implied-eval': 'error',
      'no-lone-blocks': 'error',
      'no-multi-str': 'error',
      'no-global-assign': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-proto': 'error',
      'no-redeclare': 'off', // Handled by TypeScript
      'no-script-url': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-useless-call': 'error',
      'no-void': 'error',
      'no-caller': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-fallthrough': 'error',
      'no-octal': 'error',
      'no-constructor-return': 'error',

      // Variables
      'no-delete-var': 'error',
      'no-undef': 'off', // Handled by TypeScript
      'no-unused-vars': 'off', // Handled by @typescript-eslint/no-unused-vars
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'no-undef-init': 'error',

      // Non-formatting stylistic rules (won't conflict with Prettier)
      'no-array-constructor': 'error',
      'no-lonely-if': 'error',
      camelcase: [
        'error',
        { properties: 'never' }],
      'no-multiple-empty-lines': 'error',
      'no-nested-ternary': 'error',
      'one-var': [
        'error',
        'never'
      ],
      'no-unneeded-ternary': 'error',
      'no-new-object': 'error',
      'default-case-last': 'error',
      'grouped-accessor-pairs': [
        'error',
        'getBeforeSet'
      ],

      // ES6
      'constructor-super': 'error',
      'no-class-assign': 'error',
      'no-const-assign': 'error',
      'no-this-before-super': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // Node.js
      'no-new-require': 'error',
      'no-path-concat': 'error',

      // Other
      'no-empty': [
        'error',
        { allowEmptyCatch: true }],
      'no-labels': 'error',
      'no-useless-catch': 'error',
      'no-misleading-character-class': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'getter-return': 'error',

      // TypeScript specific
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // Prettier config must be last to override formatting rules
  prettier,
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '*.js',
      '*.cjs',
      '*.mjs'
    ]
  }
);
