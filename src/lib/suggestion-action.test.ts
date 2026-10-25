import { describe, it, expect } from 'vitest';
import { suggestionAction } from './suggestion-action';

describe('suggestionAction', () => {
  it('asks to connect first when the card needs an MCP server that is not connected', () => {
    expect(suggestionAction({ mcp: 'saas', experiment: 'sf-agg' }, [])).toBe('connect');
    expect(suggestionAction({ mcp: 'saas' }, ['cf-docs'])).toBe('connect');
  });

  it('runs the comparison once the server is connected', () => {
    expect(suggestionAction({ mcp: 'saas', experiment: 'sf-agg' }, ['saas'])).toBe('compare');
  });

  it('just sends everything else', () => {
    expect(suggestionAction({}, [])).toBe('send');
    expect(suggestionAction({ mcp: 'saas' }, ['saas'])).toBe('send');
  });
});
