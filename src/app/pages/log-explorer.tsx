'use client';

import React, { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronRight,
  FileText,
  Loader2,
  Search,
  Copy,
  Check,
  ImageIcon,
  AlertCircle,
  KeyRound,
  Lock,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useLogExplorer } from "../contexts/log-explorer-context";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";

// ── Helper components ──

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`size-7 shrink-0 ${className ?? ""}`}
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

function JsonHighlight({ data }: { data: unknown }) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const coloured = json
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"([^"]+)"(?=\s*:)/g, '<span class="text-purple-600 dark:text-purple-400">"$1"</span>')
    .replace(/:\s*"([^"]*)"/g, ': <span class="text-green-600 dark:text-green-400">"$1"</span>')
    .replace(/:\s*(\d+(\.\d+)?)/g, ': <span class="text-blue-600 dark:text-blue-400">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="text-orange-600 dark:text-orange-400">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="text-red-500">$1</span>');
  return (
    <pre
      className="text-xs whitespace-pre-wrap break-all font-mono leading-relaxed"
      dangerouslySetInnerHTML={{ __html: coloured }}
    />
  );
}

function HtmlHighlight({ html }: { html: string }) {
  const coloured = html
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;(\/?[\w-]+)/g, '&lt;<span class="text-red-600 dark:text-red-400">$1</span>')
    .replace(/([\w-]+)=(&quot;|")/g, '<span class="text-purple-600 dark:text-purple-400">$1</span>=<span class="text-green-600 dark:text-green-400">&quot;')
    .replace(/(&quot;|")([\s>])/g, '&quot;</span>$2');
  return (
    <pre
      className="text-xs whitespace-pre-wrap break-all font-mono leading-relaxed"
      dangerouslySetInnerHTML={{ __html: coloured }}
    />
  );
}

// ── Decrypt utilities (browser Web Crypto API) ──

const PEM_STORAGE_KEY = "cf-demo-log-private-key";

const AI_GATEWAY_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
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
P0+dJHAmzN9BVABqvMZpwLuECwPV
-----END PRIVATE KEY-----`;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [\w\s]+-----/, "")
    .replace(/-----END [\w\s]+-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8", der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false, ["decrypt"]
  );
}

async function decryptAIGatewayField(
  field: { type: string; data: string; key: string; iv: string },
  privateKey: CryptoKey
): Promise<unknown> {
  // 1. RSA-OAEP decrypt the AES key
  const encAesKey = Uint8Array.from(atob(field.key), (c) => c.charCodeAt(0));
  const aesKeyBuf = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encAesKey);

  // 2. Import AES key
  const aesKey = await crypto.subtle.importKey("raw", aesKeyBuf, "AES-GCM", false, ["decrypt"]);

  // 3. AES-GCM decrypt (last 16 bytes = auth tag, included by WebCrypto automatically)
  const iv = Uint8Array.from(atob(field.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(field.data), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  const text = new TextDecoder().decode(plain);

  try { return JSON.parse(text); } catch { return text; }
}

function isEncryptedField(v: unknown): v is { type: "encrypted"; data: string; key: string; iv: string } {
  return !!v && typeof v === "object" && (v as any).type === "encrypted" && !!(v as any).key && !!(v as any).iv;
}

function hasEncryptedFields(entry: Record<string, unknown>): boolean {
  // AI Gateway: RequestBody, ResponseBody, Metadata with type=encrypted
  for (const k of ["RequestBody", "ResponseBody", "Metadata"]) {
    if (isEncryptedField(entry[k])) return true;
  }
  // DLP: long Payload string
  if (typeof entry.Payload === "string" && entry.Payload.length > 200) return true;
  return false;
}

async function decryptEntry(entry: Record<string, unknown>, privateKey: CryptoKey): Promise<Record<string, unknown>> {
  const result = { ...entry };

  // AI Gateway encrypted fields
  for (const k of ["RequestBody", "ResponseBody", "Metadata"]) {
    if (isEncryptedField(entry[k])) {
      try {
        result[k] = await decryptAIGatewayField(entry[k] as any, privateKey);
      } catch (err) {
        result[k] = { _decryptError: (err as Error).message, _original: entry[k] };
      }
    }
  }

  // DLP Payload (base64, possibly gzipped)
  if (typeof entry.Payload === "string" && entry.Payload.length > 200) {
    try {
      const raw = Uint8Array.from(atob(entry.Payload), (c) => c.charCodeAt(0));
      let text: string;
      // Only attempt gzip if magic bytes match (0x1f 0x8b)
      if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        try {
          const ds = new DecompressionStream("gzip");
          const w = ds.writable.getWriter();
          w.write(raw); w.close();
          text = await new Response(ds.readable).text();
        } catch {
          text = new TextDecoder().decode(raw);
        }
      } else {
        text = new TextDecoder().decode(raw);
      }
      try { result.Payload = JSON.parse(text); } catch { result.Payload = text; }
    } catch (err) {
      result.Payload = { _decryptError: (err as Error).message, _original: entry.Payload };
    }
  }

  return result;
}

// ── File payload type ──

interface FilePayload {
  content?: string;
  base64?: string;
  contentType?: string;
  compressed?: boolean;
  error?: string;
}

// ── Main component ──

export function LogExplorerPage() {
  const { t } = useTranslation();
  const { selectedFile } = useLogExplorer();
  const [payload, setPayload] = useState<FilePayload | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Decrypt state
  const [decryptedEntries, setDecryptedEntries] = useState<Record<number, Record<string, unknown>>>({});
  const [decryptingIdx, setDecryptingIdx] = useState<number | null>(null);
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [pendingDecryptIdx, setPendingDecryptIdx] = useState<number | null>(null);
  const [keyInput, setKeyInput] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem(PEM_STORAGE_KEY) ?? AI_GATEWAY_PRIVATE_KEY;
    return AI_GATEWAY_PRIVATE_KEY;
  });

  // Reset decrypted entries when file changes
  useEffect(() => { setDecryptedEntries({}); }, [selectedFile]);

  const handleDecrypt = useCallback(async (idx: number, entry: Record<string, unknown>) => {
    const pem = (typeof window !== "undefined" ? localStorage.getItem(PEM_STORAGE_KEY) : null) || AI_GATEWAY_PRIVATE_KEY;
    setDecryptingIdx(idx);
    try {
      const pk = await importPrivateKey(pem);
      const decrypted = await decryptEntry(entry, pk);
      setDecryptedEntries((prev) => ({ ...prev, [idx]: decrypted }));
      toast.success("解密成功");
    } catch (err) {
      toast.error(`解密失敗: ${(err as Error).message}`);
    } finally {
      setDecryptingIdx(null);
    }
  }, []);

  const handleDecryptAll = useCallback(async (lines: string[]) => {
    const pem = (typeof window !== "undefined" ? localStorage.getItem(PEM_STORAGE_KEY) : null) || AI_GATEWAY_PRIVATE_KEY;
    let pk: CryptoKey;
    try {
      pk = await importPrivateKey(pem);
    } catch (err) {
      toast.error(`Private key 無效: ${(err as Error).message}`);
      return;
    }
    let success = 0;
    const results: Record<number, Record<string, unknown>> = {};
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (hasEncryptedFields(entry)) {
          setDecryptingIdx(i);
          results[i] = await decryptEntry(entry, pk);
          success++;
        }
      } catch { /* skip */ }
    }
    setDecryptedEntries((prev) => ({ ...prev, ...results }));
    setDecryptingIdx(null);
    toast.success(`已解密 ${success} 筆記錄`);
  }, []);

  const saveKeyAndDecrypt = useCallback(async () => {
    if (!keyInput.trim()) return;
    // Validate key
    try {
      await importPrivateKey(keyInput);
    } catch {
      toast.error("Private Key 格式無效");
      return;
    }
    localStorage.setItem(PEM_STORAGE_KEY, keyInput);
    setShowKeyDialog(false);
    if (pendingDecryptIdx !== null) {
      setPendingDecryptIdx(null);
      // Re-trigger pending action after dialog closes — handled by caller
    }
    toast.success("Private Key 已儲存");
  }, [keyInput, pendingDecryptIdx]);

  // Load file content when selectedFile changes
  useEffect(() => {
    if (!selectedFile) {
      setPayload(null);
      return;
    }

    const loadContent = async () => {
      setLogLoading(true);
      setPayload(null);
      setSearchTerm("");
      try {
        const response = await fetch(
          `/api/logs/read?bucket=${encodeURIComponent(selectedFile.bucket)}&key=${encodeURIComponent(selectedFile.key)}`
        );
        const text = await response.text();
        let data: FilePayload;
        try {
          data = JSON.parse(text) as FilePayload;
        } catch {
          data = { error: `Server error (${response.status}): ${text.slice(0, 200)}` };
        }
        if (data.error) {
          toast.error(data.error);
          setPayload({ error: data.error });
        } else {
          setPayload(data);
        }
      } catch (err) {
        const msg = (err as Error).message;
        toast.error(msg);
        setPayload({ error: msg });
      } finally {
        setLogLoading(false);
      }
    };

    loadContent();
  }, [selectedFile]);

  // ── Renderers per content type ──

  const renderImage = () => {
    if (!payload?.base64 || !payload.contentType) return null;
    return (
      <div className="flex flex-col items-center gap-4">
        <img
          src={`data:${payload.contentType};base64,${payload.base64}`}
          alt={selectedFile?.key ?? "image"}
          className="w-3/4 rounded-lg border shadow-sm"
        />
        <span className="text-xs text-muted-foreground">
          {payload.contentType} &middot; {Math.round((payload.base64.length * 3) / 4 / 1024)} KB
        </span>
      </div>
    );
  };

  const renderPdf = () => {
    if (!payload?.base64 || !payload.contentType) return null;
    return (
      <div className="flex flex-col items-center gap-4 h-full">
        <iframe
          src={`data:application/pdf;base64,${payload.base64}`}
          title={selectedFile?.key ?? "PDF"}
          className="w-3/4 h-[75vh] rounded-lg border shadow-sm"
        />
        <span className="text-xs text-muted-foreground">
          {payload.contentType} &middot; {Math.round((payload.base64.length * 3) / 4 / 1024)} KB
        </span>
      </div>
    );
  };

  const renderJson = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      const pretty = JSON.stringify(parsed, null, 2);
      return (
        <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[calc(100vh-12rem)] overflow-y-auto">
          <div className="absolute top-2 right-2"><CopyButton text={pretty} /></div>
          <JsonHighlight data={parsed} />
        </div>
      );
    } catch {
      return renderRawText(text);
    }
  };

  const renderNdjson = (text: string) => {
    const lines = text.split("\n").filter((l) => l.trim());
    const filteredLines = searchTerm
      ? lines.filter((l) => l.toLowerCase().includes(searchTerm.toLowerCase()))
      : lines;

    // Check if any line has encrypted fields
    const hasAnyEncrypted = lines.some((l) => {
      try { return hasEncryptedFields(JSON.parse(l)); } catch { return false; }
    });

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
            {filteredLines.length} / {lines.length}
          </Badge>
          {hasAnyEncrypted && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 shrink-0"
              onClick={() => handleDecryptAll(lines)}
            >
              <Unlock className="size-3.5" />
              全部解密
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="設定 Private Key"
            onClick={() => setShowKeyDialog(true)}
          >
            <KeyRound className="size-3.5" />
          </Button>
          <CopyButton text={text} />
        </div>

        <div className="space-y-1.5">
          {filteredLines.map((line, i) => {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              const isDecrypted = !!decryptedEntries[i];
              const displayData = decryptedEntries[i] ?? parsed;
              const encrypted = hasEncryptedFields(parsed);

              return (
                <details key={i} className="rounded-lg border bg-card group">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-mono flex items-center gap-2 hover:bg-accent transition-colors">
                    <ChevronRight className="size-3 shrink-0 group-open:rotate-90 transition-transform" />
                    <span className="text-muted-foreground w-6 text-right shrink-0">{i + 1}</span>
                    <span className="truncate">
                      {parsed.Timestamp || parsed.timestamp || parsed.EventTimestampMs
                        ? new Date((parsed.Timestamp || parsed.timestamp || parsed.EventTimestampMs) as string | number).toLocaleString()
                        : parsed.Datetime
                          ? new Date(parsed.Datetime as string).toLocaleString()
                          : ""}
                    </span>
                    {!!parsed.ClientRequestMethod && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {String(parsed.ClientRequestMethod)}
                      </Badge>
                    )}
                    {!!parsed.ClientRequestURI && (
                      <span className="truncate text-muted-foreground">{String(parsed.ClientRequestURI)}</span>
                    )}
                    {!!parsed.Endpoint && (
                      <span className="truncate text-muted-foreground">{String(parsed.Endpoint)}</span>
                    )}
                    {!!parsed.EdgeResponseStatus && (
                      <Badge
                        variant={Number(parsed.EdgeResponseStatus) >= 400 ? "destructive" : "secondary"}
                        className={`text-[10px] px-1.5 py-0 ${Number(parsed.EdgeResponseStatus) >= 400 ? "text-white" : ""}`}
                      >
                        {String(parsed.EdgeResponseStatus)}
                      </Badge>
                    )}
                    {!!parsed.CacheResponseStatus && (
                      <Badge
                        variant={Number(parsed.CacheResponseStatus) >= 400 ? "destructive" : "secondary"}
                        className={`text-[10px] px-1.5 py-0 ${Number(parsed.CacheResponseStatus) >= 400 ? "text-white" : ""}`}
                      >
                        {String(parsed.CacheResponseStatus)}
                      </Badge>
                    )}
                    {encrypted && (
                      isDecrypted ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-emerald-600 border-emerald-300">
                          <Unlock className="size-2.5 mr-0.5" /> 已解密
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-300">
                          <Lock className="size-2.5 mr-0.5" /> 加密
                        </Badge>
                      )
                    )}
                  </summary>
                  <div className="relative border-t px-3 py-2 bg-muted/50">
                    <div className="absolute top-1 right-1 flex items-center gap-1">
                      {encrypted && !isDecrypted && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={decryptingIdx === i}
                          onClick={() => handleDecrypt(i, parsed)}
                          title="解密此筆"
                        >
                          {decryptingIdx === i
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <Unlock className="size-3.5 text-amber-600" />}
                        </Button>
                      )}
                      <CopyButton text={JSON.stringify(displayData, null, 2)} />
                    </div>
                    <JsonHighlight data={displayData} />
                  </div>
                </details>
              );
            } catch {
              return (
                <div key={i} className="rounded border px-3 py-1.5 text-xs font-mono break-all">
                  {line}
                </div>
              );
            }
          })}
        </div>
      </div>
    );
  };

  const renderMarkdown = (text: string) => {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <CopyButton text={text} />
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border bg-card p-6 overflow-auto max-h-[calc(100vh-12rem)]">
          <MarkdownRenderer content={text} />
        </div>
      </div>
    );
  };

  const renderHtml = (text: string) => {
    return (
      <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[calc(100vh-12rem)] overflow-y-auto">
        <div className="absolute top-2 right-2"><CopyButton text={text} /></div>
        <HtmlHighlight html={text} />
      </div>
    );
  };

  const renderRawText = (text: string) => {
    return (
      <div className="relative rounded-lg border bg-muted/30 p-4 overflow-x-auto max-h-[calc(100vh-12rem)] overflow-y-auto">
        <div className="absolute top-2 right-2"><CopyButton text={text} /></div>
        <pre className="text-xs whitespace-pre-wrap break-all font-mono">{text}</pre>
      </div>
    );
  };

  // ── Route to the right renderer ──

  const renderContent = () => {
    if (!payload) return null;

    if (payload.error) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-destructive gap-3">
          <AlertCircle className="size-10 opacity-40" />
          <p className="text-sm font-medium">{payload.error}</p>
        </div>
      );
    }

    // Binary (PDF / image)
    if (payload.base64 && payload.contentType === "application/pdf") return renderPdf();
    if (payload.base64) return renderImage();

    const content = payload.content ?? "";
    if (!content) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
          <FileText className="size-10 opacity-20" />
          <p className="text-sm">{t("logs.empty")}</p>
        </div>
      );
    }

    const ct = payload.contentType ?? "";
    const key = selectedFile?.key ?? "";

    // NDJSON (Logpush .log.gz or explicit ndjson)
    if (ct === "application/x-ndjson" || key.endsWith(".log.gz")) {
      return renderNdjson(content);
    }

    // JSON
    if (ct === "application/json" || key.endsWith(".json")) {
      return renderJson(content);
    }

    // Markdown
    if (ct === "text/markdown" || key.endsWith(".md")) {
      return renderMarkdown(content);
    }

    // HTML
    if (ct === "text/html" || key.endsWith(".html") || key.endsWith(".htm")) {
      return renderHtml(content);
    }

    // Check if content looks like multi-line JSON (NDJSON heuristic)
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    if (firstLine.startsWith("{") || firstLine.startsWith("[")) {
      try {
        JSON.parse(firstLine);
        const lines = content.split("\n").filter((l) => l.trim());
        if (lines.length > 1) return renderNdjson(content);
        return renderJson(content);
      } catch {
        // not JSON
      }
    }

    // Default: raw text
    return renderRawText(content);
  };

  // ── Layout ──

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with file path */}
      <div className="flex items-center gap-2 p-3 border-b shrink-0">
        {payload?.base64 ? (
          <ImageIcon className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <FileText className="size-4 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-medium truncate">
          {selectedFile
            ? `${selectedFile.bucket}/${selectedFile.key}`
            : t("logs.title")}
        </span>
        {payload?.compressed && (
          <Badge variant="outline" className="text-[10px] shrink-0">gzip</Badge>
        )}
        {payload?.contentType && (
          <Badge variant="secondary" className="text-[10px] shrink-0">{payload.contentType}</Badge>
        )}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedFile ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
            <FileText className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-sm">{t("logs.selectFile")}</p>
          </div>
        ) : logLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          renderContent()
        )}
      </div>
      {/* Private Key Dialog */}
      <Dialog open={showKeyDialog} onOpenChange={setShowKeyDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5" />
              AI Gateway / DLP Private Key
            </DialogTitle>
            <DialogDescription>
              貼入 RSA Private Key（PEM 格式）用於解密加密的 log 欄位。Key 僅儲存在瀏覽器 localStorage，不會傳送到伺服器。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="font-mono text-xs min-h-[200px]"
            placeholder="-----BEGIN PRIVATE KEY-----&#10;MIIJQQIBADANBgkq...&#10;-----END PRIVATE KEY-----"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <DialogFooter className="gap-2">
            {keyInput && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive mr-auto"
                onClick={() => {
                  localStorage.removeItem(PEM_STORAGE_KEY);
                  setKeyInput("");
                  toast.success("Private Key 已清除");
                }}
              >
                清除 Key
              </Button>
            )}
            <Button variant="outline" onClick={() => setShowKeyDialog(false)}>
              取消
            </Button>
            <Button onClick={saveKeyAndDecrypt} disabled={!keyInput.trim()}>
              儲存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
