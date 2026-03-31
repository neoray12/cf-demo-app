#!/bin/bash
# Deploy script that injects a dummy ChatAgent DO class into the worker entrypoint.
# The old Vite version had a ChatAgent Durable Object that no longer exists in the Next.js version,
# but Cloudflare still requires the class to be exported. This script injects a minimal stub.

set -e

echo "==> Injecting dummy ChatAgent class into worker entrypoint..."
cat >> .open-next/worker.js << 'EOF'

// Stub DO class — kept for backward compatibility with existing Durable Object namespace
export class ChatAgent {
  constructor(state) { this.state = state; }
  async fetch() { return new Response("deprecated", { status: 410 }); }
}
EOF

echo "==> Hiding open-next.config.ts to bypass OpenNext redirect..."
mv open-next.config.ts open-next.config.ts.bak

echo "==> Deploying with wrangler..."
npx wrangler deploy
STATUS=$?

echo "==> Restoring open-next.config.ts..."
mv open-next.config.ts.bak open-next.config.ts

exit $STATUS
