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
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

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

  // Endpoint-specific state
  const [selectors, setSelectors] = useState('[{"selector": "h1"}, {"selector": "p"}]');
  const [jsonPrompt, setJsonPrompt] = useState("Extract the main title and description");
  const [maxDepth, setMaxDepth] = useState("2");
  const [limit, setLimit] = useState("5");
  const [screenshotFullPage, setScreenshotFullPage] = useState(true);
  const [pdfFormat, setPdfFormat] = useState("A4");
  const [pdfLandscape, setPdfLandscape] = useState(false);

  const handleExecute = async () => {
    if (!url.trim()) {
      toast.error(t("crawler.enterUrl"));
      return;
    }
    setLoading(true);
    setResult(null);
    setBinaryResult(null);

    try {
      let body: Record<string, unknown> = { url: url.trim() };

      switch (endpoint) {
        case "screenshot":
          body = { ...body, screenshotOptions: { fullPage: screenshotFullPage } };
          break;
        case "pdf":
          body = { ...body, pdfOptions: { format: pdfFormat, landscape: pdfLandscape, printBackground: true } };
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
            maxDepth: parseInt(maxDepth),
            limit: parseInt(limit),
            scrapeOptions: { formats: ["markdown"] },
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
      } else {
        const data = await response.json();
        setResult(data);
      }
      toast.success(t("crawler.executeSuccess"));
    } catch (err) {
      toast.error(t("crawler.executeError", { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveToR2 = async () => {
    if (!result) return;
    try {
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
      const data = (await response.json()) as { success?: boolean; key?: string };
      if (data.success) {
        toast.success(t("crawler.savedToR2", { key: data.key }));
      } else {
        toast.error(t("crawler.saveFailed"));
      }
    } catch (err) {
      toast.error(t("crawler.saveFailedWithError", { message: (err as Error).message }));
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
                <option value="A4">A4</option>
                <option value="Letter">Letter</option>
                <option value="Legal">Legal</option>
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
        </div>
      );
    }

    if (binaryResult) {
      if (endpoint === "screenshot") {
        return (
          <div className="space-y-4">
            <img src={binaryResult} alt="Screenshot" className="w-full rounded-lg border shadow" />
            <a href={binaryResult} download={`screenshot_${Date.now()}.png`}>
              <Button variant="outline" size="sm">
                <Download className="size-4 mr-2" />
                {t("crawler.options.downloadScreenshot")}
              </Button>
            </a>
          </div>
        );
      }
      if (endpoint === "pdf") {
        return (
          <div className="space-y-4">
            <iframe src={binaryResult} className="h-[600px] w-full rounded-lg border" title="PDF Preview" />
            <a href={binaryResult} download={`page_${Date.now()}.pdf`}>
              <Button variant="outline" size="sm">
                <Download className="size-4 mr-2" />
                {t("crawler.options.downloadPdf")}
              </Button>
            </a>
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

    if (endpoint === "markdown") {
      const md = typeof result === "object" && result !== null && "result" in result
        ? String(result.result)
        : typeof result === "string" ? result : JSON.stringify(result);
      return <MarkdownRenderer content={md} />;
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
      const pages = Array.isArray(result) ? result : result.data || result.results || [result];
      return (
        <div className="space-y-3">
          <Badge variant="secondary">{t("crawler.options.pagesCount", { count: Array.isArray(pages) ? pages.length : 1 })}</Badge>
          <div className="space-y-2">
            {(Array.isArray(pages) ? pages : [pages]).map((page: any, i: number) => (
              <details key={i} className="rounded-lg border group">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-accent transition-colors flex items-center gap-2">
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                  <span className="truncate">{page.url || page.sourceURL || `Page ${i + 1}`}</span>
                </summary>
                <div className="border-t p-4">
                  {page.markdown ? (
                    <MarkdownRenderer content={page.markdown} />
                  ) : (
                    <pre className="text-xs whitespace-pre-wrap break-all font-mono overflow-x-auto bg-muted rounded p-3">
                      {JSON.stringify(page, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-lg bg-muted p-4 overflow-x-auto">
        <pre className="text-xs whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(result, null, 2)}
        </pre>
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
        <div>
          <div className="flex items-center gap-2">
            <Icon className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-bold">{title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{desc}</p>
        </div>
      </div>

      {/* Two-column layout on desktop */}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-0">
        {/* Left: Input + Options */}
        <div className="md:w-[38%] md:border-r flex flex-col shrink-0">
          <div className="p-4 md:p-5 flex flex-col gap-4 overflow-y-auto">
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
            {renderEndpointOptions()}
          </div>
        </div>

        {/* Right: Results */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-5 py-3 border-b shrink-0">
            <span className="text-sm font-medium">{t("common.result")}</span>
            {result && !binaryResult && (
              <Button variant="outline" size="sm" onClick={handleSaveToR2}>
                <Save className="size-4 mr-1.5" />
                {t("common.saveToR2")}
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-5">
            {renderResult()}
          </div>
        </div>
      </div>
    </div>
  );
}
