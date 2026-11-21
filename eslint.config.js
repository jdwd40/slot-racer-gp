// ESLint (flat config) with typescript-eslint (#148). Warn-only for now: every rule of the recommended sets reports as a
// warning, so `npm run lint` lists findings and exits 0, and the CI step is a visible report, never a deploy gate. A
// parse failure is still fatal. No type-aware rules (tsc --noEmit with `strict` already type-checks) and no formatter
// rules (formatting is not enforced).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** A config with each rule's `error` severity lowered to `warn` (options kept). */
const warnOnly = (c) => !c.rules ? c : {
  ...c,
  rules: Object.fromEntries(Object.entries(c.rules).map(([k, v]) => {
    const [sev, ...opts] = Array.isArray(v) ? v : [v];
    return [k, sev === 'error' || sev === 2 ? (opts.length ? ['warn', ...opts] : 'warn') : v];
  })),
};

/** `_`-prefixed names are deliberately unused (rest-destructuring a field away, a required but ignored parameter). */
const unused = ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }];

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'dist-online/', 'server-dist/', 'server-bundle/', 'bundle/', '.local-pg/', '.qa/', 'public/'] },
  warnOnly(js.configs.recommended),
  {
    files: ['**/*.ts'],
    extends: tseslint.configs.recommended.map(warnOnly),
    rules: { '@typescript-eslint/no-unused-vars': unused },
  },
  {
    // Node scripts (and the page.evaluate callbacks inside them, which run in the browser): no globals list is kept
    // for them, so no-undef would only report false positives
    files: ['**/*.mjs', '**/*.js'],
    rules: { 'no-undef': 'off', 'no-unused-vars': unused },
  },
);
