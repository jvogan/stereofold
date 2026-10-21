const EMPTY = [];

/** Visibility can be sampled without interpolating an invisible body's pose. */
export function evaluateTrackVisibility(track, seconds) {
  let visible = true;
  for (const event of track.visibility ?? EMPTY) { if (event.t > seconds) break; visible = event.visible; }
  return visible;
}

/** Absolute file-coordinate poses. Inputs are validated at the lesson boundary. */
export function evaluateTrack(track, seconds, out = { translation: [0,0,0], rotation: [0,0,0,1], visible: true }) {
  const frames = track.keyframes;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (frames[mid].t <= seconds) lo = mid; else hi = mid - 1; }
  const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
  const u = b.t === a.t ? 0 : Math.max(0, Math.min(1, (seconds - a.t) / (b.t - a.t)));
  const { translation, rotation } = out;
  for (let i = 0; i < 3; i++) translation[i] = a.translation[i] + (b.translation[i] - a.translation[i]) * u;
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a.rotation[i] * b.rotation[i];
  const sign = dot < 0 ? -1 : 1; dot = Math.min(1, Math.abs(dot));
  const angle = Math.acos(dot), sine = Math.sin(angle);
  const x = dot > .9995 ? 1 - u : Math.sin((1 - u) * angle) / sine;
  const y = dot > .9995 ? u : Math.sin(u * angle) / sine;
  for (let i = 0; i < 4; i++) rotation[i] = x * a.rotation[i] + y * sign * b.rotation[i];
  const norm = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]); for (let i = 0; i < 4; i++) rotation[i] /= norm;
  // Convert the interpolated hinge pose to an absolute model-origin transform.
  // Scratch scalars only: the frame path must not allocate vectors or geometry.
  if (track.pivot) {
    const [px, py, pz] = track.pivot, [x, y, z, w] = rotation;
    const tx = 2 * (y * pz - z * py), ty = 2 * (z * px - x * pz), tz = 2 * (x * py - y * px);
    translation[0] -= w * tx + y * tz - z * ty;
    translation[1] -= w * ty + z * tx - x * tz;
    translation[2] -= w * tz + x * ty - y * tx;
  }
  out.visible = evaluateTrackVisibility(track, seconds); return out;
}

/** Timestamps are milliseconds from the selected presentation scheduler. */
export function createPlaybackClock(durationSeconds, playback = {}) {
  let timeSeconds = 0, state = playback.autoplay ? 'playing' : 'paused';
  let speed = playback.speed ?? 1, loop = playback.loop ?? false, last;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw Error('Animation duration must be positive.');
  const snapshot = (out = {}) => { out.state = state; out.timeSeconds = timeSeconds; out.speed = speed; out.loop = loop; return out; };
  const sample = (timestamp, out) => {
    if (!Number.isFinite(timestamp)) throw Error('Animation timestamp must be finite.');
    if (last !== undefined && timestamp >= last && state === 'playing') {
      timeSeconds += (timestamp - last) * speed / 1000;
      if (loop) timeSeconds %= durationSeconds;
      else if (timeSeconds >= durationSeconds) { timeSeconds = durationSeconds; state = 'paused'; }
    }
    if (last === undefined || timestamp >= last) last = timestamp;
    return snapshot(out);
  };
  const patch = (value, timestamp) => {
    if (value.speed !== undefined && (!Number.isFinite(value.speed) || value.speed <= 0 || value.speed > 16)) throw Error('Animation speed must be in (0, 16].');
    if (value.seekSeconds !== undefined && (!Number.isFinite(value.seekSeconds) || value.seekSeconds < 0 || value.seekSeconds > durationSeconds)) throw Error('Animation seek must lie within its duration.');
    if (timestamp !== undefined) sample(timestamp);
    if (value.speed !== undefined) speed = value.speed;
    if (value.loop !== undefined) loop = value.loop;
    if (value.seekSeconds !== undefined) timeSeconds = value.seekSeconds;
    if (value.restart === true) timeSeconds = 0;
    if (value.state !== undefined) state = value.state === 'play' ? 'playing' : 'paused';
    if (timestamp === undefined) last = undefined;
    return snapshot();
  };
  patch({ speed });
  return { sample, patch, snapshot, reanchor: () => { last = undefined; } };
}
