import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

initOpenNextCloudflareForDev({
  configPath: 'wrangler.dev.toml',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // `agents/observability/ai` imports `cloudflare:workers` at module top level.
  // Map it to a global that src/lib/agents/tracing.ts fills at runtime (workerd only),
  // so neither webpack nor OpenNext's esbuild has to resolve the `cloudflare:` scheme.
  webpack: (config, { isServer }) => {
    if (isServer) {
      const prev = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
      config.externals = [
        ...prev,
        ({ request }, cb) =>
          request === 'cloudflare:workers' ? cb(null, 'var (globalThis.__CF_WORKERS__ || {})') : cb(),
      ];
    }
    return config;
  },
};

export default nextConfig;
