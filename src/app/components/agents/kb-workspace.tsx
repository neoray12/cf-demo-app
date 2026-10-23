'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  FileText,
  Globe,
  Info,
  Library,
  Loader2,
  Plus,
  TriangleAlert,
  Upload,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countUploadedDocs, isValidWorkspace, newWorkspaceId, validateUpload } from "@/lib/agents/kb";
import {
  docDisplayName,
  formatBytes,
  indexState,
  kbErrorKey,
  summarizeIndex,
  type IndexState,
  type KbStatusFile,
} from "@/lib/agents/ui-helpers";
import { cn } from "@/lib/utils";

export const KB_WORKSPACE_STORAGE_KEY = "cf-demo-kb-workspace";
const DEFAULT_WORKSPACE = "default";
/** /status (+ /docs) poll interval, only while this panel is mounted and the tab is visible. */
const STATUS_POLL_MS = 10_000;
/** Give up polling after this long even if a document never reports a final status (AI Search status is unreliable). */
const STATUS_POLL_MAX_MS = 15 * 60_000;
const IMPORT_POLL_MS = 3_000;
const IMPORT_MAX_MS = 10 * 60_000;
const IMPORT_MAX_POLL_FAILURES = 3;

interface DocItem {
  key: string;
  size: number;
  uploaded: string;
}

interface UploadItem {
  id: number;
  name: string;
  state: "uploading" | "done" | "error";
  errorKey?: string;
}

type ImportView =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; finished: number; total: number }
  | { phase: "done"; saved: number; failed: number }
  | { phase: "failed"; status: string; saved: number; failed: number }
  | { phase: "error"; errorKey: string };

function readStoredWorkspace(): string | null {
  try {
    const v = localStorage.getItem(KB_WORKSPACE_STORAGE_KEY);
    return v && v !== DEFAULT_WORKSPACE && isValidWorkspace(v) ? v : null;
  } catch {
    return null;
  }
}

function storeWorkspace(id: string): void {
  try {
    localStorage.setItem(KB_WORKSPACE_STORAGE_KEY, id);
  } catch {
    // private mode / blocked storage: the workspace just won't be remembered
  }
}

async function getJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

const STATE_STYLE: Record<IndexState, string> = {
  indexing: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  unknown: "text-muted-foreground",
};

function StateBadge({ state, error }: { state: IndexState; error?: string }) {
  const { t } = useTranslation();
  const Icon = state === "indexing" ? Loader2 : state === "done" ? CheckCircle2 : state === "failed" ? XCircle : CircleHelp;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 px-1.5 py-0 text-[11px] font-normal", STATE_STYLE[state])}
      title={state === "failed" && error ? error : undefined}
    >
      <Icon className={cn("size-3", state === "indexing" && "animate-spin")} />
      {t(`agents.kb.state.${state}`)}
    </Badge>
  );
}

export interface KbWorkspaceProps {
  /** `default` (read-only sample) or the user's `ws-xxxxxxxx`. */
  value: string;
  onChange: (workspace: string) => void;
  storeContent: boolean;
  onStoreContentChange: (storeContent: boolean) => void;
}

/**
 * Workspace picker + document upload / site import + document list with (advisory) indexing status.
 * Polling is bound to this component's lifetime: every timer is cleared on unmount.
 */
export function KbWorkspace({ value, onChange, storeContent, onStoreContentChange }: KbWorkspaceProps) {
  const { t } = useTranslation();
  const writable = value !== DEFAULT_WORKSPACE;

  const [myId, setMyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [files, setFiles] = useState<KbStatusFile[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [imp, setImp] = useState<ImportView>({ phase: "idle" });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const importTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const uploadSeq = useRef(0);
  const mountedRef = useRef(false);
  /** Id of the latest status request: a response older than the latest is ignored. */
  const statusSeq = useRef(0);

  // The stored workspace id is only readable in the browser (SSR renders without it).
  useEffect(() => {
    const stored = readStoredWorkspace();
    setMyId(stored);
    // A valid workspace passed in from outside that we don't know yet is "mine" too.
    if (!stored && value !== DEFAULT_WORKSPACE && isValidWorkspace(value)) setMyId(value);
  }, []);

  const stopImport = useCallback(() => {
    if (importTimerRef.current) {
      clearInterval(importTimerRef.current);
      importTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopImport();
    };
  }, [stopImport]);

  // Switching workspace resets everything that belongs to the previous one.
  useEffect(() => {
    setDocs(null);
    setFiles([]);
    setInstanceStatus(null);
    setLoadError(false);
    setUploads([]);
    setImp({ phase: "idle" });
    stopImport();
  }, [value, stopImport]);

  // Document list (+ indexing status for a writable workspace). `epoch` restarts it after an upload / import.
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const qs = `workspace=${encodeURIComponent(value)}`;

    const stop = () => {
      settled = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    };

    // One request round at a time: interval, visibility and epoch triggers must not race each other.
    let inFlight = false;
    const tick = async () => {
      if (settled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const seq = ++statusSeq.current;
      try {
        // allSettled: a good /docs result is kept even when /status fails (and vice versa).
        const [dr, sr] = await Promise.allSettled([
          getJson(`/api/agents/kb/docs?${qs}`),
          writable ? getJson(`/api/agents/kb/status?${qs}`) : Promise.resolve(null),
        ]);
        if (cancelled || !mountedRef.current || seq !== statusSeq.current) return;
        const d = dr.status === "fulfilled" ? dr.value : null;
        const s = sr.status === "fulfilled" ? sr.value : null;
        const list = d?.ok ? ((d.body as { docs?: DocItem[] } | null)?.docs ?? []) : null;
        if (list) setDocs(list);
        setLoadError(!list);
        let fileList: KbStatusFile[] = [];
        const statusOk = !!s?.ok;
        if (s?.ok) {
          const body = s.body as { status?: string; files?: KbStatusFile[] } | null;
          fileList = Array.isArray(body?.files) ? body.files : [];
          setFiles(fileList);
          setInstanceStatus(typeof body?.status === "string" ? body.status : null);
        }
        // The read-only sample workspace has no status to follow (one fetch, no retry). A writable one is polled
        // until every document is completed / error (or the cap); a failed round never settles it.
        if (!writable) stop();
        else if (list && statusOk && summarizeIndex(list.map((x) => x.key), fileList).settled) stop();
        else if (Date.now() - startedAt > STATUS_POLL_MAX_MS) stop();
      } finally {
        inFlight = false;
      }
    };

    void tick();
    if (writable) timer = setInterval(() => void tick(), STATUS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [value, writable, epoch]);

  const summary = useMemo(
    () => summarizeIndex((docs ?? []).map((d) => d.key), files),
    [docs, files],
  );
  const fileByKey = useMemo(() => new Map(files.map((f) => [f.key, f])), [files]);
  const uploadedCount = useMemo(() => (docs ? countUploadedDocs(value, docs) : 0), [docs, value]);

  // ---- workspace -----------------------------------------------------------------------------------------------

  const createWorkspace = () => {
    const id = newWorkspaceId();
    storeWorkspace(id);
    setMyId(id);
    setOpen(true);
    onChange(id);
  };

  // ---- upload --------------------------------------------------------------------------------------------------

  const patchUpload = (id: number, patch: Partial<UploadItem>) =>
    setUploads((us) => us.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const uploadFiles = async (list: File[]) => {
    if (!writable || list.length === 0 || uploading) return;
    const target = value;
    setUploading(true);
    let count = uploadedCount;
    let uploadedAny = false;
    for (const file of list) {
      const id = ++uploadSeq.current;
      // Same rules as the server (type, 10 MB, 20 files), checked here first so a bad file never leaves the browser.
      const invalid = validateUpload({ name: file.name, size: file.size }, count);
      if (invalid) {
        setUploads((us) => [...us, { id, name: file.name, state: "error", errorKey: invalid }]);
        continue;
      }
      setUploads((us) => [...us, { id, name: file.name, state: "uploading" }]);
      count++;
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("workspace", target);
        const res = await getJson("/api/agents/kb/upload", { method: "POST", body: form });
        if (valueRef.current !== target) break;
        if (res.ok) {
          uploadedAny = true;
          patchUpload(id, { state: "done" });
        } else {
          count--;
          patchUpload(id, { state: "error", errorKey: kbErrorKey(res.body) });
        }
      } catch {
        count--;
        if (valueRef.current !== target) break;
        patchUpload(id, { state: "error", errorKey: "agents.kb.errors.server" });
      }
    }
    setUploading(false);
    if (uploadedAny && valueRef.current === target) setEpoch((e) => e + 1);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    void uploadFiles(picked);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(e.dataTransfer.files));
  };

  // ---- site import ---------------------------------------------------------------------------------------------

  const startImport = async () => {
    if (!writable || imp.phase === "starting" || imp.phase === "running") return;
    const raw = importUrl.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const target = value;
    setImp({ phase: "starting" });
    let jobId: string;
    try {
      const res = await getJson("/api/agents/kb/import-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, workspace: target }),
      });
      const id = (res.body as { jobId?: unknown } | null)?.jobId;
      // Navigated away (or switched workspace) during the POST: do not start polling for a dead component.
      if (!mountedRef.current || valueRef.current !== target) return;
      if (!res.ok || typeof id !== "string") {
        setImp({ phase: "error", errorKey: kbErrorKey(res.body) });
        return;
      }
      jobId = id;
    } catch {
      if (mountedRef.current && valueRef.current === target) setImp({ phase: "error", errorKey: "agents.kb.errors.server" });
      return;
    }

    if (!mountedRef.current) return;
    setImp({ phase: "running", finished: 0, total: 0 });
    const startedAt = Date.now();
    let failures = 0;
    let inFlight = false;
    stopImport();
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await getJson(
          `/api/agents/kb/import-site?jobId=${encodeURIComponent(jobId)}&workspace=${encodeURIComponent(target)}`,
        );
        if (!mountedRef.current || valueRef.current !== target || importTimerRef.current === null) return;
        if (!res.ok) {
          // A foreign / malformed job is final; anything else (incl. a 404 from KV not having caught up yet) gets a few retries.
          if (res.status === 400 || res.status === 403 || ++failures >= IMPORT_MAX_POLL_FAILURES) {
            stopImport();
            setImp({ phase: "error", errorKey: kbErrorKey(res.body) });
          }
          return;
        }
        failures = 0;
        const b = res.body as { status?: string; finished?: number; total?: number; saved?: number; failed?: number };
        if (b.status === "running") {
          setImp({ phase: "running", finished: b.finished ?? 0, total: b.total ?? 0 });
        } else {
          stopImport();
          const saved = b.saved ?? 0;
          const failed = b.failed ?? 0;
          setImp(
            b.status === "completed"
              ? { phase: "done", saved, failed }
              : { phase: "failed", status: b.status ?? "unknown", saved, failed },
          );
          setEpoch((e) => e + 1);
        }
        if (Date.now() - startedAt > IMPORT_MAX_MS && importTimerRef.current !== null) {
          stopImport();
          setImp({ phase: "error", errorKey: "agents.kb.importTimeout" });
        }
      } catch {
        if (++failures >= IMPORT_MAX_POLL_FAILURES) {
          stopImport();
          if (mountedRef.current && valueRef.current === target) setImp({ phase: "error", errorKey: "agents.kb.errors.server" });
        }
      } finally {
        inFlight = false;
      }
    };
    importTimerRef.current = setInterval(() => void poll(), IMPORT_POLL_MS);
    void poll();
  };

  // ---- render --------------------------------------------------------------------------------------------------

  const importing = imp.phase === "starting" || imp.phase === "running";
  const docCount = docs?.length ?? 0;

  const syncBadge = (() => {
    if (!writable || !docs || docs.length === 0) return null;
    if (summary.indexing > 0)
      return { cls: STATE_STYLE.indexing, icon: Loader2, spin: true, text: t("agents.kb.sync.indexing", { n: summary.indexing }) };
    if (summary.failed > 0)
      return { cls: STATE_STYLE.failed, icon: TriangleAlert, spin: false, text: t("agents.kb.sync.failed", { n: summary.failed }) };
    if (summary.unknown > 0)
      return { cls: STATE_STYLE.unknown, icon: CircleHelp, spin: false, text: t("agents.kb.sync.unknown", { n: summary.unknown }) };
    return { cls: STATE_STYLE.done, icon: CheckCircle2, spin: false, text: t("agents.kb.sync.done") };
  })();

  return (
    <Card className="mx-3 mt-2 shrink-0 gap-0 p-0 shadow-none md:mx-4">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Library className="size-3.5" />
          {t("agents.kb.title")}
        </div>
        <Select value={value} onValueChange={onChange} disabled={uploading || importing}>
          <SelectTrigger size="sm" className="h-8 max-w-[15rem] text-xs" aria-label={t("agents.kb.workspaceLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={DEFAULT_WORKSPACE} className="text-xs">
              {t("agents.kb.sampleWorkspace")}
            </SelectItem>
            {myId && (
              <SelectItem value={myId} className="text-xs">
                {t("agents.kb.myWorkspace")}
                <span className="font-mono text-[10px] text-muted-foreground">{myId}</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {!myId && (
          <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={createWorkspace}>
            <Plus className="size-3.5" />
            {t("agents.kb.createWorkspace")}
          </Button>
        )}
        {syncBadge && (
          <Badge
            variant="outline"
            className={cn("gap-1 font-normal", syncBadge.cls)}
            title={instanceStatus ? t("agents.kb.sync.instance", { status: instanceStatus }) : undefined}
          >
            <syncBadge.icon className={cn("size-3", syncBadge.spin && "animate-spin")} />
            {syncBadge.text}
          </Badge>
        )}
        <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={!storeContent}
            onChange={(e) => onStoreContentChange(!e.target.checked)}
          />
          {t("agents.kb.storeContentOff")}
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {t("agents.kb.manage")}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </Button>
      </div>

      <p className="px-3 pb-2 text-[11px] leading-snug text-muted-foreground">
        {storeContent ? t("agents.kb.retentionNotice") : t("agents.kb.retentionOff")}
      </p>

      {open && (
        <div className="flex max-h-[42svh] flex-col gap-3 overflow-y-auto border-t px-3 py-3">
          {/* Indexing takes minutes: say so first. */}
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <div>
              <p className="font-medium">{t("agents.kb.prepNote")}</p>
              <p className="mt-0.5 opacity-90">{t("agents.kb.prepNoteMore")}</p>
            </div>
          </div>

          {!writable ? (
            <p className="text-xs text-muted-foreground">{t("agents.kb.readOnly")}</p>
          ) : (
            <>
              <div
                role="button"
                tabIndex={0}
                aria-disabled={uploading}
                onClick={() => !uploading && fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !uploading) {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center transition-colors hover:bg-muted/50",
                  dragging && "border-primary bg-primary/5",
                  uploading && "cursor-progress opacity-70",
                )}
              >
                <Upload className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium">{t("agents.kb.dropTitle")}</span>
                <span className="text-[11px] text-muted-foreground">{t("agents.kb.dropHint")}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.md,.txt"
                  className="hidden"
                  onChange={onPick}
                />
              </div>

              {uploads.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {uploads.slice(-6).map((u) => (
                    <li key={u.id} className="flex items-center gap-1.5 min-w-0">
                      {u.state === "uploading" ? (
                        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                      ) : u.state === "done" ? (
                        <CheckCircle2 className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="size-3 shrink-0 text-destructive" />
                      )}
                      <span className="truncate">{u.name}</span>
                      {u.state === "error" && u.errorKey && (
                        <span className="shrink-0 text-destructive">{t(u.errorKey)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Globe className="size-3.5 text-muted-foreground" />
                  {t("agents.kb.importTitle")}
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void startImport();
                  }}
                >
                  <Input
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder={t("agents.kb.importPlaceholder")}
                    inputMode="url"
                    className="h-8 text-xs md:text-xs"
                    disabled={importing}
                    aria-label={t("agents.kb.importTitle")}
                  />
                  <Button type="submit" size="sm" className="h-8 shrink-0 px-3 text-xs" disabled={importing || !importUrl.trim()}>
                    {importing && <Loader2 className="size-3.5 animate-spin" />}
                    {t("agents.kb.importButton")}
                  </Button>
                </form>
                <p className="text-[11px] text-muted-foreground">{t("agents.kb.importHint")}</p>
                {importing && (
                  <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200">
                    {t("agents.kb.importStayHint")}
                  </p>
                )}
                {imp.phase === "starting" && <p className="text-xs text-muted-foreground">{t("agents.kb.importStarting")}</p>}
                {imp.phase === "running" && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground">
                      {imp.total > 0
                        ? t("agents.kb.importRunning", { finished: imp.finished, total: imp.total })
                        : t("agents.kb.importRunningUnknown")}
                    </p>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full bg-primary transition-all", imp.total === 0 && "w-1/4 animate-pulse")}
                        style={imp.total > 0 ? { width: `${Math.min(100, Math.round((imp.finished / imp.total) * 100))}%` } : undefined}
                      />
                    </div>
                  </div>
                )}
                {imp.phase === "done" && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    {t("agents.kb.importDone", { saved: imp.saved, failed: imp.failed })}
                  </p>
                )}
                {imp.phase === "failed" && (
                  <p className="text-xs text-destructive">
                    {t("agents.kb.importFailed", { status: imp.status, saved: imp.saved, failed: imp.failed })}
                  </p>
                )}
                {imp.phase === "error" && <p className="text-xs text-destructive">{t(imp.errorKey)}</p>}
              </div>
            </>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
              <span>{t("agents.kb.docsTitle", { n: docCount })}</span>
              {writable && docCount > 0 && (
                <span className="text-[11px] font-normal text-muted-foreground">{t("agents.kb.statusColumn")}</span>
              )}
            </div>
            {loadError && (
              <p className="text-xs text-destructive">{t(writable ? "agents.kb.loadFailed" : "agents.kb.loadFailedStatic")}</p>
            )}
            {docs === null && !loadError && <p className="text-xs text-muted-foreground">{t("agents.kb.docsLoading")}</p>}
            {docs && docs.length === 0 && <p className="text-xs text-muted-foreground">{t("agents.kb.docsEmpty")}</p>}
            {docs && docs.length > 0 && (
              <ul className="flex max-h-44 flex-col overflow-y-auto rounded-md border">
                {docs.map((d) => {
                  const file = fileByKey.get(d.key);
                  const name = docDisplayName(value, d.key);
                  return (
                    <li key={d.key} className="flex items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0">
                      <FileText className="size-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate" title={name}>
                        {name}
                      </span>
                      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{formatBytes(d.size)}</span>
                      {writable && <StateBadge state={indexState(file)} error={file?.error} />}
                    </li>
                  );
                })}
              </ul>
            )}
            {writable && docCount > 0 && <p className="text-[11px] text-muted-foreground">{t("agents.kb.statusNote")}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}
