import { describe, it, expect, vi, afterEach } from 'vitest';
import { createIdleGuard } from './idle-guard';

afterEach(() => vi.useRealTimers());

describe('createIdleGuard', () => {
  it('fires after idleMs without stream parts', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const guard = createIdleGuard(1000, onIdle);
    guard.onPart({ type: 'text-delta' });
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('pauses while a tool is executing (tool-call … tool-result), e.g. a long subagent', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const guard = createIdleGuard(1000, onIdle);
    guard.onPart({ type: 'tool-call', toolCallId: 'a' });
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    guard.onPart({ type: 'tool-result', toolCallId: 'a' });
    vi.advanceTimersByTime(1001);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stays paused until every parallel tool has finished', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const guard = createIdleGuard(1000, onIdle);
    guard.onPart({ type: 'tool-call', toolCallId: 'a' });
    guard.onPart({ type: 'tool-call', toolCallId: 'b' });
    guard.onPart({ type: 'tool-error', toolCallId: 'a' });
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
    guard.onPart({ type: 'tool-result', toolCallId: 'b' });
    vi.advanceTimersByTime(1001);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never fires after stop()', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const guard = createIdleGuard(1000, onIdle);
    guard.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
