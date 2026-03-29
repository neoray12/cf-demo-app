import React, { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const endpointMeta: Record<string, { title: string; desc: string; icon: React.ElementType }> = {
  content: { title: "HTML 內容", desc: "取得網頁的 HTML 原始碼", icon: Code },
  screenshot: { title: "截圖", desc: "擷取網頁完整或部分截圖", icon: Camera },
  pdf: { title: "PDF 轉換", desc: "將網頁轉換為 PDF 文件", icon: FileDown },
  markdown: { title: "Markdown 擷取", desc: "將 HTML 轉換為 Markdown 格式", icon: ScanText },
  snapshot: { title: "快照", desc: "同時取得 HTML 內容與截圖", icon: Image },
  scrape: { title: "元素提取", desc: "使用 CSS 選取器提取特定元素", icon: Search },
  json: { title: "JSON 結構化", desc: "用 AI 將網頁轉為結構化 JSON", icon: Braces },
  links: { title: "連結抓取", desc: "提取網頁中所有超連結", icon: Link2 },
  crawl: { title: "整站爬取", desc: "按深度爬取整個網站所有頁面", icon: Globe2 },
};

export function CrawlerEndpointPage() {
  const { endpoint } = useParams<{ endpoint: string }>();
  const navigate = useNavigate();
  const meta = endpointMeta[endpoint || ""] || { title: "未知", desc: "", icon: Globe };

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
      toast.error("請輸入網址");
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
            toast.error("CSS 選取器 JSON 格式錯誤");
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
      toast.success("執行成功");
    } catch (err) {
      toast.error(`執行失敗: ${(err as Error).message}`);
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
        toast.success(`已儲存至 R2: ${data.key}`);
      } else {
        toast.error("儲存失敗");
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
              全頁截圖
            </label>
          </div>
        );
      case "pdf":
        return (
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-sm">
              紙張格式：
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
              橫向列印
            </label>
          </div>
        );
      case "scrape":
        return (
          <div className="space-y-2">
            <label className="text-sm font-medium">CSS 選取器 (JSON 陣列)</label>
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
            <label className="text-sm font-medium">AI 提取指令</label>
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
              <label className="text-sm font-medium">最大深度</label>
              <Input type="number" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} min={1} max={10} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">頁面上限</label>
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
          <p className="mt-4 text-sm text-muted-foreground">執行中...</p>
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
                下載截圖
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
                下載 PDF
              </Button>
            </a>
          </div>
        );
      }
    }

    if (!result) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <meta.icon className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-sm">輸入網址並點擊「執行」以查看結果</p>
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
          <Badge variant="secondary">{result.length} 個連結</Badge>
          <div className="rounded-lg border divide-y max-h-[500px] overflow-y-auto">
            {result.map((link: { href?: string; text?: string }, i: number) => (
              <div key={i} className="px-3 py-2 text-sm">
                <div className="font-medium truncate">{link.text || "(無文字)"}</div>
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
          <Badge variant="secondary">{Array.isArray(pages) ? pages.length : 1} 頁</Badge>
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

  const Icon = meta.icon;
  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate("/crawler")}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <Icon className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-bold">{meta.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{meta.desc}</p>
        </div>
      </div>

      {/* URL Input + Options */}
      <Card className="mb-4">
        <CardContent className="pt-6 space-y-4">
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
              <span className="hidden sm:inline ml-1">執行</span>
            </Button>
          </div>
          {renderEndpointOptions()}
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">結果</CardTitle>
            {result && !binaryResult && (
              <Button variant="outline" size="sm" onClick={handleSaveToR2}>
                <Save className="size-4 mr-1.5" />
                存入 R2
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>{renderResult()}</CardContent>
      </Card>
    </div>
  );
}

