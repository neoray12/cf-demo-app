import { describe, it, expect } from 'vitest';
import {
  TurnRecorder,
  deriveTitle,
  isValidConversationId,
  likePattern,
  ownsAssetKey,
  toHistoryTurn,
  turnKey,
  userPrefix,
  type TurnRequestInfo,
} from './chat-history';

const request: TurnRequestInfo = {
  model: 'claude-haiku-5-5',
  provider: 'anthropic',
  compatModelId: 'anthropic/claude-haiku-5-5',
  toolsEnabled: true,
  codeMode: false,
  codeModeActive: false,
  appCodeModeSkipped: false,
  mcpServers: [],
  edgeColo: 'TPE',
  country: 'TW',
  userAgent: 'vitest',
  maxOutputTokens: 4096,
  systemPrompt: 'sys',
  tools: [{ name: 'executeJs', description: 'run js' }],
  messages: [{ role: 'user', content: '1+1?' }],
  userText: '1+1?',
  imageKeys: [],
  attachments: [],
};

function recorder(clockStart = 1_000) {
  let now = clockStart;
  const clock = () => now;
  const rec = new TurnRecorder(
    { conversationId: 'conv-1', turnIndex: 0, user: { email: 'neo@cloudflare.com', name: 'Neo', source: 'login' }, request },
    clock,
  );
  return { rec, advance: (ms: number) => (now += ms) };
}

describe('TurnRecorder', () => {
  it('builds the assistant message, timeline, ttft and raw event log', () => {
    const { rec, advance } = recorder();
    advance(100);
    rec.onEvent({ type: 'tool-call-start', toolCallId: 't1', toolName: 'executeJs' });
    advance(50);
    rec.onEvent({ type: 'tool-result', toolCallId: 't1', toolName: 'executeJs', result: 2 });
    advance(20);
    rec.onEvent({ type: 'text-delta', text: '2' });
    rec.noteAttempt({ attempt: 'stream-1', startedMs: 0, endedMs: 180, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 3 }, steps: [], error: null });
    advance(10);
    const r = rec.finish();

    expect(r.status).toBe('completed');
    expect(r.durationMs).toBe(180);
    expect(r.ttftMs).toBe(170);
    expect(r.startedAt).toBe(new Date(1_000).toISOString());
    expect(r.response.assistant.content).toBe('2');
    expect(r.response.assistant.parts).toEqual([{ type: 'tool', id: 't1' }, { type: 'text', text: '2' }]);
    expect(r.response.timeline.events.map((e) => e.kind)).toEqual(['tool-start', 'tool-end', 'text']);
    expect(r.events.map((e) => [e.t, e.type])).toEqual([
      [100, 'tool-call-start'],
      [150, 'tool-result'],
      [170, 'text-delta'],
    ]);
  });

  it('marks errors and client disconnects', () => {
    const a = recorder().rec;
    a.onEvent({ type: 'error', errorType: 'dlp', message: 'blocked' });
    expect(a.finish().status).toBe('error');

    const b = recorder().rec;
    b.onEvent({ type: 'text-delta', text: 'partial' });
    b.clientGone = true;
    expect(b.finish().status).toBe('client-aborted');
  });

  it('round-trips into the chat page shape', () => {
    const { rec } = recorder();
    rec.onEvent({ type: 'reasoning-delta', text: 'hmm' });
    rec.onEvent({ type: 'text-delta', text: 'hi' });
    const turn = toHistoryTurn({ ...rec.finish(), request: { ...request, imageKeys: ['users/abc/conv-1/turn-0000-image-0.png'] } });
    expect(turn.user).toEqual({ content: '1+1?', images: ['/api/chat/history/asset?key=users%2Fabc%2Fconv-1%2Fturn-0000-image-0.png'] });
    expect(turn.assistant.content).toBe('hi');
    expect(turn.assistant.reasoning).toBe('hmm');
    expect(turn.assistant.timeline.startedAt).toBe(0);
  });
});

describe('helpers', () => {
  it('derives a short title from the first line', () => {
    expect(deriveTitle('  \n第一行問題\n第二行')).toBe('第一行問題');
    expect(deriveTitle('分析這份檔案\n\n📎 sales.csv')).toBe('分析這份檔案');
    expect(deriveTitle('')).toBe('（圖片）');
    expect(deriveTitle('x'.repeat(100))).toHaveLength(60);
  });

  it('validates conversation ids', () => {
    expect(isValidConversationId('0f8e2c1a-1234-4abc-9def-001122334455')).toBe(true);
    expect(isValidConversationId('../etc')).toBe(false);
    expect(isValidConversationId('')).toBe(false);
  });

  it('builds per-user keys and checks asset ownership', async () => {
    const prefix = await userPrefix('Neo@Cloudflare.com');
    expect(prefix).toMatch(/^users\/[0-9a-f]{16}$/);
    expect(prefix).toBe(await userPrefix('neo@cloudflare.com'));
    expect(turnKey(prefix, 'c1', 7)).toBe(`${prefix}/c1/turn-0007.json`);
    expect(await ownsAssetKey('neo@cloudflare.com', `${prefix}/c1/turn-0007-image-0.png`)).toBe(true);
    expect(await ownsAssetKey('neo@cloudflare.com', `${prefix}/c1/turn-0007.json`)).toBe(false);
    expect(await ownsAssetKey('vera@cloudflare.com', `${prefix}/c1/turn-0007-image-0.png`)).toBe(false);
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
