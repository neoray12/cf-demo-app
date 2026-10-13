import { ShieldAlert, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GUARDRAIL_SCENARIOS, gatewayRuleUrl, type GatewayBlock } from "@/lib/mcp-guardrails";

/** Shown in place of a tool call that Cloudflare Gateway blocked. */
export function GatewayBlockCard({
  block,
  label,
}: {
  block: GatewayBlock & { source: string; tool: string };
  /** Display name for the blocked tool; defaults to `source · tool`. */
  label?: string;
}) {
  const { t } = useTranslation();
  const scenario = block.scenarioId ? GUARDRAIL_SCENARIOS.find((s) => s.id === block.scenarioId) : undefined;

  return (
    <div className="my-2 max-w-xl rounded-xl border border-destructive/30 bg-destructive/5 dark:bg-destructive/10 p-3 text-xs">
      <div className="flex items-center gap-2 text-destructive">
        <ShieldAlert className="size-4 shrink-0" />
        <span className="text-sm font-medium">{t("chat.gatewayBlock.title")}</span>
      </div>
      <div className="mt-1 ml-6 font-mono text-muted-foreground break-all">
        {label ?? `${block.source} · ${block.tool}`}
      </div>

      <div className="mt-2 ml-6 space-y-1 text-foreground/80">
        {block.direction === "request" ? (
          <>
            <div>
              <span className="font-medium">{t("chat.gatewayBlock.request")}</span>
              {scenario && <span className="text-muted-foreground"> · {t(scenario.titleKey)}</span>}
            </div>
            {block.ruleId && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-muted-foreground">{t("chat.gatewayBlock.rule")}</span>
                <a
                  href={gatewayRuleUrl(block.ruleId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-destructive hover:underline break-all"
                >
                  {block.ruleId}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </div>
            )}
            {block.requestId && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-muted-foreground">{t("chat.gatewayBlock.requestId")}</span>
                <span className="font-mono break-all">{block.requestId}</span>
              </div>
            )}
          </>
        ) : (
          <div>{t("chat.gatewayBlock.response")}</div>
        )}
      </div>
    </div>
  );
}
