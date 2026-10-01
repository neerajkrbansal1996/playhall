import type { NextConfig } from 'next'

/**
 * `PLAYHALL_STATIC_EXPORT=1` switches `next build` to a static export into
 * `out/`, for the Cloudflare Pages staging link (`docs/ci-cd.md` →
 * "The free staging link on Cloudflare Pages"). It is **off by default**: the
 * served app — production, staging on the ratified provider, and `pnpm dev` —
 * is the normal Node build, and nothing here changes it.
 *
 * A static export cannot host a route handler, and `src/app/api/health/route.ts`
 * is deliberately `force-dynamic` because a prerendered health payload answers
 * about the build rather than the running process. Rather than weaken that
 * contract for the benefit of a link, the export drops `.ts` from
 * `pageExtensions`, which excludes `route.ts` while `layout.tsx` and `page.tsx`
 * still build. So the static link serves the pages and has no `/api/health` —
 * stated in `docs/ci-cd.md` so nobody points a probe at it.
 */
const staticExport = process.env.PLAYHALL_STATIC_EXPORT === '1'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not build output, so the dev
  // loop has no pre-build step. Next compiles them like app code.
  transpilePackages: ['@playhall/game-sdk', '@playhall/shared', '@playhall/ui'],
  typedRoutes: true,
  ...(staticExport ? { output: 'export' as const, pageExtensions: ['tsx', 'jsx'] } : {}),
  webpack(config) {
    // `packages/game-sdk` is ESM TypeScript, so its internal imports carry the
    // `.js` specifiers that `"moduleResolution": "Bundler"` + `verbatimModuleSyntax`
    // require — `./settings.js` on disk is `./settings.ts`. Node and Vite map that
    // back on their own; webpack needs telling, or every SDK-internal import
    // fails to resolve the moment apps/web imports the package.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return config
  },
}

export default nextConfig
