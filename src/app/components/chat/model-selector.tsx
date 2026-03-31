'use client';

import { AI_MODELS, type AIModel, type ModelProvider } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

function CloudflareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 209.51 94.74" fill="currentColor" className={className}>
      <path d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.75,22.27-16.71l4.34-11.36a2.68,2.68,0,0,0,.18-1,3.31,3.31,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z" fill="#f4801f"/>
      <path d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.09.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.55,1.55,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z" fill="#f9ab41"/>
    </svg>
  );
}

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"/>
    </svg>
  );
}

function PerplexityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} fillRule="evenodd">
      <path d="M8 .188a.5.5 0 0 1 .503.5V4.03l3.022-2.92.059-.048a.51.51 0 0 1 .49-.054.5.5 0 0 1 .306.46v3.247h1.117l.1.01a.5.5 0 0 1 .403.49v5.558a.5.5 0 0 1-.503.5H12.38v3.258a.5.5 0 0 1-.312.462.51.51 0 0 1-.55-.11l-3.016-3.018v3.448c0 .275-.225.5-.503.5a.5.5 0 0 1-.503-.5v-3.448l-3.018 3.019a.51.51 0 0 1-.548.11.5.5 0 0 1-.312-.463v-3.258H2.503a.5.5 0 0 1-.503-.5V5.215l.01-.1c.047-.229.25-.4.493-.4H3.62V1.469l.006-.074a.5.5 0 0 1 .302-.387.51.51 0 0 1 .547.102l3.023 2.92V.687c0-.276.225-.5.503-.5M4.626 9.333v3.984l2.87-2.872v-4.01zm3.877 1.113 2.871 2.871V9.333l-2.87-2.897zm3.733-1.668a.5.5 0 0 1 .145.35v1.145h.612V5.715H9.201zm-9.23 1.495h.613V9.13c0-.131.052-.257.145-.35l3.033-3.064h-3.79zm1.62-5.558H6.76L4.626 2.652zm4.613 0h2.134V2.652z"/>
    </svg>
  );
}

function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/>
    </svg>
  );
}

function ProviderIcon({ provider, className }: { provider: ModelProvider; reasoning?: boolean; className?: string }) {
  if (provider === "openai") return <OpenAIIcon className={className} />;
  if (provider === "perplexity") return <PerplexityIcon className={className} />;
  if (provider === "anthropic") return <ClaudeIcon className={className} />;
  return <CloudflareIcon className={className} />;
}

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  "workers-ai": "Cloudflare Workers AI",
  "openai": "OpenAI",
  "perplexity": "Perplexity",
  "anthropic": "Anthropic",
};

function groupByProvider(models: AIModel[]): Map<ModelProvider, AIModel[]> {
  const map = new Map<ModelProvider, AIModel[]>();
  for (const m of models) {
    if (!map.has(m.provider)) map.set(m.provider, []);
    map.get(m.provider)!.push(m);
  }
  return map;
}

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const current = AI_MODELS.find((m) => m.id === selectedModel) || AI_MODELS[0]!;
  const grouped = groupByProvider(AI_MODELS);
  const providers: ModelProvider[] = ["workers-ai", "openai", "perplexity", "anthropic"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8">
          <ProviderIcon provider={current.provider} reasoning={current.reasoning} className="size-3.5" />
          <span className="hidden sm:inline">{current.name}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        {providers.map((provider, i) => {
          const models = grouped.get(provider);
          if (!models?.length) return null;
          return (
            <div key={provider}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal py-1">
                {PROVIDER_LABELS[provider]}
              </DropdownMenuLabel>
              {models.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  onClick={() => onModelChange(model.id)}
                  className={selectedModel === model.id ? "bg-accent" : ""}
                >
                  <ProviderIcon provider={model.provider} reasoning={model.reasoning} className="size-4 mr-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{model.name}</div>
                    {model.reasoning && (
                      <div className="text-xs text-muted-foreground">{t("chat.reasoningModel")}</div>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
