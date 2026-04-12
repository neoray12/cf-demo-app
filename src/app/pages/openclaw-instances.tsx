'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, ExternalLink, Pause, Play, Trash2, Loader2, Boxes, RefreshCw, Settings } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface OpenClawInstance {
  id: string;
  name: string;
  slug: string;
  owner: { name: string; email: string };
  status: 'provisioning' | 'active' | 'sleeping' | 'suspended' | 'deleted';
  gatewayToken: string;
  sandboxId: string;
  config: {
    aiProvider: string;
    aiModel: string;
    sleepAfter: string;
    channels: string[];
  };
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  provisioning: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
  active: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  sleeping: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  suspended: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  deleted: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
};

const AI_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'workers-ai', label: 'Workers AI' },
];

const AI_MODELS: Record<string, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  'workers-ai': [
    { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B' },
  ],
};

export function OpenClawInstancesPage() {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<OpenClawInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formProvider, setFormProvider] = useState('anthropic');
  const [formModel, setFormModel] = useState('claude-sonnet-4-20250514');
  const [formSleep, setFormSleep] = useState('10m');

  // Settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInstance, setSettingsInstance] = useState<OpenClawInstance | null>(null);
  const [channelTelegram, setChannelTelegram] = useState('');
  const [channelDiscord, setChannelDiscord] = useState('');
  const [channelSlack, setChannelSlack] = useState('');

  const [currentUser, setCurrentUser] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cf-demo-user');
      if (raw) setCurrentUser(JSON.parse(raw));
    } catch {}
  }, []);

  const fetchInstances = useCallback(async () => {
    setLoading(true);
    try {
      const email = currentUser?.email || '';
      const res = await fetch(`/api/openclaw/instances?email=${encodeURIComponent(email)}`);
      const data = await res.json();
      const serverInstances: OpenClawInstance[] = data.instances || [];
      // Merge: keep any locally-optimistic provisioning instances not yet in KV
      setInstances((prev) => {
        const serverIds = new Set(serverInstances.map((i) => i.id));
        const localOnly = prev.filter((i) => i.status === 'provisioning' && !serverIds.has(i.id));
        return [...localOnly, ...serverInstances];
      });
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [currentUser?.email, t]);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  // Auto-refresh provisioning instances
  useEffect(() => {
    const hasProvisioning = instances.some((i) => i.status === 'provisioning');
    if (!hasProvisioning) return;
    const interval = setInterval(fetchInstances, 3000);
    return () => clearInterval(interval);
  }, [instances, fetchInstances]);

  // Auto-status polling: check real container status every 30s for active instances
  useEffect(() => {
    const hasActive = instances.some((i) => i.status === 'active');
    if (!hasActive) return;
    const interval = setInterval(async () => {
      for (const inst of instances.filter((i) => i.status === 'active')) {
        try {
          const res = await fetch(`/api/openclaw/instances/${inst.id}?check_status=true`);
          if (res.ok) {
            const data = await res.json();
            if (data.instance.status !== inst.status) {
              fetchInstances();
              break;
            }
          }
        } catch {}
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [instances, fetchInstances]);

  const openSettings = (inst: OpenClawInstance) => {
    setSettingsInstance(inst);
    setChannelTelegram(inst.config.channels?.find(c => c.startsWith('telegram:'))?.replace('telegram:', '') || '');
    setChannelDiscord(inst.config.channels?.find(c => c.startsWith('discord:'))?.replace('discord:', '') || '');
    setChannelSlack(inst.config.channels?.find(c => c.startsWith('slack:'))?.replace('slack:', '') || '');
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!settingsInstance) return;
    const channels: string[] = [];
    if (channelTelegram.trim()) channels.push(`telegram:${channelTelegram.trim()}`);
    if (channelDiscord.trim()) channels.push(`discord:${channelDiscord.trim()}`);
    if (channelSlack.trim()) channels.push(`slack:${channelSlack.trim()}`);
    try {
      const res = await fetch(`/api/openclaw/instances/${settingsInstance.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { channels } }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t('openclaw.error', { message: data.error }));
        return;
      }
      toast.success(t('openclaw.updateSuccess'));
      setSettingsOpen(false);
      fetchInstances();
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    }
  };

  // Auto-generate slug from name
  useEffect(() => {
    const slug = formName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    setFormSlug(slug);
  }, [formName]);

  // Update model when provider changes
  useEffect(() => {
    const models = AI_MODELS[formProvider];
    if (models?.[0]) {
      setFormModel(models[0].id);
    }
  }, [formProvider]);

  const handleCreate = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/openclaw/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          slug: formSlug.trim(),
          owner: currentUser || { name: 'Anonymous', email: 'anonymous@demo.com' },
          aiProvider: formProvider,
          aiModel: formModel,
          sleepAfter: formSleep,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(t('openclaw.createError', { message: data.error }));
        return;
      }
      const newInstance = (data as { instance: OpenClawInstance }).instance;
      toast.success(t('openclaw.createSuccess'));
      setDialogOpen(false);
      setFormName('');
      setFormSlug('');
      setFormProvider('anthropic');
      setFormModel('claude-sonnet-4-20250514');
      // Optimistically insert the new instance immediately (KV may lag)
      setInstances((prev) => [newInstance, ...prev]);
      // Then sync from server to get latest status
      fetchInstances();
    } catch (err) {
      toast.error(t('openclaw.createError', { message: (err as Error).message }));
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: OpenClawInstance['status']) => {
    try {
      const res = await fetch(`/api/openclaw/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t('openclaw.error', { message: data.error }));
        return;
      }
      toast.success(t('openclaw.updateSuccess'));
      fetchInstances();
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('openclaw.actions.confirmDelete'))) return;
    try {
      const res = await fetch(`/api/openclaw/instances/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        toast.error(t('openclaw.error', { message: data.error }));
        return;
      }
      toast.success(t('openclaw.deleteSuccess'));
      fetchInstances();
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    }
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-lg font-semibold">{t('openclaw.myInstances')}</h1>
          <p className="text-sm text-muted-foreground">{t('openclaw.myInstancesDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchInstances} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4 mr-1" />
                {t('openclaw.createInstance')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('openclaw.createInstanceTitle')}</DialogTitle>
                <DialogDescription>{t('openclaw.createInstanceDesc')}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('openclaw.instanceName')}</label>
                  <Input
                    placeholder={t('openclaw.instanceNamePlaceholder')}
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('openclaw.instanceSlug')}</label>
                  <Input
                    placeholder={t('openclaw.instanceSlugPlaceholder')}
                    value={formSlug}
                    onChange={(e) => setFormSlug(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('openclaw.aiProvider')}</label>
                  <select
                    value={formProvider}
                    onChange={(e) => setFormProvider(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {AI_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('openclaw.aiModel')}</label>
                  <select
                    value={formModel}
                    onChange={(e) => setFormModel(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {(AI_MODELS[formProvider] || []).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">{t('openclaw.sleepAfter')}</label>
                  <select
                    value={formSleep}
                    onChange={(e) => setFormSleep(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="10m">10 分鐘</option>
                    <option value="30m">30 分鐘</option>
                    <option value="1h">1 小時</option>
                    <option value="never">永不休眠</option>
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  {t('openclaw.cancel')}
                </Button>
                <Button onClick={handleCreate} disabled={creating || !formName.trim() || !formSlug.trim()}>
                  {creating && <Loader2 className="size-4 mr-1 animate-spin" />}
                  {creating ? t('openclaw.creating') : t('openclaw.create')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading && instances.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : instances.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Boxes className="size-12 text-muted-foreground/50 mb-4" />
            <p className="text-lg font-medium text-muted-foreground">{t('openclaw.noInstances')}</p>
            <p className="text-sm text-muted-foreground/70 mt-1">{t('openclaw.noInstancesHint')}</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {instances.map((instance) => (
              <Card key={instance.id} className="relative overflow-hidden">
                {instance.status === 'provisioning' && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-yellow-500/30">
                    <div className="h-full bg-yellow-500 animate-pulse" style={{ width: '60%' }} />
                  </div>
                )}
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base truncate">{instance.name}</CardTitle>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{instance.slug}</p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 ml-2 text-[10px] ${STATUS_COLORS[instance.status] || ''}`}>
                      {instance.status === 'provisioning' && <Loader2 className="size-3 mr-1 animate-spin" />}
                      {t(`openclaw.status.${instance.status}`)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>{t('openclaw.aiModel')}</span>
                      <span className="font-mono truncate ml-2 max-w-[60%] text-right">
                        {instance.config.aiModel.split('/').pop()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t('openclaw.sleepAfter')}</span>
                      <span>{instance.config.sleepAfter}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t('openclaw.table.createdAt')}</span>
                      <span>{formatDate(instance.createdAt)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 mt-4 pt-3 border-t">
                    {instance.status === 'active' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs flex-1"
                          onClick={() => {
                            const sub = instance.id.replace('_', '-'); // oc_xxx → oc-xxx (DNS labels disallow underscores)
                            const model = encodeURIComponent(`${instance.config.aiProvider}/${instance.config.aiModel}`);
                            window.open(`https://${sub}.saas-cfclaw.neokung.work/?token=${instance.gatewayToken}&_m=${model}`, '_blank');
                          }}
                        >
                          <ExternalLink className="size-3 mr-1" />
                          {t('openclaw.actions.openUI')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleUpdateStatus(instance.id, 'suspended')}
                        >
                          <Pause className="size-3" />
                        </Button>
                      </>
                    )}
                    {instance.status === 'suspended' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() => handleUpdateStatus(instance.id, 'active')}
                      >
                        <Play className="size-3 mr-1" />
                        {t('openclaw.actions.resume')}
                      </Button>
                    )}
                    {instance.status === 'sleeping' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() => handleUpdateStatus(instance.id, 'active')}
                      >
                        <Play className="size-3 mr-1" />
                        {t('openclaw.actions.resume')}
                      </Button>
                    )}
                    {instance.status !== 'provisioning' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => openSettings(instance)}
                        >
                          <Settings className="size-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-red-500 hover:text-red-600"
                          onClick={() => handleDelete(instance.id)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>頻道設定</DialogTitle>
            <DialogDescription>
              設定 {settingsInstance?.name} 的聊天頻道整合
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Telegram Bot Token</label>
              <Input
                placeholder="123456:ABC-DEF..."
                value={channelTelegram}
                onChange={(e) => setChannelTelegram(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Discord Webhook URL</label>
              <Input
                placeholder="https://discord.com/api/webhooks/..."
                value={channelDiscord}
                onChange={(e) => setChannelDiscord(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Slack Webhook URL</label>
              <Input
                placeholder="https://hooks.slack.com/services/..."
                value={channelSlack}
                onChange={(e) => setChannelSlack(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              {t('openclaw.cancel')}
            </Button>
            <Button onClick={saveSettings}>
              儲存設定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
