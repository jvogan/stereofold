import { describe, it, expect } from 'vitest';
import { CODEX_HANDOFF_OPT_IN_KEY, hostIdentity, offerCodexHandoff, readCodexOptIn, writeCodexOptIn } from '../src/host-identity.js';

describe('which host this panel is mounted in', () => {
  it('reads the name out of the MCP Apps handshake, from either field', () => {
    expect(hostIdentity({name: 'Codex'}, undefined)).toBe('codex');
    expect(hostIdentity({name: 'OpenAI Codex CLI'}, {userAgent: 'codex-cli/1.2'})).toBe('codex');
    expect(hostIdentity(undefined, {userAgent: 'Codex Desktop'})).toBe('codex');
    expect(hostIdentity({name: 'Claude Code'}, {userAgent: 'claude-code/2'})).toBe('other');
  });

  it('calls a host that said nothing unknown, and never guesses from an empty string', () => {
    expect(hostIdentity(undefined, undefined)).toBe('unknown');
    expect(hostIdentity({name: ''}, {userAgent: '   '})).toBe('unknown');
    expect(hostIdentity({name: 42 as unknown as string}, {userAgent: null as unknown as string})).toBe('unknown');
  });

  it('does not read Codex out of a word that merely contains it', () => {
    expect(hostIdentity({name: 'Codexterous Studio'}, undefined)).toBe('other');
    expect(hostIdentity({name: 'precodex'}, undefined)).toBe('other');
  });
});

describe('offering the Codex viewer request', () => {
  it('offers it to Codex, never to a host that named itself something else', () => {
    expect(offerCodexHandoff('codex', false)).toBe(true);
    expect(offerCodexHandoff('other', true)).toBe(false);
  });

  it('offers it on an unidentified host only after the user turns it on', () => {
    expect(offerCodexHandoff('unknown', false)).toBe(false);
    expect(offerCodexHandoff('unknown', true)).toBe(true);
  });
});

describe('the opt-in a browser may refuse to store', () => {
  it('round-trips through storage and treats anything else as off', () => {
    const values = new Map<string, string>();
    const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }};
    expect(readCodexOptIn(storage)).toBe(false);
    writeCodexOptIn(storage, true);
    expect(values.get(CODEX_HANDOFF_OPT_IN_KEY)).toBe('true');
    expect(readCodexOptIn(storage)).toBe(true);
    writeCodexOptIn(storage, false);
    expect(readCodexOptIn(storage)).toBe(false);
  });

  it('survives a browser with storage switched off', () => {
    const refusing = {
      getItem: () => { throw Error('storage disabled'); },
      setItem: () => { throw Error('storage disabled'); },
    };
    expect(readCodexOptIn(refusing)).toBe(false);
    expect(() => writeCodexOptIn(refusing, true)).not.toThrow();
    expect(readCodexOptIn(null)).toBe(false);
  });
});
