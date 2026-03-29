import { useNavigate } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Camera,
  FileDown,
  ScanText,
  Code,
  Image,
  Search,
  Braces,
  Link2,
  Globe2,
} from "lucide-react";

const features = [
  { id: "screenshot", title: "截圖", desc: "擷取網頁完整或部分截圖", icon: Camera, color: "text-rose-500" },
  { id: "pdf", title: "PDF 轉換", desc: "將網頁轉換為 PDF 文件", icon: FileDown, color: "text-cyan-500" },
  { id: "markdown", title: "Markdown 擷取", desc: "將 HTML 轉換為 Markdown 格式", icon: ScanText, color: "text-emerald-500" },
  { id: "content", title: "HTML 內容", desc: "取得網頁的 HTML 原始碼", icon: Code, color: "text-violet-500" },
  { id: "snapshot", title: "快照", desc: "同時取得 HTML 內容與截圖", icon: Image, color: "text-amber-500" },
  { id: "scrape", title: "元素提取", desc: "使用 CSS 選取器提取特定元素", icon: Search, color: "text-blue-500" },
  { id: "json", title: "JSON 結構化", desc: "用 AI 將網頁轉為結構化 JSON", icon: Braces, color: "text-orange-500" },
  { id: "links", title: "連結抓取", desc: "提取網頁中所有超連結", icon: Link2, color: "text-teal-500" },
  { id: "crawl", title: "整站爬取", desc: "按深度爬取整個網站所有頁面", icon: Globe2, color: "text-purple-500" },
];

export function CrawlerPage() {
  const navigate = useNavigate();

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">網站爬蟲</h1>
        <p className="text-sm text-muted-foreground mt-1">
          選擇一個功能來開始使用 Cloudflare Browser Rendering API
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <Card
            key={f.id}
            className="cursor-pointer transition-all hover:shadow-md hover:border-primary/30 group"
            onClick={() => navigate(`/crawler/${f.id}`)}
          >
            <CardHeader className="pb-3">
              <div className={`mb-2 ${f.color}`}>
                <f.icon className="size-8 transition-transform group-hover:scale-110" />
              </div>
              <CardTitle className="text-base">{f.title}</CardTitle>
              <CardDescription className="text-xs">{f.desc}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
