import type { Metafile } from 'esbuild';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface PackageMetadata {
  author?: unknown;
  homepage?: unknown;
  license?: unknown;
  name?: unknown;
  version?: unknown;
}

interface BundledPackage {
  author?: string;
  homepage?: string;
  license: string;
  name: string;
  noticeFiles: Array<{ name: string; text: string }>;
  root: string;
  version: string;
}

/** Keep generated notices stable across packages that ship CRLF licenses. */
function normalizeNoticeText(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

function textMetadata(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value != null && typeof value === 'object' && 'name' in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  return undefined;
}

async function noticeFiles(packageRoot: string): Promise<Array<{ name: string; text: string }>> {
  const names = (await readdir(packageRoot)).filter((name) =>
    /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name));
  const files: Array<{ name: string; text: string }> = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const path = resolve(packageRoot, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Refusing non-regular third-party notice source: ${path}`);
    }
    files.push({ name, text: normalizeNoticeText(await readFile(path, 'utf8')) });
  }
  return files;
}

async function findPackage(input: string, pluginRoot: string): Promise<BundledPackage | undefined> {
  const inputPath = await realpath(resolve(pluginRoot, input));
  if (!inputPath.split(/[\\/]/u).includes('node_modules')) return undefined;

  let cursor = dirname(inputPath);
  for (;;) {
    if (!cursor.split(/[\\/]/u).includes('node_modules')) break;
    try {
      const metadata = JSON.parse(await readFile(resolve(cursor, 'package.json'), 'utf8')) as PackageMetadata;
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string'
        && typeof metadata.license === 'string') {
        const files = await noticeFiles(cursor);
        if (files.length > 0) {
          return {
            author: textMetadata(metadata.author),
            homepage: textMetadata(metadata.homepage),
            license: metadata.license,
            name: metadata.name,
            noticeFiles: files,
            root: cursor,
            version: metadata.version,
          };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Could not locate package metadata and license text for bundled input: ${input}`);
}

/**
 * Two different on-disk roots for the same name@version identity can be
 * legitimate: pnpm sometimes gives a dependency's own nested resolution a
 * separate hardlinked copy of the same store package rather than a symlink,
 * so the roots differ but the content doesn't. Compare the metadata that
 * ends up in the notices file plus every notice file's exact text; only a
 * genuine difference in that content is a real conflict worth failing the
 * build over.
 */
function sameLicenseContent(a: BundledPackage, b: BundledPackage): boolean {
  if (a.license !== b.license) return false;
  if (a.noticeFiles.length !== b.noticeFiles.length) return false;
  return a.noticeFiles.every((file, index) =>
    file.name === b.noticeFiles[index].name && file.text === b.noticeFiles[index].text);
}

function fencedText(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}text\n${text.replace(/\s+$/u, '')}\n${fence}`;
}

export async function generateThirdPartyNotices(
  pluginRoot: string,
  metafiles: readonly Metafile[],
): Promise<string> {
  const packageByIdentity = new Map<string, BundledPackage>();
  const inputs = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.inputs)));
  for (const input of [...inputs].sort((left, right) => left.localeCompare(right))) {
    const bundledPackage = await findPackage(input, pluginRoot);
    if (bundledPackage == null) continue;
    const identity = `${bundledPackage.name}@${bundledPackage.version}`;
    const existing = packageByIdentity.get(identity);
    if (existing == null) {
      packageByIdentity.set(identity, bundledPackage);
      continue;
    }
    if (existing.root === bundledPackage.root) continue;
    // Two different node_modules paths (a hoisted pnpm link and a
    // dependency's own nested link or hardlinked copy) can both name the
    // same on-disk package content under different roots. Keep whichever
    // root was seen first, and only fail the build when the content that
    // actually ends up in the notices file genuinely disagrees.
    if (!sameLicenseContent(existing, bundledPackage)) {
      throw new Error(`Bundled package identity resolves to multiple roots: ${identity}`);
    }
  }
  if (packageByIdentity.size === 0) throw new Error('No bundled third-party packages were found.');

  const packages = [...packageByIdentity.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const sections = packages.map((item) => {
    const metadata = [
      `- Package: ${item.name}`,
      `- Version: ${item.version}`,
      `- License metadata: ${item.license}`,
      ...(item.author == null ? [] : [`- Author metadata: ${item.author}`]),
      ...(item.homepage == null ? [] : [`- Homepage metadata: ${item.homepage}`]),
    ].join('\n');
    const texts = item.noticeFiles.map((file) =>
      `### ${file.name}\n\n${fencedText(file.text)}`).join('\n\n');
    return `## ${item.name} ${item.version}\n\n${metadata}\n\n${texts}`;
  });

  const fontRoot=resolve(pluginRoot,'../lab/inspection/fonts');
  const fontNotices=await Promise.all(['SourceSans3','IBMPlexMono'].map(async name=>
    `## ${name} embedded fonts\n\n${fencedText((await readFile(resolve(fontRoot,`${name}-OFL.txt`),'utf8')).replace(/\r\n?/g,'\n').replace(/[ \t]+$/gm,''))}`));
  return `# Third-party notices

This file is generated by \`plugin/scripts/build.ts\` from the esbuild
metafiles and the package metadata and license/notice files installed for the
code actually bundled into all four runtime bundles: \`dist/server.mjs\`,
\`dist/viewer.html\`, \`dist/inspector.html\`, and \`dist/inspector-host.js\`.
Do not edit it by hand.

The Stereofold project license is in \`LICENSE\`. The following notices apply
to bundled third-party software. Copyright and attribution statements below
are reproduced from each installed package's own files.

${sections.join('\n\n')}\n\n${fontNotices.join('\n\n')}
`;
}
