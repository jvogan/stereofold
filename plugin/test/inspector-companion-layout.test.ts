import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('the companion Talk pill layout', () => {
  it('anchors Talk inside the stage and reserves a separate caption row above it', async () => {
    const css = await readFile(new URL('../src/inspector.css', import.meta.url), 'utf8');
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');

    expect(source).toContain("document.querySelector('.stage')!.append(voicePanel)");
    expect(css).toMatch(/body\[data-companion="true"\] \.stage \{[^}]*--companion-voice-clearance:96px/isu);
    expect(css).toMatch(/body\[data-companion="true"\] \.canvas-caption \{[^}]*bottom:var\(--companion-voice-clearance\)/isu);
    expect(css).toMatch(/\.voice-panel \{[^}]*position:absolute[^}]*bottom:18px/isu);
    expect(css).not.toMatch(/\.voice-panel \{[^}]*position:\s*fixed/isu);
  });
});
