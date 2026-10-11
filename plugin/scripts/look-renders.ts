/**
 * Render every Colour and every Style option and measure what came out.
 *
 * The check is one render per option, looked at, with any
 * option that comes out black, white or unchanged named. "Looked at" needs a
 * number to go with the eye, so each render is reduced to four: how much of
 * the frame is lit, the mean luma of the lit part, how many distinct colours
 * it carries, and how many pixels differ from the render before it. A black
 * option has no lit pixels, a white one has mean luma near 255 with no
 * saturation, and an unchanged one differs from its neighbour in nothing.
 *
 * Three other claims are measured here rather than asserted:
 *
 * - **The camera must not move on a colour change.** Recorded as the camera
 *   position and target either side of every colour apply.
 * - **A non-Chain colour survives an anaglyph round trip.** Rendered before
 *   anaglyph and after coming back, and compared pixel by pixel.
 * - **Both eyes get the same colour theme.** At Depth 0 the two eye images are
 *   geometrically identical, so the two halves of a parallel pair must be
 *   pixel-identical; at Depth 20 they are compared by colour histogram.
 *
 * Phase two loads the same structure into an ordinary page — no acceptance
 * hook — drives the two real `<select>` elements, and screenshots the panel so
 * the drawer's Look group can be checked against the design mockups.
 *
 * Run: `tsx scripts/look-renders.ts --structure path/to/1crn.pdb --out dir`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { LOOK_COLOR_OPTIONS, LOOK_STYLE_OPTIONS, type LookColor, type LookStyle } from '../src/look.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

type Rgba = { width: number; height: number; data: Uint8Array };

function decodePng(source: Buffer): Rgba {
  let cursor = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (cursor < source.length) {
    const length = source.readUInt32BE(cursor);
    const type = source.subarray(cursor + 4, cursor + 8).toString('ascii');
    const content = source.subarray(cursor + 8, cursor + 8 + length);
    cursor += 12 + length;
    if (type === 'IHDR') {
      width = content.readUInt32BE(0);
      height = content.readUInt32BE(4);
      colorType = content[9] ?? -1;
    } else if (type === 'IDAT') idat.push(content);
    else if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const decoded = new Uint8Array(width * height * 4);
  let input = 0;
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const byte = raw[input++] ?? 0;
      const left = x >= channels ? row[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      if (filter === 0) row[x] = byte;
      else if (filter === 1) row[x] = (byte + left) & 255;
      else if (filter === 2) row[x] = (byte + up) & 255;
      else if (filter === 3) row[x] = (byte + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (byte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      decoded[to] = row[from]!;
      decoded[to + 1] = row[from + 1]!;
      decoded[to + 2] = row[from + 2]!;
      decoded[to + 3] = channels === 4 ? row[from + 3]! : 255;
    }
    previous = row;
  }
  return { width, height, data: decoded };
}

/**
 * A pixel counts as scene content when it is brighter than the stage ground.
 *
 * The mono/parallel ground is `#071015`, whose brightest channel is 21, and
 * the anaglyph ground is exact black. 32 clears both with room for the
 * ground's own antialiasing.
 */
const LIT_THRESHOLD = 32;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type ImageStats = {
  litFraction: number;
  meanLuma: number;
  meanSaturation: number;
  distinctColours: number;
  maxChannel: number;
};

/** Reduce a render to the four numbers that separate a good frame from a dud. */
function imageStats(image: Rgba, fromX = 0, toX = image.width): ImageStats {
  const seen = new Set<number>();
  let lit = 0;
  let lumaSum = 0;
  let saturationSum = 0;
  let maxChannel = 0;
  let total = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = fromX; x < toX; x++) {
      const at = (y * image.width + x) * 4;
      const r = image.data[at]!;
      const g = image.data[at + 1]!;
      const b = image.data[at + 2]!;
      total += 1;
      const high = Math.max(r, g, b);
      if (high > maxChannel) maxChannel = high;
      if (high <= LIT_THRESHOLD) continue;
      lit += 1;
      lumaSum += luma(r, g, b);
      saturationSum += high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
      // Quantised to 5 bits a channel: shading gradients do not each count as
      // their own colour, but two different themes do.
      seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  return {
    litFraction: total === 0 ? 0 : lit / total,
    meanLuma: lit === 0 ? 0 : lumaSum / lit,
    meanSaturation: lit === 0 ? 0 : saturationSum / lit,
    distinctColours: seen.size,
    maxChannel,
  };
}

/** Fraction of pixels whose colour differs by more than a couple of codes. */
function differingFraction(a: Rgba, b: Rgba, tolerance = 4): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i]! - b.data[i]!);
    const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!);
    const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    if (Math.max(dr, dg, db) > tolerance) differing += 1;
  }
  return differing / (a.data.length / 4);
}

/** Largest per-channel difference between the two halves of a stereo pair. */
function eyeHalfDelta(image: Rgba): { maxDelta: number; differingFraction: number } {
  const half = Math.floor(image.width / 2);
  let maxDelta = 0;
  let differing = 0;
  let counted = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < half; x++) {
      const left = (y * image.width + x) * 4;
      const right = (y * image.width + x + half) * 4;
      let delta = 0;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(image.data[left + c]! - image.data[right + c]!));
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 4) differing += 1;
      counted += 1;
    }
  }
  return { maxDelta, differingFraction: counted === 0 ? 0 : differing / counted };
}

/**
 * Chi-square distance between the two eyes' colour histograms.
 *
 * The two eyes see the structure from slightly different angles, so their
 * pixels are never identical at a non-zero depth budget. What must match is
 * the palette: the same theme applied to both. 32 bins a channel.
 */
function eyeHistogramDistance(image: Rgba): number {
  const half = Math.floor(image.width / 2);
  const bins = 32 * 32 * 32;
  const left = new Float64Array(bins);
  const right = new Float64Array(bins);
  let leftTotal = 0;
  let rightTotal = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4;
      const r = image.data[at]!;
      const g = image.data[at + 1]!;
      const b = image.data[at + 2]!;
      if (Math.max(r, g, b) <= LIT_THRESHOLD) continue;
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (x < half) { left[bin]! += 1; leftTotal += 1; } else { right[bin]! += 1; rightTotal += 1; }
    }
  }
  if (leftTotal === 0 || rightTotal === 0) return 1;
  let distance = 0;
  for (let bin = 0; bin < bins; bin++) {
    const p = left[bin]! / leftTotal;
    const q = right[bin]! / rightTotal;
    if (p + q > 0) distance += ((p - q) * (p - q)) / (p + q);
  }
  return distance / 2;
}

/**
 * A three-residue mmCIF that says it is experimental.
 *
 * The Confidence choice resolves through Mol*'s own applicability test, whose
 * negative branch 1CRN cannot exercise: `Model.isExperimental` reads
 * `_struct.pdbx_structure_determination_methodology`, which only an mmCIF
 * carries, so a PDB-parsed file is never "experimental" and always takes the
 * pLDDT branch. This is the smallest input that takes the other one.
 */
const EXPERIMENTAL_MMCIF = [
  'data_XPTL',
  '_struct.entry_id XPTL',
  '_struct.pdbx_structure_determination_methodology experimental',
  'loop_',
  '_atom_site.group_PDB',
  '_atom_site.id',
  '_atom_site.type_symbol',
  '_atom_site.label_atom_id',
  '_atom_site.label_comp_id',
  '_atom_site.label_asym_id',
  '_atom_site.label_entity_id',
  '_atom_site.label_seq_id',
  '_atom_site.Cartn_x',
  '_atom_site.Cartn_y',
  '_atom_site.Cartn_z',
  '_atom_site.occupancy',
  '_atom_site.B_iso_or_equiv',
  '_atom_site.auth_seq_id',
  '_atom_site.auth_asym_id',
  '_atom_site.pdbx_PDB_model_num',
  'ATOM 1 N N ALA A 1 1 0.000 0.000 0.000 1.00 20.00 1 A 1',
  'ATOM 2 C CA ALA A 1 1 1.450 0.250 0.100 1.00 21.00 1 A 1',
  'ATOM 3 C C ALA A 1 1 2.000 1.650 0.300 1.00 22.00 1 A 1',
  'ATOM 4 O O ALA A 1 1 1.350 2.650 0.350 1.00 23.00 1 A 1',
  'ATOM 5 N N GLY A 1 2 3.250 1.800 0.500 1.00 24.00 2 A 1',
  'ATOM 6 C CA GLY A 1 2 4.000 3.050 0.750 1.00 25.00 2 A 1',
  'ATOM 7 C C GLY A 1 2 5.450 2.750 0.900 1.00 26.00 2 A 1',
  'ATOM 8 O O GLY A 1 2 6.100 3.700 1.100 1.00 27.00 2 A 1',
  'ATOM 9 N N SER A 1 3 5.950 1.500 0.750 1.00 28.00 3 A 1',
  'ATOM 10 C CA SER A 1 3 7.300 1.050 0.900 1.00 29.00 3 A 1',
  'ATOM 11 C C SER A 1 3 8.300 2.100 1.200 1.00 30.00 3 A 1',
  'ATOM 12 O O SER A 1 3 9.500 1.850 1.300 1.00 31.00 3 A 1',
  '#',
].join('\n');

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
}

async function settle(page: Page, frames = 8): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, frames);
  await page.waitForTimeout(260);
}

type Pose = { position: [number, number, number]; target: [number, number, number] };

function poseDelta(a: Pose, b: Pose): number {
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    worst = Math.max(worst, Math.abs(a.position[i]! - b.position[i]!), Math.abs(a.target[i]! - b.target[i]!));
  }
  return worst;
}

type Row = {
  kind: 'colour' | 'style';
  label: string;
  choice: string;
  appliedColorTheme: string;
  representationThemes: string[];
  file: string;
  stats: ImageStats;
  differsFromPreviousFraction: number;
  cameraMovedAngstrom: number;
  sceneRadiusAngstrom: number;
  sceneRadiusBeforeAngstrom: number;
  verdict: string;
};

function verdictFor(stats: ImageStats, differs: number, isFirst: boolean): string {
  const notes: string[] = [];
  if (stats.litFraction < 0.001) notes.push('BLACK: nothing drawn');
  if (stats.meanLuma > 240 && stats.meanSaturation < 0.05) notes.push('WHITE: washed out');
  if (!isFirst && differs < 0.001) notes.push('UNCHANGED from the previous option');
  return notes.length === 0 ? 'ok' : notes.join('; ');
}

async function main(): Promise<void> {
  const structurePath = arg('structure', '');
  if (structurePath === '') throw new Error('pass --structure path/to/1crn.pdb');
  const structureText = await readFile(structurePath, 'utf8');
  // A structure carrying HETATM ligands, waters or non-standard residues, so
  // the one thing 1CRN cannot show can be checked: Chain colours the polymer
  // by chain and leaves everything else on the preset's element colouring.
  const ligandPath = arg('ligand-structure', '');
  const ligandText = ligandPath === '' ? undefined : await readFile(ligandPath, 'utf8');
  const outDir = arg('out', resolve(pluginRoot, 'reports/looks'));
  await mkdir(outDir, { recursive: true });
  const viewerUrl = pathToFileURL(resolve(pluginRoot, 'dist/viewer.html')).href;

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const rows: Row[] = [];
  const extra: Record<string, unknown> = {};
  try {
    /* ---------------------------------------- phase one: one render per option */
    const context = await browser.newContext({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await page.addInitScript(() => { globalThis.__stereoStructureAcceptanceMode = true; });
    await page.goto(viewerUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__stereoStructureAcceptance?.state().webgl2 === true, undefined, { timeout: 40_000 });
    // From here the shipped fit, cap, refit and look paths are the ones running.
    await page.evaluate(() => { globalThis.__stereoStructureAcceptanceMode = false; });
    await page.evaluate((text) => window.__stereoStructureAcceptance!.loadShipped(text), structureText);
    await page.evaluate(() => window.__stereoStructureAcceptance!.setMode('off', 20, false));
    await settle(page, 14);

    const canvas = page.locator('#molstar-stage canvas').first();
    await canvas.waitFor({ state: 'visible' });
    const shoot = async (file: string): Promise<Rgba> => {
      const buffer = await canvas.screenshot({ animations: 'disabled', path: resolve(outDir, file) });
      return decodePng(buffer);
    };
    const readState = () => page.evaluate(() => {
      const state = window.__stereoStructureAcceptance!.state();
      return {
        look: state.look,
        pose: { position: state.pose.position, target: state.pose.target } as Pose,
        radius: state.camera.boundingRadius,
      };
    });
    /**
     * Wait for the scene to stop moving before reading a pose.
     *
     * A style change moves the visible bounding sphere, and the refit that
     * follows runs one frame later from `updateReadout`. Reading the pose
     * before that has landed attributes the previous row's refit to this one.
     */
    const quiesce = async (): Promise<Awaited<ReturnType<typeof readState>>> => {
      let previousKey = '';
      let stable = 0;
      let last = await readState();
      for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
        await settle(page, 3);
        last = await readState();
        const key = `${last.radius.toFixed(6)}|${last.pose.position.map((v) => v.toFixed(6)).join(',')}`;
        stable = key === previousKey ? stable + 1 : 0;
        previousKey = key;
      }
      return last;
    };
    const themesNow = async (): Promise<string[]> => (await readState()).look.representations
      .map((representation) => `${representation.type}:${representation.colorTheme}`)
      .sort();

    let previous: Rgba | undefined;
    for (const [index, option] of LOOK_COLOR_OPTIONS.entries()) {
      const before = await quiesce();
      await page.evaluate((color) => window.__stereoStructureAcceptance!.setLook({ color: color as LookColor }), option.value);
      const after = await quiesce();
      const file = `colour-${index + 1}-${option.value}.png`;
      const image = await shoot(file);
      const stats = imageStats(image);
      const differs = previous == null ? 1 : differingFraction(previous, image);
      rows.push({
        kind: 'colour',
        label: option.label,
        choice: option.value,
        appliedColorTheme: after.look.appliedColorTheme,
        representationThemes: await themesNow(),
        file,
        stats,
        differsFromPreviousFraction: differs,
        cameraMovedAngstrom: poseDelta(before.pose, after.pose),
        sceneRadiusAngstrom: after.radius,
        sceneRadiusBeforeAngstrom: before.radius,
        verdict: verdictFor(stats, differs, index === 0),
      });
      previous = image;
    }
    extra.plddtApplicable = (await readState()).look.plddtApplicable;


    // Back to the default look, so the style rows start from a known state and
    // the first of them is a genuine no-op rather than an undo of whatever ran
    // before it.
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'chain-id' as LookColor, style: 'polymer-and-ligand' as LookStyle }));
    await quiesce();
    previous = undefined;
    for (const [index, option] of LOOK_STYLE_OPTIONS.entries()) {
      const before = await quiesce();
      await page.evaluate((style) => window.__stereoStructureAcceptance!.setLook({ style: style as LookStyle }), option.value);
      const after = await quiesce();
      const file = `style-${index + 1}-${option.value}.png`;
      const image = await shoot(file);
      const stats = imageStats(image);
      const differs = previous == null ? 1 : differingFraction(previous, image);
      rows.push({
        kind: 'style',
        label: option.label,
        choice: option.value,
        appliedColorTheme: after.look.appliedColorTheme,
        representationThemes: await themesNow(),
        file,
        stats,
        differsFromPreviousFraction: differs,
        cameraMovedAngstrom: poseDelta(before.pose, after.pose),
        sceneRadiusAngstrom: after.radius,
        sceneRadiusBeforeAngstrom: before.radius,
        verdict: verdictFor(stats, differs, index === 0),
      });
      previous = image;
    }

    /*
     * Chain and Element come out pixel-identical on a single-chain polymer
     * with no ligands: both are one flat colour on the cartoon. That is a
     * property of 1CRN, not of the control, so the same two colours are
     * rendered again on Ball and stick, where every atom is drawn and the two
     * themes cannot agree.
     */
    const crossCheck: Record<string, unknown> = {};
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'chain-id' as LookColor, style: 'polymer-and-ligand' as LookStyle }));
    await settle(page, 14);
    crossCheck.cartoonChainThemes = await themesNow();
    const cartoonChain = await shoot('crosscheck-1-cartoon-chain.png');
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'element-symbol' as LookColor }));
    await settle(page, 14);
    crossCheck.cartoonElementThemes = await themesNow();
    const cartoonElement = await shoot('crosscheck-2-cartoon-element.png');
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ style: 'atomic-detail' as LookStyle }));
    await settle(page, 16);
    crossCheck.atomicElementThemes = await themesNow();
    const atomicElement = await shoot('crosscheck-3-atomic-element.png');
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'chain-id' as LookColor }));
    await settle(page, 16);
    crossCheck.atomicChainThemes = await themesNow();
    const atomicChain = await shoot('crosscheck-4-atomic-chain.png');
    crossCheck.cartoonChainVsElement = differingFraction(cartoonChain, cartoonElement);
    crossCheck.atomicChainVsElement = differingFraction(atomicChain, atomicElement);
    crossCheck.atomicElementStats = imageStats(atomicElement);
    crossCheck.atomicChainStats = imageStats(atomicChain);
    extra.chainVersusElement = crossCheck;

    /* ------------------------------- the anaglyph round trip keeps the choice */
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'chain-id' as LookColor, style: 'polymer-and-ligand' as LookStyle }));
    await settle(page, 12);
    await page.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'secondary-structure' as LookColor }));
    await settle(page, 12);
    const beforeAnaglyph = await shoot('roundtrip-1-secondary-structure-before.png');
    const themeBefore = (await readState()).look.appliedColorTheme;
    await page.evaluate(() => window.__stereoStructureAcceptance!.setMode('anaglyph', 20, false));
    await settle(page, 14);
    const inAnaglyph = await shoot('roundtrip-2-anaglyph.png');
    const themeInAnaglyph = (await readState()).look.appliedColorTheme;
    await page.evaluate(() => window.__stereoStructureAcceptance!.setMode('off', 20, false));
    await settle(page, 14);
    const afterAnaglyph = await shoot('roundtrip-3-secondary-structure-after.png');
    const themeAfter = (await readState()).look.appliedColorTheme;
    extra.anaglyphRoundTrip = {
      themeBefore,
      themeInAnaglyph,
      themeAfter,
      differingFractionBeforeAfter: differingFraction(beforeAnaglyph, afterAnaglyph),
      anaglyphDiffersFromBefore: differingFraction(beforeAnaglyph, inAnaglyph),
      statsBefore: imageStats(beforeAnaglyph),
      statsAfter: imageStats(afterAnaglyph),
    };

    /* ------------------------------------- one theme, applied to both eyes */
    await page.evaluate(() => window.__stereoStructureAcceptance!.setMode('parallel', 0, false));
    await settle(page, 16);
    const zeroDepth = await shoot('pair-1-secondary-structure-depth0.png');
    await page.evaluate(() => window.__stereoStructureAcceptance!.setMode('parallel', 20, false));
    await settle(page, 16);
    const pair = await shoot('pair-2-secondary-structure-depth20.png');
    const half = Math.floor(pair.width / 2);
    extra.eyes = {
      zeroDepth: eyeHalfDelta(zeroDepth),
      depth20HistogramDistance: eyeHistogramDistance(pair),
      leftStats: imageStats(pair, 0, half),
      rightStats: imageStats(pair, half, pair.width),
    };

    /* --------------------------- the fixture turns the Look group off */
    await page.evaluate(async () => {
      const drawer = document.querySelector<HTMLElement>('#drawer');
      if (drawer != null) drawer.hidden = false;
    });
    extra.pageErrorsPhaseOne = [...errors];
    await context.close();

    /* --------------------- phase two: the drawer, driven through its own DOM */
    const panels: Array<{ profile: string; width: number; height: number; file: string; look: Record<string, unknown> }> = [];
    for (const profile of [
      { name: 'wide', width: 800, height: 560 },
      { name: 'narrow', width: 440, height: 720 },
    ]) {
      const uiContext = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: 1,
      });
      const uiPage = await uiContext.newPage();
      const uiErrors: string[] = [];
      uiPage.on('pageerror', (error) => uiErrors.push(error.message));
      await uiPage.goto(viewerUrl, { waitUntil: 'load' });
      await uiPage.waitForSelector('#molstar-stage canvas', { timeout: 40_000 });
      // Every control this phase drives lives in the drawer, which starts
      // closed, so it is opened first and left open for the screenshot.
      await uiPage.click('#settings-toggle');
      // The paste path is entirely local, so an ordinary page with no host
      // behind it can still load a structure and drive the real controls.
      await uiPage.fill('#structure-text', structureText);
      await uiPage.click('#load-text');
      await uiPage.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('Loaded') === true, undefined, { timeout: 40_000 });
      await settle(uiPage, 10);
      // Drive the shipped listeners, not the acceptance hook.
      await uiPage.selectOption('#look-color', 'secondary-structure');
      await uiPage.selectOption('#look-style', 'molecular-surface');
      await settle(uiPage, 20);
      const file = `drawer-${profile.name}.png`;
      await uiPage.screenshot({ path: resolve(outDir, file) });
      const look = await uiPage.evaluate(() => {
        const group = document.querySelector<HTMLElement>('#look-group');
        const color = document.querySelector<HTMLSelectElement>('#look-color');
        const style = document.querySelector<HTMLSelectElement>('#look-style');
        const colorBox = color?.getBoundingClientRect();
        const styleBox = style?.getBoundingClientRect();
        const groupBox = group?.getBoundingClientRect();
        const previous = group?.previousElementSibling?.querySelector('h3')?.textContent ?? null;
        return {
          groupHeading: group?.querySelector('h3')?.textContent ?? null,
          previousGroupHeading: previous,
          hint: group?.querySelector('.hint')?.textContent ?? null,
          colorLabel: group?.querySelector('label[for="look-color"]')?.textContent ?? null,
          styleLabel: group?.querySelector('label[for="look-style"]')?.textContent ?? null,
          colorValue: color?.value ?? null,
          styleValue: style?.value ?? null,
          colorOptions: Array.from(color?.options ?? []).map((option) => `${option.value}=${option.label}`),
          styleOptions: Array.from(style?.options ?? []).map((option) => `${option.value}=${option.label}`),
          sideBySide: colorBox != null && styleBox != null && Math.abs(colorBox.top - styleBox.top) < 1 && styleBox.left > colorBox.right - 1,
          colorRect: colorBox == null ? null : [Math.round(colorBox.left), Math.round(colorBox.top), Math.round(colorBox.width)],
          styleRect: styleBox == null ? null : [Math.round(styleBox.left), Math.round(styleBox.top), Math.round(styleBox.width)],
          groupWidth: groupBox == null ? null : Math.round(groupBox.width),
          overflowsDrawer: colorBox != null && styleBox != null && groupBox != null
            && (colorBox.left < groupBox.left - 0.5 || styleBox.right > groupBox.right + 0.5),
        };
      });
      panels.push({ profile: profile.name, width: profile.width, height: profile.height, file, look });

      // The fixture turns the group off, with the reason on it.
      await uiPage.click('#load-fixture');
      await uiPage.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('Depth fixture loaded') === true, undefined, { timeout: 40_000 });
      await settle(uiPage, 10);
      const disabled = await uiPage.evaluate(() => ({
        colorDisabled: document.querySelector<HTMLSelectElement>('#look-color')?.disabled ?? null,
        styleDisabled: document.querySelector<HTMLSelectElement>('#look-style')?.disabled ?? null,
        groupTitle: document.querySelector<HTMLElement>('#look-group')?.title ?? null,
        colorTitle: document.querySelector<HTMLSelectElement>('#look-color')?.title ?? null,
      }));
      await uiPage.screenshot({ path: resolve(outDir, `drawer-${profile.name}-fixture-disabled.png`) });
      panels.push({ profile: `${profile.name}-fixture`, width: profile.width, height: profile.height, file: `drawer-${profile.name}-fixture-disabled.png`, look: disabled });
      if (uiErrors.length > 0) extra[`pageErrors-${profile.name}`] = uiErrors;
      await uiContext.close();
    }
    extra.panels = panels;

    /* ------------- Chain leaves ligands and waters element-coloured */
    if (ligandText !== undefined) {
      const ligandContext = await browser.newContext({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
      const ligandPage = await ligandContext.newPage();
      const ligandErrors: string[] = [];
      ligandPage.on('pageerror', (error) => ligandErrors.push(error.message));
      await ligandPage.addInitScript(() => { globalThis.__stereoStructureAcceptanceMode = true; });
      await ligandPage.goto(viewerUrl, { waitUntil: 'load' });
      await ligandPage.waitForFunction(() => window.__stereoStructureAcceptance?.state().webgl2 === true, undefined, { timeout: 40_000 });
      await ligandPage.evaluate(() => { globalThis.__stereoStructureAcceptanceMode = false; });
      await ligandPage.evaluate((text) => window.__stereoStructureAcceptance!.loadShipped(text), ligandText);
      await ligandPage.evaluate(() => window.__stereoStructureAcceptance!.setMode('off', 20, false));
      await settle(ligandPage, 16);
      const ligandCanvas = ligandPage.locator('#molstar-stage canvas').first();
      await ligandCanvas.waitFor({ state: 'visible' });
      const ligandLook = async () => (await ligandPage.evaluate(() => window.__stereoStructureAcceptance!.state().look)).representations
        .map((representation) => `${(representation.tags ?? []).join('+') || 'untagged'}:${representation.type}:${representation.colorTheme}`)
        .sort();
      // As loaded, which is the look every structure opened with before.
      const asLoaded = await ligandLook();
      await ligandCanvas.screenshot({ path: resolve(outDir, 'ligand-1-chain.png'), animations: 'disabled' });
      // Away and back, which is the path that used to flatten the ligands.
      await ligandPage.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'sequence-id' as LookColor }));
      await settle(ligandPage, 16);
      const underRainbow = await ligandLook();
      await ligandCanvas.screenshot({ path: resolve(outDir, 'ligand-2-rainbow.png'), animations: 'disabled' });
      await ligandPage.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'chain-id' as LookColor }));
      await settle(ligandPage, 16);
      const backToChain = await ligandLook();
      await ligandCanvas.screenshot({ path: resolve(outDir, 'ligand-3-chain-again.png'), animations: 'disabled' });
      extra.ligandStructure = {
        file: ligandPath,
        asLoaded,
        underRainbow,
        backToChain,
        chainIsStableAcrossARoundTrip: JSON.stringify(asLoaded) === JSON.stringify(backToChain),
        pageErrors: ligandErrors,
      };
      await ligandContext.close();
    }

    /* --------------- Confidence on a structure that says it is experimental */
    const cifContext = await browser.newContext({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
    const cifPage = await cifContext.newPage();
    await cifPage.addInitScript(() => { globalThis.__stereoStructureAcceptanceMode = true; });
    await cifPage.goto(viewerUrl, { waitUntil: 'load' });
    await cifPage.waitForFunction(() => window.__stereoStructureAcceptance?.state().webgl2 === true, undefined, { timeout: 40_000 });
    await cifPage.evaluate(() => { globalThis.__stereoStructureAcceptanceMode = false; });
    await cifPage.evaluate((text) => window.__stereoStructureAcceptance!.loadShipped(text, 'mmcif'), EXPERIMENTAL_MMCIF);
    await settle(cifPage, 14);
    await cifPage.evaluate(() => window.__stereoStructureAcceptance!.setLook({ color: 'plddt-confidence' as LookColor }));
    await settle(cifPage, 14);
    extra.experimentalMmcif = await cifPage.evaluate(() => {
      const look = window.__stereoStructureAcceptance!.state().look;
      return { plddtApplicable: look.plddtApplicable, appliedColorTheme: look.appliedColorTheme, representations: look.representations };
    });
    await cifContext.close();
  } finally {
    await browser.close();
  }

  const report = { rows, ...extra };
  await writeFile(resolve(outDir, 'look-renders.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const row of rows) {
    console.log(
      `${row.kind.padEnd(6)} ${row.label.padEnd(24)} theme=${row.appliedColorTheme.padEnd(20)} `
      + `lit ${(row.stats.litFraction * 100).toFixed(2)}% luma ${row.stats.meanLuma.toFixed(1)} `
      + `sat ${row.stats.meanSaturation.toFixed(3)} colours ${String(row.stats.distinctColours).padStart(5)} `
      + `differs ${(row.differsFromPreviousFraction * 100).toFixed(2)}% camera ${row.cameraMovedAngstrom.toFixed(6)} Å `
      + `radius ${row.sceneRadiusBeforeAngstrom.toFixed(3)}→${row.sceneRadiusAngstrom.toFixed(3)} Å — ${row.verdict}`,
    );
  }
  console.log(JSON.stringify({ ...extra, panels: undefined }, null, 2));
  console.log(`LOOK RENDERS written to ${outDir}`);
  const bad = rows.filter((row) => row.verdict !== 'ok');
  if (bad.length > 0) console.log(`DEFECTIVE OPTIONS: ${bad.map((row) => `${row.label} (${row.verdict})`).join(' | ')}`);
  else console.log('DEFECTIVE OPTIONS: none');

  // The four claims this script exists to keep true. Stated as failures rather
  // than left for a reader of the JSON, so a regression is loud.
  const roundTrip = extra.anaglyphRoundTrip as { themeAfter: string; differingFractionBeforeAfter: number };
  const eyes = extra.eyes as { zeroDepth: { maxDelta: number }; depth20HistogramDistance: number };
  const experimental = extra.experimentalMmcif as { appliedColorTheme: string };
  const failures: string[] = [];
  if (bad.length > 0) failures.push('an option rendered black, white or unchanged');
  for (const row of rows.filter((candidate) => candidate.kind === 'colour')) {
    if (row.cameraMovedAngstrom > 1e-6) failures.push(`the camera moved ${row.cameraMovedAngstrom} Å on the ${row.label} colour change`);
  }
  if (roundTrip.themeAfter !== 'secondary-structure') failures.push(`anaglyph round trip restored ${roundTrip.themeAfter}, not the chosen theme`);
  if (roundTrip.differingFractionBeforeAfter > 0) failures.push(`anaglyph round trip changed ${(roundTrip.differingFractionBeforeAfter * 100).toFixed(3)}% of the frame`);
  if (eyes.zeroDepth.maxDelta > 0) failures.push(`the two eyes differ by ${eyes.zeroDepth.maxDelta} codes at a zero depth budget`);
  if (eyes.depth20HistogramDistance > 0.05) failures.push(`the two eyes' colour histograms differ by ${eyes.depth20HistogramDistance}`);
  if (experimental.appliedColorTheme !== 'uncertainty') failures.push(`Confidence on an experimental mmCIF applied ${experimental.appliedColorTheme}, not uncertainty`);
  const ligand = extra.ligandStructure as { asLoaded: string[]; backToChain: string[]; chainIsStableAcrossARoundTrip: boolean } | undefined;
  if (ligand !== undefined) {
    // Chain must colour the polymer by chain and leave every non-polymer
    // representation on the preset's own default, which is element colouring.
    const polymer = ligand.asLoaded.filter((row) => row.startsWith('polymer:'));
    const others = ligand.asLoaded.filter((row) => !row.startsWith('polymer:') && !row.startsWith('untagged:'));
    if (polymer.length === 0) failures.push('the ligand-bearing structure produced no polymer representation to check');
    for (const row of polymer) {
      if (!row.endsWith(':chain-id')) failures.push(`Chain did not colour the polymer by chain: ${row}`);
    }
    for (const row of others) {
      if (row.endsWith(':chain-id')) failures.push(`Chain recoloured a non-polymer representation: ${row}`);
    }
    if (!ligand.chainIsStableAcrossARoundTrip) failures.push('Chain did not restore the as-loaded look after a round trip through another colour');
  }
  if (failures.length > 0) {
    for (const failure of failures) console.log(`LOOK CHECK FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('LOOK CHECKS PASS — every option renders, colour never moves the camera, Chain leaves non-polymer components element-coloured, the choice survives anaglyph, both eyes get one theme, and Confidence falls back on an experimental model.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
