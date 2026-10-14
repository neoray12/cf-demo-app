import { describe, expect, it } from 'vitest';
import { codeModeIdentifier, describeTools, resolveCodeModeToolName } from './codemode';

const names = ['readWebPage', 'tool_saas-cm_portal_list_servers', 'tool_saas_salesforce-mcp_sf_list_accounts'];

describe('codeModeIdentifier', () => {
  it('turns MCP tool keys into valid JS identifiers', () => {
    expect(codeModeIdentifier('tool_saas-cm_portal_list_servers')).toBe('tool_saas_cm_portal_list_servers');
    expect(codeModeIdentifier('tool_saas_salesforce-mcp_sf_list_accounts')).toBe('tool_saas_salesforce_mcp_sf_list_accounts');
    expect(codeModeIdentifier('readWebPage')).toBe('readWebPage');
  });
});

describe('describeTools', () => {
  it('advertises identifier names the model can call with dot syntax', () => {
    const text = describeTools({ 'tool_saas-cm_portal_list_servers': { description: 'List servers\nmore' } });
    expect(text).toBe('  codemode.tool_saas_cm_portal_list_servers(args) — List servers');
  });
});

describe('resolveCodeModeToolName', () => {
  it('accepts the exact tool key', () => {
    expect(resolveCodeModeToolName('tool_saas-cm_portal_list_servers', names)).toBe('tool_saas-cm_portal_list_servers');
  });
  it('maps an identifier back to its tool key', () => {
    expect(resolveCodeModeToolName('tool_saas_cm_portal_list_servers', names)).toBe('tool_saas-cm_portal_list_servers');
    expect(resolveCodeModeToolName('tool_saas_salesforce_mcp_sf_list_accounts', names)).toBe('tool_saas_salesforce-mcp_sf_list_accounts');
  });
  it('rejects names that are not in the session', () => {
    expect(resolveCodeModeToolName('tool_other_thing', names)).toBeNull();
  });
});
