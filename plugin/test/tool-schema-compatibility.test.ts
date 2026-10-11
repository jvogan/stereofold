import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { MODEL_VISIBLE_TOOL_NAMES, REGISTERED_TOOL_NAMES } from '../scripts/tool-inventory.js';
import { sceneStylesSchema } from '../src/inspection-contract.js';

/** Check every branch, definition and nested property of the exported schema. */
function incompatibleArrays(node: unknown, path: string): string[] {
  if (!node || typeof node !== 'object') return [];
  const schema = node as Record<string, unknown>;
  const problems: string[] = [];
  if ('minItems' in schema) problems.push(`${path}.minItems`);
  if (Array.isArray(schema.items)) problems.push(`${path}.items (tuple)`);
  if ('prefixItems' in schema) problems.push(`${path}.prefixItems (tuple)`);
  // A homogeneous array's maxItems is a real budget and remains supported.
  // Tuple tails may export only maxItems without a homogeneous item schema.
  if ('maxItems' in schema && (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)))
    problems.push(`${path}.maxItems (tuple without homogeneous items)`);
  for (const [key, value] of Object.entries(schema)) {
    problems.push(...incompatibleArrays(value, Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`));
  }
  return problems;
}

/** Run `use` against a connected in-memory client of the real server. */
async function withClient<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(new URL('./unused-viewer.html', import.meta.url).pathname);
  const client = new Client({ name: 'schema compatibility test', version: '0.1.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await use(client);
  } finally { await client.close(); await server.close(); }
}

function modelVisible(tool: { _meta?: Record<string, unknown> }): boolean {
  const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
  return visibility === undefined || visibility.includes('model');
}

describe('Codex model-visible input schemas', () => {
  it('exports every model-visible tool without incompatible array shapes through MCP tools/list', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./unused-viewer.html', import.meta.url).pathname);
    const client = new Client({ name: 'schema compatibility test', version: '0.1.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      // This exercises the SDK's actual Zod -> JSON Schema export, including
      // the tool registration wrappers, rather than rebuilding input schemas.
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(REGISTERED_TOOL_NAMES);
      const visible = tools.filter(tool => {
        const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
        return visibility === undefined || visibility.includes('model');
      });
      expect(visible.map(tool => tool.name).sort()).toEqual(MODEL_VISIBLE_TOOL_NAMES);
      const problems = visible.flatMap(tool => incompatibleArrays(tool.inputSchema, `${tool.name}.inputSchema`));
      expect(problems, problems.join('\n')).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('reports nested tuple/minItems paths while allowing homogeneous geometry budgets', () => {
    expect(incompatibleArrays({ anyOf: [
      { type: 'array', items: { type: 'number' }, minItems: 3 },
      { type: 'array', items: [{ type: 'number' }] },
      { type: 'array', maxItems: 3 },
      { type: 'array', prefixItems: [{ type: 'number' }] },
    ] }, 'tool.inputSchema')).toEqual([
      'tool.inputSchema.anyOf[0].minItems',
      'tool.inputSchema.anyOf[1].items (tuple)',
      'tool.inputSchema.anyOf[2].maxItems (tuple without homogeneous items)',
      'tool.inputSchema.anyOf[3].prefixItems (tuple)',
    ]);
    expect(incompatibleArrays({ type: 'array', items: { type: 'string' }, maxItems: 20000 }, 'tool')).toEqual([]);
  });

  it('publishes the input fields of every model-visible tool that takes any', async () => {
    // The SDK lists a root that is not a Zod object as
    // {"type":"object","properties":{}}, which reads as a tool with no inputs.
    const { tools } = await withClient(client => client.listTools());
    const empty = tools.filter(modelVisible)
      .filter(tool => Object.keys(tool.inputSchema.properties ?? {}).length === 0).map(tool => tool.name);
    expect(empty).toEqual(['stereo_structure.list_experiences']);
  });

  it('lists every named-view field while the per-action union still decides what passes', async () => {
    await withClient(async client => {
      const { tools } = await client.listTools();
      const schema = tools.find(tool => tool.name === 'stereo_structure.manage_inspection_view')!.inputSchema as unknown as {
        properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: unknown };
      expect(Object.keys(schema.properties).sort()).toEqual(['action', 'baseInspectionRevision', 'baseStateRevision', 'commandId',
        'name', 'panelId', 'replaceViewId', 'serverEpoch', 'sessionId', 'sourceToken', 'utteranceId', 'viewId', 'viewRevision']);
      expect(schema.properties.action.enum).toEqual(['list', 'save', 'restore', 'delete', 'return-to-desktop']);
      expect(schema.required).toEqual(['action', 'sessionId']);
      expect(schema.additionalProperties).toBe(false);

      const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
      const binding = { sessionId: uuid(1), serverEpoch: uuid(2), baseStateRevision: 3, baseInspectionRevision: 4, sourceToken: uuid(5) };
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'stereo_structure.manage_inspection_view', arguments: args });
        return (result.content as Array<{ text: string }>)[0].text;
      };
      // Each action is still strict about its own fields: delete takes no panel,
      // save needs a name, and list still takes the state-query fields it ignores.
      expect(await call({ ...binding, action: 'delete', viewId: uuid(6), viewRevision: 1, panelId: uuid(7) }))
        .toMatch(/Input validation error[\s\S]*unrecognized_keys[\s\S]*panelId/);
      expect(await call({ ...binding, action: 'save', panelId: uuid(7), commandId: 'save-1' }))
        .toMatch(/Input validation error[\s\S]*"name"/);
      // A valid call passes validation and reaches the handler, which knows no
      // such session.
      expect(await call({ action: 'list', sessionId: uuid(1), includeExperienceCatalog: true }))
        .toMatch(/^Stereofold session was not found/);
    });
  });

  it('still rejects empty scoped selections and enforces the existing selection and style budgets', () => {
    const style = { selectionKeys: ['residue-1'], uniformColor: '#ff8800' };
    expect(sceneStylesSchema.safeParse([style]).success).toBe(true);
    expect(sceneStylesSchema.safeParse([{ ...style, selectionKeys: [] }]).success).toBe(false);
    expect(sceneStylesSchema.safeParse([{ ...style, selectionKeys: Array.from({ length: 20001 }, (_, i) => `residue-${i}`) }]).success).toBe(false);
    expect(sceneStylesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ ...style, selectionKeys: [`residue-${i}`] }))).success).toBe(false);
  });
});
