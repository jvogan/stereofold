// Loaded only by the explicit, loopback emulation page. The ordinary inspection
// build never installs a runtime or requests immersion.
(async () => {
  const deadline = performance.now() + 30_000;
  while (document.body.dataset.ready !== 'true') {
    if (performance.now() > deadline) throw Error('The inspection scene did not finish loading.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const dock = document.createElement('aside');
  dock.setAttribute('aria-label', 'Quest emulation controls');
  dock.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:100000;max-width:calc(100vw - 24px);max-height:45vh;overflow:auto;padding:12px;background:var(--surface);color:var(--text);border:1px solid var(--teal);font:14px var(--font-sans,system-ui);box-shadow:0 6px 30px #0003';
  const label = document.createElement('strong');
  label.textContent = 'Quest 2 emulation';
  const note = document.createElement('div');
  note.textContent = 'Simulated head movement · use the scene controls above for molecule placement.';
  note.style.cssText = 'font-size:12px;color:var(--muted);margin:4px 0 8px';
  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;max-width:760px';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:12px;margin-top:8px';
  let busy = false, ready = false, lastMode;
  const controls = [];
  function sync() {
    const snapshot = window.__preview?.snapshot(), presenting = Boolean(snapshot?.presenting);
    for (const {element,kind} of controls) element.disabled = busy || !ready
      || (kind === 'enter' && presenting) || (kind === 'immersive' && !presenting);
    const mode = presenting ? snapshot.active?.mode ?? snapshot.requestedMode : 'desktop';
    const motion = window.__stereofoldInspection?.viewer.inspection.getMotion();
    rotationControl.hidden = !presenting;
    rotationControl.textContent = motion?.paused ? 'Rotate structure' : 'Pause rotation';
    rotationControl.disabled = busy || !ready || !presenting || motion?.reason === 'reduced-motion';
    if (mode !== lastMode) {
      status.textContent = presenting
        ? `Emulated ${mode === 'immersive-ar' ? 'AR' : 'VR'} active. Leave XR before switching modes.`
        : 'Desktop view. AR simulates transparency; camera passthrough is not emulated.';
      lastMode = mode;
    }
  }
  const run = action => {
    if (busy || !ready) return;
    busy = true; sync();
    Promise.resolve().then(action).then(() => { lastMode = undefined; })
      .catch(error => { status.textContent = error.message; })
      .finally(() => { busy = false; sync(); });
  };
  const button = (text, action, kind = 'desktop') => {
    const element = document.createElement('button');
    element.textContent = text; element.type = 'button';
    element.addEventListener('click', () => run(action)); buttons.append(element);
    controls.push({element,kind});return element;
  };
  button('Enter emulated AR', () => window.__preview.enter('immersive-ar'), 'enter');
  button('Enter emulated VR', () => window.__preview.enter('immersive-vr'), 'enter');
  button('Leave XR', () => window.__preview.end(), 'immersive');
  const rotationControl = button('Rotate structure', () => {
    const inspection = window.__stereofoldInspection.viewer.inspection;
    return inspection.setMotion({paused:!inspection.getMotion().paused});
  }, 'immersive');
  const move = async (axis, amount) => {
    if (!window.__preview.snapshot().presenting) throw Error('Enter emulation before moving the simulated head.');
    const { device, initialHeadPosition } = window.__xrProbe;
    const next = Math.max(initialHeadPosition[axis] - 1, Math.min(initialHeadPosition[axis] + 1, device.position[axis] + amount));
    device.position[axis] = next;
    await window.__preview.frames(5);
  };
  for (const [text, axis, amount] of [['Head ←', 'x', -.1], ['Head →', 'x', .1], ['Head forward', 'z', -.1], ['Head back', 'z', .1]]) {
    button(text, () => move(axis, amount), 'immersive');
  }
  let headYaw = 0;
  for (const [text, direction] of [['Look left', 1], ['Look right', -1]]) button(text, async () => {
    if (!window.__preview.snapshot().presenting) throw Error('Enter emulation before turning the simulated head.');
    headYaw = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, headYaw + direction * Math.PI / 12));
    window.__xrProbe.device.quaternion.set(0, Math.sin(headYaw / 2), 0, Math.cos(headYaw / 2));
    await window.__preview.frames(5);
  }, 'immersive');
  button('Reset head', async () => {
    const { device, initialHeadPosition: p } = window.__xrProbe;
    device.position.set(p.x, p.y, p.z); device.quaternion.set(0, 0, 0, 1); headYaw = 0;
    if (window.__preview.snapshot().presenting) await window.__preview.frames(5);
  });
  const minimize = button('Hide controls', () => { buttons.style.display = 'none'; note.hidden = true; minimize.hidden = true; reopen.hidden = false; });
  const reopen = document.createElement('button'); reopen.type = 'button'; reopen.textContent = 'Show controls'; reopen.hidden = true;
  reopen.onclick = () => { buttons.style.display = 'flex'; note.hidden = false; minimize.hidden = false; reopen.hidden = true; };
  dock.append(label, reopen, note, buttons, status); document.body.append(dock);
  sync();
  await window.__stereofoldInspection.viewer.testHooks.attachXrPreview(window.__attachInspectionXr);
  ready = true; sync();
  // Also reflect session changes initiated by browser tools or the runtime.
  const timer = setInterval(sync, 500);
  window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
})().catch(error => { document.querySelector('#status').textContent = error.message; });
