import { useNavigate } from "react-router";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useTranslation } from "react-i18next";

const features = [
  { id: "screenshot", icon: Camera, color: "text-rose-500" },
  { id: "pdf", icon: FileDown, color: "text-cyan-500" },
  { id: "markdown", icon: ScanText, color: "text-emerald-500" },
  { id: "content", icon: Code, color: "text-violet-500" },
  { id: "snapshot", icon: Image, color: "text-amber-500" },
  { id: "scrape", icon: Search, color: "text-blue-500" },
  { id: "json", icon: Braces, color: "text-orange-500" },
  { id: "links", icon: Link2, color: "text-teal-500" },
  { id: "crawl", icon: Globe2, color: "text-purple-500" },
];

export function CrawlerPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t("crawler.title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("crawler.description")}
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
              <CardTitle className="text-base">{t(`crawler.endpoints.${f.id}.title`)}</CardTitle>
              <CardDescription className="text-xs">{t(`crawler.endpoints.${f.id}.desc`)}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
