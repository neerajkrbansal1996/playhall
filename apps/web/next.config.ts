import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not build output, so the dev
  // loop has no pre-build step. Next compiles them like app code.
  transpilePackages: ['@playhall/game-sdk', '@playhall/shared', '@playhall/ui'],
  typedRoutes: true,
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
