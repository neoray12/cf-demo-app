'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents/ids";
import type { ModelKey } from "@/lib/agents/models";
import { createNdjsonParser, type TraceEvent } from "@/lib/agents/trace-events";
import { reduceTrace, type RunTrace } from "@/lib/agents/trace-tree";

export interface AgentTurn {
  id: string;
  user: string;
  model: ModelKey;
  trace: RunTrace | null;
  /** performance.now() when the user pressed send. */
  sentAt: number;
  /** performance.now() when the stream finished (ok, error or abort); undefined while running. */
  endedAt?: number;
  /**
   * performance.now() minus the server clock (`t` of run-start), so that
   * `performance.now() - serverOffset` ≈ the server's ms-since-request: anchors live span timers.
   */
  serverOffset?: number;
  /** Send → first NDJSON event. */
  clientFirstEventMs?: number;
  /** Send → first reasoning-delta of any span (root or subagent). */
  clientFirstReasoningMs?: number;
  /** Send → first root-agent text-delta (the answer). */
  clientTtftMs?: number;
  /** Send → first / latest root-agent reasoning-delta (drives 「思考中 Ns」). */
  rootReasoningFirstMs?: number;
  rootReasoningLastMs?: number;
  /** Send → run-end received (the stream may stay open a little longer while the server cleans up). */
  clientRunEndMs?: number;
  /** Transport failure (HTTP error, network drop) — distinct from a run that ended with status error. */
  error?: string;
  /** Set when the user stopped the turn before any trace event arrived. */
  abortedEarly?: boolean;
}

export type TurnStatus = "running" | "ok" | "error" | "aborted";

export function turnStatus(turn: AgentTurn): TurnStatus {
  if (turn.trace && turn.trace.status !== "running") return turn.trace.status;
  if (turn.abortedEarly) return "aborted";
  if (turn.error) return "error";
  return turn.endedAt === undefined ? "running" : "error";
}

export interface SendOptions {
  model: ModelKey;
  workspace?: string;
  storeContent: boolean;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sumChatUsage(trace: RunTrace): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const n of Object.values(trace.spans)) {
    if (n.kind === "chat" && n.usage) {
      input += n.usage.input;
      output += n.usage.output;
    }
  }
  return { input, output };
}

/**
 * Streams one agent run per `send()` from `POST /api/agents/{agentId}` (NDJSON) and folds the
 * events into a `RunTrace` per turn. One React state update per network chunk.
 */
export function useAgentRun(agentId: AgentId) {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => newId());

  const turnsRef = useRef<AgentTurn[]>([]);
  turnsRef.current = turns;
  const abortRef = useRef<AbortController | null>(null);
  /** Every fetch still streaming (incl. one past run-end that the server is closing) — aborted on unmount. */
  const liveRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const c of liveRef.current) c.abort();
      liveRef.current.clear();
      abortRef.current = null;
    };
  }, []);

  const patchTurn = useCallback((id: string, patch: Partial<AgentTurn>) => {
    if (!mountedRef.current) return;
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const send = useCallback(
    (text: string, opts: SendOptions) => {
      const question = text.trim();
      if (!question || runningRef.current) return;

      // History: earlier turns that finished ok with an answer. Stopped / failed turns are left out —
      // their partial text (often just the plan sentence) makes the model merge the old question into the new one.
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const t of turnsRef.current) {
        const answer = t.trace?.status === "ok" ? t.trace.text.trim() : "";
        if (!answer) continue;
        messages.push({ role: "user", content: t.user }, { role: "assistant", content: t.trace!.text });
      }
      messages.push({ role: "user", content: question });

      const id = newId();
      const sentAt = performance.now();
      const turn: AgentTurn = { id, user: question, model: opts.model, trace: null, sentAt };
      setTurns((ts) => [...ts, turn]);
      setRunning(true);
      runningRef.current = true;

      const controller = new AbortController();
      abortRef.current = controller;
      liveRef.current.add(controller);

      // Mutable per-run state; React state gets a snapshot once per chunk.
      let trace: RunTrace | null = null;
      const metrics: Partial<AgentTurn> = {};
      const parser = createNdjsonParser();

      const fold = (events: TraceEvent[]) => {
        if (events.length === 0) return;
        const now = performance.now();
        const sinceSend = now - sentAt;
        if (metrics.clientFirstEventMs === undefined) metrics.clientFirstEventMs = sinceSend;
        for (const e of events) {
          if (e.type === "run-start" && metrics.serverOffset === undefined) metrics.serverOffset = now - e.t;
          const prevText = trace?.text.length ?? 0;
          const prevReasoning = trace?.reasoning.length ?? 0;
          trace = reduceTrace(trace, e);
          if (e.type === "reasoning-delta" && metrics.clientFirstReasoningMs === undefined) {
            metrics.clientFirstReasoningMs = sinceSend;
          }
          if (trace.text.length > prevText && metrics.clientTtftMs === undefined) metrics.clientTtftMs = sinceSend;
          if (e.type === "run-end" && metrics.clientRunEndMs === undefined) metrics.clientRunEndMs = sinceSend;
          if (trace.reasoning.length > prevReasoning) {
            metrics.rootReasoningFirstMs ??= sinceSend;
            metrics.rootReasoningLastMs = sinceSend;
          }
        }
        patchTurn(id, { trace, ...metrics });
        // run-end is the end of the run for the user; the server may hold the stream open a moment
        // longer while it closes run resources, which must not keep the input locked.
        if (trace && trace.status !== "running") release();
      };

      /** Give up the running flag (only if this run still owns it: after reset() a newer run may). */
      const release = () => {
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        runningRef.current = false;
        if (mountedRef.current) setRunning(false);
      };

      const finish = (patch: Partial<AgentTurn>) => {
        liveRef.current.delete(controller);
        patchTurn(id, { endedAt: performance.now(), ...patch });
        release();
      };

      /** Close a run that never got its run-end (user stop, dropped connection): every open span ends. */
      const synthesizeEnd = (status: "aborted" | "error", error?: string) => {
        const current = trace as RunTrace | null;
        if (!current || current.status !== "running") return;
        const serverNow = metrics.serverOffset !== undefined ? performance.now() - metrics.serverOffset : performance.now() - sentAt;
        // Server-clock time of the first answer token, relative to the root span start (same as the server's ttft).
        const rootStart = current.spans[current.runId]?.start ?? 0;
        const serverTtft =
          metrics.clientTtftMs !== undefined && metrics.serverOffset !== undefined
            ? Math.max(0, sentAt + metrics.clientTtftMs - metrics.serverOffset - rootStart)
            : 0;
        trace = reduceTrace(current, {
          type: "run-end",
          t: serverNow,
          totalMs: serverNow,
          ttftMs: serverTtft,
          usage: sumChatUsage(current),
          status,
          ...(error !== undefined ? { error } : {}),
        });
      };

      void (async () => {
        try {
          const res = await fetch(`/api/agents/${agentId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              model: opts.model,
              conversationId,
              ...(opts.workspace ? { workspace: opts.workspace } : {}),
              storeContent: opts.storeContent,
            }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            let message = `HTTP ${res.status}`;
            try {
              const body = (await res.json()) as { error?: string };
              if (body?.error) message = `${message} · ${body.error}`;
            } catch {
              // not JSON
            }
            finish({ error: message });
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            fold(parser.push(decoder.decode(value, { stream: true })));
          }
          fold(parser.push(decoder.decode()));
          fold(parser.flush());
          const ended = (trace as RunTrace | null)?.status !== "running" && trace !== null;
          if (!ended) {
            synthesizeEnd("error", "stream ended without run-end");
            finish({ trace, ...metrics, error: "stream ended without run-end" });
          } else {
            finish({ trace, ...metrics });
          }
        } catch (err) {
          if (controller.signal.aborted) {
            synthesizeEnd("aborted");
            finish(trace ? { trace, ...metrics } : { ...metrics, abortedEarly: true });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            synthesizeEnd("error", message);
            finish({ trace, ...metrics, error: message });
          }
        }
      })();
    },
    [agentId, conversationId, patchTurn],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    for (const c of liveRef.current) c.abort();
    liveRef.current.clear();
    abortRef.current = null;
    runningRef.current = false;
    setTurns([]);
    setRunning(false);
    setConversationId(newId());
  }, []);

  return { turns, send, stop, running, conversationId, reset };
}
