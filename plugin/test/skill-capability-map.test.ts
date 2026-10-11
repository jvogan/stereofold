/**
 * The capability map in `skills/stereo-structure/SKILL.md` is the table an
 * agent reads mid-session to answer a wearer without deriving the call from
 * the schema first. A row that names a tool the server does not register, an
 * argument the tool refuses, a tour action the contract does not accept or a
 * spoken phrase the grammar never matches is worse than no row at all: it is
 * read while somebody is wearing the headset.
 *
 * So the table is parsed here and checked against the running server's own
 * tool list, the inspection contract, the tour catalog and the fixed voice
 * grammar. The map cannot drift from the code without this failing.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { tourActionSchema, updateInspectionSchema } from '../src/inspection-contract.js';
import { TOURS } from '../src/tour-catalog.js';
// @ts-ignore Shared JavaScript grammar module, the same one the headset runs.
import { voiceCommandFromTranscript } from '../../lab/browser-roundtrip/voice-command.mjs';

const SKILL_PATH = new URL('../skills/stereo-structure/references/commands.md', import.meta.url);
const POINTER_PATH = new URL('../claude-code/skills/stereofold-quest/SKILL.md', import.meta.url);
const SECTION_HEADING = '## Tool examples';
const PHRASE_LEAD = 'These fixed phrases work without you';

/** Fields the standalone host's CLI fills in from `get_inspection_state`. */
const FILLED_BY_THE_CLI = new Set(['sessionId', 'serverEpoch', 'sourceToken',
  'baseStateRevision', 'baseInspectionRevision', 'panelId', 'commandId']);

type Row = { group: string; want: string; tool: string | undefined; args: unknown; raw: string };

const skill = readFileSync(SKILL_PATH, 'utf8');

/** The one fenced code span in a table cell, or undefined for a prose cell. */
function code(cell: string): string | undefined {
  return /`([^`]+)`/u.exec(cell)?.[1];
}

function capabilityRows(markdown: string): Row[] {
  const section = markdown.slice(markdown.indexOf(SECTION_HEADING));
  expect(section.startsWith(SECTION_HEADING)).toBe(true);
  const rows: Row[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) { if (rows.length > 0) break; continue; }
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 4 || cells[0] === 'Group' || /^-+$/u.test(cells[0])) continue;
    const tool = code(cells[2]);
    const argument = code(cells[3]);
    rows.push({ group: cells[0], want: cells[1], tool, raw: cells[3],
      args: argument !== undefined && argument.startsWith('{') ? JSON.parse(argument) : undefined });
  }
  return rows;
}

/** The quoted phrases in the one paragraph that claims they are recognized. */
function quotedPhrases(markdown: string): string[] {
  const start = markdown.indexOf(PHRASE_LEAD);
  expect(start).toBeGreaterThan(-1);
  const paragraph = markdown.slice(start, markdown.indexOf('\n\n', start));
  return [...paragraph.matchAll(/"([^"]+)"/gu)].map(match => match[1]);
}

const rows = capabilityRows(skill);
const argumentsOf = (tool: string) => rows.filter(row => row.tool === tool && row.args !== undefined)
  .map(row => row.args as Record<string, unknown>);

describe('the headset capability map', () => {
  let client: Client;
  let server: ReturnType<typeof createStereoStructureServer>;
  let listed: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', new URL('..', import.meta.url)).pathname);
    client = new Client({ name: 'Stereofold capability map test', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    listed = (await client.listTools()).tools as typeof listed;
  });

  afterAll(async () => { await client.close(); await server.close(); });

  it('has rows in every group the wearer can reach', () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(new Set(rows.map(row => row.group))).toEqual(new Set(
      ['Talk', 'Motion', 'Tour', 'Look', 'Move', 'Source', 'Room', 'Mol*', 'Session', 'Eyes', 'Voice']));
  });

  it('names only tools this server registers', () => {
    const names = new Set(listed.map(tool => tool.name));
    for (const row of rows) {
      if (row.tool === undefined) continue;
      expect(names, `${row.group}: ${row.want}`).toContain(`stereo_structure.${row.tool}`);
    }
    // The one row with no tool has to say so rather than leaving a blank cell.
    for (const row of rows.filter(row => row.tool === undefined)) expect(row.raw.length).toBeGreaterThan(20);
  });

  it('sends only arguments those tools accept', () => {
    for (const row of rows) {
      if (row.tool === undefined || row.args === undefined) continue;
      const tool = listed.find(entry => entry.name === `stereo_structure.${row.tool}`);
      const properties = Object.keys(tool?.inputSchema?.properties ?? {});
      expect(properties.length, row.tool).toBeGreaterThan(0);
      for (const key of Object.keys(row.args as Record<string, unknown>)) {
        expect(properties, `${row.tool} argument ${key}`).toContain(key);
      }
    }
  });

  it('leaves the binding fields to the caller', () => {
    for (const row of rows) {
      // `get_inspection_state` is the exception: there a commandId is the
      // receipt being asked about, not a binding field anything fills in.
      if (row.tool === 'get_inspection_state' || row.tool === 'open_inspector') continue;
      for (const key of Object.keys((row.args ?? {}) as Record<string, unknown>)) {
        expect(FILLED_BY_THE_CLI, `${row.tool} should not pin ${key}`).not.toContain(key);
      }
    }
  });

  it('carries change kinds the inspection contract accepts', () => {
    const kinds = new Set<string>();
    for (const args of argumentsOf('update_inspection')) {
      const change = updateInspectionSchema.shape.change.parse(args.change);
      kinds.add(change.kind);
    }
    expect(kinds).toEqual(new Set(['appearance', 'placement', 'motion', 'render-quality', 'visibility', 'compound']));
  });

  it('carries tour actions the contract accepts, and a tour that exists', () => {
    const actions = new Set<string>();
    for (const args of argumentsOf('control_tour')) {
      const patch = tourActionSchema.parse(args);
      actions.add(patch.action);
      if (patch.tourId) expect(TOURS.map(tour => tour.id)).toContain(patch.tourId);
    }
    expect(actions).toEqual(new Set(['play', 'pause', 'next', 'back', 'start', 'menu']));
  });

  it('quotes only phrases the fixed grammar matches', () => {
    const phrases = quotedPhrases(readFileSync(new URL('../skills/stereo-structure/references/voice.md', import.meta.url), 'utf8'));
    expect(phrases.length).toBeGreaterThanOrEqual(20);
    for (const phrase of phrases) {
      expect(voiceCommandFromTranscript(phrase), `"${phrase}" is not in the grammar`).toBeDefined();
    }
  });

  it('is pointed at from the Claude Code quest skill', () => {
    const pointer = readFileSync(POINTER_PATH, 'utf8');
    expect(pointer).toContain('relevant references');
    expect(pointer).toContain('skills/stereo-structure/SKILL.md');
  });
});
