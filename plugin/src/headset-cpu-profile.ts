import { redactDeep, redactDevtoolsText } from './headset-devtools.js';

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; scriptId: string; lineNumber: number; columnNumber: number } };
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] };

/** CDP samples name leaf nodes; weight their self time by microsecond deltas,
 * not hitCount or inclusive parent time. Keep idle/GC/native entries visible.
 * This is sampled elapsed time, not an OS measurement of scheduled CPU time.
 */
export function summarizeCpuProfile(profile: CpuProfile) {
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)
    || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length
    || !Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime)
    || profile.endTime < profile.startTime) throw Error('Incomplete CDP CPU profile.');
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const functions = new Map<string, { functionName: string; url: string; line: number; column: number; selfUs: number; samples: number }>();
  let sampledUs = 0;
  profile.samples.forEach((id, index) => {
    const node = nodes.get(id), delta = profile.timeDeltas[index]!;
    if (!node || !Number.isFinite(delta) || delta < 0) throw Error('Invalid CDP CPU sample.');
    const frame = node.callFrame;
    const key = JSON.stringify([frame.scriptId, frame.functionName, frame.url, frame.lineNumber, frame.columnNumber]);
    const row = functions.get(key) ?? { functionName: redactDevtoolsText(frame.functionName || '(anonymous)'),
      url: redactDevtoolsText(frame.url), line: frame.lineNumber + 1, column: frame.columnNumber + 1, selfUs: 0, samples: 0 };
    row.selfUs += delta; row.samples++; sampledUs += delta; functions.set(key, row);
  });
  return {
    durationMs: (profile.endTime - profile.startTime) / 1000, sampledMs: sampledUs / 1000,
    samples: profile.samples.length,
    topTen: [...functions.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, 10)
      .map(({ selfUs, ...row }) => ({ ...row, selfMs: selfUs / 1000,
        percentOfSamples: sampledUs ? 100 * selfUs / sampledUs : 0 })),
  };
}

/** One explicitly requested 10 s capture on the existing DevTools session.
 * No page polling or extra XR callbacks are installed during the sample.
 */
export async function captureCpuProfile(session: { send(method: string): Promise<unknown> },
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  await session.send('Profiler.enable');
  let started = false;
  try {
    await session.send('Profiler.start'); started = true;
    await wait(10_000);
    const result = await session.send('Profiler.stop') as { profile: CpuProfile };
    started = false;
    const summary = summarizeCpuProfile(result.profile);
    return { profile: redactDeep(result.profile), summary };
  } finally {
    if (started) await session.send('Profiler.stop').catch(() => {});
    await session.send('Profiler.disable').catch(() => {});
  }
}
