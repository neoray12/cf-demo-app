'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, RefreshCw, ExternalLink, Loader2 } from 'lucide-react';

interface InstanceInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  gatewayToken: string;
}

export default function OpenClawViewPage({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchInstance() {
      try {
        const res = await fetch(`/api/openclaw/instances/${instanceId}`);
        if (!res.ok) {
          setError('實例不存在');
          return;
        }
        const data = await res.json();
        setInstance(data.instance);
      } catch {
        setError('載入失敗');
      } finally {
        setLoading(false);
      }
    }
    fetchInstance();
  }, [instanceId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !instance) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-muted-foreground">{error || '實例不存在'}</p>
        <Button variant="outline" onClick={() => window.close()}>
          <ArrowLeft className="size-4 mr-2" />
          返回
        </Button>
      </div>
    );
  }

  const statusColor: Record<string, string> = {
    active: 'bg-green-500',
    sleeping: 'bg-yellow-500',
    provisioning: 'bg-blue-500',
    suspended: 'bg-red-500',
  };

  // The proxy URL routes through cf-demo-app → companion worker → container
  const proxyBaseUrl = `/api/openclaw/proxy/${instanceId}`;

  return (
    <div className="flex flex-col h-screen">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-background shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => window.close()}
        >
          <ArrowLeft className="size-4" />
        </Button>

        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-sm font-semibold truncate">{instance.name}</h1>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {instance.slug}
          </Badge>
          <div className={`size-2 rounded-full shrink-0 ${statusColor[instance.status] || 'bg-gray-400'}`} />
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              const iframe = document.getElementById('openclaw-iframe') as HTMLIFrameElement;
              if (iframe) iframe.src = iframe.src;
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              window.open(
                `https://cf-openclaw-sandbox.neo-cloudflare.workers.dev/?token=${instance.gatewayToken}`,
                '_blank'
              );
            }}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* iframe embedding the OpenClaw Control UI */}
      {instance.status === 'active' ? (
        <iframe
          id="openclaw-iframe"
          src={`${proxyBaseUrl}/?token=${instance.gatewayToken}`}
          className="flex-1 w-full border-0"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <p className="text-muted-foreground">
              {instance.status === 'provisioning' && '容器正在啟動中，請稍候...'}
              {instance.status === 'sleeping' && '容器正在休眠中'}
              {instance.status === 'suspended' && '容器已暫停'}
            </p>
            {(instance.status === 'sleeping' || instance.status === 'suspended') && (
              <Button
                variant="outline"
                onClick={async () => {
                  await fetch(`/api/openclaw/instances/${instanceId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'active' }),
                  });
                  window.location.reload();
                }}
              >
                喚醒容器
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
