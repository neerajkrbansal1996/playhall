// jest-dom's matcher types, augmented onto *this package's* `vitest`.
//
// `@testing-library/jest-dom/vitest` already ships a `declare module 'vitest'`
// augmentation, and `test/setup.ts` pulls it in as a side effect. Relying on
// that alone is what made `pnpm --filter @playhall/web typecheck` flaky
// (PER-209): the augmentation lives inside the jest-dom package, which declares
// no `vitest` dependency or peer of its own, so TypeScript resolves its
// `'vitest'` specifier by walking up to pnpm's hidden hoist directory,
// `node_modules/.pnpm/node_modules/vitest`. This workspace installs two vitest
// majors — apps/web and most packages on 2.x, games/chess and tools/* on 3.x —
// and only one of them wins that hoist. When the one apps/web does not use
// wins, jest-dom augments an `Assertion` interface nobody here imports and every
// matcher call fails with TS2339 ("Property 'toBeInTheDocument' does not exist
// on type 'Assertion<HTMLElement>'") while the import itself still resolves
// cleanly — no TS2307.
//
// This file sits inside apps/web, so its `'vitest'` resolves through
// `apps/web/node_modules/vitest`: the same copy the test files resolve, by
// construction. Hoist order stops mattering. Keep it until `vitest` is a single
// version across the workspace; deleting it reopens the flake.
//
// The element type parameter must stay `any` to match jest-dom's own
// `TestingLibraryMatchers<any, T>`. Narrowing it makes the two augmentations
// non-identical and TypeScript rejects the merged interface with TS2320.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'vitest' {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
