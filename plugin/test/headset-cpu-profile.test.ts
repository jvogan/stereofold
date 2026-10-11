import { describe, expect, it } from 'vitest';
import { captureCpuProfile, summarizeCpuProfile, type CpuProfile } from '../src/headset-cpu-profile.js';

const node = (id: number, name: string, line = id) => ({ id, callFrame: {
  functionName: name, scriptId: '1', url: 'https://viewer.test/viewer#private', lineNumber: line, columnNumber: 0,
} });
const profile = (): CpuProfile => ({ nodes: [node(1, '(root)'), node(2, 'draw'), node(3, 'draw', 2), node(4, '(idle)')],
  startTime: 0, endTime: 10_000_000, samples: [2, 4, 3], timeDeltas: [1000, 8000, 1000] });

describe('resting headset CPU probe', () => {
  it('weights leaf self time, merges shared functions and keeps idle visible', () => {
    const report = summarizeCpuProfile(profile());
    expect(report.durationMs).toBe(10_000);
    expect(report.sampledMs).toBe(10);
    expect(report.topTen.map(row => [row.functionName, row.selfMs])).toEqual([['(idle)', 8], ['draw', 2]]);
    expect(report.topTen[1]!.samples).toBe(2);
    expect(report.topTen[1]!.line).toBe(3);
    expect(JSON.stringify(report)).not.toContain('#private');
  });

  it('reports only the ten largest self times and rejects incomplete samples', () => {
    const p = profile();
    p.nodes = Array.from({ length: 12 }, (_, i) => node(i, `f${i}`));
    p.samples = p.nodes.map(n => n.id); p.timeDeltas = p.nodes.map(n => n.id * 1000);
    expect(summarizeCpuProfile(p).topTen.map(row => row.functionName)).toEqual(Array.from({ length: 10 }, (_, i) => `f${11 - i}`));
    expect(() => summarizeCpuProfile({ ...p, timeDeltas: [] })).toThrow('Incomplete');
    expect(() => summarizeCpuProfile({ ...p, samples: p.samples.map(() => 99) })).toThrow('Invalid');
  });

  it('captures ten seconds over one CDP session and redacts saved URLs', async () => {
    const calls: (string | number)[] = [];
    const result = await captureCpuProfile({ send: async method => {
      calls.push(method); return method === 'Profiler.stop' ? { profile: profile() } : {};
    } }, async ms => { calls.push(ms); });
    expect(calls).toEqual(['Profiler.enable', 'Profiler.start', 10_000, 'Profiler.stop', 'Profiler.disable']);
    expect(JSON.stringify(result.profile)).not.toContain('#private');
  });

  it('stops and disables the profiler if the capture wait fails', async () => {
    const calls: string[] = [];
    await expect(captureCpuProfile({ send: async method => { calls.push(method); return {}; } },
      async () => { throw Error('interrupted'); })).rejects.toThrow('interrupted');
    expect(calls).toEqual(['Profiler.enable', 'Profiler.start', 'Profiler.stop', 'Profiler.disable']);
  });
});
