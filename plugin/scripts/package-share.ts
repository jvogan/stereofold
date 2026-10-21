import { readInlineHtml } from '../src/inline-html.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stampedBuildId } from '../src/build-identity.js';
import { compositeRecipePath, readCompositeRecipe, readModelledCompositeSource } from '../src/demo-composite-files.js';
import { readBundledDemoCoordinates } from '../src/bundled-demo-coordinates.js';
import { isModelledCompositeSource } from '../src/demo-rigid-composite.js';
import { demoLessonPaths, type DemoIndexLike } from './demo-lesson-paths.js';

const execFileAsync = promisify(execFile);

const REQUIRED_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'INSPECTOR.md',
  'LICENSE',
  'QUICKSTART.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets/icon-256.png',
  'assets/logo-1024.png',
  'assets/oauth-transcribe.py',
  // Claude Code reads `.claude-plugin/` and Codex reads `.codex-plugin/`, and
  // both install this whole directory, so the two hosts run one build of
  // `dist/server.mjs`. The Quest skill is Claude Code's alone: Codex reads
  // `skills/` only, and the Claude Code manifest adds `claude-code/skills/`.
  '.claude-plugin/plugin.json',
  '.claude-plugin/icon.png',
  'claude-code/skills/stereofold-quest/SKILL.md',
  'codex/INSTALL.md',
  // Growth reads `../demos/index.json` beside the bundle, so the demo index
  // travels with the share rather than only with a checkout.
  'demos/index.json',
  'dist/inspector.html',
  'dist/inspector.css',
  'dist/inspector-host.js',
  'dist/inspector-script-1.js',
  'dist/inspector-script-2.js',
  'dist/server.mjs',
  'dist/headset-host.mjs',
  'dist/serve-inspection.mjs',
  // The Unix-socket relay QUICKSTART names for sandboxed hosts, run with
  // node alone from the share.
  'dist/scene-socket-relay.mjs',
  'dist/viewer.html',
  'dist/molstar/molstar.js',
  'dist/molstar/molstar.css',
  'dist/molstar/LICENSE',
  // The Swift speech tool travels as source and a build script, so the Apple
  // voice route exists for a share recipient and not only for someone working
  // in a checkout.
  'native/applespeech/transcribe.swift',
  'native/applespeech/Info.plist',
  'native/applespeech/build.sh',
  'skills/stereo-structure/SKILL.md',
  'skills/molecular-presentation/SKILL.md',
  'skills/molecular-presentation/scripts/lesson.mjs',
  'skills/molecular-presentation/references/live-authoring.md',
  // A share is handed to someone whose machine has never run this. The setup
  // skill and its bare-`node` check are what they read first, so a share
  // without them is a share that assumes the recipient already knows.
  'skills/stereofold-setup/SKILL.md',
  'skills/stereofold-setup/scripts/setup-check.mjs',
] as const;

// Exact published gallery assets, including originals and their provenance.
// Neither an added file in this directory nor a manifest path can expand the
// share boundary. New datasets require their own explicit audited list.
const BINDER_GALLERY_FILES = [
  'demos/binder-gallery/CREDITS.md',
  'demos/binder-gallery/PROVENANCE.md',
  'demos/binder-gallery/README.md',
  'demos/binder-gallery/gallery.cif',
  'demos/binder-gallery/lesson.json',
  'demos/binder-gallery/manifest.json',
  'demos/binder-gallery/original-pairs.json',
  'demos/binder-gallery/structures/Binder01.cif',
  'demos/binder-gallery/structures/Binder02.cif',
  'demos/binder-gallery/structures/Binder03.cif',
  'demos/binder-gallery/structures/Binder04.cif',
  'demos/binder-gallery/structures/Binder05.cif',
  'demos/binder-gallery/structures/Binder06.cif',
  'demos/binder-gallery/structures/Binder07.cif',
  'demos/binder-gallery/structures/Binder08.cif',
  'demos/binder-gallery/structures/Binder09.cif',
  'demos/binder-gallery/structures/Binder10.cif',
  'demos/binder-gallery/structures/Binder11.cif',
  'demos/binder-gallery/structures/Binder12.cif',
  'demos/binder-gallery/structures/Binder13.cif',
  'demos/binder-gallery/structures/Binder14.cif',
  'demos/binder-gallery/structures/Binder15.cif',
  'demos/binder-gallery/structures/Binder16.cif',
  'demos/binder-gallery/structures/Binder17.cif',
  'demos/binder-gallery/upstream/COLUMNS.md',
  'demos/binder-gallery/upstream/LICENSE.md',
  'demos/binder-gallery/upstream/README.md',
  'demos/binder-gallery/upstream/design.csv',
  'demos/binder-gallery/upstream/structures/02090d8c/02090d8c_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/03131527/03131527_esmfold2-aah1.pdb',
  'demos/binder-gallery/upstream/structures/30fc4a66/30fc4a66_esmfold2-aah1.pdb',
  'demos/binder-gallery/upstream/structures/5f5b71ad/5f5b71ad_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/66c2cc29/66c2cc29_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/888c8f04/888c8f04_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/8ac202c8/8ac202c8_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/8ebe5db2/8ebe5db2_esmfold2-aah1.pdb',
  'demos/binder-gallery/upstream/structures/8f156315/8f156315_esmfold2-aah2.pdb',
  'demos/binder-gallery/upstream/structures/96ee6417/96ee6417_esmfold2-aah2.pdb',
  'demos/binder-gallery/upstream/structures/9cad7527/9cad7527_esmfold2-aah1.pdb',
  'demos/binder-gallery/upstream/structures/9d008884/9d008884_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/INDEX.csv',
  'demos/binder-gallery/upstream/structures/a199ee01/a199ee01_esmfold2-aah2.pdb',
  'demos/binder-gallery/upstream/structures/b6d46ba0/b6d46ba0_esmfold2-cn2.pdb',
  'demos/binder-gallery/upstream/structures/d2a254ba/d2a254ba_esmfold2-aah2.pdb',
  'demos/binder-gallery/upstream/structures/dbb87a88/dbb87a88_esmfold2-lqh3.pdb',
  'demos/binder-gallery/upstream/structures/dceea244/dceea244_esmfold2-lqh3.pdb',
  'demos/binder-gallery/upstream/toxins.csv',
  'skills/molecular-presentation/references/binder-gallery.md',
] as const;
// Frozen extended-gallery assets: all ten batches, their source originals and
// provenance. This list is audited source, never expanded from an artifact's
// manifest or directory contents at packaging time.
const BINDER_EXTENDED_FILES = [
  'demos/binder-gallery/catalog.json',
  'demos/binder-gallery/upstream/in_silico_scores.csv',
  'demos/binder-gallery/extended/README.md',
  'demos/binder-gallery/extended/batch-01/gallery.cif',
  'demos/binder-gallery/extended/batch-01/lesson.json',
  'demos/binder-gallery/extended/batch-01/manifest.json',
  'demos/binder-gallery/extended/batch-02/gallery.cif',
  'demos/binder-gallery/extended/batch-02/lesson.json',
  'demos/binder-gallery/extended/batch-02/manifest.json',
  'demos/binder-gallery/extended/batch-03/gallery.cif',
  'demos/binder-gallery/extended/batch-03/lesson.json',
  'demos/binder-gallery/extended/batch-03/manifest.json',
  'demos/binder-gallery/extended/batch-04/gallery.cif',
  'demos/binder-gallery/extended/batch-04/lesson.json',
  'demos/binder-gallery/extended/batch-04/manifest.json',
  'demos/binder-gallery/extended/batch-05/gallery.cif',
  'demos/binder-gallery/extended/batch-05/lesson.json',
  'demos/binder-gallery/extended/batch-05/manifest.json',
  'demos/binder-gallery/extended/batch-06/gallery.cif',
  'demos/binder-gallery/extended/batch-06/lesson.json',
  'demos/binder-gallery/extended/batch-06/manifest.json',
  'demos/binder-gallery/extended/batch-07/gallery.cif',
  'demos/binder-gallery/extended/batch-07/lesson.json',
  'demos/binder-gallery/extended/batch-07/manifest.json',
  'demos/binder-gallery/extended/batch-08/gallery.cif',
  'demos/binder-gallery/extended/batch-08/lesson.json',
  'demos/binder-gallery/extended/batch-08/manifest.json',
  'demos/binder-gallery/extended/batch-09/gallery.cif',
  'demos/binder-gallery/extended/batch-09/lesson.json',
  'demos/binder-gallery/extended/batch-09/manifest.json',
  'demos/binder-gallery/extended/batch-10/gallery.cif',
  'demos/binder-gallery/extended/batch-10/lesson.json',
  'demos/binder-gallery/extended/batch-10/manifest.json',
  'demos/binder-gallery/extended/demo-index-entry.json',
  'demos/binder-gallery/extended/manifest.json',
  'demos/binder-gallery/extended/selected17/lesson.json',
  'demos/binder-gallery/extended/source-lock.json',
  'demos/binder-gallery/extended/upstream/structures/005ebdae/005ebdae_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/01f0df6e/01f0df6e_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/0510b42f/0510b42f_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/05efdf6e/05efdf6e_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/062f6e47/062f6e47_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/099c0240/099c0240_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/0af4b327/0af4b327_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/0bf88e5c/0bf88e5c_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/0c86c52b/0c86c52b_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/0f463bed/0f463bed_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/110493ed/110493ed_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/1296b21d/1296b21d_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/138181a8/138181a8_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/142cb24a/142cb24a_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/1578f84e/1578f84e_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/16974899/16974899_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/173c84c2/173c84c2_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/1a602e62/1a602e62_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/1ffc4a0a/1ffc4a0a_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/20511619/20511619_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/21286dd8/21286dd8_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/21c4722c/21c4722c_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/22359df4/22359df4_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/2375ac8e/2375ac8e_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/23bf54fe/23bf54fe_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/246a108f/246a108f_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/24baf4bf/24baf4bf_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/268861a2/268861a2_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/27764014/27764014_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/28491140/28491140_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/290c0215/290c0215_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/2a608b59/2a608b59_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/2afea962/2afea962_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/2b620ceb/2b620ceb_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/2c5aeaaf/2c5aeaaf_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/31723df8/31723df8_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/3369ca93/3369ca93_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/33b2180d/33b2180d_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/346a7f1f/346a7f1f_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/367f7a60/367f7a60_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/37b43daf/37b43daf_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/39f80384/39f80384_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/3a62f8c7/3a62f8c7_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/3d3dff1a/3d3dff1a_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/3f096f6b/3f096f6b_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/3f0f990a/3f0f990a_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/3f1c47f1/3f1c47f1_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/40090fca/40090fca_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/41a3e304/41a3e304_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/4412a3c3/4412a3c3_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/443207a9/443207a9_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/44bc002a/44bc002a_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/457acf43/457acf43_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/46735fe6/46735fe6_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/47d04ba8/47d04ba8_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/47dd0a8a/47dd0a8a_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/4aadd0af/4aadd0af_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/4cc8857b/4cc8857b_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/4d787f86/4d787f86_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/4dc34f91/4dc34f91_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/4eae42fc/4eae42fc_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/4efbc623/4efbc623_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/4fcc0f88/4fcc0f88_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/50967325/50967325_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/50c76cf5/50c76cf5_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/52a91175/52a91175_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/5545ab00/5545ab00_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/562dbd2b/562dbd2b_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/569171b8/569171b8_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/569c6be9/569c6be9_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/56dd795b/56dd795b_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/5b454168/5b454168_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/5d9c83b5/5d9c83b5_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/5e6f7ee4/5e6f7ee4_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6278a864/6278a864_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6522cb3b/6522cb3b_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6a7a1c19/6a7a1c19_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6a9bcd5b/6a9bcd5b_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/6b131882/6b131882_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6bdf371c/6bdf371c_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/6d0b4f3f/6d0b4f3f_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/6da28c32/6da28c32_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/6db2c0fc/6db2c0fc_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/6e170f78/6e170f78_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/6fbd27ee/6fbd27ee_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/700d103b/700d103b_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/70e95c3a/70e95c3a_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/7491eb22/7491eb22_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/76ba446b/76ba446b_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/7773743e/7773743e_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/79a1814e/79a1814e_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/80a0ae6b/80a0ae6b_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/829eb8ff/829eb8ff_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/82abc3c1/82abc3c1_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/82c02c9d/82c02c9d_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/8382cd8f/8382cd8f_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/85342f05/85342f05_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/88ef5fe9/88ef5fe9_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/895f0136/895f0136_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/8995a1e3/8995a1e3_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/8ac1c76b/8ac1c76b_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/8ba23b79/8ba23b79_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/8c613690/8c613690_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/8d8d0a11/8d8d0a11_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/8f127bdf/8f127bdf_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/8ffee11e/8ffee11e_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/90ba09fa/90ba09fa_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/917b6d05/917b6d05_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/925ee271/925ee271_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/946282e8/946282e8_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/9525432f/9525432f_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/97559b03/97559b03_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/98052822/98052822_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/987f7834/987f7834_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/99e5450e/99e5450e_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/9a8cdc7a/9a8cdc7a_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/9d46e87b/9d46e87b_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/a01ae210/a01ae210_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/a1f798ca/a1f798ca_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/a214e675/a214e675_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a31d8156/a31d8156_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/a43e7072/a43e7072_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a4692b5f/a4692b5f_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a5ed7742/a5ed7742_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a6a68a39/a6a68a39_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a6efe904/a6efe904_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a8411894/a8411894_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/a8a3f1f9/a8a3f1f9_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/a981802c/a981802c_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/a9ff4905/a9ff4905_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/aa310a28/aa310a28_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/aaf31f4b/aaf31f4b_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/aaf88b56/aaf88b56_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/abcdee20/abcdee20_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/ac4dc12a/ac4dc12a_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/ae04db8a/ae04db8a_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/aecee075/aecee075_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/b033f20c/b033f20c_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/b39bbbd3/b39bbbd3_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/b46280d0/b46280d0_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/b6e5be90/b6e5be90_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/b7640b51/b7640b51_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/bb35ab17/bb35ab17_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/bbe37cf8/bbe37cf8_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/bc1b4f00/bc1b4f00_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/bdeffba4/bdeffba4_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/bdfd04c0/bdfd04c0_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/bf9f87d6/bf9f87d6_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/c23660b4/c23660b4_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/c259cc8f/c259cc8f_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/c29a9b88/c29a9b88_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/c4bf2b3e/c4bf2b3e_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/c816725c/c816725c_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/c96ce7e1/c96ce7e1_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/ca06e722/ca06e722_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/cac1ca4c/cac1ca4c_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/cc1c8edb/cc1c8edb_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/ccfd801c/ccfd801c_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/cdc4f510/cdc4f510_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/cea7b270/cea7b270_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/cec3d0b0/cec3d0b0_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/cf8652bc/cf8652bc_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/d15c8ece/d15c8ece_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/d1ce49a2/d1ce49a2_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/d248dd44/d248dd44_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/d3c5127a/d3c5127a_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/d5c50c2b/d5c50c2b_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/d62f6cc0/d62f6cc0_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/d6cc3356/d6cc3356_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/d9a83a6c/d9a83a6c_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/da1fb341/da1fb341_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/dd557447/dd557447_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/e1d7f65f/e1d7f65f_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/e32555c5/e32555c5_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/e711b957/e711b957_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/e752eb69/e752eb69_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/e80c46be/e80c46be_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/e9a01963/e9a01963_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/e9aa252c/e9aa252c_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/e9b98778/e9b98778_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/ea109fea/ea109fea_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/eade0bd3/eade0bd3_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/ec765866/ec765866_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/eeaf0e49/eeaf0e49_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/f5d78037/f5d78037_esmfold2-aah2.pdb',
  'demos/binder-gallery/extended/upstream/structures/f7afd975/f7afd975_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/f8242edc/f8242edc_esmfold2-lqh3.pdb',
  'demos/binder-gallery/extended/upstream/structures/f8eb661d/f8eb661d_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/fb23e376/fb23e376_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/fb81748a/fb81748a_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/fc655cd5/fc655cd5_esmfold2-ts1.pdb',
  'demos/binder-gallery/extended/upstream/structures/fe18e4b2/fe18e4b2_esmfold2-aah1.pdb',
  'demos/binder-gallery/extended/upstream/structures/fe345fb0/fe345fb0_esmfold2-cn2.pdb',
  'demos/binder-gallery/extended/upstream/structures/ff7c1df6/ff7c1df6_esmfold2-cn2.pdb',
] as const;
const BUNDLED_DEMO_FILES = new Map<string, readonly string[]>([
  ['binder-gallery/gallery.cif', BINDER_GALLERY_FILES],
  ['binder-gallery/extended/batch-01/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-02/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-03/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-04/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-05/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-06/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-07/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-08/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-09/gallery.cif', BINDER_EXTENDED_FILES],
  ['binder-gallery/extended/batch-10/gallery.cif', BINDER_EXTENDED_FILES],

]);

// Exact recipient paths from the audited share tree. Extensions alone are not
// sufficient: lesson JSON must not admit unrelated credential JSON. New shipped
// files require an explicit addition here or an indexed composite reference.
const ALLOWED_ARTIFACT_FILES = new Set<string>([
  // The build stamp lets setup-doctor answer fresh/stale by content on an
  // installed copy; older builds have none, so it is allowed, not required.
  'dist/build-inputs.json',
  'skills/stereo-structure/references/commands.md',
  'skills/stereo-structure/references/handoffs.md',
  'skills/stereo-structure/references/headsets.md',
  'skills/stereo-structure/references/stereo-viewer.md',
  'skills/stereo-structure/references/voice.md',
  'skills/stereofold-setup/references/hosts.md',
  'skills/stereofold-setup/references/voice.md',

  ...REQUIRED_FILES,
  ...BINDER_GALLERY_FILES,
  ...BINDER_EXTENDED_FILES,
  'demos/README.md',
  'demos/atp-synthase-rotor/figure-recipe.json',
  'demos/atp-synthase-rotor/figure.json',
  'demos/atp-synthase-rotor/flipbook-recipe.json',
  'demos/atp-synthase-rotor/flipbook.json',
  'demos/atp-synthase-rotor/motion-recipe.json',
  'demos/atp-synthase-rotor/motion.json',
  'demos/atp-synthase.json',
  'demos/crispr-cas9.json',
  'demos/daraxonrasib.json',
  'demos/glucose-transporter.json',
  'demos/hemoglobin-switch/figure-recipe.json',
  'demos/hemoglobin-switch/figure.json',
  'demos/hemoglobin-switch/flipbook-recipe.json',
  'demos/hemoglobin-switch/flipbook.json',
  'demos/hemoglobin-switch/motion-recipe.json',
  'demos/hemoglobin-switch/motion.json',
  'demos/hemoglobin.json',
  'demos/kinesin-walk/cycle-model.cif',
  'demos/kinesin-walk/cycle-recipe.json',
  'demos/kinesin-walk/cycle.json',
  'demos/kinesin-walk/flipbook-recipe.json',
  'demos/kinesin-walk/flipbook.json',
  'demos/kinesin-walk/motion-model.cif',
  'demos/kinesin-walk/motion-recipe.json',
  'demos/kinesin-walk/motion.json',
  'demos/microtubule-arrival/build.json',
  'demos/microtubule-arrival/density.json',
  'demos/microtubule-growth/dimer.json',
  'demos/microtubule-growth/filament.json',
  'demos/microtubule-growth/monomer.json',
  'demos/microtubule-growth/protofilament.json',
  'demos/microtubule-growth/tip.json',
  'demos/microtubule-growth/tube.json',
  'demos/microtubule-growth/wall.json',
  'demos/microtubule-lattice.json',
  'demos/nucleosome.json',
  'demos/spike.json',
  'demos/telomerase-haca.json',
  'demos/tubulin-dimer.json',
  'skills/molecular-presentation/assets/9kj6-guided.json',
  'skills/molecular-presentation/assets/9qb3-guided.json',
  'skills/molecular-presentation/assets/9ax6-daraxonrasib.json',
  'skills/molecular-presentation/assets/LICENSE',
  'skills/molecular-presentation/assets/ZOD-LICENSE',
  'skills/molecular-presentation/assets/own-molecule-guided.json',
  'skills/stereofold-setup/scripts/open-check.mjs',
  'skills/stereofold-setup/scripts/setup-check.d.mts',
  // Accepted as a release input only; copyTree omits this local build.
  'native/applespeech/bin/applespeech',
]);

const REQUIRED_DIRECTORIES = [
  '.claude-plugin',
  '.codex-plugin',
  'assets',
  'claude-code',
  'codex',
  'demos',
  'dist',
  'native',
  'skills',
] as const;

const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  '.claude-plugin',
  '.codex-plugin',
  '.mcp.json',
  'INSPECTOR.md',
  'LICENSE',
  'QUICKSTART.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'claude-code',
  'codex',
  'demos',
  'dist',
  'native',
  'skills',
]);

/**
 * The one staged input a share does not carry.
 *
 * `scripts/release.ts` copies `native/` whole, so a `bin/applespeech` built
 * before staging rides along into the release artifact. That is right for the
 * artifact, which is the build machine's own. It is wrong for a share, which is a
 * file handed to someone else: the binary is an unsigned Mach-O for whichever
 * architecture happened to build it, the repository already treats it as
 * output rather than source (`plugin/.gitignore` excludes it), and the
 * recipient reproduces it in one step with `sh native/applespeech/build.sh`.
 * Leaving it out also keeps the archive checksum a function of source alone.
 */
const EXCLUDED_FROM_SHARE = ['native/applespeech/bin'];

const ARCHIVE_NAME = 'stereofold-marketplace.tar.gz';
const ARCHIVE_CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`;
const CHECKSUM_NAME = 'SHA256SUMS';
const SHARE_GUIDE_NAME = 'SHARE.md';
const MARKETPLACE_NAME = 'stereofold-local';
const CODEX_MARKETPLACE_PATH = '.agents/plugins/marketplace.json';
/**
 * Claude Code reads its own marketplace file and never the Codex one.
 *
 * A share that carried only `.agents/plugins/marketplace.json` answered
 * `claude plugin marketplace add` with "Marketplace file not found", so the
 * documented Claude Code route had no command that worked. Both descriptors
 * name the same share root and the same plugin directory, `plugins/stereofold`.
 * Claude Code copies that directory into its own plugin cache and expands
 * `${CLAUDE_PLUGIN_ROOT}` to the copy, which is why the Claude Code manifest
 * sits at the artifact root beside `dist/`: a plugin rooted one level down was
 * copied without `dist/` and had no server to start.
 */
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const CLAUDE_PLUGIN_SOURCE = './plugins/stereofold';
const CLAUDE_SERVER_ARGS = ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'];

export interface PackageShareOptions {
  artifact: string;
  output: string;
}

export interface PackageShareResult {
  archive: string;
  archiveChecksum: string;
  checksums: string;
  claudeMarketplace: string;
  marketplace: string;
  output: string;
  plugin: string;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  interface?: {
    displayName?: unknown;
  };
}

interface McpConfig {
  mcpServers?: {
    stereo_structure?: {
      command?: unknown;
      args?: unknown;
      cwd?: unknown;
    };
  };
}

interface ClaudeManifest {
  name?: unknown;
  mcpServers?: {
    stereo_structure?: { command?: unknown; args?: unknown };
  };
}

interface MarketplaceDescriptor {
  name: string;
  interface: { displayName: string };
  plugins: Array<{
    name: string;
    source: { source: 'local'; path: './plugins/stereofold' };
    policy: { installation: 'AVAILABLE'; authentication: 'ON_INSTALL' };
    category: 'Education & Research';
  }>;
}

interface ClaudeMarketplaceDescriptor {
  name: string;
  owner: { name: string };
  metadata: { description: string; version: string };
  plugins: Array<{
    name: string;
    source: typeof CLAUDE_PLUGIN_SOURCE;
    description: string;
    version: string;
  }>;
}

export { demoLessonPaths } from './demo-lesson-paths.js';
export type { DemoIndexLike } from './demo-lesson-paths.js';

async function requireRegularFile(root: string, relativePath: string): Promise<void> {
  const path = resolve(root, relativePath);
  const details = await lstat(path).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact is missing ${relativePath}.`);
  if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}.`);
  if (!details.isFile()) throw new Error(`Release artifact entry ${relativePath} is not a regular file.`);
}

async function requireDirectory(root: string, relativePath: string): Promise<void> {
  const path = resolve(root, relativePath);
  const details = await lstat(path).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact is missing ${relativePath}/.`);
  if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}/.`);
  if (!details.isDirectory()) throw new Error(`Release artifact entry ${relativePath} is not a directory.`);
}

async function walkRegularFiles(
  root: string,
  allowedFiles?: ReadonlySet<string>,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}.`);
    // Validate directories too, including empty ones. Only ancestors of an
    // explicitly named recipient file can be traversed.
    if (allowedFiles != null && !(details.isDirectory()
      ? [...allowedFiles].some(file => file.startsWith(`${relativePath}/`))
      : allowedFiles.has(relativePath))) {
      throw new Error(`Release artifact contains forbidden share entry: ${relativePath}.`);
    }
    if (details.isDirectory()) {
      files.push(...await walkRegularFiles(root, allowedFiles, absolutePath));
    } else if (details.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Release artifact contains a non-regular entry at ${relativePath}.`);
    }
  }
  return files.sort();
}

export async function validateArtifact(artifactRoot: string): Promise<PluginManifest> {
  const details = await lstat(artifactRoot).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact does not exist: ${artifactRoot}`);
  if (details.isSymbolicLink()) throw new Error('Release artifact root must not be a symlink.');
  if (!details.isDirectory()) throw new Error(`Release artifact is not a directory: ${artifactRoot}`);
  if (basename(artifactRoot) !== 'stereofold') {
    throw new Error(`Release artifact directory must be named stereofold (received ${basename(artifactRoot)}).`);
  }

  for (const entry of await readdir(artifactRoot, { withFileTypes: true })) {
    if (!ALLOWED_TOP_LEVEL_ENTRIES.has(entry.name)) {
      throw new Error(`Release artifact contains an unallowlisted top-level entry: ${entry.name}.`);
    }
  }
  for (const requiredDirectory of REQUIRED_DIRECTORIES) await requireDirectory(artifactRoot, requiredDirectory);
  for (const requiredFile of REQUIRED_FILES) await requireRegularFile(artifactRoot, requiredFile);

  // Every lesson the demo index lists travels too: a grow reads the target
  // tier's lesson from beside the index, so an artifact with the index but
  // without a lesson fails mid-session instead of at packaging time.
  const demoIndex = JSON.parse(
    await readFile(resolve(artifactRoot, 'demos/index.json'), 'utf8'),
  ) as DemoIndexLike;
  for (const lesson of demoLessonPaths(demoIndex)) {
    await requireRegularFile(artifactRoot, `demos/${lesson}`);
  }

  const allowedFiles = new Set(ALLOWED_ARTIFACT_FILES);
  const demosRoot = resolve(artifactRoot, 'demos');
  const recipes = new Set<string>();
  for (const demo of demoIndex.demos ?? []) {
    for (const entry of [demo, ...(demo.stages ?? [])]) {
      const coordinates = entry.coordinates as { sha256?: unknown;
        derivation?: { kind?: unknown; recipe?: unknown; path?: unknown } } | undefined;
      const derivation = coordinates?.derivation;
      if (derivation?.kind === 'bundled-file') {
        const path = derivation.path;
        if (typeof path !== 'string' || !BUNDLED_DEMO_FILES.has(path))
          throw Error('Bundled coordinates must name an explicitly approved share file.');
        if (typeof coordinates?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(coordinates.sha256))
          throw Error('Bundled coordinates must declare a sha256 digest.');
        for (const file of BUNDLED_DEMO_FILES.get(path)!) await requireRegularFile(artifactRoot, file);
        await readBundledDemoCoordinates(path, coordinates.sha256, demosRoot);
        continue;
      }
      if (derivation?.kind !== 'prepared-rigid-composite') continue;
      if (typeof derivation.recipe !== 'string') throw Error('Composite recipe must name a path relative to demos/');
      recipes.add(derivation.recipe);
    }
  }
  // A shipped recipe needs its local ingredients even when no index tier uses it.
  for (const file of allowedFiles) {
    if (file.startsWith('demos/') && file.endsWith('-recipe.json') && await lstat(resolve(artifactRoot, file)).catch(() => undefined))
      recipes.add(file.slice('demos/'.length));
  }
  for (const recipeFile of recipes) {
    const recipePath = compositeRecipePath(recipeFile, demosRoot);
    const recipe = await readCompositeRecipe(recipePath, demosRoot);
    allowedFiles.add(`demos/${recipeFile}`);
    for (const source of recipe.sources) {
      if (!isModelledCompositeSource(source)) continue;
      const file = relative(artifactRoot, resolve(dirname(recipePath), source.file)).split(sep).join('/');
      await readModelledCompositeSource(dirname(recipePath), source, demosRoot);
      await requireRegularFile(artifactRoot, file);
      allowedFiles.add(file);
    }
  }
  const files = await walkRegularFiles(artifactRoot, allowedFiles);
  if (files.some((file) => file === 'package.json' || file.startsWith('node_modules/'))) {
    throw new Error('Release artifact must not contain package.json or node_modules.');
  }
  if (files.some((file) => file.startsWith('src/') || file.startsWith('test/'))) {
    throw new Error('Release artifact must not contain development source or tests.');
  }

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(artifactRoot, '.codex-plugin/plugin.json'), 'utf8')) as PluginManifest;
  } catch (error) {
    throw new Error('Release artifact manifest is not valid JSON.', { cause: error });
  }
  if (manifest.name !== 'stereofold') throw new Error(`Manifest name must be stereofold, received ${String(manifest.name)}.`);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Manifest version must be a non-empty string.');
  }
  if (manifest.interface?.displayName !== 'Stereofold') {
    throw new Error('Manifest interface.displayName must be Stereofold.');
  }

  let mcp: McpConfig;
  try {
    mcp = JSON.parse(await readFile(resolve(artifactRoot, '.mcp.json'), 'utf8')) as McpConfig;
  } catch (error) {
    throw new Error('Release artifact .mcp.json is not valid JSON.', { cause: error });
  }
  if (JSON.stringify(mcp.mcpServers?.stereo_structure) !== JSON.stringify({
    command: 'node',
    args: ['./dist/server.mjs'],
    cwd: '.',
  })) {
    throw new Error('Release artifact .mcp.json does not point at ./dist/server.mjs.');
  }

  let claude: ClaudeManifest;
  try {
    claude = JSON.parse(await readFile(resolve(artifactRoot, '.claude-plugin/plugin.json'), 'utf8')) as ClaudeManifest;
  } catch (error) {
    throw new Error('Release artifact Claude Code manifest is not valid JSON.', { cause: error });
  }
  if (claude.name !== 'stereofold') {
    throw new Error(`Claude Code manifest name must be stereofold, received ${String(claude.name)}.`);
  }
  if (JSON.stringify(claude.mcpServers?.stereo_structure) !== JSON.stringify({ command: 'node', args: CLAUDE_SERVER_ARGS })) {
    throw new Error('Release artifact Claude Code manifest does not start ${CLAUDE_PLUGIN_ROOT}/dist/server.mjs.');
  }

  return manifest;
}

async function copyTree(sourceRoot: string, targetRoot: string, prefix = ''): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const sourcePath = resolve(sourceRoot, entry.name);
    const targetPath = resolve(targetRoot, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (EXCLUDED_FROM_SHARE.includes(relativePath)) continue;
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) throw new Error(`Cannot package symlinked release input ${relative(sourceRoot, sourcePath)}.`);
    if (details.isDirectory()) {
      await copyTree(sourcePath, targetPath, `${relativePath}/`);
    } else if (details.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    } else {
      throw new Error(`Cannot package non-regular release input ${relative(sourceRoot, sourcePath)}.`);
    }
  }
}

function marketplaceDescriptor(): MarketplaceDescriptor {
  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Stereofold local' },
    plugins: [{
      name: 'stereofold',
      source: { source: 'local', path: './plugins/stereofold' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Education & Research',
    }],
  };
}

function claudeMarketplaceDescriptor(version: string): ClaudeMarketplaceDescriptor {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'Stereofold Contributors' },
    metadata: {
      description: 'Local Stereofold share: the same plugin directory Codex installs, with its shipped MCP server.',
      version,
    },
    plugins: [{
      name: 'stereofold',
      source: CLAUDE_PLUGIN_SOURCE,
      description: 'Registers the shipped stereo_structure MCP server, its skills, and the headset skill for Claude Code, including Meta Quest, Apple Vision Pro and other WebXR headset browsers.',
      version,
    }],
  };
}

/**
 * The revision the share was built from, when the artifact sits in a checkout.
 *
 * A share is a complete local delivery: its recipient installs from the share
 * without cloning the repository. The commit identifies a delivery in a problem
 * report and tells two shares apart when their versions match. A build outside a
 * checkout records nothing rather than guessing.
 */
export async function sourceRevision(artifactRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', artifactRoot, 'rev-parse', 'HEAD']);
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(commit)) return undefined;
    const { stdout: dirty } = await execFileAsync('git', ['-C', artifactRoot, 'status', '--porcelain']);
    return dirty.trim().length === 0 ? commit : `${commit} (built with uncommitted changes)`;
  } catch {
    return undefined;
  }
}

export function shareGuide(version: string, builds: { inspector: string; viewer: string; commit?: string }): string {
  return `# Stereofold local share

This directory is a generated, local distribution of the complete Stereofold
plugin artifact (version ${version}). It does not publish anything and it does
not modify a Codex or Claude profile by itself.

Build identity:

- viewer: \`${builds.viewer}\`
- inspector: \`${builds.inspector}\`
${builds.commit ? `- source commit: \`${builds.commit}\`\n` : ''}
The first two are the self-stamped bundle identities from the shipped HTML
files; use them when comparing a mounted panel with this share.${builds.commit
    ? '\n\nThe source commit identifies this delivery when reporting a problem.'
    : ''}

## Requirements

The staged server requires Node.js 22 or newer. **Connect over Wi-Fi** also
needs \`openssl\` at a fixed runtime location to create the private LAN certificate, plus
an assigned RFC1918 IPv4 address on the intended interface. OpenSSL searches
\`/usr/bin/openssl\`, \`/opt/homebrew/bin/openssl\`, \`/usr/local/bin/openssl\`,
then \`/bin/openssl\`; it has no PATH fallback or environment override.
**Send using Meta**
requires an already installed \`cloudflared\` executable on the host PATH, or
an absolute executable path in \`STEREOFOLD_CLOUDFLARED\`; Stereofold never
downloads or updates it. The Meta route is an explicit public HTTPS relay.

Headset push-to-talk on a Mac uses Apple's on-device recognizer, which is one
compile step away and is *not* shipped compiled: a Mach-O built on one Mac is
the wrong file to hand another one. Build it in the extracted plugin:

\`\`\`sh
sh plugins/stereofold/native/applespeech/build.sh
\`\`\`

The setup skill lists the fixed helper paths, PATH fallbacks and absolute
\`STEREOFOLD_FFMPEG_BIN\`, \`STEREOFOLD_WHISPER_BIN\` and
\`STEREOFOLD_APPLESPEECH_BIN\` overrides. Spoken replies have no ffmpeg PATH
fallback; set its override for a nonstandard installation.

Both transcription routes require \`ffmpeg\` on the host. Without the Apple
helper the host transcribes with \`whisper-cli\`, which also needs a readable
model named by \`STEREOFOLD_WHISPER_MODEL\`. Set \`STEREOFOLD_PTT_TRANSCRIBER=whisper\` to stay
on whisper on a Mac that has the Apple helper built.

Setting \`STEREOFOLD_PTT_TRANSCRIBE=1\` in the MCP server environment is
recommended to make transcription explicit; restart the host after changing it.
Unset, the runtime auto-detects a local transcriber: an Apple helper with \`ffmpeg\` or a complete Whisper route enables transcription, and readiness reports the
local recognizer resolved (Apple still needs Speech Recognition consent).
With none detected, voice stays off and readiness names the missing prerequisites;
no headset speech is transcribed. With \`=1\` and no transcriber, readiness
instead reports the missing prerequisites. \`0\` explicitly turns transcription
off. Recording still requires microphone permission and a held talk control.
Keep an already configured spoken-reply provider. On a Mac without an OAuth narration helper, set \`STEREOFOLD_REPLY_VOICE_PROVIDER=system\`; it uses local \`say\` and
\`ffmpeg\`. Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply. The runtime's unset reply provider is OAuth, whose narration
helper Stereofold does not ship; without it, replies are captions with no sound.
Follow \`plugins/stereofold/QUICKSTART.md\` for consent and readiness checks.

## Two hosts, one plugin directory

Codex reads \`plugins/stereofold/.codex-plugin/plugin.json\` and Claude Code
reads \`plugins/stereofold/.claude-plugin/plugin.json\`. Both install the whole
\`plugins/stereofold/\` directory and both start the same \`dist/server.mjs\`,
so the two hosts run one build. The build identities above are the check:
every host should report the same pair.

## Verify the share

Run this from the extracted share directory:

\`\`\`sh
shasum -a 256 -c SHA256SUMS
# Linux alternative:
sha256sum -c SHA256SUMS
\`\`\`

The archive contains this checksum manifest, so an archive-only recipient can
extract it and verify the complete marketplace root. When the adjacent archive
sidecar is available, verify the outer archive before extracting it:

\`\`\`sh
shasum -a 256 -c stereofold-marketplace.tar.gz.sha256
\`\`\`

## Use the local Codex marketplace

The generated root contains \`.agents/plugins/marketplace.json\` and
\`plugins/stereofold/\`. The descriptor uses Codex's local marketplace shape
and the relative source \`./plugins/stereofold\`:

\`\`\`sh
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin marketplace list --json
codex plugin add stereofold@stereofold-local
\`\`\`

The last command installs into the selected Codex profile. Run these commands
only on the machine and profile where you want the plugin installed. The
packager itself performs no installation, profile write, or marketplace
registration.

## Use the local Claude Code marketplace

Claude Code reads \`.claude-plugin/marketplace.json\`, which this root carries
beside the Codex descriptor. The plugin it installs registers the shipped
\`stereo_structure\` MCP server, loads the same skills Codex reads, and adds the
\`stereofold-quest\` skill for a paired headset.

\`\`\`sh
claude plugin marketplace add /absolute/path/to/stereofold-share
claude plugin install stereofold@${MARKETPLACE_NAME}
\`\`\`

Claude Code opens the bundled panel in this Mac's browser through
\`stereo_structure.open_inspector\`, so the first scene can be saved from Claude Code alone.
Follow \`plugins/stereofold/claude-code/skills/stereofold-quest/SKILL.md\`
for the scene and headset steps. Codex can also render the same panel inside
its own window.

## Use the artifact with Claude Science

Claude Science does not consume the Codex marketplace descriptor. Add one
object to the \`servers\` array in \`~/.claude-science/mcp/local-mcp.json\`,
keeping every entry already there, then restart it and reconnect the connector:

\`\`\`json
{
  "name": "stereofold",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/stereofold-share/plugins/stereofold/dist/server.mjs"],
  "env": {}
}
\`\`\`

Both paths are absolute because that daemon runs with a stripped PATH, which is
also why every optional helper it should reach has to be named in \`env\`.
\`plugins/stereofold/skills/stereofold-setup/SKILL.md\` covers the whole route,
including which variable turns on which feature.

Keep the \`.agents\` descriptor for Codex; do not copy it into Claude's MCP
configuration. Physical Quest entry remains a separate hardware qualification
and is not established by this local package check.
`;
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function buildIdentity(path: string, label: string): Promise<string> {
  const identity = stampedBuildId(await readInlineHtml(path));
  if (identity == null) throw new Error(`${label} must carry exactly one self-consistent build identity.`);
  return identity;
}

async function writeChecksums(root: string): Promise<void> {
  const files = await walkRegularFiles(root);
  const included = files.filter((file) => file !== CHECKSUM_NAME);
  const lines = await Promise.all(included.map(async (file) => `${await sha256(resolve(root, file))}  ${file}`));
  const checksums = `${lines.join('\n')}\n`;
  await writeFile(resolve(root, CHECKSUM_NAME), checksums, 'utf8');
}

async function ensureOutputIsSafe(outputRoot: string, artifactRoot: string): Promise<void> {
  const outputDetails = await lstat(outputRoot).catch(() => undefined);
  if (outputDetails?.isSymbolicLink()) throw new Error('Output directory must not be a symlink.');
  if (outputDetails != null && !outputDetails.isDirectory()) throw new Error(`Output path is not a directory: ${outputRoot}`);
  if (outputDetails != null) throw new Error(`Output path already exists: ${outputRoot}`);

  const artifactReal = await resolveRealPath(artifactRoot);
  const outputParentReal = await resolveRealPath(dirname(outputRoot));
  const prospectiveOutput = resolve(outputParentReal, basename(outputRoot));
  if (prospectiveOutput === artifactReal || prospectiveOutput.startsWith(`${artifactReal}${sep}`)) {
    throw new Error('Output directory must be outside the release artifact.');
  }
}

async function resolveRealPath(path: string): Promise<string> {
  const details = await lstat(path).catch(() => undefined);
  if (details != null) {
    if (details.isSymbolicLink()) throw new Error(`Path must not be a symlink: ${path}`);
    return resolve(path);
  }
  const parent = dirname(path);
  if (parent === path) return resolve(path);
  return resolve(await resolveRealPath(parent), basename(path));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value == null || value.startsWith('--')) return undefined;
  return value;
}

export async function packageShare(options: PackageShareOptions): Promise<PackageShareResult> {
  if (isAbsolute(options.artifact) === false) {
    throw new Error(`Artifact path must be absolute after resolution; received ${options.artifact}.`);
  }
  if (isAbsolute(options.output) === false) {
    throw new Error(`Output path must be absolute after resolution; received ${options.output}.`);
  }
  const artifactRoot = resolve(options.artifact);
  const outputRoot = resolve(options.output);
  const manifest = await validateArtifact(artifactRoot);
  await ensureOutputIsSafe(outputRoot, artifactRoot);

  const outputParent = dirname(outputRoot);
  await mkdir(outputParent, { recursive: true });
  const stageRoot = await mkdtemp(join(outputParent, `.${basename(outputRoot)}.stage-`));
  try {
    const pluginRoot = resolve(stageRoot, 'plugins/stereofold');
    await copyTree(artifactRoot, pluginRoot);
    const [viewerBuild, inspectorBuild] = await Promise.all([
      buildIdentity(resolve(pluginRoot, 'dist/viewer.html'), 'Viewer bundle'),
      buildIdentity(resolve(pluginRoot, 'dist/inspector.html'), 'Inspector bundle'),
    ]);
    const marketplacePath = resolve(stageRoot, CODEX_MARKETPLACE_PATH);
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, `${JSON.stringify(marketplaceDescriptor(), null, 2)}\n`, 'utf8');
    const claudeMarketplacePath = resolve(stageRoot, CLAUDE_MARKETPLACE_PATH);
    await mkdir(dirname(claudeMarketplacePath), { recursive: true });
    await writeFile(
      claudeMarketplacePath,
      `${JSON.stringify(claudeMarketplaceDescriptor(String(manifest.version)), null, 2)}\n`,
      'utf8',
    );
    await writeFile(resolve(stageRoot, SHARE_GUIDE_NAME), shareGuide(String(manifest.version), {
      commit: await sourceRevision(artifactRoot),
      inspector: inspectorBuild,
      viewer: viewerBuild,
    }), 'utf8');

    const archivePath = resolve(stageRoot, ARCHIVE_NAME);
    await writeChecksums(stageRoot);
    // Native tar records the builder's account and filesystem metadata.
    // The portable writer keeps recipient bytes while clearing those headers.
    await execFileAsync('python3', [
      fileURLToPath(new URL('./share-archive.py', import.meta.url)),
      archivePath,
      stageRoot,
      '.agents',
      '.claude-plugin',
      'plugins',
      SHARE_GUIDE_NAME,
      CHECKSUM_NAME,
    ]);
    const archiveChecksumPath = resolve(stageRoot, ARCHIVE_CHECKSUM_NAME);
    await writeFile(archiveChecksumPath, `${await sha256(archivePath)}  ${ARCHIVE_NAME}\n`, 'utf8');

    await rename(stageRoot, outputRoot);
    return {
      archive: resolve(outputRoot, ARCHIVE_NAME),
      archiveChecksum: resolve(outputRoot, ARCHIVE_CHECKSUM_NAME),
      checksums: resolve(outputRoot, CHECKSUM_NAME),
      claudeMarketplace: resolve(outputRoot, CLAUDE_MARKETPLACE_PATH),
      marketplace: resolve(outputRoot, CODEX_MARKETPLACE_PATH),
      output: outputRoot,
      plugin: resolve(outputRoot, 'plugins/stereofold'),
    };
  } catch (error) {
    await rm(stageRoot, { force: true, recursive: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const artifact = argument('--artifact') ?? resolve(pluginRoot, 'release/stereofold');
  const output = argument('--out');
  if (output == null) throw new Error('Usage: package-share.ts --out /absolute/path/to/share [--artifact /absolute/path/to/stereofold].');
  const result = await packageShare({ artifact: resolve(artifact), output: resolve(output) });
  console.log(`SHARE PACKAGE ${result.output}`);
  console.log(`MARKETPLACE ${result.marketplace}`);
  console.log(`CLAUDE MARKETPLACE ${result.claudeMarketplace}`);
  console.log(`PLUGIN ${result.plugin}`);
  console.log(`ARCHIVE ${result.archive}`);
  console.log(`ARCHIVE CHECKSUM ${result.archiveChecksum}`);
  console.log(`CHECKSUMS ${result.checksums}`);
}

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url) void main();
