import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const exporter=fileURLToPath(new URL('../scripts/package-submissions.py',import.meta.url));
const roots:string[]=[];
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const listingUrls={websiteURL:'https://example.org/plugin',supportURL:'https://example.org/support',
  privacyPolicyURL:'https://example.org/privacy',termsOfServiceURL:'https://example.org/terms'};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'stereofold-submissions-'));roots.push(root);
  const share=join(root,'marketplace'),out=join(root,'exports');
  mkdirSync(share);
  const files=new Map<string,string>();
  const add=(name:string,data:string)=>{files.set(name,data);const path=join(share,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data);};
  add('.agents/plugins/marketplace.json',JSON.stringify({plugins:[{name:'stereofold',source:{source:'local',path:'./plugins/stereofold'}}]}));
  add('.claude-plugin/marketplace.json',JSON.stringify({plugins:[{name:'stereofold',source:'./plugins/stereofold'}]}));
  add('SHARE.md','- source commit: `abc123-declared`\n');
  const manifest={name:'stereofold',version:'9.8.7',author:{name:'Fixture Publisher'},license:'MIT',
    homepage:'https://example.org',repository:'https://example.org/source',skills:'./skills/',mcpServers:'./.mcp.json',
    interface:{displayName:'Stereofold',shortDescription:'Explore molecules.',longDescription:'Inspect molecular structures.',
      developerName:'Fixture Publisher',brandColor:'#123456',capabilities:['Interactive','Read'],
      composerIcon:'./assets/icon-256.png',logo:'./assets/logo-1024.png',defaultPrompt:['Open a molecular structure.'],...listingUrls},
    extensions:{'com.openai':{onboardingSkill:'./skills/stereofold-setup/SKILL.md',
      review:{commerce:false,commerce_description:'This fixture has no purchases or payments.'},
      publication:{countries:[],release_notes:'Fixture runtime release 9.8.7.'}}}};
  const runtime='plugins/stereofold/';
  add(runtime+'.codex-plugin/plugin.json',JSON.stringify(manifest));
  add(runtime+'.claude-plugin/plugin.json',JSON.stringify(manifest));
  add(runtime+'.mcp.json',JSON.stringify({mcpServers:{stereo_structure:{command:'node',args:['./dist/server.mjs'],cwd:'.'}}}));
  for(const name of ['LICENSE','README.md','QUICKSTART.md','THIRD_PARTY_NOTICES.md',
    '.claude-plugin/icon.png','assets/icon-256.png','assets/logo-1024.png','dist/server.mjs','dist/viewer.html','dist/inspector.html',
    'dist/inspector.css','skills/molecular-presentation/SKILL.md','skills/molecular-presentation/scripts/lesson.mjs',
    'skills/stereo-structure/SKILL.md','skills/stereofold-setup/SKILL.md',
    'claude-code/skills/stereofold-quest/SKILL.md'])add(runtime+name,`content ${name}`);
  const checksum=()=>writeFileSync(join(share,'SHA256SUMS'),[...files].sort().map(([name,data])=>`${hash(data)}  ${name}\n`).join(''));
  checksum();
  const run=(output=out,submission=false)=>execFileSync('python3',[exporter,'--share',share,'--out',output,...(submission?['--codex-submission']:[])],{encoding:'utf8',stdio:'pipe'});
  return {root,share,out,run,add,checksum};
}

it('exports full runtime and portable layouts, supplied metadata and reproducible ZIPs with complete checksums',()=>{
  const f=fixture();f.run();
  const runtime=join(f.out,'claude-plugin');
  expect(readdirSync(runtime)).not.toContain('.codex-plugin');
  for(const name of ['.claude-plugin/plugin.json','.claude-plugin/icon.png','.mcp.json','RUNTIME.md','dist/server.mjs','dist/inspector.css',
    'skills/molecular-presentation/SKILL.md','skills/stereo-structure/SKILL.md','skills/stereofold-setup/SKILL.md',
    'claude-code/skills/stereofold-quest/SKILL.md','assets/logo-1024.png'])
    expect(readFileSync(join(runtime,name),'utf8')).toBe(readFileSync(join(f.share,'plugins/stereofold',name==='RUNTIME.md'?'README.md':name),'utf8'));
  expect(JSON.parse(readFileSync(join(runtime,'.claude-plugin/plugin.json'),'utf8'))).not.toHaveProperty('icon');
  expect(readFileSync(join(runtime,'README.md'),'utf8')).toContain('## Data and permissions');
  expect(readFileSync(join(f.out,'molecular-presentation/scripts/lesson.mjs'),'utf8')).toContain('content');
  const manifest=JSON.parse(readFileSync(join(f.out,'codex-presentations-plugin/.codex-plugin/plugin.json'),'utf8'));
  expect(manifest).toMatchObject({name:'stereofold-presentations',version:'9.8.7',author:{name:'Fixture Publisher'},homepage:'https://example.org',interface:{brandColor:'#123456'}});
  expect(manifest).not.toHaveProperty('mcpServers');
  expect(manifest.interface.capabilities).toEqual([]);
  expect(manifest.interface).toMatchObject(listingUrls);
  expect(manifest.extensions['com.openai'].publication.countries).toEqual([]);
  expect(manifest.extensions['com.openai'].publication.release_notes).toContain('Stereofold Presentations');
  expect(manifest.extensions['com.openai'].review).toMatchObject({commerce:false});
  expect(manifest.extensions['com.openai'].review.commerce_description).toMatch(/no purchases or payments/);
  expect(manifest.extensions['com.openai'].review).not.toHaveProperty('test_cases');
  expect(manifest.extensions['com.openai']).not.toHaveProperty('onboardingSkill');
  const fullCodex=join(f.out,'codex-plugin');
  for(const name of ['.codex-plugin/plugin.json','.claude-plugin/plugin.json','.claude-plugin/icon.png','.mcp.json','README.md','dist/inspector.css',
    'dist/server.mjs','skills/stereo-structure/SKILL.md','skills/stereofold-setup/SKILL.md','skills/molecular-presentation/SKILL.md'])
    expect(readFileSync(join(fullCodex,name))).toEqual(readFileSync(join(f.share,'plugins/stereofold',name)));
  const fullManifest=JSON.parse(readFileSync(join(fullCodex,'.codex-plugin/plugin.json'),'utf8'));
  expect(fullManifest.interface).toMatchObject(listingUrls);
  expect(fullManifest.extensions['com.openai']).toMatchObject({onboardingSkill:'./skills/stereofold-setup/SKILL.md',
    review:{commerce:false},publication:{countries:[],release_notes:'Fixture runtime release 9.8.7.'}});
  const artifacts=JSON.parse(readFileSync(join(f.out,'ARTIFACTS.json'),'utf8'));
  expect(artifacts.source_share).toMatchObject({source_commit_as_recorded:'abc123-declared',checksum_manifest_sha256:hash(readFileSync(join(f.share,'SHA256SUMS')))});
  expect(artifacts.packages.map((pkg:any)=>pkg.directory)).toEqual(['codex-plugin','claude-plugin','molecular-presentation','codex-presentations-plugin']);
  const second=join(f.root,'exports-again');f.run(second);
  for(const name of readdirSync(f.out).filter(name=>name.endsWith('.zip')))
    expect(readFileSync(join(second,name))).toEqual(readFileSync(join(f.out,name)));
  const checksums=readFileSync(join(f.out,'SHA256SUMS'),'utf8').trim().split('\n');
  for(const line of checksums){const [digest,name]=line.split('  ');expect(hash(readFileSync(join(f.out,name!)))).toBe(digest);}
  expect(checksums.some(line=>line.endsWith('  claude-plugin/dist/inspector.css'))).toBe(true);
  // Read the actual ZIP directory, including the skill-upload enclosing folder.
  const names=JSON.parse(execFileSync('python3',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',join(f.out,'molecular-presentation.zip')],{encoding:'utf8'}));
  expect(names).toContain('molecular-presentation/SKILL.md');
  expect(names.every((name:string)=>!name.startsWith('/')&&!name.split('/').includes('..'))).toBe(true);
  const fullZip=JSON.parse(execFileSync('python3',['-c',`import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({name:hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist()}))`,join(f.out,'stereofold-codex-plugin.zip')],{encoding:'utf8'}));
  expect(fullZip).toHaveProperty('.codex-plugin/plugin.json');
  expect(Object.keys(fullZip).every(name=>!name.startsWith('/')&&!name.startsWith('codex-plugin/')&&!name.split('/').includes('..'))).toBe(true);
  for(const [name,digest] of Object.entries(fullZip))expect(hash(readFileSync(join(fullCodex,name)))).toBe(digest);
  const claudeZip=JSON.parse(execFileSync('python3',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',join(f.out,'stereofold-claude-plugin.zip')],{encoding:'utf8'})) as string[];
  expect(claudeZip.some(name=>name.startsWith('.codex-plugin/'))).toBe(false);
  expect(claudeZip).toEqual(expect.arrayContaining(['.claude-plugin/plugin.json','.claude-plugin/icon.png','assets/logo-1024.png','dist/server.mjs',
    'skills/molecular-presentation/SKILL.md','skills/stereo-structure/SKILL.md','skills/stereofold-setup/SKILL.md',
    'claude-code/skills/stereofold-quest/SKILL.md']));
  // Omission must remain omission: inventing countries=[] here would clear a
  // saved portal allowlist, and the homepage must not invent listing URLs.
  const omitted=fixture(),manifestPath='plugins/stereofold/.codex-plugin/plugin.json';
  const omittedManifest=JSON.parse(readFileSync(join(omitted.share,manifestPath),'utf8'));
  delete omittedManifest.extensions['com.openai'].publication.countries;
  for(const field of Object.keys(listingUrls))delete omittedManifest.interface[field];
  omitted.add(manifestPath,JSON.stringify(omittedManifest));omitted.checksum();omitted.run();
  const presentationWithout=JSON.parse(readFileSync(join(omitted.out,'codex-presentations-plugin/.codex-plugin/plugin.json'),'utf8'));
  expect(presentationWithout.extensions['com.openai'].publication).not.toHaveProperty('countries');
  for(const field of Object.keys(listingUrls))expect(presentationWithout.interface).not.toHaveProperty(field);
});

it('keeps full source exports intact and records the two changes in the optional Codex submission candidate',()=>{
  const f=fixture();
  f.add('plugins/stereofold/skills/stereofold-setup/references/hosts.md','All host registration routes');
  f.add('plugins/stereofold/skills/stereofold-setup/scripts/setup-check.mjs','Full setup helper');
  f.add('plugins/stereofold/skills/stereo-structure/references/headsets.md','All headset controls');
  f.checksum();
  const before=readFileSync(join(f.share,'SHA256SUMS'));
  f.run();
  const candidateOut=join(f.root,'with-submission');f.run(candidateOut,true);
  for(const name of readdirSync(f.out).filter(name=>name.endsWith('.zip')))
    expect(readFileSync(join(candidateOut,name))).toEqual(readFileSync(join(f.out,name)));
  expect(readFileSync(join(f.share,'SHA256SUMS'))).toEqual(before);
  const full=join(candidateOut,'codex-plugin'),candidate=join(candidateOut,'codex-submission-plugin');
  const fullNames=readdirSync(full,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
    .map(entry=>join(entry.parentPath,entry.name).slice(full.length+1)).sort();
  const candidateNames=readdirSync(candidate,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
    .map(entry=>join(entry.parentPath,entry.name).slice(candidate.length+1)).sort();
  expect(candidateNames).toEqual(fullNames);
  const changed=fullNames.filter(name=>!readFileSync(join(candidate,name)).equals(readFileSync(join(full,name))));
  expect(changed).toEqual(['.codex-plugin/plugin.json','skills/stereofold-setup/SKILL.md']);
  const sourceManifest=JSON.parse(readFileSync(join(full,'.codex-plugin/plugin.json'),'utf8'));
  const manifest=JSON.parse(readFileSync(join(candidate,'.codex-plugin/plugin.json'),'utf8'));
  expect(manifest).toMatchObject({name:'stereofold',version:'9.8.7',author:{name:'Fixture Publisher'},mcpServers:'./.mcp.json',skills:'./skills/'});
  expect(manifest.extensions).toEqual(sourceManifest.extensions);
  expect(manifest.interface).toMatchObject(listingUrls);
  expect(manifest.interface.shortDescription).toBe('Put molecules in your headset');
  expect(manifest.description+' '+manifest.interface.longDescription).not.toMatch(/Claude|Anthropic/i);
  const preserved={...manifest,description:sourceManifest.description,
    interface:{...manifest.interface,shortDescription:sourceManifest.interface.shortDescription,longDescription:sourceManifest.interface.longDescription}};
  expect(preserved).toEqual(sourceManifest);
  const metadata=JSON.parse(readFileSync(join(candidateOut,'ARTIFACTS.json'),'utf8'));
  expect(metadata.packages.at(-1)).toMatchObject({directory:'codex-submission-plugin',archive:'stereofold-codex-submission.zip',files:fullNames.length});
  const profile=metadata.codex_submission_profile;
  expect(profile.inputs.map((entry:any)=>entry.path)).toEqual(['listing.json','stereofold-setup/SKILL.md']);
  for(const change of profile.changes){
    expect(change.source_sha256).toBe(hash(readFileSync(join(full,change.path))));
    expect(change.candidate_sha256).toBe(hash(readFileSync(join(candidate,change.path))));
  }
  const archiveHashes=JSON.parse(execFileSync('python3',['-c',`import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({name:hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist()}))`,join(candidateOut,'stereofold-codex-submission.zip')],{encoding:'utf8'}));
  expect(Object.keys(archiveHashes).sort()).toEqual(candidateNames);
  for(const [name,digest] of Object.entries(archiveHashes))expect(hash(readFileSync(join(candidate,name)))).toBe(digest);
  for(const line of readFileSync(join(candidateOut,'SHA256SUMS'),'utf8').trim().split('\n')){
    const [digest,name]=line.split('  ');expect(hash(readFileSync(join(candidateOut,name!)))).toBe(digest);
  }
  const second=join(f.root,'with-submission-again');f.run(second,true);
  expect(readFileSync(join(second,'stereofold-codex-submission.zip'))).toEqual(readFileSync(join(candidateOut,'stereofold-codex-submission.zip')));
});

it('refuses invalid local manifest references, missing capabilities and listing text beyond final limits',()=>{
  const cases=[
    {patch:(m:any)=>{m.interface.logo='./missing.png';},error:/reference is missing/},
    {patch:(m:any)=>{m.skills='./../outside';},error:/leaves the package/},
    {patch:(m:any)=>{delete m.interface.capabilities;},error:/capabilities/},
    {patch:(m:any)=>{m.interface.shortDescription='x'.repeat(31);},error:/30 characters/},
    {patch:(m:any)=>{m.interface.longDescription='x'.repeat(4001);},error:/4000 characters/},
    {patch:(m:any)=>{m.mcpServers=undefined;},error:/local .mcp.json/},
  ];
  for(const {patch,error} of cases){
    const f=fixture(),name='plugins/stereofold/.codex-plugin/plugin.json';
    const manifest=JSON.parse(readFileSync(join(f.share,name),'utf8'));patch(manifest);f.add(name,JSON.stringify(manifest));f.checksum();
    expect(()=>f.run()).toThrow(error);
    expect(readdirSync(f.root)).toEqual(['marketplace']);
  }
});

it('refuses changed or unlisted input files before creating output',()=>{
  const f=fixture();writeFileSync(join(f.share,'plugins/stereofold/dist/inspector.css'),'tampered');
  expect(()=>f.run()).toThrow(/checksum mismatch/);
  const g=fixture();writeFileSync(join(g.share,'unchecked'),'extra');expect(()=>g.run()).toThrow(/unchecked files/);
  expect(readdirSync(f.root)).toEqual(['marketplace']);
});

it('requires the default Claude icon in the verified share',()=>{
  const f=fixture(),name='plugins/stereofold/.claude-plugin/icon.png';
  rmSync(join(f.share,name));
  const checksums=readFileSync(join(f.share,'SHA256SUMS'),'utf8').split('\n')
    .filter(line=>!line.endsWith(`  ${name}`)).join('\n');
  writeFileSync(join(f.share,'SHA256SUMS'),checksums);
  expect(()=>f.run()).toThrow(/missing required checksummed marketplace\/runtime files/);
  expect(readdirSync(f.root)).toEqual(['marketplace']);
});

it('refuses checksum path traversal, duplicate paths and development files',()=>{
  const f=fixture();writeFileSync(join(f.share,'SHA256SUMS'),`${'a'.repeat(64)}  ../escape\n`);
  expect(()=>f.run()).toThrow(/Unsafe or duplicate/);
  const g=fixture();const checksum=readFileSync(join(g.share,'SHA256SUMS'),'utf8');writeFileSync(join(g.share,'SHA256SUMS'),checksum+checksum.split('\n')[0]+'\n');
  expect(()=>g.run()).toThrow(/Unsafe or duplicate/);
  const h=fixture();h.add('plugins/stereofold/src/private.ts','source');h.checksum();expect(()=>h.run()).toThrow(/development files/);
});

it('refuses symlinks, existing output and an output inside its share',()=>{
  const f=fixture();symlinkSync('dist',join(f.share,'plugins/stereofold/link'));expect(()=>f.run()).toThrow(/symlink/);
  const g=fixture();mkdirSync(g.out);writeFileSync(join(g.out,'keep'),'original');expect(()=>g.run()).toThrow(/already exists/);
  expect(readFileSync(join(g.out,'keep'),'utf8')).toBe('original');
  const h=fixture();expect(()=>h.run(join(h.share,'nested'))).toThrow(/outside the share/);
});

it('verifies a supplied marketplace archive checksum and refuses oversized runtime files',()=>{
  const f=fixture();writeFileSync(join(f.share,'stereofold-marketplace.tar.gz'),'archive');
  writeFileSync(join(f.share,'stereofold-marketplace.tar.gz.sha256'),`${hash('archive')}  stereofold-marketplace.tar.gz\n`);f.run();
  const g=fixture();writeFileSync(join(g.share,'stereofold-marketplace.tar.gz'),'archive');
  writeFileSync(join(g.share,'stereofold-marketplace.tar.gz.sha256'),`${'a'.repeat(64)}  stereofold-marketplace.tar.gz\n`);
  expect(()=>g.run()).toThrow(/archive checksum mismatch/);
  const h=fixture();h.add('plugins/stereofold/dist/inspector.css','x'.repeat(5*1024*1024));h.checksum();
  expect(()=>h.run()).toThrow(/smaller than 5 MiB/);
});
