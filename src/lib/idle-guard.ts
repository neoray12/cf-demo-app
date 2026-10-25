// Inactivity guard for a model stream: fires when no stream part arrives for
// `idleMs`, except while tools are executing — the AI SDK sends nothing between
// a tool-call and its result, and a delegate tool (subagent) can run for minutes.

export interface IdleGuard {
  onPart(part: { type: string; toolCallId?: unknown }): void;
  stop(): void;
}

export function createIdleGuard(idleMs: number, onIdle: () => void): IdleGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const running = new Set<string>();

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (!stopped && running.size === 0) timer = setTimeout(onIdle, idleMs);
  };

  arm();
  return {
    onPart(part) {
      if (part.type === 'tool-call') running.add(String(part.toolCallId));
      else if (part.type === 'tool-result' || part.type === 'tool-error') running.delete(String(part.toolCallId));
      arm();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
