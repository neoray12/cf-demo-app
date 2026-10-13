'use client';

import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { ExternalLink, MessageSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { GUARDRAIL_SCENARIOS, gatewayRuleUrl, type GuardrailLevel } from "@/lib/mcp-guardrails";

const LEVEL_STYLE: Record<GuardrailLevel, string> = {
  tool: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  action: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  parameter: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  response: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export function McpGuardrailsPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const tryInChat = (text: string) =>
    router.push("/?prompt=" + encodeURIComponent(text) + "&mcp=saas");

  const PromptRow = ({ label, text }: { label: string; text: string }) => (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <p className="text-sm break-words">{text}</p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => tryInChat(text)}>
        <MessageSquare className="size-3.5" />
        {t("guardrails.tryInChat")}
      </Button>
    </div>
  );

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="size-6 text-orange-500" />
          {t("guardrails.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("guardrails.intro")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("guardrails.flowTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {[1, 2, 3].map((n) => (
              <li key={n} className="flex items-start gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-semibold text-white">
                  {n}
                </span>
                <span className="pt-0.5">{t(`guardrails.flow${n}`)}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {GUARDRAIL_SCENARIOS.map((s) => (
        <Card key={s.id}>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className={LEVEL_STYLE[s.level]}>
                {t(`guardrails.levels.${s.level}`)}
              </Badge>
              <CardTitle className="text-base">{t(s.titleKey)}</CardTitle>
            </div>
            <CardDescription>{t(s.descKey)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("guardrails.policy")}</div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("guardrails.selector")}</th>
                      <th className="px-3 py-2 font-medium">{t("guardrails.operator")}</th>
                      <th className="px-3 py-2 font-medium">{t("guardrails.value")}</th>
                      <th className="px-3 py-2 font-medium">{t("guardrails.actionCol")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.policy.map((row, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{row.selector}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{row.operator}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{row.value}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{i === 0 ? s.action : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("guardrails.dlpRegex")}</div>
              <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">{s.dlpRegex}</pre>
            </div>

            {s.id === 3 && <p className="text-xs text-muted-foreground">{t("guardrails.s3Note")}</p>}
            {s.id === 4 && <p className="text-xs text-muted-foreground">{t("guardrails.s4Note")}</p>}

            <Button variant="outline" size="sm" asChild>
              <a href={gatewayRuleUrl(s.ruleId)} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" />
                {t("guardrails.openRule")}
              </a>
            </Button>

            <div className="space-y-2">
              <PromptRow label={t("guardrails.allowPrompt")} text={t(s.allowPromptKey)} />
              <PromptRow label={t("guardrails.blockPrompt")} text={t(s.blockPromptKey)} />
              {s.resetPromptKey && (
                <PromptRow label={t("guardrails.resetPrompt")} text={t(s.resetPromptKey)} />
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
