// What a home-page suggestion card does when clicked.

export type SuggestionAction = 'connect' | 'compare' | 'edit' | 'send';

/**
 * 'connect' — its MCP server isn't connected: fill the input and open the MCP
 * panel instead of sending; 'compare' — the Code Mode comparison example (two
 * runs); 'edit' — fill the input so the prompt can be changed before sending
 * (the card's options still apply when it is sent); 'send' — a normal turn.
 */
export function suggestionAction(opts: { mcp?: string; experiment?: string; edit?: boolean }, connected: string[]): SuggestionAction {
  if (opts.mcp && !connected.includes(opts.mcp)) return 'connect';
  if (opts.experiment) return 'compare';
  return opts.edit ? 'edit' : 'send';
}
