import { describe, it, expect } from 'vitest';
import { buildGatewayMetadata } from './gateway-metadata';

describe('buildGatewayMetadata', () => {
  it('carries exactly the five filterable keys', () => {
    const meta = JSON.parse(buildGatewayMetadata({ email: 'neo@cloudflare.com', codeMode: true, test: 'sf-agg' }));
    expect(meta).toEqual({ email: 'neo@cloudflare.com', usertier: 'regular', department: '技術', code_mode: true, test: 'sf-agg' });
    expect(Object.keys(meta)).toHaveLength(5);
  });

  it('fills defaults for an anonymous normal chat', () => {
    const meta = JSON.parse(buildGatewayMetadata({ codeMode: false }));
    expect(meta).toEqual({ email: 'unknown', usertier: 'regular', department: '業務', code_mode: false, test: 'none' });
  });

  it('marks VIP users', () => {
    expect(JSON.parse(buildGatewayMetadata({ email: 'vera@cloudflare.com', codeMode: false })).usertier).toBe('VIP');
  });

  it('keeps the header Latin-1 safe', () => {
    expect(buildGatewayMetadata({ email: 'neo@cloudflare.com', codeMode: false })).toMatch(/^[\x20-\x7E]*$/);
  });
});
