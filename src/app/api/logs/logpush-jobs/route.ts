import { getCloudflareContext } from '@opennextjs/cloudflare';

interface LogpushJob {
  id: number;
  dataset: string;
  name: string;
  destination_conf: string;
  enabled: boolean;
}

export async function GET() {
  const { env } = await getCloudflareContext();
  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const apiToken = (env as any).CF_API_TOKEN as string;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/logpush/jobs`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );

  // Known mappings from Logpush dashboard (some jobs require Zero Trust / Gateway
  // permissions that the API token may not have, so we seed with a fallback)
  const fallback: Record<string, string> = {
    'cloudflare-managed-0f8108e0': 'zero_trust_network_sessions',
    'cloudflare-managed-9cab9085': 'dlp_forensic_copies',
    'cloudflare-managed-f6a3b878': 'audit_logs',
    'cloudflare-managed-8b9a3019': 'device_posture_results',
    'cloudflare-managed-4a6dd1c8': 'gateway_dns',
    'cloudflare-managed-e33feb3a': 'gateway_http',
    'cloudflare-managed-ba0cd611': 'gateway_network',
    'cloudflare-managed-0eef17ef': 'ai_gateway_events',
    'cloudflare-managed-8987be33': 'workers_trace_events',
    'cloudflare-managed-8e67db0b': 'http_requests',
    'cloudflare-managed-27b89b30': 'dns_logs',
    'cloudflare-managed-3390cb25': 'nel_reports',
    'cloudflare-managed-390b5fac': 'spectrum_events',
    'cloudflare-managed-426202a1': 'firewall_events',
    'cloudflare-managed-b1f1f1e8': 'magic_ids_detections',
    'cloudflare-managed-c735df26': 'access_requests',
    'cloudflare-managed-cb0af4f7': 'casb_findings',
  };

  if (!response.ok) {
    // API failed but still return fallback labels
    return Response.json({ map: fallback });
  }

  const data = await response.json() as { result?: LogpushJob[] };
  const jobs = data.result ?? [];

  // Build bucket → dataset label mapping (dynamic overrides fallback)
  const map: Record<string, string> = { ...fallback };
  for (const job of jobs) {
    const dest = job.destination_conf ?? '';
    const r2Match = dest.match(/^r2:\/\/([^/?]+)/);
    if (r2Match) {
      const bucketName = r2Match[1]!;
      map[bucketName] = job.dataset
        ? `${job.dataset}${job.name ? ` (${job.name})` : ''}`
        : job.name || `Job #${job.id}`;
    }
  }

  return Response.json({ map });
}
