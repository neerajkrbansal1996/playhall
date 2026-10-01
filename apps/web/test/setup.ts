// This side-effect import is also what supplies jest-dom's matcher types, via
// the `declare module 'vitest'` augmentation inside the jest-dom package.
// jest-dom declares no `vitest` dependency or peer, so TypeScript resolves that
// specifier through pnpm's hoist directory, `node_modules/.pnpm/node_modules/
// vitest`. It lands on the interface this package actually imports only while
// the workspace installs exactly one vitest major. With two, the hoist picks one
// and the loser gets TS2339 on every matcher call while the import itself still
// resolves — no TS2307 (PER-209). PER-220 unified the workspace on one major, so
// the hoist has nothing to choose between. Keep it that way: reintroducing a
// second vitest major reopens the flake here.
import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)
