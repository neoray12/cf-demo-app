// What a home-page suggestion card does when clicked.

export type SuggestionAction = 'connect' | 'compare' | 'send';

/**
 * 'connect' — its MCP server isn't connected: fill the input and open the MCP
 * panel instead of sending; 'compare' — the Code Mode comparison example (two
 * runs); 'send' — a normal turn.
 */
export function suggestionAction(opts: { mcp?: string; experiment?: string }, connected: string[]): SuggestionAction {
  if (opts.mcp && !connected.includes(opts.mcp)) return 'connect';
  return opts.experiment ? 'compare' : 'send';
}
