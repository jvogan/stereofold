import { describe, expect, it } from 'vitest';
import { isPageRoute, renderBudgetSearchSource, RENDER_BUDGET_PARAM, XR_LAYERS_PARAM, XR_UI_PARAM } from '../src/inspection-page-route.js';

/**
 * The route tables matched `request.url` exactly, so the
 * wearer's page 404'd on any query and the whole `?xrRenderBudget=` knob layer
 * was unreachable — on the emulator through `companion-browser.ts
 * --render-budget`, and on the headset through a typed address. Only the page
 * settings are admitted, each once, and nothing that carries a capability is.
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

  it('serves the page with the projection-layer switch, alone or beside the knobs', () => {
    expect(isPageRoute('/?xrLayers=1', '/')).toBe(true);
    expect(isPageRoute('/viewer?xrLayers=1', '/viewer')).toBe(true);
    expect(isPageRoute('/viewer?xrRenderBudget=scale:0.5&xrLayers=1', '/viewer')).toBe(true);
    expect(isPageRoute('/?xrLayers=1&xrRenderBudget=postfx:on', '/')).toBe(true);
  });

  it('refuses any other switch value, a repeated setting, and anything beside the settings', () => {
    for (const query of ['xrLayers=0', 'xrLayers=true', 'xrLayers=', 'xrLayers', 'xrLayers=1&xrLayers=1',
      'xrRenderBudget=light:off&xrRenderBudget=postfx:on', 'xrLayers=1&token=leak', 'xrLayers=1&', '&xrLayers=1', 'XRLAYERS=1']) {
      expect(isPageRoute(`/?${query}`, '/'), query).toBe(false);
    }
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
    expect(evaluate('?xrLayers=1')).toBe(`?${XR_LAYERS_PARAM}=1`);
    expect(evaluate('?xrLayers=1&token=leak&xrRenderBudget=scale:0.5')).toBe(`?${RENDER_BUDGET_PARAM}=scale%3A0.5&${XR_LAYERS_PARAM}=1`);
    expect(evaluate('?xrLayers=2')).toBe('');
  });

  it('rebuilds a redirect address that the page route then admits', () => {
    const evaluate = (search: string) => new Function('location', 'URLSearchParams', `return ${renderBudgetSearchSource()};`)({ search }, URLSearchParams);
    expect(isPageRoute(`/viewer${evaluate('?xrLayers=1&xrRenderBudget=light:off')}`, '/viewer')).toBe(true);
  });

  it('carries the headset-controls target on every route to the page and through the redirect', () => {
    const evaluate = (search: string) => new Function('location', 'URLSearchParams', `return ${renderBudgetSearchSource()};`)({ search }, URLSearchParams);
    // The pairing page and the companion's own page are both `/`; the paired
    // headset lands on `/viewer`.
    for (const path of ['/', '/viewer']) {
      for (const value of ['quad', 'projection']) {
        expect(isPageRoute(`${path}?${XR_LAYERS_PARAM}=1&${XR_UI_PARAM}=${value}`, path), `${path} ${value}`).toBe(true);
        expect(isPageRoute(`${path}?${XR_UI_PARAM}=${value}&${XR_LAYERS_PARAM}=1&xrRenderBudget=postfx:on`, path), `${path} ${value}`).toBe(true);
      }
      for (const query of ['xrUi=', 'xrUi', 'xrUi=Quad', 'xrUi=quads', 'xrUi=quad&xrUi=quad', 'xrUi=quad&token=leak', 'XRUI=quad']) {
        expect(isPageRoute(`${path}?${query}`, path), `${path} ${query}`).toBe(false);
      }
    }
    expect(evaluate('?xrLayers=1&xrUi=quad')).toBe(`?${XR_LAYERS_PARAM}=1&${XR_UI_PARAM}=quad`);
    expect(evaluate('?xrUi=projection&token=leak')).toBe(`?${XR_UI_PARAM}=projection`);
    expect(evaluate('?xrUi=bogus&xrLayers=1')).toBe(`?${XR_LAYERS_PARAM}=1`);
    expect(isPageRoute(`/viewer${evaluate('?xrUi=quad&token=leak&xrLayers=1&xrRenderBudget=light:off')}`, '/viewer')).toBe(true);
  });
});
