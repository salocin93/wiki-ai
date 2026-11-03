// ESLint for the extension and its tests: npm run lint. Rules are listed here rather than taken from a preset,
// so eslint is the only package needed.
const readonly = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));

const shared = readonly([
  'globalThis', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'structuredClone', 'crypto', 'performance', 'Intl',
  'indexedDB', 'IDBKeyRange', 'DOMException', 'atob', 'btoa', 'chrome',
]);
const worker = readonly(['importScripts', 'self']);
const browser = readonly([
  'window', 'document', 'location', 'history', 'navigator', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'CSS', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'Text', 'Range',
  'DOMParser', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent',
  'KeyboardEvent', 'confirm', 'alert', 'prompt', 'getSelection', 'sessionStorage', 'Highlight', 'katex',
]);
const node = readonly(['process', 'Buffer', '__dirname', 'require', 'module']);

const rules = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-fallthrough': 'error',
  'no-redeclare': 'error',
  'no-shadow-restricted-names': 'error',
  'no-sparse-arrays': 'error',
  'no-useless-catch': 'error',
  'no-async-promise-executor': 'error',
  'no-loss-of-precision': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'eqeqeq': ['error', 'smart'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};

export default [
  { ignores: ['vendor/**', 'dist/**', 'node_modules/**', 'test_results/**', 'test/fixtures/**'] },
  {
    files: ['lib/**/*.js', 'background/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...shared, ...worker } },
    rules,
  },
  {
    files: ['content/**/*.js', 'options/**/*.js', 'test/harness.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...shared, ...browser } },
    rules,
  },
  {
    files: ['test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...shared, ...node } },
    rules,
  },
];
