'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft } from 'lucide-react';

interface InstanceInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  gatewayToken: string;
}

export default function OpenClawViewPage({ instanceId }: { instanceId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function redirectToProxy() {
      try {
        const res = await fetch(`/api/openclaw/instances/${instanceId}`);
        if (!res.ok) {
          setError('實例不存在');
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { instance: InstanceInfo };
        const inst = data.instance;

        if (inst.status !== 'active') {
          setError(`實例狀態：${inst.status}（需為 active 才能開啟）`);
          setLoading(false);
          return;
        }

        // Redirect to companion worker directly — supports both HTTP and WebSocket
        const sandboxUrl = 'https://cf-openclaw-sandbox.neo-cloudflare.workers.dev';
        window.location.replace(`${sandboxUrl}/api/proxy/${instanceId}/?token=${inst.gatewayToken}`);
      } catch {
        setError('載入失敗');
        setLoading(false);
      }
    }
    redirectToProxy();
  }, [instanceId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <span className="ml-3 text-muted-foreground">正在載入 OpenClaw...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4">
      <p className="text-muted-foreground">{error}</p>
      <Button variant="outline" onClick={() => window.history.back()}>
        <ArrowLeft className="size-4 mr-2" />
        返回
      </Button>
    </div>
  );
}
