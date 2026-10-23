import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentEnv } from "./env";
import type { AgentModel } from "./models";

/**
 * Merge extra top-level fields into a JSON request body.
 * Workers AI GLM/Kimi reasoning is controlled by the body field `reasoning_effort`,
 * which AI SDK providerOptions do not reliably forward. Non-JSON or missing bodies
 * are returned untouched.
 */
export function injectBodyParams(
  init: RequestInit | undefined,
  params: Record<string, unknown>,
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  try {
    const parsed = JSON.parse(init.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return init;
    return { ...init, body: JSON.stringify({ ...parsed, ...params }) };
  } catch {
    return init;
  }
}

export function createAgentModel(
  env: AgentEnv,
  model: AgentModel,
  meta: { functionId: string; conversationId: string },
): LanguageModel {
  // \uXXXX-escape non-ASCII so the header stays Latin-1 safe (AI Gateway decodes it).
  const metadata = JSON.stringify({ agent: meta.functionId, conversation: meta.conversationId }).replace(
    /[^\x20-\x7E]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  const openai = createOpenAI({
    apiKey: env.CF_API_TOKEN,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/compat`,
    headers: {
      ...(env.CF_AIG_TOKEN ? { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` } : {}),
      "cf-aig-skip-cache": "true",
      "cf-aig-metadata": metadata,
    },
    fetch: (url, init) =>
      fetch(url, injectBodyParams(init, { reasoning_effort: model.reasoningEffort })),
  });

  return openai.chat(`workers-ai/${model.workersAiId}`);
}
