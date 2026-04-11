'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pause, Play, Trash2, Loader2, Boxes, Activity, Moon, CalendarPlus, RefreshCw, Search, BarChart3, Eye, Copy, CheckCheck, Server, Database, HardDrive, Globe, Key, Box } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

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

interface Stats {
  total: number;
  active: number;
  sleeping: number;
  today: number;
}

const STATUS_COLORS: Record<string, string> = {
  provisioning: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
  active: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  sleeping: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  suspended: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  deleted: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
};

export function OpenClawAdminPage() {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<OpenClawInstance[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, sleeping: 0, today: 0 });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailInstance, setDetailInstance] = useState<OpenClawInstance | null>(null);
  const [copiedKey, setCopiedKey] = useState('');

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
    });
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [instancesRes, statsRes] = await Promise.all([
        fetch('/api/openclaw/instances'),
        fetch('/api/openclaw/admin/stats'),
      ]);
      const instancesData = await instancesRes.json() as { instances: OpenClawInstance[] };
      const statsData = await statsRes.json() as Stats;
      setInstances(instancesData.instances || []);
      setStats(statsData);
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleUpdateStatus = async (id: string, status: OpenClawInstance['status']) => {
    try {
      const res = await fetch(`/api/openclaw/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        toast.error(t('openclaw.error', { message: data.error }));
        return;
      }
      toast.success(t('openclaw.updateSuccess'));
      fetchData();
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('openclaw.actions.confirmDelete'))) return;
    try {
      const res = await fetch(`/api/openclaw/instances/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        toast.error(t('openclaw.error', { message: data.error }));
        return;
      }
      toast.success(t('openclaw.deleteSuccess'));
      fetchData();
    } catch (err) {
      toast.error(t('openclaw.error', { message: (err as Error).message }));
    }
  };

  const filteredInstances = useMemo(() => {
    return instances.filter((inst) => {
      if (statusFilter !== 'all' && inst.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          inst.name.toLowerCase().includes(q) ||
          inst.slug.toLowerCase().includes(q) ||
          inst.owner.name.toLowerCase().includes(q) ||
          inst.owner.email.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [instances, statusFilter, searchQuery]);

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const statCards = [
    { key: 'total', value: stats.total, icon: Boxes, color: 'text-foreground' },
    { key: 'active', value: stats.active, icon: Activity, color: 'text-green-500' },
    { key: 'sleeping', value: stats.sleeping, icon: Moon, color: 'text-blue-500' },
    { key: 'today', value: stats.today, icon: CalendarPlus, color: 'text-orange-500' },
  ];

  const cfInfraItems = (inst: OpenClawInstance) => [
    {
      icon: Box,
      label: 'Durable Object',
      sublabel: 'Sandbox DO namespace',
      value: inst.id,
      description: `cf-openclaw-sandbox / Sandbox`,
    },
    {
      icon: Globe,
      label: 'Proxy URL',
      sublabel: '自訂域名入口',
      value: `https://saas-cfclaw.neokung.work/api/proxy/${inst.id}`,
      mono: true,
    },
    {
      icon: HardDrive,
      label: 'R2 Bucket',
      sublabel: '備份與 Logpush 存儲',
      value: 'cf-demo-openclaw',
      description: 'binding: BACKUP_BUCKET',
    },
    {
      icon: Database,
      label: 'KV Namespace',
      sublabel: 'Instance metadata 存儲',
      value: `openclaw:${inst.id}`,
      description: 'binding: KV (SESSIONS namespace)',
    },
    {
      icon: Server,
      label: 'Companion Worker',
      sublabel: '管理 Container 生命週期',
      value: 'cf-openclaw-sandbox',
      description: 'saas-cfclaw.neokung.work',
    },
    {
      icon: Key,
      label: 'Gateway Token',
      sublabel: 'OpenClaw 閘道認證 token',
      value: inst.gatewayToken,
      masked: true,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-lg font-semibold">{t('openclaw.adminTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('openclaw.adminDesc')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Stats */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {statCards.map((s) => (
            <Card key={s.key}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t(`openclaw.stats.${s.key}`)}
                </CardTitle>
                <s.icon className={`size-4 ${s.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{loading ? '—' : s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Charts */}
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          {/* Status Distribution Pie */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">狀態分佈</CardTitle>
              <BarChart3 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {stats.total === 0 ? (
                <div className="flex items-center justify-center h-[180px] text-muted-foreground text-sm">尚無資料</div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: '運行中', value: stats.active, color: '#22c55e' },
                        { name: '休眠中', value: stats.sleeping, color: '#3b82f6' },
                        { name: '已暫停', value: Math.max(0, stats.total - stats.active - stats.sleeping), color: '#ef4444' },
                      ].filter(d => d.value > 0)}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={3}
                      dataKey="value"
                      label={({ name, value }) => `${name} ${value}`}
                    >
                      {[
                        { name: '運行中', value: stats.active, color: '#22c55e' },
                        { name: '休眠中', value: stats.sleeping, color: '#3b82f6' },
                        { name: '已暫停', value: Math.max(0, stats.total - stats.active - stats.sleeping), color: '#ef4444' },
                      ].filter(d => d.value > 0).map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Daily Creation Bar */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">近 7 天建立趨勢</CardTitle>
              <CalendarPlus className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {instances.length === 0 ? (
                <div className="flex items-center justify-center h-[180px] text-muted-foreground text-sm">尚無資料</div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={(() => {
                    const days: { date: string; count: number }[] = [];
                    for (let i = 6; i >= 0; i--) {
                      const d = new Date();
                      d.setDate(d.getDate() - i);
                      const dateStr = d.toISOString().slice(5, 10);
                      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                      const dayEnd = dayStart + 86400000;
                      const count = instances.filter(inst => {
                        const t = new Date(inst.createdAt).getTime();
                        return t >= dayStart && t < dayEnd;
                      }).length;
                      days.push({ date: dateStr, count });
                    }
                    return days;
                  })()}>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} name="建立數" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder={t('openclaw.filter.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">{t('openclaw.filter.allStatus')}</option>
            <option value="provisioning">{t('openclaw.status.provisioning')}</option>
            <option value="active">{t('openclaw.status.active')}</option>
            <option value="sleeping">{t('openclaw.status.sleeping')}</option>
            <option value="suspended">{t('openclaw.status.suspended')}</option>
          </select>
        </div>

        {/* Table */}
        {loading && instances.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredInstances.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <Boxes className="size-10 text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">{t('openclaw.noInstances')}</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.name')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.slug')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.owner')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.status')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.model')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('openclaw.table.createdAt')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('openclaw.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map((inst) => (
                    <tr key={inst.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setDetailInstance(inst)}>
                      <td className="px-4 py-3 font-medium">{inst.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{inst.slug}</td>
                      <td className="px-4 py-3">
                        <div className="text-xs">
                          <span className="font-medium">{inst.owner.name}</span>
                          <br />
                          <span className="text-muted-foreground">{inst.owner.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[inst.status] || ''}`}>
                          {inst.status === 'provisioning' && <Loader2 className="size-3 mr-1 animate-spin" />}
                          {t(`openclaw.status.${inst.status}`)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {inst.config.aiModel.split('/').pop()}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(inst.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={(e) => { e.stopPropagation(); setDetailInstance(inst); }}
                            title="詳細資訊"
                          >
                            <Eye className="size-3.5" />
                          </Button>
                          {inst.status === 'active' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => handleUpdateStatus(inst.id, 'suspended')}
                              title={t('openclaw.actions.suspend')}
                            >
                              <Pause className="size-3.5" />
                            </Button>
                          )}
                          {(inst.status === 'suspended' || inst.status === 'sleeping') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => handleUpdateStatus(inst.id, 'active')}
                              title={t('openclaw.actions.resume')}
                            >
                              <Play className="size-3.5" />
                            </Button>
                          )}
                          {inst.status !== 'provisioning' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                              onClick={() => handleDelete(inst.id)}
                              title={t('openclaw.actions.delete')}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Detail Sheet */}
      <Sheet open={!!detailInstance} onOpenChange={(open) => !open && setDetailInstance(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {detailInstance && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="flex items-center gap-2">
                  <Boxes className="size-4" />
                  {detailInstance.name}
                </SheetTitle>
                <SheetDescription>
                  <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[detailInstance.status] || ''}`}>
                    {detailInstance.status === 'provisioning' && <Loader2 className="size-3 mr-1 animate-spin" />}
                    {t(`openclaw.status.${detailInstance.status}`)}
                  </Badge>
                  <span className="ml-2 font-mono text-xs">{detailInstance.id}</span>
                </SheetDescription>
              </SheetHeader>

              {/* CF Infrastructure */}
              <div className="space-y-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cloudflare 基礎設施</h3>
                <div className="space-y-3">
                  {cfInfraItems(detailInstance).map((item) => {
                    const Icon = item.icon;
                    const displayValue = item.masked
                      ? `${item.value.slice(0, 8)}…${item.value.slice(-4)}`
                      : item.value;
                    return (
                      <div key={item.label} className="flex items-start gap-3 p-3 rounded-lg border bg-muted/20">
                        <Icon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{item.label}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 shrink-0"
                              onClick={() => copyToClipboard(item.value, item.label)}
                            >
                              {copiedKey === item.label
                                ? <CheckCheck className="size-3 text-green-500" />
                                : <Copy className="size-3" />}
                            </Button>
                          </div>
                          <p className={`text-xs break-all mt-0.5 ${item.mono ? 'font-mono' : ''}`}>{displayValue}</p>
                          {item.sublabel && <p className="text-[10px] text-muted-foreground mt-0.5">{item.sublabel}</p>}
                          {item.description && <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{item.description}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Separator />

                {/* Config */}
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">AI 設定</h3>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Provider', value: detailInstance.config.aiProvider },
                    { label: 'Model', value: detailInstance.config.aiModel.split('/').pop() || detailInstance.config.aiModel },
                    { label: 'Sleep After', value: detailInstance.config.sleepAfter },
                    { label: 'Channels', value: detailInstance.config.channels.length ? detailInstance.config.channels.join(', ') : '無' },
                  ].map((item) => (
                    <div key={item.label} className="p-2 rounded-md border bg-muted/20">
                      <p className="text-[10px] text-muted-foreground">{item.label}</p>
                      <p className="text-xs font-mono mt-0.5 truncate" title={item.value}>{item.value}</p>
                    </div>
                  ))}
                </div>

                <Separator />

                {/* Owner & Time */}
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">擁有者與時間</h3>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">擁有者</span>
                    <span>{detailInstance.owner.name} ({detailInstance.owner.email})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">建立時間</span>
                    <span>{formatDate(detailInstance.createdAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">更新時間</span>
                    <span>{formatDate(detailInstance.updatedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Slug</span>
                    <span className="font-mono">{detailInstance.slug}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
