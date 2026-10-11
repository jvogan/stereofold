#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { installProbe, launchViewer } = require('../headset-preview/probe.cjs');
const adapters = require('../headset-preview/adapters.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  if (![2, 4].includes(args.length) || args[0] !== '--build' || !path.isAbsolute(args[1])
    || (args.length === 4 && (args[2] !== '--xr-runtime' || !path.isAbsolute(args[3])))) {
    throw Error('Usage: serve.cjs --build /absolute/build [--xr-runtime /absolute/iwer.min.js]');
  }
  const root = await fs.realpath(args[1]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'artifact-hashes.json'), 'utf8'));
  const report = JSON.parse(await fs.readFile(path.join(root, 'build-report.json'), 'utf8'));
  if (report.status !== 'passed' || report.kind !== 'inspection_build') throw Error('Use a passing inspection build.');
  const assets = new Map();
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
  for (const item of manifest) {
    if (path.basename(item.path) !== item.path) throw Error('Unexpected build asset path.');
    const bytes = await fs.readFile(path.join(root, item.path));
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw Error(`Build asset changed: ${item.path}`);
    const type = types[path.extname(item.path)];
    if (type) assets.set(`/${item.path}`, { type, bytes });
  }
  if (!assets.has('/index.html')) throw Error('Inspection index is missing.');
  assets.set('/', assets.get('/index.html'));
  if (args[3]) {
    const bytes = await fs.readFile(args[3]);
    if (bytes.length !== 195151 || hash(bytes) !== '4a3d7610fc263655e73311a61dc4d6d4f8004e5dc83f9f163f2e17934e31817b') {
      throw Error('Use the preserved IWER 2.3.0 runtime.');
    }
    assets.set('/emulation-runtime.js', { type: types['.js'], bytes });
    const setup = `window.__previewAdapters = {
      installReferenceSpaceAdapter: ${adapters.installReferenceSpaceAdapter},
      installPresentationDepthAdapter: ${adapters.installPresentationDepthAdapter},
      installSceneDepthAdapter: ${adapters.installSceneDepthAdapter}
    }; (${installProbe})(); window.__attachInspectionXr = ${launchViewer};`;
    assets.set('/emulation-setup.js', { type: types['.js'], bytes: Buffer.from(setup) });
    assets.set('/emulation-controls.js', { type: types['.js'], bytes: await fs.readFile(path.join(__dirname, 'emulation.mjs')) });
    const html = assets.get('/index.html').bytes.toString('utf8')
      .replace('<script src="inspection.js">', '<script src="emulation-runtime.js"></script><script src="emulation-setup.js"></script><script src="inspection.js">')
      .replace('</body>', '<script src="emulation-controls.js"></script></body>');
    assets.set('/emulation.html', { type: types['.html'], bytes: Buffer.from(html) });
    const desktop = { type: types['.html'], bytes: Buffer.from(assets.get('/index.html').bytes.toString('utf8')
      .replace('<body>', '<body data-emulation-url="/emulation.html">')) };
    assets.set('/index.html', desktop); assets.set('/', desktop);
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const asset = assets.get(url.pathname);
    if (request.method !== 'GET' || !asset) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(asset.bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ preview: origin, ...(args[3] ? { emulation: `${origin}/emulation.html` } : {}),
    scope: 'loopback-only local inspection preview', pid: process.pid }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
