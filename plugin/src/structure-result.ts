/**
 * Private `CallToolResult._meta` slot used for cached coordinate hydration.
 *
 * `structuredContent` is model-visible even when a tool is app-only. Keep PDB
 * or mmCIF text exclusively under this namespaced result-metadata key, which
 * MCP Apps delivers to the component but does not add to model context.
 */
export const PRIVATE_STRUCTURE_META_KEY = 'stereo_structure/structure';
