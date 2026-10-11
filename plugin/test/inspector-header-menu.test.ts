import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readSource = () => readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const readChrome = () => readFile(new URL('../src/inspector-card-chrome.css', import.meta.url), 'utf8');

describe('the desktop header row inside a chat card', () => {
  it('moves the connect, Quest, handoff and preview recording buttons into the header menu body', async () => {
    const source = await readSource();

    expect(source).toContain('headerMenuBody.append(connect,quest,handoff,recording)');
    expect(source).toMatch(/headerMenu\.className='header-menu';headerMenu\.dataset\.headerMenu=''/u);
    expect(source).toContain('headerMenu.append(headerMenuSummary,headerMenuBody)');
    expect(source).toContain("headerActions.append(headerMenu)");
  });

  it('keeps the display mode toggle in the header row and out of the menu', async () => {
    const source = await readSource();

    expect(source).toContain('headerActions.prepend(displayModeToggle)');
    expect(source).not.toMatch(/headerMenuBody\.append\([^)]*displayModeToggle/u);
    expect(source).not.toContain('connect.after(displayModeToggle)');
  });

  it('still enables the handoff button after the menu is assembled', async () => {
    const source = await readSource();
    const menu = source.indexOf('headerMenuBody.append(connect,quest,handoff,recording)');
    const sync = source.indexOf('syncHandoff();', menu);

    expect(menu).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(menu);
    expect(source.indexOf('syncHandoff=()=>{')).toBeLessThan(menu);
  });

  it('keeps connect and preview recording available in the companion header', async () => {
    const source = await readSource();

    expect(source).toContain('if(isCompanion) headerActions.prepend(connect,recording);');
  });

  it('closes the menu on an inside click, on Escape and on an outside pointerdown', async () => {
    const source = await readSource();

    expect(source).toContain("headerMenuBody.addEventListener('click',closeHeaderMenu)");
    expect(source).toMatch(/pointerdown[\s\S]{0,160}event\.target instanceof Node && !headerMenu\.contains\(event\.target\)\) closeHeaderMenu\(\)/u);
    expect(source).toMatch(/event\.key!=='Escape'[\s\S]{0,120}event\.preventDefault\(\);closeHeaderMenu\(\);headerMenuSummary\.focus\(\)/u);
  });

  it('loads the card chrome sheet after inspector.css', async () => {
    const source = await readSource();
    const base = source.indexOf("import './inspector.css';");
    const chrome = source.indexOf("import './inspector-card-chrome.css';");

    expect(base).toBeGreaterThanOrEqual(0);
    expect(chrome).toBeGreaterThan(base);
  });

  it('tags the panel label so the card chrome sheet can style it', async () => {
    const source = await readSource();
    const css = await readChrome();

    expect(source).toContain("label.className='panel-label'");
    expect(source).toContain("label.setAttribute('data-panel-label','')");
    expect(css).toMatch(/\.panel-label \{[^}]*font: 11px var\(--mono\)/isu);
  });

  it('moves the panel id from the card header into the wordmark tooltip', async () => {
    const source = await readSource();
    const css = await readChrome();

    expect(source).toContain("document.querySelector('.app-header .brand')?.setAttribute('title',`${isCompanion?'Companion':'Desktop'} panel ${issued.slice(0,8)}`)");
    expect(source).toContain("document.querySelector('.app-header .brand')?.removeAttribute('title')");
    expect(css).toMatch(/@media \(max-height: 760px\)[\s\S]*body:not\(\[data-companion="true"\]\) #app > \.app-header \.panel-label \{ display: none; \}/u);
  });

  it('folds the selection row into the card footer', async () => {
    const source = await readSource();
    const css = await readChrome();

    expect(source).toContain("footerSelection.className='footer-selection';footer.append(footerSelection)");
    expect(css).toMatch(/\.workspace \.canvas-bottom \{ display: none; \}/u);
    expect(css).toMatch(/\.footer-selection\[data-empty="true"\] \{ display: none; \}/u);
  });

  it('hides the outcome line while it has nothing to report', async () => {
    const source = await readSource();
    const css = await readChrome();

    expect(css).toMatch(/\.session-outcome:empty \{ display: none; \}/u);
    expect(source).toContain("outcome.textContent=isCompanion?'Connecting to your desktop inspection…':'';");
    expect(source).not.toContain("'Current inspection'");
  });
});
