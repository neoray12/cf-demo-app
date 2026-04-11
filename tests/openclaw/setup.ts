/**
 * Shared helpers for OpenClaw E2E tests.
 *
 * Environment variables:
 *   TEST_BASE_URL       — cf-demo-app API base (default: http://localhost:3000)
 *   TEST_SANDBOX_URL    — companion worker base (default: from .dev.vars or production URL)
 *   TEST_SANDBOX_SECRET — companion worker shared secret (default: from .dev.vars)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadDevVars(): Record<string, string> {
  try {
    const content = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const devVars = loadDevVars();

export const BASE_URL =
  process.env.TEST_BASE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

export const SANDBOX_URL =
  (process.env.TEST_SANDBOX_URL || devVars.OPENCLAW_SANDBOX_URL || '')
    .replace(/\/$/, '');

export const SANDBOX_SECRET =
  process.env.TEST_SANDBOX_SECRET || devVars.OPENCLAW_SANDBOX_SECRET || '';

export const TEST_OWNER = {
  name: 'E2E Test',
  email: 'e2e-test@cloudflare.com',
};

// ---------------------------------------------------------------------------
// Shared test state (persisted to temp file across Vitest processes)
// ---------------------------------------------------------------------------

export interface TestState {
  instanceId: string;
  gatewayToken: string;
  slug: string;
}

const STATE_FILE = resolve(process.cwd(), 'node_modules/.cache/openclaw-e2e-state.json');

export function getTestState(): TestState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { instanceId: '', gatewayToken: '', slug: '' };
}

export function setTestState(partial: Partial<TestState>) {
  const current = getTestState();
  const next = { ...current, ...partial };
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
}

export function clearTestState() {
  try {
    if (existsSync(STATE_FILE)) {
      writeFileSync(STATE_FILE, JSON.stringify({ instanceId: '', gatewayToken: '', slug: '' }));
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Fetch cf-demo-app API route */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, init);
}

/** Fetch companion worker with auth header */
export async function sandbox(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SANDBOX_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SANDBOX_SECRET}`,
      ...(init?.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  label?: string;
}

/**
 * Poll `fn` until it returns a truthy value or timeout.
 * Returns the last result from `fn`.
 */
export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  opts: PollOptions = {},
): Promise<T> {
  const { intervalMs = 5_000, timeoutMs = 180_000, label = 'poll' } = opts;
  const start = Date.now();
  let last: T;

  while (true) {
    last = await fn();
    if (predicate(last)) return last;

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[${label}] Timeout after ${timeoutMs / 1000}s. Last value: ${JSON.stringify(last)}`,
      );
    }

    await sleep(intervalMs);
  }
}

/** Wait for instance status via cf-demo-app API */
export async function waitForStatus(
  instanceId: string,
  target: string | string[],
  timeoutMs = 180_000,
): Promise<any> {
  const targets = Array.isArray(target) ? target : [target];
  return poll(
    async () => {
      const res = await api(`/api/openclaw/instances/${instanceId}`);
      const data = await res.json() as any;
      return data.instance;
    },
    (inst) => targets.includes(inst?.status),
    { timeoutMs, label: `waitForStatus(${targets.join('|')})` },
  );
}

/** Wait for gateway ready via companion worker */
export async function waitForGateway(
  instanceId: string,
  timeoutMs = 180_000,
): Promise<any> {
  return poll(
    async () => {
      const res = await sandbox(`/api/status/${instanceId}`);
      return res.json();
    },
    (data: any) => data?.gatewayReady === true,
    { timeoutMs, label: 'waitForGateway' },
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueSlug() {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
