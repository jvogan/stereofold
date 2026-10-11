#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { extractFile } = require('../identity/extract.cjs');
const { importClosure, isUnexpectedInput, within } = require('./import-closure.cjs');

const repo = path.resolve(__dirname, '../..');
const plugin = path.join(repo, 'plugin');
const labRoot = path.resolve(__dirname, '..');
const closureFile = path.join(__dirname, 'import-closure.cjs');
const abortPatchFile = path.join(plugin, 'src/molstar-state-abort-patch.mjs');
const requirePlugin = createRequire(path.join(plugin, 'package.json'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(repo, file).split(path.sep).join('/');
const fixtureNames = {
  public_1crn: '1CRN.cif',
  synthetic_ligand: 'voice-ligand.cif',
  identity_edge: 'identity-edge.cif',
};
const stockModules = ['helper/xr-manager.js', 'camera/stereo.js', 'passes/draw.js', 'helper/pick-helper.js'];
const forbidden = ['__stereoStructure', 'suppressDeniedWebXrProbe', 'MotionController', 'decideRefit',
  'stereoViewportPatch', 'anaglyphDrawPassFork', 'pickHelperPatch',
  'stereo-structure-viewport-x-swap', 'stereo-structure-anaglyph-draw-pass-fork',
  'stereo-structure-pick-helper-eye-assignment'];

async function fingerprint(file) {
  const bytes = await fs.readFile(file);
  return { path: relative(file), bytes: bytes.length, sha256: sha256(bytes) };
}

async function main() {
  const args = process.argv.slice(2);
  const inspection = args.at(-1) === '--inspection';
  if (inspection) args.pop();
  if (args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: build.cjs --out /absolute/new-directory [--inspection]');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node 22 or newer.');
  const out = path.join(await fs.realpath(path.dirname(args[1])), path.basename(args[1]));
  if (within(await fs.realpath(repo), out)) throw new Error('Keep generated artifacts outside the repository.');
  await fs.mkdir(out); // A previous run is never replaced.
  const write = (name, content) => fs.writeFile(path.join(out, name), content, { flag: 'wx' });
  const json = (name, value) => write(name, `${JSON.stringify(value, null, 2)}\n`);
  const report = { schemaVersion: 1, kind: inspection ? 'inspection_build' : 'browser_roundtrip_build', status: 'failed',
    startedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: repo, encoding: 'utf8' }).trim(), violations: [],
    headsetQualification: 'not_run', nativeVoice: 'not_run', actualCodexHost: 'not_run' };
  try {
    const esbuild = requirePlugin('esbuild');
    const { stateAbortLoggingPatch } = await import(pathToFileURL(abortPatchFile).href);
    const patchedInputs = new Map();
    const abortLogging = stateAbortLoggingPatch(input => patchedInputs.set(input.path, input));
    const molstarPackage = requirePlugin('molstar/package.json');
    const declared = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
    if (molstarPackage.version !== '5.11.0' || declared.dependencies.molstar !== '5.11.0'
      || esbuild.version !== '0.25.12') throw new Error('The installed dependencies differ from the declared experiment pins.');
    const corpus = JSON.parse(await fs.readFile(path.join(__dirname, '../../fixtures/voice-cases.json'), 'utf8'));
    const catalogs = {};
    const fixtures = [];
    const fixtureFiles = [];
    for (const [id, name] of Object.entries(fixtureNames)) {
      const file = path.join(__dirname, '../../fixtures', name);
      const expected = corpus.fixtureDefinitions[id];
      const catalog = await extractFile(file, { expectedHash: expected.sha256, assemblyId: '1' });
      catalogs[id] = catalog;
      fixtureFiles.push(file);
      fixtures.push({ id, ...await fingerprint(file), catalogSha256: sha256(JSON.stringify(catalog)),
        modelNumbers: catalog.modelNumbers, assemblyId: catalog.assemblyId,
        residueInstances: catalog.rows.length, atomInstances: catalog.rows.reduce((n, r) => n + r.atomSites.length, 0) });
    }
    const entryDir = inspection ? path.resolve(__dirname, '../inspection') : __dirname;
    const bundleName = inspection ? 'inspection' : 'roundtrip';
    const sessionRequestModules = new Set(await Promise.all(['immersive-session.mjs', 'xr-session-request.mjs']
      .map(name => fs.realpath(path.join(__dirname, name)))));
    // The set of lab files the build may bundle is read from the entry points'
    // own import closure, not from a list kept by hand: a hand-written list
    // went stale the moment a module was added, and every build after it
    // failed with `Unexpected runtime input` for files the entry points do
    // reach. The walk stops at the edge of the lab tree, so a file outside it
    // is still reported however it got into the bundle.
    const localRuntime = await importClosure({
      entries: [path.join(__dirname, 'appearance-fit-worker.mjs'), path.join(__dirname, 'entry.mjs'), path.join(labRoot, 'inspection', 'entry.mjs')],
      root: labRoot,
    });
    const fontFiles = inspection ? (await fs.readdir(path.join(entryDir, 'fonts'))).sort()
      .map(name => path.join(entryDir, 'fonts', name)) : [];
    const identityPath = path.resolve(__dirname, '../identity/identity.cjs');
    const allowed = new Set(await Promise.all([...localRuntime, identityPath, ...fixtureFiles, ...fontFiles].map(f => fs.realpath(f))));
    for (const file of localRuntime) {
      const source = await fs.readFile(file, 'utf8');
      for (const marker of forbidden) if (source.includes(marker)) report.violations.push(`${relative(file)} contains ${marker}`);
      // The opt-in companion owns production entry. Lab entry points never
      // enable it; all other modules retain the no-session-request boundary.
      if (!sessionRequestModules.has(await fs.realpath(file)) && /\brequestSession\s*\(/u.test(source)) report.violations.push(`${relative(file)} requests an XR session`);
    }
    if (report.violations.length) throw new Error('Unexpected runtime source.');
    const appearanceWorker = await esbuild.build({
      absWorkingDir: repo, entryPoints: [path.join(__dirname, 'appearance-fit-worker.mjs')],
      bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], write: false, metafile: true,
    });
    const result = await esbuild.build({
      absWorkingDir: repo, entryPoints: [path.join(entryDir, 'entry.mjs')],
      nodePaths: [path.join(plugin, 'node_modules')], outfile: path.join(out, `${bundleName}.js`),
      bundle: true, platform: 'browser', format: 'iife', target: ['es2022'],
      loader: { '.cif': 'text', '.css': 'css', '.ttf': 'file' }, assetNames: '[name]-[hash]',
      define: { __ROUNDTRIP_CATALOGS__: JSON.stringify(catalogs),
        __APPEARANCE_FIT_WORKER_SOURCE__: JSON.stringify(appearanceWorker.outputFiles[0].text) },
      plugins: [abortLogging], minify: false, sourcemap: false, legalComments: 'eof', metafile: true, write: false, logLevel: 'silent',
    });
    Object.assign(result.metafile.inputs, appearanceWorker.metafile.inputs);
    const dependencyRoot = await fs.realpath(path.join(repo, 'node_modules'));
    await json('metafile.json', result.metafile);
    const inputs = [];
    for (const [name, input] of Object.entries(result.metafile.inputs)) {
      if (name === '<define:__ROUNDTRIP_CATALOGS__>' && input.imports.length === 0) {
        const definition = JSON.stringify(catalogs);
        inputs.push({ path: name, kind: 'generated_catalog_definition', esbuildInputBytes: input.bytes,
          definitionBytes: Buffer.byteLength(definition), definitionSha256: sha256(definition) });
        continue;
      }
      if (name.startsWith('(disabled):') && input.bytes === 0 && input.imports.length === 0) {
        inputs.push({ path: name, bytes: 0, sha256: null });
        continue;
      }
      const file = await fs.realpath(path.resolve(repo, name));
      if (isUnexpectedInput(file, { allowed, dependencyRoot })) report.violations.push(`Unexpected runtime input: ${relative(file)}`);
      // esbuild marks injected object definitions as external input edges even
      // though it includes their generated module in the emitted bundle.
      const generatedCatalogImport = i => i.path === '<define:__ROUNDTRIP_CATALOGS__>'
        && i.kind === 'import-statement' && result.metafile.inputs[i.path]?.imports.length === 0;
      if (input.imports.some(i => (i.external && !generatedCatalogImport(i)) || /^@stereo\//u.test(i.original ?? i.path))) {
        report.violations.push(`External or desktop import: ${name}`);
      }
      const print = await fingerprint(file);
      const patched = patchedInputs.get(file);
      if (patched) {
        if (print.sha256 !== sha256(patched.source) || Buffer.byteLength(patched.contents) !== input.bytes) {
          report.violations.push(`Patched input changed during build: ${name}`);
        }
        inputs.push({ ...print, transformation: abortLogging.name, transformedBytes: input.bytes,
          transformedSha256: sha256(patched.contents) });
      } else {
        if (print.bytes !== input.bytes) report.violations.push(`Input changed during build: ${name}`);
        inputs.push(print);
      }
    }
    const molstarRoot = path.dirname(await fs.realpath(requirePlugin.resolve('molstar/package.json')));
    report.stockMolstar = [];
    for (const name of stockModules) {
      const file = path.join(molstarRoot, 'lib/mol-canvas3d', name);
      const print = await fingerprint(file);
      const present = inputs.some(i => i.path === print.path && i.sha256 === print.sha256);
      report.stockMolstar.push({ ...print, present });
      if (!present) report.violations.push(`Stock Mol* module absent: ${name}`);
    }
    for (const [name, output] of Object.entries(result.metafile.outputs)) {
      if (output.imports.some(i => i.external)) report.violations.push(`External emitted import: ${name}`);
    }
    const js = result.outputFiles.find(f => path.basename(f.path) === `${bundleName}.js`);
    const css = result.outputFiles.find(f => path.basename(f.path) === `${bundleName}.css`);
    if (!js || !css || (!inspection && result.outputFiles.length !== 2)
      || result.outputFiles.some(f => ![`${bundleName}.js`, `${bundleName}.css`].includes(path.basename(f.path)) && !f.path.endsWith('.ttf'))) {
      throw new Error('Expected one script and stylesheet, with only local font assets in the inspection build.');
    }
    for (const marker of forbidden) if (js.text.includes(marker)) report.violations.push(`Emitted desktop marker: ${marker}`);
    if (report.violations.length) throw new Error('The independent import check failed.');
    for (const file of result.outputFiles) await write(path.basename(file.path), file.contents);
    await json('inputs.json', inputs);
    await write('MOLSTAR-LICENSE', await fs.readFile(path.join(molstarRoot, 'LICENSE')));
    if (inspection) {
      for (const file of fontFiles.filter(file => !file.endsWith('.ttf'))) await write(path.basename(file), await fs.readFile(file));
    }
    await write('index.html', inspection ? `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'">
<link rel="icon" href="data:,"><title>Stereofold · Inspection preview</title><link rel="stylesheet" href="inspection.css"></head>
<body><div id="app"></div><p id="status" role="status" aria-live="polite">Loading public crambin.</p><script src="inspection.js"></script></body></html>\n` : `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'">
<title>Stereofold browser round trip</title><link rel="stylesheet" href="roundtrip.css"></head>
<body><header><p class="eyebrow">STEREOFOLD / APP INTEGRATION</p><h1>Browser scene transfer</h1>
<p>Two source panels, an independent receiver, and linked molecular selection.</p></header>
<main id="panels" aria-label="Molecular viewers"></main>
<footer><p id="status" role="status">Loading the three small public fixtures.</p>
<p>Browser experiment. The driver checks transfer and command routing. Quest and native Codex voice tests remain pending.</p></footer>
<script src="roundtrip.js"></script></body></html>\n`);
    report.dependencies = { molstar: molstarPackage.version, esbuild: esbuild.version };
    report.fixtures = fixtures;
    report.sourceFiles = await Promise.all([...new Set([__filename, closureFile, abortPatchFile, ...localRuntime, ...fontFiles,
      identityPath, ...fixtureFiles, path.resolve(__dirname, '../identity/extract.cjs'),
      path.join(repo, 'pnpm-lock.yaml'), path.join(plugin, 'package.json')])].map(fingerprint));
    report.inputCount = inputs.length;
    report.plugins = [abortLogging.name];
    report.bundleSha256 = sha256(js.contents);
    report.warnings = result.warnings.map(w => w.text);
    report.status = 'passed';
  } catch (error) {
    report.error = error.stack ?? String(error);
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await json('build-report.json', report);
  const artifacts = [];
  for (const name of (await fs.readdir(out)).sort()) {
    const bytes = await fs.readFile(path.join(out, name));
    artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await json('artifact-hashes.json', artifacts);
  process.stdout.write(`${JSON.stringify({ status: report.status, report: path.join(out, 'build-report.json'), error: report.error })}\n`);
}
main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
