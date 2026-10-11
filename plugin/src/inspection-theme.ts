import { applyDocumentTheme, type App } from '@modelcontextprotocol/ext-apps';

/** Follow the host UI, falling back to the OS when no host preference exists. */
export function followHostTheme(app: App): () => void {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const theme = app.getHostContext()?.theme ?? (system.matches ? 'dark' : 'light');
    applyDocumentTheme(theme);
  };
  // Additive subscription preserves the panel's size/context handler.
  app.addEventListener('hostcontextchanged', sync);
  system.addEventListener('change', sync);
  window.addEventListener('pagehide', () => {
    app.removeEventListener('hostcontextchanged', sync);
    system.removeEventListener('change', sync);
  }, { once: true });
  sync();
  return sync;
}
