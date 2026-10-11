import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginReactContext } from 'molstar/lib/mol-plugin-ui/base.js';
import { DefaultStructureTools, SelectionViewportControls } from 'molstar/lib/mol-plugin-ui/controls.js';
import './connected-workbench.css';

/**
 * Mount Mol*'s own Structure Tools against the inspector's live PluginUIContext.
 * The inspector viewer is a PluginUIContext, so these are the stock controls
 * from the pinned Mol* build, not a second viewer or a look-alike control set.
 */
type WorkbenchWorkspace = { viewer: { plugin?: unknown; synchronizeRepresentationFromPlugin?: (options?: { selectionChanged?: boolean }) => Promise<unknown> } };

export function mountConnectedWorkbench(options: { workspace: WorkbenchWorkspace; anchor: Element; onOpen?: () => void }): { open(): void; dispose(): void } {
  const plugin = options.workspace.viewer.plugin;
  if (!plugin) return { open() {}, dispose() {} };
  const uiPlugin = plugin as { selectionMode: boolean };
  const button = document.createElement('button');
  // This is the panel's primary Mol* action and says so.
  // Everything else that says "Mol*" opens a separate viewer, and those live
  // together under "Other viewers"; this one is the tools for this canvas.
  button.type = 'button'; button.dataset.connectedWorkbench = ''; button.dataset.primary = 'true';
  button.textContent = 'Mol* tools';
  button.title = 'Mol*’s own Structure Tools, live on this canvas. What you change here stays in Stereofold.';
  options.anchor.append(button);
  const dialog = document.createElement('dialog');
  dialog.className = 'connected-workbench'; dialog.dataset.connectedWorkbenchDialog = '';
  dialog.innerHTML = `<form method="dialog"><button aria-label="Close Mol* workbench">Close</button></form>
    <h2>Mol* workbench</h2>
    <p class="connected-workbench-note">Explore this molecule with Mol* tools. Changes are live in this Stereofold canvas. Close to return to your journey.</p>
    <p data-connected-workbench-status role="status">Mol* tools are ready for this canvas.</p>
    <div data-stock-molstar-tools></div>`;
  document.body.append(dialog);
  const target = dialog.querySelector<HTMLElement>('[data-stock-molstar-tools]')!;
  const reactRoot: Root = createRoot(target);
  reactRoot.render(createElement(PluginReactContext.Provider, { value: plugin as any },
    createElement('div', { 'data-stock-molstar-structure-tools': '' }, createElement(DefaultStructureTools)),
    createElement('div', { 'data-stock-molstar-selection-tools': '' }, createElement(SelectionViewportControls))));
  let disposed = false;
  let selectionModeBeforeOpen = false;
  let stockSelectionChanged = false;
  const selectionEvents = (plugin as any).managers?.structure?.selection?.events?.changed;
  const selectionSubscription = selectionEvents?.subscribe?.(() => {
    if (dialog.open) stockSelectionChanged = true;
  });
  const close = () => {
    if (!disposed) uiPlugin.selectionMode = selectionModeBeforeOpen;
  };
  dialog.addEventListener('close', close);
  const status = dialog.querySelector<HTMLElement>('[data-connected-workbench-status]')!;
  const reconcile = async () => {
    const sync = options.workspace.viewer.synchronizeRepresentationFromPlugin;
    if (!sync || disposed) return;
    await new Promise<void>(resolve => window.setTimeout(resolve, 100));
    const deadline = Date.now() + 30_000;
    while (!disposed && Date.now() < deadline) {
      const isBusy = Boolean((plugin as any).behaviors?.state?.isBusy?.value);
      if (!isBusy) {
        const selectionChanged = stockSelectionChanged;
        stockSelectionChanged = false;
        await sync({ selectionChanged });
        status.textContent = 'Live Mol* change applied to this canvas.';
        return;
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 50));
    }
    throw new Error('Mol* is still applying the change; try the control again.');
  };
  target.addEventListener('click', event => {
    if (!(event.target as Element).closest('button')) return;
    void reconcile().catch(error => { if (!disposed) status.textContent = error instanceof Error ? error.message : 'The Mol* change could not be reconciled.'; });
  });
  button.addEventListener('click', () => {
    open();
  });
  function open() {
    if (disposed || dialog.open) return;
    options.onOpen?.();
    selectionModeBeforeOpen = uiPlugin.selectionMode;
    uiPlugin.selectionMode = true;
    dialog.showModal();
  }
  return { open, dispose() { close(); disposed = true; selectionSubscription?.unsubscribe?.(); reactRoot.unmount(); dialog.remove(); button.remove(); } };
}
