import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { enterImmersiveWithFallback, XR_AR_FALLBACK_MODE } from '../src/xr-entry-fallback.js';

describe('the Enter VR button on a Quest that reports passthrough it will not give', () => {
  it('asks for plain VR once when the passthrough request is refused', async () => {
    // isSessionSupported('immersive-ar') answering true is not a promise that
    // the request will be granted. Before this the wearer was dropped back on
    // the 2D page with an error and had to press Enter again themselves.
    const asked: string[] = [];
    const notes: string[] = [];
    const session = await enterImmersiveWithFallback(mode => {
      asked.push(mode);
      return mode === 'immersive-ar' ? Promise.reject(Error('AR refused')) : Promise.resolve('session');
    }, 'immersive-ar', error => notes.push(error.message));
    expect(asked).toEqual(['immersive-ar', XR_AR_FALLBACK_MODE]);
    expect(session).toBe('session');
    expect(notes).toEqual(['AR refused']);
  });

  it('surfaces the second failure rather than asking a third time', async () => {
    const asked: string[] = [];
    await expect(enterImmersiveWithFallback(mode => {
      asked.push(mode);
      return Promise.reject(Error(`${mode} refused`));
    }, 'immersive-ar')).rejects.toThrow('immersive-vr refused');
    expect(asked).toEqual(['immersive-ar', 'immersive-vr']);
  });

  it('leaves a plain VR request alone and never retries a request that worked', async () => {
    const asked: string[] = [];
    const enter = (mode: string) => { asked.push(mode); return Promise.reject(Error('no headset')); };
    await expect(enterImmersiveWithFallback(enter, 'immersive-vr')).rejects.toThrow('no headset');
    expect(asked).toEqual(['immersive-vr']);
    asked.length = 0;
    await enterImmersiveWithFallback(mode => { asked.push(mode); return Promise.resolve(); }, 'immersive-ar');
    expect(asked).toEqual(['immersive-ar']);
  });

  it('is the path the Enter button takes, inside the click handler', async () => {
    // The retry only works from the gesture that opened it: requestSession
    // needs a transient user activation, and the button press is the only one
    // there is. A retry moved out of this handler would be refused.
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf("button.addEventListener('click'"), source.indexOf('enterButtons.push(button)'));
    expect(handler).toMatch(/enterImmersiveWithFallback\(/u);
    expect(handler).not.toMatch(/workspace\.viewer\.xr\.enter\(requested\)/u);
  });
});
