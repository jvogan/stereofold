#!/usr/bin/env python3
"""Export packages from a verified share, with an optional Codex submission profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import unicodedata
import zipfile

MAX_FILE_BYTES = 5 * 1024 * 1024
ARCHIVE = 'stereofold-marketplace.tar.gz'
RUNTIME = 'plugins/stereofold/'
CODEX_PROFILE = Path(__file__).resolve().parent.parent / 'distributions/codex-submission'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    """Read ordinary files once, rejecting links and device/socket entries."""
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Share must be a directory, not a symlink.')
    files = {}
    for parent, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(parent) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f'Share contains a symlink or special file: {path.relative_to(root)}')
            if stat.S_ISREG(mode):
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    data = stream.read()
                    after = os.fstat(stream.fileno())
                if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError(f'Share changed while being read: {path.relative_to(root)}')
                files[path.relative_to(root).as_posix()] = (data, 0o755 if mode & 0o111 else 0o644)
    return files


def checksum_entries(data):
    result = {}
    for line in data.decode('utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('Invalid SHA256SUMS line.')
        digest, name = match.groups()
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or '\\' in name or name in result:
            raise ValueError(f'Unsafe or duplicate checksum path: {name}')
        result[name] = digest
    if not result:
        raise ValueError('SHA256SUMS is empty.')
    return result


def verified_share(root):
    files = inventory(root)
    if 'SHA256SUMS' not in files:
        raise ValueError('Share must contain SHA256SUMS from package-share.ts.')
    entries = checksum_entries(files['SHA256SUMS'][0])
    for name, digest in entries.items():
        if name not in files or sha256(files[name][0]) != digest:
            raise ValueError(f'Share checksum mismatch: {name}')
    extras = set(files) - set(entries) - {'SHA256SUMS'}
    archive_files = {ARCHIVE, ARCHIVE + '.sha256'}
    if extras and extras != archive_files:
        raise ValueError(f'Share has unchecked files: {sorted(extras)}')
    if extras:
        archive_entries = checksum_entries(files[ARCHIVE + '.sha256'][0])
        if archive_entries != {ARCHIVE: sha256(files[ARCHIVE][0])}:
            raise ValueError('Marketplace archive checksum mismatch.')
    required = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'SHARE.md']
    required += [RUNTIME + name for name in [
        '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/icon.png', '.mcp.json',
        'LICENSE', 'README.md', 'QUICKSTART.md', 'THIRD_PARTY_NOTICES.md',
        'assets/icon-256.png', 'assets/logo-1024.png', 'dist/server.mjs',
        'dist/viewer.html', 'dist/inspector.html', 'dist/inspector.css',
        'skills/molecular-presentation/SKILL.md', 'skills/molecular-presentation/scripts/lesson.mjs',
        'skills/stereo-structure/SKILL.md', 'skills/stereofold-setup/SKILL.md',
    ]]
    if any(name not in entries for name in required):
        raise ValueError('Input is missing required checksummed marketplace/runtime files.')
    for name in entries:
        if name.startswith(RUNTIME):
            parts = PurePosixPath(name[len(RUNTIME):]).parts
            if any(part in {'src', 'test', 'node_modules', '__pycache__'} for part in parts) or parts[0] == 'package.json':
                raise ValueError(f'Runtime share contains development files: {name}')
            if len(files[name][0]) >= MAX_FILE_BYTES:
                raise ValueError(f'Runtime file must be smaller than 5 MiB: {name}')
        elif name not in required[:3]:
            raise ValueError(f'Unexpected marketplace file: {name}')
    codex = json.loads(files[RUNTIME + '.codex-plugin/plugin.json'][0])
    claude = json.loads(files[RUNTIME + '.claude-plugin/plugin.json'][0])
    version = codex.get('version')
    if codex.get('name') != 'stereofold' or claude.get('name') != 'stereofold' or not isinstance(version, str) or not version or claude.get('version') != version:
        raise ValueError('Stereofold manifests must declare the same nonempty version.')
    if codex.get('mcpServers') != './.mcp.json':
        raise ValueError('Full Stereofold manifest must reference its local .mcp.json.')
    validate_codex_package({name[len(RUNTIME):]: value for name, value in files.items() if name.startswith(RUNTIME)}, codex)
    for name, source in [
        ('.agents/plugins/marketplace.json', {'source': 'local', 'path': './plugins/stereofold'}),
        ('.claude-plugin/marketplace.json', './plugins/stereofold'),
    ]:
        plugins = json.loads(files[name][0]).get('plugins', [])
        if not any(item.get('name') == 'stereofold' and item.get('source') == source for item in plugins):
            raise ValueError('Marketplace does not register the Stereofold plugin.')
    return files, codex


def validate_codex_package(files, manifest):
    """Check local paths and final listing text limits, not directory eligibility.

    Compatibility manifests remain supported. Local MCP/hardware review is a
    separate process; preserving its actual server configuration matters here.
    See developers.openai.com/plugins/deploy/submission-errors.
    """
    interface = manifest.get('interface')
    if not isinstance(interface, dict):
        raise ValueError('Codex manifest must have interface metadata.')
    for field, limit in [('displayName', 30), ('shortDescription', 30), ('longDescription', 4000), ('developerName', 80)]:
        value = interface.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > limit or ('\n' in value or '\r' in value) and field != 'longDescription':
            raise ValueError(f'Codex interface.{field} must be nonempty and at most {limit} characters.')
    capabilities = interface.get('capabilities')
    if not isinstance(capabilities, list) or len(capabilities) > 20 or any(
        not isinstance(value, str) or not value.strip() or len(value) > 120 or '\n' in value or '\r' in value for value in capabilities
    ):
        raise ValueError('Codex interface.capabilities must be a list of at most 20 nonempty single-line strings.')
    prompts = interface.get('defaultPrompt', [])
    if not isinstance(prompts, list) or len(prompts) > 3 or any(
        not isinstance(value, str) or not value.strip() or len(value) > 128 or '\n' in value or '\r' in value for value in prompts
    ):
        raise ValueError('Codex starter prompts must have at most 3 single-line entries of 128 characters or fewer.')
    normalized = [' '.join(unicodedata.normalize('NFKC', value).split()) for value in prompts]
    if len(set(normalized)) != len(normalized):
        raise ValueError('Codex starter prompts must be unique.')

    def local_reference(value, directory=False):
        if not isinstance(value, str) or not value.startswith('./') or value.strip() != value or '\\' in value or any(ord(char) < 32 for char in value):
            raise ValueError('Codex manifest references must use safe ./ paths inside the package.')
        path = PurePosixPath(value[2:])
        if path.is_absolute() or '..' in path.parts or ':' in value or path.as_posix() == '.':
            raise ValueError('Codex manifest reference leaves the package root.')
        name = path.as_posix()
        if not (any(file.startswith(name + '/') for file in files) if directory else name in files):
            raise ValueError(f'Codex manifest reference is missing: {value}')

    local_reference(manifest.get('skills'), directory=True)
    for field in ['composerIcon', 'logo']:
        local_reference(interface.get(field))
    for field in ['mcpServers', 'apps']:
        if field in manifest:
            local_reference(manifest[field])
    if 'mcpServers' in manifest:
        mcp = json.loads(files[manifest['mcpServers'][2:]][0])
        servers = mcp.get('mcpServers', {})
        if not servers or any(server.get('command') != 'node' or server.get('cwd') != '.' or server.get('args') != ['./dist/server.mjs'] for server in servers.values()):
            raise ValueError('Full Stereofold runtime must preserve its local Node MCP server command.')
        local_reference('./dist/server.mjs')


def write_file(root, name, value, mode=0o644):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value.encode('utf-8') if isinstance(value, str) else value)
    path.chmod(mode)


def archive(folder, target, include_folder=False):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for file in sorted(folder.rglob('*')):
            if not file.is_file():
                continue
            relative = file.relative_to(folder).as_posix()
            name = folder.name + '/' + relative if include_folder else relative
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100755 if file.stat().st_mode & 0o111 else 0o100644) << 16
            zipped.writestr(info, file.read_bytes(), compresslevel=9)


def codex_submission(files, original, profile):
    """Apply two declared changes; keep the complete runtime and its references."""
    inputs = inventory(profile)
    if set(inputs) != {'listing.json', 'stereofold-setup/SKILL.md'}:
        raise ValueError('Codex submission profile must contain only listing.json and stereofold-setup/SKILL.md.')
    listing = json.loads(inputs['listing.json'][0])
    if not isinstance(listing, dict) or set(listing) != {'description', 'interface'} or not isinstance(listing['interface'], dict) or set(listing['interface']) != {'shortDescription', 'longDescription'}:
        raise ValueError('Codex submission profile may change only description and short/long listing descriptions.')
    if not isinstance(listing['description'], str) or not listing['description'].strip() or len(listing['description']) > 4000:
        raise ValueError('Codex submission description must be nonempty and at most 4000 characters.')
    skill = inputs['stereofold-setup/SKILL.md'][0]
    if not re.match(rb'---\r?\nname: stereofold-setup\r?\ndescription: [^\r\n]+\r?\n---\r?\n', skill):
        raise ValueError('Codex submission onboarding must retain the stereofold-setup skill identity and description.')
    manifest = json.loads(json.dumps(original))
    manifest['description'] = listing['description']
    manifest['interface'].update(listing['interface'])
    replacements = {
        '.codex-plugin/plugin.json': (json.dumps(manifest, indent=2, ensure_ascii=False).encode() + b'\n', 0o644),
        'skills/stereofold-setup/SKILL.md': (skill, 0o644),
    }
    contents = {name[len(RUNTIME):]: value for name, value in files.items() if name.startswith(RUNTIME)}
    changes = [{'path': name, 'source_sha256': sha256(contents[name][0]), 'candidate_sha256': sha256(data)}
        for name, (data, _) in sorted(replacements.items())]
    contents.update(replacements)
    if any(len(data) >= MAX_FILE_BYTES for data, _ in contents.values()):
        raise ValueError('Codex submission profile files must be smaller than 5 MiB.')
    validate_codex_package(contents, manifest)
    return contents, {'name': 'codex-submission',
        'inputs': [{'path': name, 'sha256': sha256(data)} for name, (data, _) in sorted(inputs.items())],
        'changes': changes,
        'note': 'Only the two declared files differ from the full Codex export. Runtime, helpers, references and other skills are identical.'}


def export(share, output, submission_profile=None):
    # Check the lexical root first, then use fixed canonical paths. The parent
    # directory and input are trusted; this is not a hostile same-user sandbox.
    if share.is_symlink():
        raise ValueError('Share must not be a symlink.')
    share = share.resolve(strict=True)
    if os.path.lexists(output):
        raise ValueError('Output path already exists; choose a NEW directory.')
    output = output.parent.resolve(strict=True) / output.name
    if output == share or output.is_relative_to(share):
        raise ValueError('Output must be outside the share directory.')
    files, original = verified_share(share)
    candidate = codex_submission(files, original, submission_profile) if submission_profile else None
    output.mkdir()  # Exclusive creation; an existing target is never replaced.
    try:
        claude = output / 'claude-plugin'
        full_codex = output / 'codex-plugin'
        skill = output / 'molecular-presentation'
        codex = output / 'codex-presentations-plugin'
        for name, (data, mode) in files.items():
            if name.startswith(RUNTIME):
                relative = name[len(RUNTIME):]
                write_file(full_codex, relative, data, mode)
                # Claude uses its own manifest; Codex listing metadata belongs
                # only in the full Codex export and the input share.
                if not relative.startswith('.codex-plugin/'):
                    write_file(claude, 'RUNTIME.md' if relative == 'README.md' else relative, data, mode)
                prefix = 'skills/molecular-presentation/'
                if relative.startswith(prefix):
                    write_file(skill, relative[len(prefix):], data, mode)
        write_file(claude, 'README.md', CLAUDE_README)
        write_file(skill, 'LICENSE', files[RUNTIME + 'LICENSE'][0])
        shutil.copytree(skill, codex / 'skills/molecular-presentation')
        for name in ['assets/icon-256.png', 'assets/logo-1024.png', 'LICENSE']:
            write_file(codex, name, files[RUNTIME + name][0])
        manifest = json.loads(json.dumps(PRESENTATIONS_TEMPLATE))
        for key in ['version', 'author', 'license', 'homepage', 'repository']:
            if key in original:
                manifest[key] = original[key]
            else:
                manifest.pop(key, None)
        for key in ['developerName', 'websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL', 'category', 'brandColor', 'brandColorDark']:
            if key in original.get('interface', {}):
                manifest['interface'][key] = original['interface'][key]
            else:
                manifest['interface'].pop(key, None)
        publication = original.get('extensions', {}).get('com.openai', {}).get('publication', {})
        manifest['extensions'] = {'com.openai': {
            'review': {'commerce': False, 'commerce_description': 'Stereofold Presentations is a free, MIT-licensed lesson-planning plugin with no purchases or payments.'},
            'publication': {
                'release_notes': 'Initial Stereofold Presentations release: create, validate and compile molecular lessons with the bundled Node.js planner, examples and licenses.',
                **({'countries': publication['countries']} if 'countries' in publication else {}),
            },
        }}
        write_file(codex, '.codex-plugin/plugin.json', json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        write_file(codex, 'README.md', CODEX_README)
        validate_codex_package(inventory(codex), manifest)
        packages = []
        layouts = [
            (full_codex, 'stereofold-codex-plugin.zip', False),
            (claude, 'stereofold-claude-plugin.zip', False),
            (skill, 'molecular-presentation.zip', True),
            (codex, 'stereofold-presentations-codex.zip', False),
        ]
        if candidate:
            candidate_files, profile_record = candidate
            submission = output / 'codex-submission-plugin'
            for name, (data, mode) in candidate_files.items():
                write_file(submission, name, data, mode)
            layouts.append((submission, 'stereofold-codex-submission.zip', False))
        for folder, zip_name, wrap in layouts:
            contents = inventory(folder)
            packages.append({'directory': folder.name, 'files': len(contents),
                'bytes': sum(len(data) for data, _ in contents.values()),
                'largest_file_bytes': max(len(data) for data, _ in contents.values()), 'archive': zip_name})
            archive(folder, output / zip_name, wrap)
        recorded = re.search(r'- source commit: `([^`\n]+)`', files['SHARE.md'][0].decode('utf-8'))
        provenance = {'checksum_manifest_sha256': sha256(files['SHA256SUMS'][0]),
            'source_commit_as_recorded': recorded.group(1) if recorded else None,
            'note': 'Input files matched the supplied share checksums; the recorded commit is not independently verified against Git.'}
        metadata = {'version': original['version'], 'source_share': provenance, 'packages': packages}
        if candidate:
            metadata['codex_submission_profile'] = profile_record
        write_file(output, 'ARTIFACTS.json', json.dumps(metadata, indent=2) + '\n')
        exported = inventory(output)
        write_file(output, 'SHA256SUMS', ''.join(sha256(data) + '  ' + name + '\n' for name, (data, _) in sorted(exported.items())))
        return packages
    except Exception:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--share', required=True, type=Path, help='Checksummed marketplace share from package-share.ts')
    parser.add_argument('--out', required=True, type=Path, help='NEW output directory with an existing parent')
    parser.add_argument('--codex-submission', action='store_true', help='Also export the full Codex runtime with the separate listing/onboarding profile')
    arguments = parser.parse_args()
    try:
        print(json.dumps(export(arguments.share, arguments.out, CODEX_PROFILE if arguments.codex_submission else None), indent=2))
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f'Export refused: {error}\n')

CLAUDE_README = """# Stereofold

![Stereofold](assets/icon-256.png)

Put molecules in your headset and keep changing them with Claude.

Start with a structure on your computer. Ask Claude to highlight a ligand,
make the surrounding protein transparent, or enlarge a cryo-EM microtubule
overhead. Keep editing the scene while the connected computer and headset
views update. Switch structures without pairing again.

Build a microtubule wall by revealing deposited tubulin copies. Prepare a
related cryo-EM density map for a larger view. Map transitions are experimental
and can stall scene updates; the [demo guide](demos/README.md) explains
preparation and recovery. Pause a guided lesson to investigate a detail, move
the molecule, or walk around it. Bundled demos include source identities and
coordinate checksums so your agent can verify what you see.

## Use with Claude Code

Install Node.js 22 or newer, then start Claude Code with this plugin folder:

```sh
claude --plugin-dir /absolute/path/to/stereofold
```

Ask: “Open PDB 1CRN in Stereofold.” For immersive viewing, ask Claude to share
the current scene with your headset. The plugin starts its bundled MCP server;
no npm installation or build is required. macOS is the tested desktop setup.
Meta Quest and Apple Vision Pro have named launch routes; other WebXR browsers
can use the private HTTPS pairing address and their supported session modes.

Try these requests:

- “Open PDB 4HHB. Show the hemes as sticks and make the protein transparent.”
- “Open the build stage of microtubule-arrival on my headset.”
- “Pause here. Make the molecule bigger and move it above me.”

The local server works in Claude Code and local Cowork sessions. Chat and cloud
Cowork sessions cannot run this local server. Claude Science uses a separately
registered local connector with the same skills. macOS and Claude Code have
been tested; actual Cowork behavior still needs verification. Headset features
depend on the browser's WebXR capabilities.

See the [quickstart](QUICKSTART.md), [runtime documentation](RUNTIME.md),
[bundled demos](demos/README.md), and [setup skill](skills/stereofold-setup/SKILL.md).

## Data and permissions

Stereofold runs on your computer, requires no Stereofold account, and sends
no telemetry to a publisher-operated service. Local diagnostics help your agent
troubleshoot rendering and input. Conversation content follows your host's data
policies. Private Wi-Fi sharing sends your selected coordinates to paired
viewers. Public PDB and AlphaFold requests contact RCSB and EMBL-EBI; opening a
coordinate URL contacts its host.

Typed requests work through your Claude conversation. Optional voice features
use a local transcription tool or an external voice helper selected during
setup. An optional public relay carries shared coordinates, and Meta launch
links use Meta's launch service. The [network and voice documentation](RUNTIME.md#network-use)
explains these data paths and the permissions each route needs.

Source, issues and license: [Stereofold](https://github.com/jvogan/stereofold),
[MIT](LICENSE). Dependency licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
"""

CODEX_README = """# Stereofold Presentations

![Stereofold](assets/icon-256.png)

Create reusable molecular lessons with an agent skill and a bundled Node.js
planner. The planner creates editable lesson JSON and compiles it into scene
and movie plans. It works without an MCP server, account or live viewer.

Ask your agent: “Create and compile a two-scene lesson about the fold of crambin,
PDB 1CRN.” The skill explains how to check source identities, preserve a user's
scene and confirm rendered results when a live viewer is available.

## Requirements

Use Node.js 22 or newer for the local planner. Live desktop presentation and
movie rendering require the separate Molecular Structure Viewer. Optional
WebXR headset playback uses the full Stereofold runtime and stereo-structure
skill, installed through a plugin or directly from the repository. A compiled plan
records intended changes; execution is confirmed by the destination viewer.

See the [skill](skills/molecular-presentation/SKILL.md) for commands and examples.
The package includes the MIT project license and licenses for bundled planner
dependencies. Local planning needs no network; fetching public structures or
scientific references uses the source services your agent chooses.

Source and issues: [Stereofold](https://github.com/jvogan/stereofold).
"""

PRESENTATIONS_TEMPLATE = {'name': 'stereofold-presentations',
 'description': 'Create source-backed molecular lessons and movie plans with a portable Node '
                'planner and agent skill.',
 'keywords': ['molecular', 'presentation', 'protein', 'pdb', 'lesson'],
 'skills': './skills/',
 'interface': {'displayName': 'Stereofold Presentations',
               'shortDescription': 'Present molecular structures.',
               'capabilities': [],
               'longDescription': 'Create reusable molecular lessons and movie plans from checked '
                                  'structural sources. A bundled Node.js planner validates lesson '
                                  'JSON and compiles scene intentions without a viewer. Live '
                                  'desktop presentation uses the separately installed Molecular '
                                  'Structure Viewer; optional WebXR playback uses the full '
                                  'Stereofold runtime. Includes examples, source checks and '
                                  'guidance for preserving the user’s current scene.',
               'composerIcon': './assets/icon-256.png',
               'logo': './assets/logo-1024.png',
               'defaultPrompt': ['Create and compile a two-scene lesson about the fold of crambin, '
                                 'PDB 1CRN.',
                                 'Build a molecular presentation from my structure and preserve my '
                                 'current viewer scene.',
                                 'Prepare a movie plan that explains the binding pocket in this '
                                 'structure.']}}


if __name__ == '__main__':
    main()
