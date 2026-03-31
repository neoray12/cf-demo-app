'use client';

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import {
  Loader2,
  Play,
  Download,
  Save,
  ArrowLeft,
  Globe,
  Camera,
  FileDown,
  ScanText,
  Code,
  Image,
  Search,
  Braces,
  Link2,
  Globe2,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

// ── Copy button helper ──

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

// ── Syntax highlighting helpers ──

function JsonHighlight({ data }: { data: unknown }) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const lines = json.split("\n");
  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
      {lines.map((line, i) => (
        <div key={i}>
          {line.split(/(".+?"\s*:|".+?"|\b\d+\.?\d*\b|\btrue\b|\bfalse\b|\bnull\b)/g).map((part, j) => {
            if (/^".+?"\s*:$/.test(part)) return <span key={j} className="text-blue-600 dark:text-blue-400">{part}</span>;
            if (/^".+?"$/.test(part)) return <span key={j} className="text-emerald-600 dark:text-emerald-400">{part}</span>;
            if (/^\d+\.?\d*$/.test(part)) return <span key={j} className="text-amber-600 dark:text-amber-400">{part}</span>;
            if (/^(true|false)$/.test(part)) return <span key={j} className="text-purple-600 dark:text-purple-400">{part}</span>;
            if (/^null$/.test(part)) return <span key={j} className="text-red-500 dark:text-red-400">{part}</span>;
            return <span key={j} className="text-foreground/80">{part}</span>;
          })}
        </div>
      ))}
    </pre>
  );
}

function HtmlHighlight({ html }: { html: string }) {
  const parts = html.split(/(<\/?[^>]+>)/g);
  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
      {parts.map((part, i) => {
        if (/^<\/?[^>]+>$/.test(part)) {
          return (
            <span key={i}>
              <span className="text-rose-600 dark:text-rose-400">&lt;</span>
              {part.slice(1, -1).split(/(\s+[a-zA-Z-]+=)/g).map((attr, j) => {
                if (/^\s+[a-zA-Z-]+=$/.test(attr)) return <span key={j} className="text-amber-600 dark:text-amber-400">{attr}</span>;
                return <span key={j} className="text-blue-600 dark:text-blue-400">{attr}</span>;
              })}
              <span className="text-rose-600 dark:text-rose-400">&gt;</span>
            </span>
          );
        }
        return <span key={i} className="text-foreground/80">{part}</span>;
      })}
    </pre>
  );
}

const endpointIcons: Record<string, React.ElementType> = {
  content: Code,
  screenshot: Camera,
  pdf: FileDown,
  markdown: ScanText,
  snapshot: Image,
  scrape: Search,
  json: Braces,
  links: Link2,
  crawl: Globe2,
};

export function CrawlerEndpointPage({ endpoint }: { endpoint: string }) {
  const router = useRouter();
  const { t } = useTranslation();

  const Icon = endpointIcons[endpoint || ""] || Globe;
  const title = endpoint ? t(`crawler.endpoints.${endpoint}.title`) : t("crawler.unknown");
  const desc = endpoint ? t(`crawler.endpoints.${endpoint}.desc`) : "";

  const [url, setUrl] = useState("https://developers.cloudflare.com");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [binaryResult, setBinaryResult] = useState<string | null>(null);

  // Crawl polling state
  const [crawlStatus, setCrawlStatus] = useState<string | null>(null);
  const [crawlProgress, setCrawlProgress] = useState<{ finished: number; total: number } | null>(null);

  // Endpoint-specific state
  const [selectors, setSelectors] = useState('[{"selector": "h1"}, {"selector": "p"}]');
  const [jsonPrompt, setJsonPrompt] = useState("Extract the main title and description");
  const [maxDepth, setMaxDepth] = useState("2");
  const [limit, setLimit] = useState("5");
  const [screenshotFullPage, setScreenshotFullPage] = useState(true);
  const [pdfFormat, setPdfFormat] = useState("a4");
  const [pdfLandscape, setPdfLandscape] = useState(false);
  const [crawlRender, setCrawlRender] = useState(false);

  // ── Crawl: poll for results on the client side ──
  const pollCrawlResults = async (jobId: string) => {
    const POLL_INTERVAL = 3000;
    const MAX_POLLS = 200; // ~10 min

    setCrawlStatus("running");
    setCrawlProgress(null);

    for (let i = 0; i < MAX_POLLS; i++) {
      try {
        const res = await fetch(`/api/browser-rendering/crawl?jobId=${jobId}&limit=1`);
        const data = await res.json();
        console.log(`[crawl poll #${i}]`, JSON.stringify(data).slice(0, 500));
        const job = data.result;
        if (!job) throw new Error("Invalid crawl poll response");

        setCrawlStatus(job.status ?? "running");
        if (job.total != null) setCrawlProgress({ finished: job.finished ?? 0, total: job.total });

        if (job.status && job.status !== "running") {
          // Job done — fetch all records (including errored/skipped for visibility)
          const allRecords: any[] = [];
          let cursor: string | undefined;
          let fullResult: any;

          do {
            const qs = cursor
              ? `jobId=${jobId}&cursor=${cursor}`
              : `jobId=${jobId}`;
            const fullRes = await fetch(`/api/browser-rendering/crawl?${qs}`);
            const fullData = await fullRes.json();
            fullResult = fullData.result;
            if (fullResult?.records) allRecords.push(...fullResult.records);
            cursor = fullResult?.cursor;
          } while (cursor);

          console.log(`[crawl done] status=${fullResult?.status}, records=${allRecords.length}`);
          setResult({ ...fullResult, records: allRecords });
          toast.success(t("crawler.executeSuccess"));
          return;
        }
      } catch (err) {
        console.error("[crawl poll]", err);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    toast.error("Crawl 超時，請稍後再試");
  };

  const handleExecute = async () => {
    if (!url.trim()) {
      toast.error(t("crawler.enterUrl"));
      return;
    }
    setLoading(true);
    setResult(null);
    setBinaryResult(null);
    setCrawlStatus(null);
    setCrawlProgress(null);

    try {
      let body: Record<string, unknown> = { url: url.trim() };

      switch (endpoint) {
        case "screenshot":
          body = { ...body, screenshotOptions: { fullPage: screenshotFullPage } };
          break;
        case "pdf":
          body = { ...body, pdfOptions: { format: pdfFormat.toLowerCase(), landscape: pdfLandscape, printBackground: true } };
          break;
        case "scrape":
          try {
            body = { ...body, elements: JSON.parse(selectors) };
          } catch {
            toast.error(t("crawler.selectorJsonError"));
            setLoading(false);
            return;
          }
          break;
        case "json":
          body = { ...body, prompt: jsonPrompt };
          break;
        case "crawl":
          body = {
            ...body,
            depth: parseInt(maxDepth),
            limit: parseInt(limit),
            formats: ["markdown"],
            render: crawlRender,
          };
          break;
      }

      const response = await fetch(`/api/browser-rendering/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText);
      }

      if (endpoint === "screenshot") {
        const blob = await response.blob();
        setBinaryResult(URL.createObjectURL(blob));
      } else if (endpoint === "pdf") {
        const blob = await response.blob();
        setBinaryResult(URL.createObjectURL(blob));
      } else if (endpoint === "crawl") {
        // POST returns { jobId }, then we poll
        const { jobId, error } = await response.json();
        if (!jobId) throw new Error(error || "No jobId returned");
        toast.info(`Crawl 任務已啟動 (${jobId.slice(0, 8)}…)，輪詢結果中…`);
        await pollCrawlResults(jobId);
      } else {
        const data = await response.json();
        setResult(data);
        toast.success(t("crawler.executeSuccess"));
      }
    } catch (err) {
      toast.error(t("crawler.executeError", { message: (err as Error).message }));
    } finally {
      setLoading(false);
      setCrawlStatus(null);
      setCrawlProgress(null);
    }
  };

  const handleSaveToR2 = async () => {
    if (!result && !binaryResult) return;
    try {
      // Binary save (screenshot/pdf)
      if (binaryResult && (endpoint === "screenshot" || endpoint === "pdf")) {
        const resp = await fetch(binaryResult);
        const blob = await resp.blob();
        if (blob.size === 0) {
          toast.error("Binary data is empty — cannot save to R2");
          return;
        }
        // Convert blob to base64 using arrayBuffer for reliability
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binaryStr = "";
        // Process in chunks to avoid call stack overflow
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binaryStr += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binaryStr);

        const ext = endpoint === "screenshot" ? "png" : "pdf";
        const response = await fetch("/api/crawler/save-to-r2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: base64,
            binary: true,
            sourceUrl: url,
            contentType: endpoint === "screenshot" ? "image/png" : "application/pdf",
            filename: `${endpoint}_${Date.now()}.${ext}`,
          }),
        });
        const text = await response.text();
        let data: { success?: boolean; key?: string; error?: string };
        try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
        if (data.success) {
          toast.success(t("crawler.savedToR2", { key: data.key }));
        } else {
          toast.error(data.error || t("crawler.saveFailed"));
        }
        return;
      }
      // Text save
      const content = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const ext = endpoint === "markdown" ? "md" : endpoint === "content" ? "html" : "json";
      const response = await fetch("/api/crawler/save-to-r2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          sourceUrl: url,
          contentType: ext === "md" ? "text/markdown" : ext === "html" ? "text/html" : "application/json",
          filename: `${endpoint}_${Date.now()}.${ext}`,
        }),
      });
      const text = await response.text();
      let data: { success?: boolean; key?: string; error?: string };
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
      if (data.success) {
        toast.success(t("crawler.savedToR2", { key: data.key }));
      } else {
        toast.error(data.error || t("crawler.saveFailed"));
      }
    } catch (err) {
      toast.error(`儲存失敗: ${(err as Error).message}`);
    }
  };

  const renderEndpointOptions = () => {
    switch (endpoint) {
      case "screenshot":
        return (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={screenshotFullPage}
                onChange={(e) => setScreenshotFullPage(e.target.checked)}
                className="rounded"
              />
              {t("crawler.options.fullPageScreenshot")}
            </label>
          </div>
        );
      case "pdf":
        return (
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-sm">
              {t("crawler.options.paperFormat")}
              <select
                value={pdfFormat}
                onChange={(e) => setPdfFormat(e.target.value)}
                className="ml-2 rounded-md border px-2 py-1 text-sm"
              >
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
                <option value="legal">Legal</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pdfLandscape}
                onChange={(e) => setPdfLandscape(e.target.checked)}
                className="rounded"
              />
              {t("crawler.options.landscape")}
            </label>
          </div>
        );
      case "scrape":
        return (
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("crawler.options.cssSelectors")}</label>
            <Textarea
              value={selectors}
              onChange={(e) => setSelectors(e.target.value)}
              placeholder='[{"selector": "h1"}, {"selector": ".content p"}]'
              rows={3}
              className="font-mono text-xs"
            />
          </div>
        );
      case "json":
        return (
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("crawler.options.aiPrompt")}</label>
            <Input
              value={jsonPrompt}
              onChange={(e) => setJsonPrompt(e.target.value)}
              placeholder="Extract the main title and all product names"
            />
          </div>
        );
      case "crawl":
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("crawler.options.maxDepth")}</label>
                <Input type="number" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} min={1} max={10} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("crawler.options.pageLimit")}</label>
                <Input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} min={1} max={100} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={crawlRender} onChange={(e) => setCrawlRender(e.target.checked)} className="rounded" />
              <span>瀏覽器渲染（較慢，適合 SPA；關閉則用快速 HTML 擷取）</span>
            </label>
          </div>
        );
      default:
        return null;
    }
  };

  const renderResult = (): React.ReactNode => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{t("common.executing")}</p>
          {crawlStatus && (
            <div className="mt-3 flex flex-col items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {crawlStatus === "running" ? "🔄 爬取中…" : crawlStatus}
              </Badge>
              {crawlProgress && (
                <>
                  <p className="text-xs text-muted-foreground">
                    已完成 {crawlProgress.finished} / {crawlProgress.total} 頁
                  </p>
                  <div className="w-48 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${crawlProgress.total ? (crawlProgress.finished / crawlProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      );
    }

    if (binaryResult) {
      if (endpoint === "screenshot") {
        return (
          <div className="space-y-4">
            <div className="flex gap-2">
              <a href={binaryResult} download={`screenshot_${Date.now()}.png`}>
                <Button variant="outline" size="sm">
                  <Download className="size-4 mr-1.5" />
                  {t("crawler.options.downloadScreenshot")}
                </Button>
              </a>
              <Button variant="outline" size="sm" onClick={handleSaveToR2}>
                <Save className="size-4 mr-1.5" />
                {t("common.saveToR2")}
              </Button>
            </div>
            <img src={binaryResult} alt="Screenshot" className="w-full rounded-lg border shadow" />
          </div>
        );
      }
      if (endpoint === "pdf") {
        return (
          <div className="space-y-4">
            <div className="flex gap-2">
              <a href={binaryResult} download={`page_${Date.now()}.pdf`}>
                <Button variant="outline" size="sm">
                  <Download className="size-4 mr-1.5" />
                  {t("crawler.options.downloadPdf")}
                </Button>
              </a>
              <Button variant="outline" size="sm" onClick={handleSaveToR2}>
                <Save className="size-4 mr-1.5" />
                {t("common.saveToR2")}
              </Button>
            </div>
            <iframe src={binaryResult} className="h-[600px] w-full rounded-lg border" title="PDF Preview" />
          </div>
        );
      }
    }

    if (!result) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Icon className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-sm">{t("crawler.emptyState")}</p>
        </div>
      );
    }

    // Content (HTML) — syntax highlighted
    if (endpoint === "content") {
      const html = typeof result === "object" && result !== null && "result" in result
        ? String(result.result)
        : typeof result === "string" ? result : JSON.stringify(result);
      return (
        <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[600px] overflow-y-auto">
          <div className="absolute top-2 right-2"><CopyButton text={html} /></div>
          <HtmlHighlight html={html} />
        </div>
      );
    }

    if (endpoint === "markdown") {
      const md = typeof result === "object" && result !== null && "result" in result
        ? String(result.result)
        : typeof result === "string" ? result : JSON.stringify(result);
      return <MarkdownRenderer content={md} />;
    }

    // Snapshot — HTML highlighted + screenshot
    if (endpoint === "snapshot" && typeof result === "object" && result !== null) {
      return (
        <div className="space-y-4">
          {result.screenshot && (
            <div>
              <Badge variant="secondary" className="mb-2">Screenshot</Badge>
              <img src={`data:image/png;base64,${result.screenshot}`} alt="Snapshot" className="w-full rounded-lg border shadow" />
            </div>
          )}
          {(result.result || result.html) && (
            <div>
              <Badge variant="secondary" className="mb-2">HTML</Badge>
              <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[400px] overflow-y-auto">
                <div className="absolute top-2 right-2"><CopyButton text={String(result.result || result.html)} /></div>
                <HtmlHighlight html={String(result.result || result.html)} />
              </div>
            </div>
          )}
        </div>
      );
    }

    if (endpoint === "links" && Array.isArray(result)) {
      return (
        <div className="space-y-2">
          <Badge variant="secondary">{t("crawler.options.linksCount", { count: result.length })}</Badge>
          <div className="rounded-lg border divide-y max-h-[500px] overflow-y-auto">
            {result.map((link: { href?: string; text?: string }, i: number) => (
              <div key={i} className="px-3 py-2 text-sm">
                <div className="font-medium truncate">{link.text || t("crawler.options.noText")}</div>
                <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline truncate block">
                  {link.href}
                </a>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (endpoint === "crawl" && result) {
      const records: any[] = result.records || (Array.isArray(result) ? result : []);
      const jobStatus = result.status;
      const total = result.total ?? records.length;
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary">{t("crawler.options.pagesCount", { count: records.length })}</Badge>
            {jobStatus && <Badge variant={jobStatus === "completed" ? "default" : "destructive"} className={jobStatus !== "completed" ? "text-white" : ""}>{jobStatus}</Badge>}
            {total > records.length && <span className="text-xs text-muted-foreground">({total} total)</span>}
          </div>
          <div className="space-y-2">
            {records.map((page: any, i: number) => (
              <details key={i} className="rounded-lg border group" open={records.length <= 3}>
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-accent transition-colors flex items-center gap-2">
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                  <span className="truncate flex-1">{page.url || page.sourceURL || `Page ${i + 1}`}</span>
                  {page.status && (
                    <Badge variant={page.status === "completed" ? "secondary" : "destructive"} className="text-[10px] shrink-0 text-white">
                      {page.status}
                    </Badge>
                  )}
                </summary>
                <div className="border-t p-4">
                  {page.markdown ? (
                    <div className="relative">
                      <div className="absolute top-2 right-2 z-10"><CopyButton text={page.markdown} /></div>
                      <MarkdownRenderer content={page.markdown} />
                    </div>
                  ) : page.html ? (
                    <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[400px] overflow-y-auto">
                      <div className="absolute top-2 right-2"><CopyButton text={page.html} /></div>
                      <HtmlHighlight html={page.html} />
                    </div>
                  ) : (
                    <div className="relative">
                      <div className="absolute top-2 right-2"><CopyButton text={JSON.stringify(page, null, 2)} /></div>
                      <pre className="text-xs whitespace-pre-wrap break-all font-mono overflow-x-auto bg-muted rounded p-3">
                        {JSON.stringify(page, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      );
    }

    // Default: JSON syntax highlighted
    const jsonStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return (
      <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[600px] overflow-y-auto">
        <div className="absolute top-2 right-2"><CopyButton text={jsonStr} /></div>
        <JsonHighlight data={result} />
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 md:px-6 py-4 border-b shrink-0">
        <Button variant="ghost" size="icon" className="shrink-0" onClick={() => router.push("/crawler")}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="size-5 text-muted-foreground shrink-0" />
            <h1 className="text-xl font-bold truncate">{title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{desc}</p>
        </div>
      </div>

      {/* URL Input Bar — full width */}
      <div className="px-4 md:px-6 py-3 border-b shrink-0 space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1"
            onKeyDown={(e) => e.key === "Enter" && handleExecute()}
          />
          <Button onClick={handleExecute} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            <span className="hidden sm:inline ml-1">{t("common.execute")}</span>
          </Button>
        </div>
        {/* Preset URLs */}
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: "Cloudflare Docs", url: "https://developers.cloudflare.com" },
            { label: "Cloudflare Blog", url: "https://blog.cloudflare.com" },
            { label: "Hacker News", url: "https://news.ycombinator.com" },
            { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Cloudflare" },
            { label: "HTTP Bin", url: "https://httpbin.org" },
            { label: "Quotes to Scrape", url: "https://quotes.toscrape.com" },
            { label: "Books to Scrape", url: "https://books.toscrape.com" },
            { label: "Scrape This Site", url: "https://www.scrapethissite.com" },
          ].map((preset) => (
            <button
              key={preset.url}
              onClick={() => setUrl(preset.url)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
                url === preset.url
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 hover:bg-muted border-transparent"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {renderEndpointOptions()}
      </div>

      {/* Results — fills remaining space */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 md:px-6 py-2.5 border-b shrink-0">
          <span className="text-sm font-medium">{t("common.result")}</span>
          {(result || binaryResult) && !(endpoint === "screenshot" || endpoint === "pdf") && (
            <Button variant="outline" size="sm" onClick={handleSaveToR2}>
              <Save className="size-4 mr-1.5" />
              {t("common.saveToR2")}
            </Button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {renderResult()}
        </div>
      </div>
    </div>
  );
}
