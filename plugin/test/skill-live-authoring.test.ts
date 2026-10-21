import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { expect, it } from 'vitest';

// Read the recipient's actual call blocks and edit code, not a parallel fixture.
const markdown = await readFile(new URL('../skills/molecular-presentation/references/live-authoring.md', import.meta.url), 'utf8');
const steps = [...markdown.matchAll(/^## \d+\. (\w+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(match => ({
  name: match[1], args: JSON.parse(match[2].match(/```json\n([\s\S]*?)\n```/)![1]),
}));
const editCode = markdown.match(/```javascript\n([\s\S]*?)\n```/)![1];
function substitute(value: any, values: Record<string, any>): any {
  if (typeof value === 'string' && value.startsWith('$')) {
    expect(values, `Unresolved example placeholder ${value}`).toHaveProperty(value.slice(1));
    return structuredClone(values[value.slice(1)]);
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, values)]));
  return value;
}
function textState(reply: any): any {
  const blocks = reply.content.flatMap((item: any) => {
    if (item.type !== 'text') return [];
    const raw = item.text.split('\n').filter((line: string) => line.startsWith('{')).map((line: string) => JSON.parse(line));
    return [...raw, ...[...item.text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))];
  });
  // Complete tool-specific JSON takes precedence over the bounded projection.
  blocks.sort((a: any, b: any) => Number(Boolean(b.textStateVersion)) - Number(Boolean(a.textStateVersion)));
  return Object.assign({}, ...blocks);
}

it('executes the shipped live-authoring example through dist MCP until rendering is required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stereofold-skill-example-'));
  let client: Client | undefined, server: any;
  try {
    // No source tree or workspace dependencies beside the runtime under test.
    await cp(new URL('../dist/', import.meta.url), join(dir, 'dist'), { recursive: true });
    await cp(new URL('../demos/', import.meta.url), join(dir, 'demos'), { recursive: true });
    const { createStereoStructureServer } = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'dist/server.mjs')).href);
    const coordinates = Object.fromEntries(await Promise.all(['1CRN', '4HHB'].map(async id =>
      [id, await readFile(new URL(`../../fixtures/${id}.cif`, import.meta.url), 'utf8')])));
    // This admission-only page has no heartbeat/render loop. Advance its
    // liveness clock explicitly, independently of real receipt-wait timers.
    // live-lesson.test.ts covers both live heartbeats and vanished pages.
    let now = 1_000_000;
    server = createStereoStructureServer(undefined, {
      now: () => now,
      fetchPdbText: async (id: string) => {
        if (!coordinates[id]) throw Error(`Unexpected download: ${id}`);
        return coordinates[id];
      },
      compositeCachePath: (file: string) => join(dir, 'cache', file),
      sceneServiceFile: join(dir, 'scene.json'),
    });
    client = new Client({ name: 'installed-skill-example', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    const listed = (await client.listTools()).tools;
    const validator = new AjvJsonSchemaValidator();
    const schemas = new Map(listed.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
    const call = async (name: string, args: any): Promise<any> => {
      const validation = schemas.get(`stereo_structure.${name}`)!(args);
      expect(validation.valid, `${name}: ${validation.errorMessage}`).toBe(true);
      return client!.callTool({ name: `stereo_structure.${name}`, arguments: args });
    };
    const ok = (reply: any) => { expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true); return textState(reply); };
    expect(steps.map(step => step.name)).toEqual(['prepare_composite', 'inspect_lesson', 'open_inspector',
      'get_readiness', 'get_inspection_state', 'control_tour', 'install_lesson', 'get_inspection_state']);
    const values: Record<string, any> = {};
    const prepared = ok(await call(steps[0].name, steps[0].args));
    expect(prepared.bodies.map((body: any) => body.chain)).toEqual(['C', 'H']);
    expect(prepared.atomSites).toBeGreaterThan(327);
    expect(prepared.atomSites).toBeLessThanOrEqual(5000);
    Object.assign(values, { source: prepared.source, sha256: prepared.sha256 });
    const opening = substitute(steps[1].args, values);
    const opened = ok(await call(steps[1].name, opening));
    expect(opened).toMatchObject({ sourceKind: 'composite', hasScene: false, customTourId: 'lesson-crambin-pair' });
    Object.assign(values, { sessionId: opened.sessionId, tourId: opened.customTourId });
    const editedLesson = new Function('lesson', `${editCode}\nreturn editedLesson;`)(opening.lesson);
    values.editedLesson = editedLesson;
    expect(editedLesson.chapters[0].immersive.figure.labels[0].text).toBe('Hinge domain');
    expect(editedLesson.chapters[0].animation.tracks[0].keyframes[1].t).toBe(2);

    // open_inspector starts a loopback listener/browser. Validate its exact
    // arguments against the bundled schema, but never launch one in this test.
    const browserArgs = substitute(steps[2].args, values);
    expect(schemas.get('stereo_structure.open_inspector')!(browserArgs).valid).toBe(true);
    const readiness = ok(await call(steps[3].name, substitute(steps[3].args, values)));
    expect(readiness.readiness.items.find((item: any) => item.capability === 'structure').state).toBe('missing');
    const before = ok(await call(steps[4].name, substitute(steps[4].args, values)));
    expect(before.hasScene).toBe(false);
    const refused = await call(steps[5].name, substitute(steps[5].args, values));
    expect(refused.isError).toBe(true); // A source alone must not claim a render.

    // Synthetic saved panel: admission only, with no complete_inspection calls
    // and no invented rendered receipt. This permits real runtime validation of
    // control_tour and install_lesson beyond their published input schemas.
    const hydration = (await call('get_inspection', { sessionId: values.sessionId }))._meta['stereo_structure/inspection'];
    const binding = { sessionId: values.sessionId, serverEpoch: hydration.serverEpoch, sourceToken: hydration.sourceToken,
      baseStateRevision: hydration.stateRevision, baseInspectionRevision: hydration.inspectionRevision };
    const scene = { sourceSha256: prepared.sha256, modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
        radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    const saved = await call('sync_inspection', { ...binding, scene });
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true);
    binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
    const attached = await call('attach_inspection', { ...binding, surface: 'desktop' });
    expect(attached.isError, JSON.stringify(attached.content)).not.toBe(true);
    const started = ok(await call(steps[5].name, substitute(steps[5].args, values)));
    expect(started.command.status).toBe('queued');
    // No renderer can complete start here. Expire that undelivered command,
    // then independently check install admission in the same saved session.
    // The documented live path instead requires the rendered start receipt.
    now += 16000;
    const expired = ok(await call('get_inspection_state', { sessionId: values.sessionId, commandId: started.commandId }));
    expect(expired.command.status).toBe('expired');
    const reattached = await call('attach_inspection', { ...binding, surface: 'desktop' });
    expect(reattached.isError, JSON.stringify(reattached.content)).not.toBe(true);
    // Preserve the example's real waitForRenderMs. The simulated page does
    // not age during that host wait; only the explicit 16 s above expires it.
    const installing = ok(await call(steps[6].name, substitute(steps[6].args, values)));
    expect(installing.command.status).toBe('queued');
    values.commandId = installing.commandId;
    const after = ok(await call(steps[7].name, substitute(steps[7].args, values)));
    expect(after.command.commandId).toBe(values.commandId);
    expect(after.command.status).not.toBe('rendered');
    // Manifest commits only on renderer completion. Text-only readback must
    // still expose the original until then, including pivot and distance.
    expect(after.lessonManifest.chapters[0].immersive.figure.labels[0].text).toBe('Moving residues 1–10');
    expect(after.lessonManifest.chapters[0].animation.tracks[0].pivot).toEqual([16.967, 12.784, 4.338]);
    expect(after.lessonManifest.chapters[0].immersive.figure.distances).toHaveLength(1);
  } finally {
    await client?.close(); await server?.close(); await rm(dir, { recursive: true, force: true });
  }
}, 60000);
