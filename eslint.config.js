import tseslint from 'typescript-eslint'

export default tseslint.config(
  // The engine writes .claude-plugin/types; docs holds the static mockup.
  { ignores: ['.claude-plugin/', 'node_modules/', 'docs/'] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Checking each `on(event, handler)` against every overload of the
      // engine's `on` takes minutes per file, and async hooks are the API.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      // Todo numbers and counts read naturally in prompts and labels.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // The code's shapes are type aliases; interfaces only where the engine's
      // own declarations merge.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      // An empty env var, label or title means unset, so `||` is meant there.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      // As tsc's noUnused*: a leading underscore marks a name left unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
)
