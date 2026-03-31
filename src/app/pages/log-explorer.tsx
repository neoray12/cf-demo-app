'use client';

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  FileText,
  Loader2,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useLogExplorer } from "../contexts/log-explorer-context";

export function LogExplorerPage() {
  const { t } = useTranslation();
  const { selectedFile } = useLogExplorer();
  const [logContent, setLogContent] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Load file content when selectedFile changes (triggered from sidebar)
  useEffect(() => {
    if (!selectedFile) {
      setLogContent(null);
      return;
    }

    const loadContent = async () => {
      setLogLoading(true);
      setLogContent(null);
      try {
        const response = await fetch(
          `/api/logs/read?bucket=${encodeURIComponent(selectedFile.bucket)}&key=${encodeURIComponent(selectedFile.key)}`
        );
        const data = (await response.json()) as any;
        setLogContent(data.content || "");
      } catch (err) {
        toast.error(t("logs.readFileError", { message: (err as Error).message }));
      } finally {
        setLogLoading(false);
      }
    };

    loadContent();
  }, [selectedFile, t]);

  const renderLogContent = () => {
    if (!selectedFile) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
          <FileText className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-sm">{t("logs.selectFile")}</p>
        </div>
      );
    }

    if (logLoading) {
      return (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (!logContent) return null;

    // Try to parse as NDJSON
    const lines = logContent.split("\n").filter((l) => l.trim());
    const isJson = lines.some((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });

    const filteredLines = searchTerm
      ? lines.filter((l) =>
          l.toLowerCase().includes(searchTerm.toLowerCase())
        )
      : lines;

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("logs.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Badge variant="secondary">
            {t("logs.resultCount", { count: filteredLines.length })}
          </Badge>
        </div>

        <div className="space-y-1.5 max-h-[calc(100%-3rem)] overflow-y-auto">
          {filteredLines.map((line, i) => {
            if (isJson) {
              try {
                const parsed = JSON.parse(line);
                return (
                  <details
                    key={i}
                    className="rounded-lg border bg-card group"
                  >
                    <summary className="cursor-pointer px-3 py-2 text-xs font-mono flex items-center gap-2 hover:bg-accent transition-colors">
                      <ChevronRight className="size-3 shrink-0 group-open:rotate-90 transition-transform" />
                      <span className="text-muted-foreground">{i + 1}</span>
                      <span className="truncate">
                        {parsed.Timestamp || parsed.timestamp || parsed.EventTimestampMs
                          ? new Date(
                              parsed.Timestamp ||
                                parsed.timestamp ||
                                parsed.EventTimestampMs
                            ).toLocaleString()
                          : ""}
                      </span>
                      {parsed.ClientRequestMethod && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0"
                        >
                          {parsed.ClientRequestMethod}
                        </Badge>
                      )}
                      {parsed.ClientRequestURI && (
                        <span className="truncate text-muted-foreground">
                          {parsed.ClientRequestURI}
                        </span>
                      )}
                      {parsed.EdgeResponseStatus && (
                        <Badge
                          variant={
                            parsed.EdgeResponseStatus >= 400
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-[10px] px-1.5 py-0"
                        >
                          {parsed.EdgeResponseStatus}
                        </Badge>
                      )}
                    </summary>
                    <div className="border-t px-3 py-2 bg-muted/50">
                      <pre className="text-xs whitespace-pre-wrap break-all font-mono overflow-x-auto">
                        {JSON.stringify(parsed, null, 2)}
                      </pre>
                    </div>
                  </details>
                );
              } catch {
                // Fall through to raw display
              }
            }
            return (
              <div
                key={i}
                className="rounded border px-3 py-1.5 text-xs font-mono break-all"
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with file path */}
      <div className="flex items-center gap-2 p-3 border-b shrink-0">
        <FileText className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate">
          {selectedFile
            ? `${selectedFile.bucket}/${selectedFile.key}`
            : t("logs.title")}
        </span>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {renderLogContent()}
      </div>
    </div>
  );
}
