// What a home-page suggestion card does when clicked.

export type SuggestionAction = 'connect' | 'compare' | 'edit' | 'send';

/**
 * 'connect' — its MCP server isn't connected: fill the input and open the MCP
 * panel instead of sending; 'edit' — a click fills the input so the prompt can
 * be changed first; sending it re-runs this with `edit: false` (the card's
 * options still apply): 'compare' — the Code Mode comparison example (two
 * runs); 'send' — a normal turn.
 */
export function suggestionAction(opts: { mcp?: string; experiment?: string; edit?: boolean }, connected: string[]): SuggestionAction {
  if (opts.mcp && !connected.includes(opts.mcp)) return 'connect';
  if (opts.edit !== false) return 'edit';
  return opts.experiment ? 'compare' : 'send';
}
