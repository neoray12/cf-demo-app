import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  Database,
  Loader2,
  Search,
  Key,
  Eye,
  EyeOff,
  RefreshCw,
  FileArchive,
} from "lucide-react";
import { toast } from "sonner";

interface BucketInfo {
  name: string;
  creation_date: string;
}

interface FileInfo {
  key: string;
  lastModified: string;
  size: number;
}

interface TreeNode {
  name: string;
  fullPath: string;
  type: "bucket" | "folder" | "file";
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
  size?: number;
  lastModified?: string;
}

export function LogExplorerPage() {
  const [buckets, setBuckets] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    bucket: string;
    key: string;
  } | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [decryptKey, setDecryptKey] = useState("");
  const [showDecryptKey, setShowDecryptKey] = useState(false);

  const loadBuckets = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/logs/buckets");
      const data = (await response.json()) as any;

      if (data.result?.buckets) {
        setBuckets(
          data.result.buckets.map((b: BucketInfo) => ({
            name: b.name,
            fullPath: b.name,
            type: "bucket" as const,
            children: [],
            expanded: false,
            loaded: false,
          }))
        );
      }
    } catch (err) {
      toast.error(`載入 bucket 列表失敗: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBuckets();
  }, [loadBuckets]);

  const loadChildren = async (
    bucket: string,
    prefix: string
  ): Promise<TreeNode[]> => {
    const response = await fetch(
      `/api/logs/list?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`
    );
    const data = (await response.json()) as any;

    const nodes: TreeNode[] = [];

    // Folders
    if (data.folders) {
      for (const folder of data.folders as string[]) {
        const name = folder
          .replace(prefix, "")
          .replace(/\/$/, "");
        if (name) {
          nodes.push({
            name,
            fullPath: folder,
            type: "folder",
            children: [],
            expanded: false,
            loaded: false,
          });
        }
      }
    }

    // Files
    if (data.files) {
      for (const file of data.files as FileInfo[]) {
        const name = file.key.replace(prefix, "");
        if (name) {
          nodes.push({
            name,
            fullPath: file.key,
            type: "file",
            size: file.size,
            lastModified: file.lastModified,
          });
        }
      }
    }

    return nodes;
  };

  const toggleNode = async (nodePath: string[], bucketName?: string) => {
    const updateTree = (
      nodes: TreeNode[],
      path: string[],
      depth: number
    ): TreeNode[] => {
      return nodes.map((node) => {
        if (node.name === path[depth]) {
          if (depth === path.length - 1) {
            return { ...node, expanded: !node.expanded };
          }
          return {
            ...node,
            children: updateTree(node.children || [], path, depth + 1),
          };
        }
        return node;
      });
    };

    // Find the target node to check if it needs loading
    const findNode = (nodes: TreeNode[], path: string[], depth: number): TreeNode | null => {
      for (const node of nodes) {
        if (node.name === path[depth]) {
          if (depth === path.length - 1) return node;
          return findNode(node.children || [], path, depth + 1);
        }
      }
      return null;
    };

    const targetNode = findNode(buckets, nodePath, 0);

    if (targetNode && !targetNode.loaded && targetNode.type !== "file") {
      const bucket = bucketName || nodePath[0]!;
      const prefix = targetNode.type === "bucket" ? "" : targetNode.fullPath;

      setLoadingPath(targetNode.fullPath);
      try {
        const children = await loadChildren(bucket, prefix);

        const updateWithChildren = (
          nodes: TreeNode[],
          path: string[],
          depth: number
        ): TreeNode[] => {
          return nodes.map((node) => {
            if (node.name === path[depth]) {
              if (depth === path.length - 1) {
                return {
                  ...node,
                  children,
                  loaded: true,
                  expanded: true,
                };
              }
              return {
                ...node,
                children: updateWithChildren(
                  node.children || [],
                  path,
                  depth + 1
                ),
              };
            }
            return node;
          });
        };

        setBuckets((prev) => updateWithChildren(prev, nodePath, 0));
      } catch (err) {
        toast.error(`載入失敗: ${(err as Error).message}`);
      } finally {
        setLoadingPath(null);
      }
    } else {
      setBuckets((prev) => updateTree(prev, nodePath, 0));
    }
  };

  const handleFileClick = async (bucket: string, key: string) => {
    setSelectedFile({ bucket, key });
    setLogLoading(true);
    setLogContent(null);

    try {
      const response = await fetch(
        `/api/logs/read?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`
      );
      const data = (await response.json()) as any;
      setLogContent(data.content || "");
    } catch (err) {
      toast.error(`讀取檔案失敗: ${(err as Error).message}`);
    } finally {
      setLogLoading(false);
    }
  };

  const renderTree = (
    nodes: TreeNode[],
    depth: number = 0,
    parentPath: string[] = [],
    bucketName?: string
  ) => {
    return nodes.map((node) => {
      const currentPath = [...parentPath, node.name];
      const currentBucket = bucketName || node.name;
      const isLoading = loadingPath === node.fullPath;

      return (
        <div key={node.fullPath} style={{ paddingLeft: depth * 16 }}>
          <button
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors ${
              selectedFile?.key === node.fullPath
                ? "bg-accent text-accent-foreground"
                : ""
            }`}
            onClick={() => {
              if (node.type === "file") {
                handleFileClick(currentBucket, node.fullPath);
              } else {
                toggleNode(currentPath, currentBucket);
              }
            }}
          >
            {node.type === "file" ? (
              <div className="w-4" />
            ) : isLoading ? (
              <Loader2 className="size-4 animate-spin shrink-0" />
            ) : node.expanded ? (
              <ChevronDown className="size-4 shrink-0" />
            ) : (
              <ChevronRight className="size-4 shrink-0" />
            )}

            {node.type === "bucket" ? (
              <Database className="size-4 shrink-0 text-blue-500" />
            ) : node.type === "folder" ? (
              node.expanded ? (
                <FolderOpen className="size-4 shrink-0 text-yellow-500" />
              ) : (
                <Folder className="size-4 shrink-0 text-yellow-500" />
              )
            ) : node.name.endsWith(".gz") ? (
              <FileArchive className="size-4 shrink-0 text-orange-500" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}

            <span className="flex-1 text-left break-all leading-tight" title={node.name}>{node.name}</span>

            {node.size !== undefined && (
              <span className="text-xs text-muted-foreground shrink-0">
                {formatSize(node.size)}
              </span>
            )}
          </button>

          {node.expanded && node.children && (
            <div>
              {renderTree(
                node.children,
                depth + 1,
                currentPath,
                currentBucket
              )}
              {node.children.length === 0 && node.loaded && (
                <div
                  className="px-2 py-1.5 text-xs text-muted-foreground"
                  style={{ paddingLeft: (depth + 1) * 16 + 8 }}
                >
                  (空)
                </div>
              )}
            </div>
          )}
        </div>
      );
    });
  };

  const renderLogContent = () => {
    if (!selectedFile) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
          <FileText className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-sm">選擇一個檔案以查看內容</p>
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
              placeholder="搜尋 log 內容..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Badge variant="secondary">
            {filteredLines.length} 筆
          </Badge>
        </div>

        <div className="space-y-1.5 max-h-[calc(100svh-300px)] overflow-y-auto">
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
    <div className="flex h-[calc(100svh-3.5rem)] flex-col md:flex-row">
      {/* Left panel: Tree navigation */}
      <div className="w-full md:w-96 border-b md:border-b-0 md:border-r flex flex-col shrink-0">
        <div className="flex items-center justify-between p-3 border-b">
          <h2 className="text-sm font-semibold">R2 Buckets</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={loadBuckets}
            disabled={loading}
          >
            <RefreshCw
              className={`size-4 ${loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2">
            {loading && buckets.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              renderTree(buckets)
            )}
          </div>
        </ScrollArea>

        {/* Decrypt key input */}
        <div className="border-t p-3">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            <Key className="size-3 inline mr-1" />
            AI Gateway 解密金鑰
          </label>
          <div className="relative">
            <Input
              type={showDecryptKey ? "text" : "password"}
              placeholder="輸入 private key..."
              value={decryptKey}
              onChange={(e) => setDecryptKey(e.target.value)}
              className="text-xs pr-8"
            />
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              onClick={() => setShowDecryptKey(!showDecryptKey)}
            >
              {showDecryptKey ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Right panel: Log content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 p-3 border-b">
          <FileText className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {selectedFile
              ? `${selectedFile.bucket}/${selectedFile.key}`
              : "Log 瀏覽器"}
          </span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {renderLogContent()}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
