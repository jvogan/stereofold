import { describe, expect, it } from 'vitest';
import { isPageRoute, renderBudgetSearchSource, RENDER_BUDGET_PARAM } from '../src/inspection-page-route.js';

/**
 * The route tables matched `request.url` exactly, so the
 * wearer's page 404'd on any query and the whole `?xrRenderBudget=` knob layer
 * was unreachable — on the emulator through `companion-browser.ts
 * --render-budget`, and on the headset through a typed address. Exactly one
 * parameter is admitted, and nothing that carries a capability is.
 */
describe('the wearer page route', () => {
  it('serves the bare page', () => {
    expect(isPageRoute('/', '/')).toBe(true);
    expect(isPageRoute('/viewer', '/viewer')).toBe(true);
  });

  it('serves the page with only the render-budget knobs on it', () => {
    expect(isPageRoute('/?xrRenderBudget=light:off,palette:off', '/')).toBe(true);
    expect(isPageRoute('/viewer?xrRenderBudget=postfx:on', '/viewer')).toBe(true);
    // A knob value may itself carry `=`, so only the first one splits the pair.
    expect(isPageRoute('/?xrRenderBudget=scale=0.6;surface=lower', '/')).toBe(true);
  });

  it('refuses every other query, so no capability is ever spellable as one', () => {
    expect(isPageRoute('/?token=leak', '/')).toBe(false);
    expect(isPageRoute('/?xrRenderBudget=light:off&token=leak', '/')).toBe(false);
    expect(isPageRoute('/?token=leak&xrRenderBudget=light:off', '/')).toBe(false);
    expect(isPageRoute('/?xrRenderBudget=', '/')).toBe(false);
    expect(isPageRoute('/?xrRenderBudget', '/')).toBe(false);
    expect(isPageRoute('/?XRRENDERBUDGET=light:off', '/')).toBe(false);
    // A 129-character value, and one with a character no knob list uses.
    expect(isPageRoute(`/?xrRenderBudget=${'a'.repeat(129)}`, '/')).toBe(false);
    expect(isPageRoute('/?xrRenderBudget=light:off/../etc', '/')).toBe(false);
    expect(isPageRoute('/?xrRenderBudget=%ZZ', '/')).toBe(false);
  });

  it('never matches another path, and never a missing url', () => {
    expect(isPageRoute('/tool', '/')).toBe(false);
    expect(isPageRoute('/viewer', '/')).toBe(false);
    expect(isPageRoute('/viewerx?xrRenderBudget=postfx:on', '/viewer')).toBe(false);
    expect(isPageRoute(undefined, '/')).toBe(false);
  });

  it('carries the same allowlist into the page that redirects to the viewer', () => {
    const evaluate = (search: string) => {
      const location = { search };
      // eslint-disable-next-line no-new-func
      return new Function('location', 'URLSearchParams', `return ${renderBudgetSearchSource()};`)(location, URLSearchParams);
    };
    expect(evaluate('?xrRenderBudget=light:off')).toBe(`?${RENDER_BUDGET_PARAM}=light%3Aoff`);
    expect(evaluate('')).toBe('');
    expect(evaluate('?token=leak')).toBe('');
    // Rebuilt from the one allowed key, so nothing else survives the redirect.
    expect(evaluate('?token=leak&xrRenderBudget=postfx:on')).toBe(`?${RENDER_BUDGET_PARAM}=postfx%3Aon`);
    expect(evaluate(`?xrRenderBudget=${'a'.repeat(129)}`)).toBe('');
  });
});
