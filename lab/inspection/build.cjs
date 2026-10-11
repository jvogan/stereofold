#!/usr/bin/env node
'use strict';

// Keep one source, dependency and artifact audit for both viewer entry points.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
execFileSync(process.execPath, [path.join(__dirname, '../browser-roundtrip/build.cjs'),
  ...process.argv.slice(2), '--inspection'], { stdio: 'inherit' });
