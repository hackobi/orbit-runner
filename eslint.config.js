import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Math members the ECMAScript spec defines exactly. Everything else on Math
// (sin, cos, pow, exp, random, ...) is implementation-approximated or
// non-deterministic, and would let two JavaScript engines disagree.
const EXACT_MATH = 'sqrt|abs|floor|ceil|round|trunc|min|max|sign|fround|imul|PI';

const deterministicRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: `MemberExpression[object.name='Math'][computed=false][property.name!=/^(${EXACT_MATH})$/]`,
      message:
        'Only exactly-specified Math members are allowed in src/shared. Use src/shared/math.ts.',
    },
    {
      selector: "MemberExpression[object.name='Math'][computed=true]",
      message: 'Computed access to Math is not allowed in src/shared.',
    },
    {
      selector: "VariableDeclarator[init.name='Math']",
      message: 'Do not alias or destructure Math in src/shared.',
    },
    {
      selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
      message: 'The ** operator is implementation-approximated. Multiply instead.',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: 'Shared code takes time as an argument.' },
    { name: 'performance', message: 'Shared code takes time as an argument.' },
    { name: 'setTimeout', message: 'Shared code is driven by its caller.' },
    { name: 'setInterval', message: 'Shared code is driven by its caller.' },
  ],
};

const noPlatformImports = (extra) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        { group: ['node:*', 'ws', 'three', 'three/*'], message: 'No platform imports here.' },
        ...extra,
      ],
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'dist-e2e/',
      'node_modules/',
      'test-results/',
      'playwright-report/',
      'release/',
      // The copy of the built client that goes into the Mac app.
      'app/client/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      ...deterministicRules,
      ...noPlatformImports([
        {
          group: ['**/net/**', '**/client/**', '**/server/**'],
          message: 'shared imports nothing above it.',
        },
      ]),
    },
  },
  {
    files: ['src/net/**/*.ts'],
    rules: noPlatformImports([
      { group: ['**/client/**', '**/server/**'], message: 'net may import only shared.' },
    ]),
  },
  { files: ['src/client/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    files: ['src/server/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
  // The Mac app's own files are plain JavaScript run by Electron.
  {
    files: ['app/*.mjs', 'app/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node, parserOptions: { projectService: false } },
  },
  {
    files: ['app/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
