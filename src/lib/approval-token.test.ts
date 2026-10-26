import { describe, it, expect } from 'vitest';
import { signApprovalLink, verifyApprovalLink } from './approval-token';

const SECRET = 'test-secret';

describe('approval link token', () => {
  it('verifies a token for the same approval before it expires', async () => {
    const t = await signApprovalLink(SECRET, 'apr_1', 1_000_000);
    expect(await verifyApprovalLink(SECRET, 'apr_1', t, 999_999)).toBe(true);
  });

  it('rejects another approval id, a wrong secret, a tampered or expired token', async () => {
    const t = await signApprovalLink(SECRET, 'apr_1', 1_000_000);
    expect(await verifyApprovalLink(SECRET, 'apr_2', t, 0)).toBe(false);
    expect(await verifyApprovalLink('other', 'apr_1', t, 0)).toBe(false);
    expect(await verifyApprovalLink(SECRET, 'apr_1', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 0)).toBe(false);
    expect(await verifyApprovalLink(SECRET, 'apr_1', t, 1_000_001)).toBe(false);
    expect(await verifyApprovalLink(SECRET, 'apr_1', 'garbage', 0)).toBe(false);
    expect(await verifyApprovalLink(SECRET, 'apr_1', null, 0)).toBe(false);
  });
});
