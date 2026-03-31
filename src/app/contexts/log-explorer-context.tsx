'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export interface TreeNode {
  name: string;
  fullPath: string;
  type: "bucket" | "folder" | "file";
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
  size?: number;
  lastModified?: string;
}

interface BucketInfo {
  name: string;
  creation_date: string;
}

interface FileInfo {
  key: string;
  lastModified: string;
  size: number;
}

interface LogExplorerContextType {
  buckets: TreeNode[];
  loading: boolean;
  loadingPath: string | null;
  selectedFile: { bucket: string; key: string } | null;
  datasetMap: Record<string, string>;
  loadBuckets: () => Promise<void>;
  toggleNode: (nodePath: string[], bucketName?: string) => Promise<void>;
  selectFile: (bucket: string, key: string) => void;
}

const LogExplorerContext = createContext<LogExplorerContextType | null>(null);

export function useLogExplorer() {
  const ctx = useContext(LogExplorerContext);
  if (!ctx) throw new Error("useLogExplorer must be used within LogExplorerProvider");
  return ctx;
}

export function LogExplorerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [buckets, setBuckets] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    bucket: string;
    key: string;
  } | null>(null);
  const [datasetMap, setDatasetMap] = useState<Record<string, string>>({});

  const loadBuckets = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/logs/buckets");
      const data = (await response.json()) as any;

      // Fetch logpush jobs in parallel to get dataset labels
      const logpushPromise = fetch("/api/logs/logpush-jobs")
        .then((r) => r.json() as Promise<{ map?: Record<string, string> }>)
        .then((d) => d.map ?? {})
        .catch(() => ({} as Record<string, string>));

      if (data.result?.buckets) {
        const dsMap = await logpushPromise;
        setDatasetMap(dsMap);
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
      toast.error(t("logs.loadBucketError", { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  const toggleNode = useCallback(async (nodePath: string[], bucketName?: string) => {
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

    setBuckets((prev) => {
      const targetNode = findNode(prev, nodePath, 0);

      if (targetNode && !targetNode.loaded && targetNode.type !== "file") {
        const bucket = bucketName || nodePath[0]!;
        const prefix = targetNode.type === "bucket" ? "" : targetNode.fullPath;

        setLoadingPath(targetNode.fullPath);

        loadChildren(bucket, prefix)
          .then((children) => {
            setBuckets((current) => {
              const updateWithChildren = (
                nodes: TreeNode[],
                path: string[],
                depth: number
              ): TreeNode[] => {
                return nodes.map((node) => {
                  if (node.name === path[depth]) {
                    if (depth === path.length - 1) {
                      return { ...node, children, loaded: true, expanded: true };
                    }
                    return {
                      ...node,
                      children: updateWithChildren(node.children || [], path, depth + 1),
                    };
                  }
                  return node;
                });
              };
              return updateWithChildren(current, nodePath, 0);
            });
          })
          .catch((err) => {
            toast.error(t("logs.loadError", { message: (err as Error).message }));
          })
          .finally(() => {
            setLoadingPath(null);
          });

        return prev; // Return unchanged, async update will handle it
      }

      return updateTree(prev, nodePath, 0);
    });
  }, [t]);

  const selectFile = useCallback((bucket: string, key: string) => {
    setSelectedFile({ bucket, key });
  }, []);

  return (
    <LogExplorerContext.Provider
      value={{ buckets, loading, loadingPath, selectedFile, datasetMap, loadBuckets, toggleNode, selectFile }}
    >
      {children}
    </LogExplorerContext.Provider>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
