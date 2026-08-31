import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// typescript-eslint refuses to load when the installed TypeScript falls outside
// its supported peer range (it currently caps at `<6.1.0`, while this project
// compiles with the TypeScript 7 line). That used to make `pnpm lint` fail
// outright, so the CI step was commented out and the required `Lint` check
// silently passed without linting anything.
//
// Load it defensively instead:
//   - JavaScript, including the .github/scripts release scripts, is always linted;
//   - TypeScript linting turns itself back on automatically as soon as the
//     installed typescript-eslint supports the installed TypeScript;
//   - a loud warning (a GitHub annotation in CI) is emitted while TypeScript
//     linting is unavailable, so the gap cannot pass unnoticed.
let tseslint = null;
let tseslintError = null;

try {
  ({ default: tseslint } = await import('typescript-eslint'));
} catch (error) {
  tseslintError = error;
}

if (!tseslint) {
  const reason = tseslintError instanceof Error ? tseslintError.message : String(tseslintError);
  const message =
    `TypeScript files are NOT being linted: typescript-eslint could not be loaded (${reason.split('\n')[0]}). ` +
    'JavaScript is still linted and TypeScript is still checked by "pnpm typecheck". ' +
    'TypeScript linting resumes automatically once typescript-eslint supports the installed TypeScript.';

  if (process.env['GITHUB_ACTIONS']) {
    console.log(`::warning title=TypeScript linting skipped::${message}`);
  }
  console.warn(`\nWARNING: ${message}\n`);
}

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**'
    ]
  },
  js.configs.recommended,
  ...(tseslint ? tseslint.configs.recommended : []),
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022
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
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'no-undef-init': 'error',

      // Non-formatting stylistic rules (won't conflict with Prettier)
      'no-array-constructor': 'error',
      'no-lonely-if': 'error',
      camelcase: [
        'error',
        { properties: 'never' }],
      'no-nested-ternary': 'error',
      'one-var': [
        'error',
        'never'
      ],
      'no-unneeded-ternary': 'error',
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

      // Other
      'no-empty': [
        'error',
        { allowEmptyCatch: true }],
      'no-labels': 'error',
      'no-useless-catch': 'error',
      'no-misleading-character-class': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'getter-return': 'error'
    }
  },
  // TypeScript-only handling, applied only when typescript-eslint is usable.
  ...(tseslint ?
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parserOptions: {
            tsconfigRootDir: import.meta.dirname + '/../..'
          }
        },
        rules: {
          // Handled by the TypeScript compiler itself.
          'no-redeclare': 'off',
          'no-undef': 'off',
          'no-unused-vars': 'off',
          '@typescript-eslint/no-unused-vars': [
            'error',
            { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
          '@typescript-eslint/no-explicit-any': 'warn',
          '@typescript-eslint/explicit-function-return-type': 'off',
          '@typescript-eslint/no-non-null-assertion': 'off',
          '@typescript-eslint/no-require-imports': 'off'
        }
      }
    ]
  : []),
  // Prettier config must be last to override formatting rules
  prettier
);
