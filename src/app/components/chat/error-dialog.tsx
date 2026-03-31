'use client';

import { ShieldCheck, ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ChatErrorState {
  errorType: "firewall" | "gateway" | "dlp" | "general";
  message: string;
  rayId: string | null;
  gatewayLogId: string | null;
  statusCode: number | null;
  gatewayCode: string | null;
  userIp: string | null;
}

interface ErrorDialogProps {
  open: boolean;
  onClose: () => void;
  error: ChatErrorState | null;
}

const STATUS_LABEL: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  424: "Failed Dependency",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const BADGE_MAP: Record<ChatErrorState["errorType"], { label: string; className: string }> = {
  firewall: { label: "Firewall for AI", className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
  gateway: { label: "AI Gateway", className: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  dlp: { label: "DLP", className: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  general: { label: "Error", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
};

// Title i18n key: firewall (HTML block) → Firewall for AI title; gateway/dlp (JSON) → AI Gateway title
const TITLE_KEY_MAP: Record<ChatErrorState["errorType"], string> = {
  firewall: "chat.error.titleFirewall",
  gateway: "chat.error.titleBlocked",
  dlp: "chat.error.titleBlocked",
  general: "chat.error.titleGeneral",
};

export function ErrorDialog({ open, onClose, error }: ErrorDialogProps) {
  const { t } = useTranslation();

  if (!error) return null;

  const statusLabel = error.statusCode
    ? `${error.statusCode} ${STATUS_LABEL[error.statusCode] || ""}`
    : null;

  const details: Array<{ label: string; value: string }> = [];
  if (statusLabel) details.push({ label: t("chat.error.statusCode"), value: statusLabel });
  if (error.rayId) details.push({ label: t("chat.error.rayId"), value: error.rayId });
  if (error.gatewayLogId) details.push({ label: t("chat.error.gatewayLogId"), value: error.gatewayLogId });
  if (error.gatewayCode) details.push({ label: t("chat.error.errorCode"), value: error.gatewayCode });
  if (error.userIp) details.push({ label: t("chat.error.userIp"), value: error.userIp });
  if (error.message) details.push({ label: t("chat.error.reason"), value: error.message });

  const badge = error.errorType === "gateway" && error.gatewayCode === "2016"
    ? BADGE_MAP.firewall
    : BADGE_MAP[error.errorType];

  return (
    <Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2.5 text-lg">
            <ShieldCheck className="size-5 shrink-0 text-red-500" />
            {t(TITLE_KEY_MAP[error.errorType])}
          </DialogTitle>
        </DialogHeader>

        <div className="mx-5 mb-4 rounded-lg border-l-4 border-l-red-500 bg-red-50 dark:bg-red-950/20 px-4 py-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}>
              {badge.label}
            </span>
          </div>

          {details.length > 0 && (
            <div>
              <p className="text-xs font-semibold flex items-center gap-1.5 mb-2">
                <ClipboardList className="size-3.5" />
                {t("chat.error.detailsLabel")}
              </p>
              <ul className="space-y-1 text-sm">
                {details.map((d) => (
                  <li key={d.label} className="flex items-start gap-1">
                    <span className="shrink-0">•</span>
                    <span>
                      <span className="font-medium">{d.label}：</span>
                      <span className="font-mono text-xs break-all">{d.value}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

        </div>

        <div className="flex justify-end px-5 pb-4">
          <Button variant="link" onClick={onClose} className="text-primary">
            {t("chat.error.ok")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
