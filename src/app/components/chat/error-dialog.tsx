import { ShieldAlert, AlertTriangle, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ChatErrorState {
  errorType: "firewall" | "gateway" | "dlp" | "general";
  message: string;
  rayId: string | null;
  gatewayLogId: string | null;
  statusCode: number | null;
  gatewayCode: string | null;
}

interface ErrorDialogProps {
  open: boolean;
  onClose: () => void;
  error: ChatErrorState | null;
}

export function ErrorDialog({ open, onClose, error }: ErrorDialogProps) {
  const { t } = useTranslation();

  if (!error) return null;

  const titleMap: Record<ChatErrorState["errorType"], string> = {
    firewall: t("chat.error.titleFirewall"),
    gateway: t("chat.error.titleGateway"),
    dlp: t("chat.error.titleDlp"),
    general: t("chat.error.titleGeneral"),
  };

  const IconComponent =
    error.errorType === "firewall"
      ? ShieldAlert
      : error.errorType === "gateway" || error.errorType === "dlp"
        ? AlertTriangle
        : AlertCircle;

  const iconColor =
    error.errorType === "firewall"
      ? "text-destructive"
      : error.errorType === "gateway" || error.errorType === "dlp"
        ? "text-orange-500"
        : "text-muted-foreground";

  const hasDetails =
    error.statusCode !== null ||
    error.rayId ||
    error.gatewayLogId ||
    error.gatewayCode;

  return (
    <Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconComponent className={`size-5 shrink-0 ${iconColor}`} />
            {titleMap[error.errorType]}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {error.message}
          </p>

          {hasDetails && (
            <div className="rounded-md border bg-muted/50 px-3 py-2.5 space-y-1.5 text-xs font-mono">
              {error.statusCode !== null && (
                <Row label={t("chat.error.statusCode")} value={String(error.statusCode)} />
              )}
              {error.rayId && (
                <Row label={t("chat.error.rayId")} value={error.rayId} highlight />
              )}
              {error.gatewayLogId && (
                <Row label={t("chat.error.gatewayLogId")} value={error.gatewayLogId} />
              )}
              {error.gatewayCode && (
                <Row label={t("chat.error.errorCode")} value={error.gatewayCode} />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t("chat.error.ok")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground shrink-0 w-24">{label}:</span>
      <span
        className={`break-all ${highlight ? "font-semibold text-foreground" : "text-muted-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}
