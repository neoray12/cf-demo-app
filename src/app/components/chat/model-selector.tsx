import { AI_MODELS, type AIModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Brain, Cpu } from "lucide-react";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const current = AI_MODELS.find((m) => m.id === selectedModel) || AI_MODELS[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs">
          {current.reasoning ? (
            <Brain className="size-3.5" />
          ) : (
            <Cpu className="size-3.5" />
          )}
          <span className="hidden sm:inline">{current.name}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {AI_MODELS.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onModelChange(model.id)}
            className={selectedModel === model.id ? "bg-accent" : ""}
          >
            {model.reasoning ? (
              <Brain className="size-4 mr-2" />
            ) : (
              <Cpu className="size-4 mr-2" />
            )}
            <div>
              <div className="text-sm">{model.name}</div>
              {model.reasoning && (
                <div className="text-xs text-muted-foreground">推理模型</div>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
