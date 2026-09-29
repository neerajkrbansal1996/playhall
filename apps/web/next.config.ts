import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not build output, so the dev
  // loop has no pre-build step. Next compiles them like app code.
  transpilePackages: ['@atrium/shared', '@atrium/ui'],
  typedRoutes: true,
}

export default nextConfig
