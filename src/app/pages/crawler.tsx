import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import {
  Loader2,
  Play,
  Download,
  Save,
  Image,
  FileText,
  Code,
  Link2,
  Globe,
  Search,
  Braces,
  Camera,
  ScanText,
} from "lucide-react";
import { toast } from "sonner";

type EndpointId =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

const endpoints = [
  { id: "content" as const, label: "Content", icon: Code },
  { id: "screenshot" as const, label: "Screenshot", icon: Camera },
  { id: "pdf" as const, label: "PDF", icon: FileText },
  { id: "markdown" as const, label: "Markdown", icon: ScanText },
  { id: "snapshot" as const, label: "Snapshot", icon: Image },
  { id: "scrape" as const, label: "Scrape", icon: Search },
  { id: "json" as const, label: "JSON", icon: Braces },
  { id: "links" as const, label: "Links", icon: Link2 },
  { id: "crawl" as const, label: "Crawl", icon: Globe },
];

export function CrawlerPage() {
  const [activeTab, setActiveTab] = useState<EndpointId>("content");
  const [url, setUrl] = useState("https://developers.cloudflare.com");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [binaryResult, setBinaryResult] = useState<string | null>(null);

  // Scrape-specific
  const [selectors, setSelectors] = useState('[{"selector": "h1"}, {"selector": "p"}]');
  // JSON-specific
  const [jsonPrompt, setJsonPrompt] = useState("Extract the main title and description");
  // Crawl-specific
  const [maxDepth, setMaxDepth] = useState("2");
  const [limit, setLimit] = useState("5");

  const handleExecute = async () => {
    if (!url.trim()) {
      toast.error("請輸入 URL");
      return;
    }

    setLoading(true);
    setResult(null);
    setBinaryResult(null);

    try {
      let body: Record<string, unknown> = { url: url.trim() };

      switch (activeTab) {
        case "screenshot":
          body = { ...body, screenshotOptions: { fullPage: true } };
          break;
        case "pdf":
          body = { ...body, pdfOptions: { format: "A4", printBackground: true } };
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

      const response = await fetch(`/api/browser-rendering/${activeTab}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText);
      }

      if (activeTab === "screenshot") {
        const blob = await response.blob();
        const dataUrl = URL.createObjectURL(blob);
        setBinaryResult(dataUrl);
      } else if (activeTab === "pdf") {
        const blob = await response.blob();
        const dataUrl = URL.createObjectURL(blob);
        setBinaryResult(dataUrl);
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
      const content =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const ext = activeTab === "markdown" ? "md" : activeTab === "content" ? "html" : "json";

      const response = await fetch("/api/crawler/save-to-r2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          sourceUrl: url,
          contentType: ext === "md" ? "text/markdown" : ext === "html" ? "text/html" : "application/json",
          filename: `${activeTab}_${Date.now()}.${ext}`,
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

  const renderResult = (): React.ReactNode => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">執行中...</p>
        </div>
      );
    }

    if (binaryResult) {
      if (activeTab === "screenshot") {
        return (
          <div className="space-y-4">
            <img
              src={binaryResult}
              alt="Screenshot"
              className="w-full rounded-lg border shadow"
            />
            <a href={binaryResult} download={`screenshot_${Date.now()}.png`}>
              <Button variant="outline" size="sm">
                <Download className="size-4 mr-2" />
                下載截圖
              </Button>
            </a>
          </div>
        );
      }
      if (activeTab === "pdf") {
        return (
          <div className="space-y-4">
            <iframe
              src={binaryResult}
              className="h-[600px] w-full rounded-lg border"
              title="PDF Preview"
            />
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
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Globe className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-sm">輸入 URL 並執行以查看結果</p>
        </div>
      );
    }

    // Markdown endpoint
    if (activeTab === "markdown") {
      const md = typeof result === "object" && result !== null && "result" in result
        ? String((result as { result: unknown }).result)
        : typeof result === "string" ? result : JSON.stringify(result);
      return <MarkdownRenderer content={md} />;
    }

    // Links endpoint
    if (activeTab === "links" && Array.isArray(result)) {
      return (
        <div className="space-y-2">
          <Badge variant="secondary">{result.length} 個連結</Badge>
          <div className="rounded-lg border divide-y max-h-[500px] overflow-y-auto">
            {result.map((link: { href?: string; text?: string }, i: number) => (
              <div key={i} className="px-3 py-2 text-sm">
                <div className="font-medium truncate">{link.text || "(無文字)"}</div>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline truncate block"
                >
                  {link.href}
                </a>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Default: JSON view
    return (
      <div className="rounded-lg bg-muted p-4 overflow-x-auto">
        <pre className="text-xs whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(result, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">網站爬蟲</h1>
        <p className="text-sm text-muted-foreground mt-1">
          使用 Cloudflare Browser Rendering 的所有端點
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as EndpointId)}>
        <div className="overflow-x-auto pb-2">
          <TabsList className="w-max">
            {endpoints.map((ep) => (
              <TabsTrigger key={ep.id} value={ep.id} className="gap-1.5 text-xs">
                <ep.icon className="size-3.5" />
                <span className="hidden sm:inline">{ep.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <Card className="mt-4">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">
              {endpoints.find((e) => e.id === activeTab)?.label}
            </CardTitle>
            <CardDescription>
              {activeTab === "content" && "取得網頁的 HTML 原始碼"}
              {activeTab === "screenshot" && "擷取網頁完整截圖"}
              {activeTab === "pdf" && "將網頁轉換為 PDF 文件"}
              {activeTab === "markdown" && "將網頁內容轉為 Markdown 格式"}
              {activeTab === "snapshot" && "同時取得 HTML 內容和截圖"}
              {activeTab === "scrape" && "使用 CSS 選取器提取特定元素"}
              {activeTab === "json" && "使用 AI 將網頁轉為結構化 JSON"}
              {activeTab === "links" && "提取網頁中的所有連結"}
              {activeTab === "crawl" && "按深度爬取整個網站"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* URL Input */}
            <div className="flex gap-2">
              <Input
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1"
              />
              <Button onClick={handleExecute} disabled={loading}>
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                <span className="hidden sm:inline ml-1">執行</span>
              </Button>
            </div>

            {/* Endpoint-specific inputs */}
            {activeTab === "scrape" && (
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
            )}

            {activeTab === "json" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">AI 提取指令</label>
                <Input
                  value={jsonPrompt}
                  onChange={(e) => setJsonPrompt(e.target.value)}
                  placeholder="Extract the main title and all product names"
                />
              </div>
            )}

            {activeTab === "crawl" && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">最大深度</label>
                  <Input
                    type="number"
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(e.target.value)}
                    min={1}
                    max={10}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">頁面上限</label>
                  <Input
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                    min={1}
                    max={100}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        <Card className="mt-4">
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
      </Tabs>
    </div>
  );
}
