#!/bin/bash
# One-time deploy script to remove old ChatAgent Durable Object via migration.
# After successful deploy, this script and the DO binding/migration in wrangler.toml can be removed.

set -e

echo "==> Injecting dummy ChatAgent class into worker entrypoint..."
cat >> .open-next/worker.js << 'EOF'

// Temporary dummy DO class — needed for wrangler to validate the delete-class migration
export class ChatAgent {
  constructor(state) { this.state = state; }
  async fetch() { return new Response("deprecated", { status: 410 }); }
}
EOF

echo "==> Hiding open-next.config.ts to bypass OpenNext redirect..."
mv open-next.config.ts open-next.config.ts.bak

echo "==> Deploying with wrangler (will apply delete-class migration)..."
npx wrangler deploy
STATUS=$?

echo "==> Restoring open-next.config.ts..."
mv open-next.config.ts.bak open-next.config.ts

exit $STATUS
