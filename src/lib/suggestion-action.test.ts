import { describe, it, expect } from 'vitest';
import { suggestionAction } from './suggestion-action';

describe('suggestionAction', () => {
  it('asks to connect first when the card needs an MCP server that is not connected', () => {
    expect(suggestionAction({ mcp: 'saas', experiment: 'sf-agg' }, [])).toBe('connect');
    expect(suggestionAction({ mcp: 'saas' }, ['cf-docs'])).toBe('connect');
    expect(suggestionAction({ mcp: 'saas', edit: false }, [])).toBe('connect');
  });

  it('fills the input for editing when a card is clicked', () => {
    expect(suggestionAction({}, [])).toBe('edit');
    expect(suggestionAction({ mcp: 'saas' }, ['saas'])).toBe('edit');
    expect(suggestionAction({ mcp: 'saas', experiment: 'sf-agg' }, ['saas'])).toBe('edit');
  });

  it('runs the comparison when the filled-in prompt is sent', () => {
    expect(suggestionAction({ mcp: 'saas', experiment: 'sf-agg', edit: false }, ['saas'])).toBe('compare');
  });

  it('sends everything else once the filled-in prompt is sent', () => {
    expect(suggestionAction({ edit: false }, [])).toBe('send');
    expect(suggestionAction({ mcp: 'saas', edit: false }, ['saas'])).toBe('send');
  });
});
