import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

const workspaceCss = readFileSync(new URL('../../lab/inspection/style.css', import.meta.url), 'utf8');
const inspectorCss = readFileSync(new URL('../src/inspector.css', import.meta.url), 'utf8');
const placementRule = /  \/\* The sequence is still an absolute sheet\.[\s\S]*?    grid-area:1 \/ 1 \/ -1 \/ -1;\n  }\n/;
const beforeCss = inspectorCss.replace(placementRule, '');

// Real Chromium layout with both production stylesheets. No model/GPU claim;
// the packaged Tube run separately covers all22,542 actual residue identities.
it.skipIf(process.env.STEREOFOLD_LAYOUT_PIXELS !== '1')('keeps short lesson sequence sheets in the explicit workspace row and tall wrapping unchanged', async () => {
  expect(beforeCss).not.toBe(inspectorCss);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const results: any[] = [];
    for (const [width, height] of [[600, 700], [900, 700], [600, 900]]) {
      for (const fixed of [false, true]) {
        await page.setViewportSize({ width, height });
        const rows = Array.from({ length: 80 }, (_, i) => `<button type="button" aria-pressed="false"><b>A</b><span>${i + 1}</span></button>`).join('');
        await page.setContent(`<style>${workspaceCss}\n${fixed ? inspectorCss : beforeCss}</style>
          <body data-ready="true"><div id="app"><header class="app-header">Stereofold</header><div class="scene-heading"><h1>Sequence sheet regression</h1></div>
          <main class="workspace" data-workspace="sequence" data-inspector-open="true" data-sequence-open="true" data-journey="true">
            <section class="molecular-view"><div class="canvas-tools">Structure</div><div class="stage"><canvas></canvas></div></section>
            <aside class="inspector"><div class="tour-player" data-selected="true"><div class="tour-heading">Lesson</div><section class="tour-caption-region">Scientific caption</section><div class="tour-transport"><button>Back</button><button>Play</button><button>Next</button></div></div></aside>
            <section class="sequence-panel"><button class="sheet-close">Hide sequence</button><div class="sequence-head"><h2>Sequence</h2><div class="sequence-actions"><input type="search"><button>Select range</button><button>Clear</button></div></div><div class="sequence"><div class="sequence-items" data-disabled="false">${rows}</div></div><div class="selection-details">Choose a residue</div></section>
          </main><footer class="app-footer">Saved</footer></div></body>`);
        const last = page.locator('.sequence button').last();
        await last.scrollIntoViewIfNeeded(); await last.focus();
        const result = await last.evaluate(node => {
          const b = node.getBoundingClientRect(), sequence = document.querySelector<HTMLElement>('.sequence')!, panel = document.querySelector<HTMLElement>('.sequence-panel')!;
          let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
          for (let p = node.parentElement; p; p = p.parentElement) {
            const css = getComputedStyle(p), r = p.getBoundingClientRect();
            if (/hidden|auto|scroll|clip/.test(css.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
            if (/hidden|auto|scroll|clip/.test(css.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
          }
          return { visible: b.top >= top - 1 && b.bottom <= bottom + 1 && b.left >= left - 1 && b.right <= right + 1,
            focused: document.activeElement === node, panelHeight: panel.clientHeight, sequenceHeight: sequence.clientHeight,
            wrap: getComputedStyle(sequence).flexWrap, groupWrap: getComputedStyle(sequence.firstElementChild!).flexWrap,
            rows: sequence.querySelectorAll('button').length };
        });
        results.push({ width, height, fixed, ...result });
        expect(result.focused).toBe(true); expect(result.rows).toBe(80);
        expect(result.groupWrap).toBe(result.wrap);
        if (height === 700) expect(result.visible).toBe(fixed);
        else expect(result.visible).toBe(true);
        if (fixed) {
          await last.evaluate(node => { node.addEventListener('click', () => node.setAttribute('aria-pressed', 'true')); });
          await last.press('Enter'); expect(await last.getAttribute('aria-pressed')).toBe('true');
        }
      }
    }
    const tall = results.filter(r => r.height === 900).map(({ fixed: _fixed, ...r }) => r);
    assert.deepEqual(tall[0], tall[1]);
    console.log('sequence sheet real layout', JSON.stringify(results));
    await page.close();
  } finally { await browser.close(); }
});
