/**
 * Quest Browser's certificate warning, recognised from what the debugger lists
 * and what the page says, with no headset attached.
 *
 * In one headset run an adb launch on the Quest 2 stopped at "Your connection
 * is not private" (NET::ERR_CERT_AUTHORITY_INVALID), the wait reported only
 * that nothing drew, and the agent told the person to tap Enter VR on a page
 * that had not loaded.
 */
import { describe, expect, it, vi } from 'vitest';
import { CERTIFICATE_PAGE_EXPRESSION, certificateInstruction, certificateWarningFor, describeCertificateWarning,
  readCertificateWarning, type CertificatePage } from '../src/headset-certificate.js';
import type { DevtoolsTransport } from '../src/headset-devtools.js';

const origin = 'https://192.168.77.24:8443';
/** Where an adb launch sends the headset: the share root with its pairing code. */
const launchUrl = `${origin}/#pair=12345678`;
const WARNING_PAGE: CertificatePage = { href: 'chrome-error://chromewebdata/', title: 'Privacy error', code: 'NET::ERR_CERT_AUTHORITY_INVALID' };

const target = (id: string, url: string, title: string) =>
  ({ id, type: 'page', title, url, webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}` });

/** A debugger with these tabs. `pages` is what each tab answers; a missing entry is a frozen tab. */
function fakeDevtools(tabs: ReturnType<typeof target>[], pages: Record<string, CertificatePage>, fetchFails?: Error) {
  const opened: string[] = [];
  const transport: DevtoolsTransport = {
    fetch: vi.fn(async () => { if (fetchFails) throw fetchFails; return JSON.stringify(tabs); }),
    open: vi.fn(async (_port: number, socketUrl: string) => {
      const id = socketUrl.split('/').pop()!;
      opened.push(id);
      return {
        send: async (method: string) => {
          const page = pages[id];
          if (page === undefined) throw Error(`${method} did not answer within 1500 ms.`);
          return { result: { value: page } };
        },
        close: () => {},
      } as never;
    }),
  };
  return { transport, opened };
}

describe('the certificate warning, from one tab', () => {
  it('is recognised from the title, the error page and the error code, and names the share', () => {
    const warning = certificateWarningFor({ target: target('71', launchUrl, 'Privacy error'), page: WARNING_PAGE,
      expectedOrigin: origin, worn: false, fingerprint: 'AB:CD' });
    expect(warning).toEqual({
      address: origin, host: '192.168.77.24', code: 'NET::ERR_CERT_AUTHORITY_INVALID', tab: '71',
      evidence: ['title', 'error-page', 'error-code'], fingerprint: 'AB:CD',
      instruction: 'Put the headset on. Quest Browser in the headset shows "Your connection is not private". '
        + 'Choose Advanced, then "Proceed to 192.168.77.24 (unsafe)". Then tap Enter VR. '
        + 'The warning returns each time Quest Browser restarts.',
    });
    // The pairing code rides in the launch address and never leaves in the warning.
    expect(JSON.stringify(warning)).not.toContain('12345678');
  });

  it('asks the person to put the headset on only when it is off their head', () => {
    expect(certificateInstruction('192.168.77.24', true)).toMatch(/^Quest Browser in the headset shows/u);
    expect(certificateInstruction('192.168.77.24')).toMatch(/^Quest Browser in the headset shows/u);
    expect(certificateInstruction('192.168.77.24', false)).toMatch(/^Put the headset on\. /u);
  });

  it('is recognised from the error code alone on a headset set to another language', () => {
    const warning = certificateWarningFor({ target: target('71', `${origin}/viewer`, 'Datenschutzfehler'),
      page: { ...WARNING_PAGE, title: 'Datenschutzfehler' }, expectedOrigin: origin });
    expect(warning).toMatchObject({ evidence: ['error-page', 'error-code'], code: 'NET::ERR_CERT_AUTHORITY_INVALID' });
  });

  it('is recognised from the title alone when the tab is frozen and its page says nothing', () => {
    const warning = certificateWarningFor({ target: target('71', launchUrl, 'Privacy error'), expectedOrigin: origin });
    expect(warning).toMatchObject({ address: origin, evidence: ['title'] });
    expect(warning?.code).toBeUndefined();
  });

  it('is not reported for the viewer, for another error page, or for another site', () => {
    expect(certificateWarningFor({ target: target('70', `${origin}/viewer`, 'Stereofold'),
      page: { href: `${origin}/viewer`, title: 'Stereofold', code: null }, expectedOrigin: origin })).toBeUndefined();
    // A share that refused the connection is an error page with no certificate code.
    expect(certificateWarningFor({ target: target('71', launchUrl, '192.168.77.24'),
      page: { href: 'chrome-error://chromewebdata/', title: '192.168.77.24', code: null }, expectedOrigin: origin })).toBeUndefined();
    expect(certificateWarningFor({ target: target('72', 'https://example.com/', 'Privacy error'),
      page: WARNING_PAGE, expectedOrigin: origin })).toBeUndefined();
  });

  it('reports a tab listed at its error address against the share origin, and only when that origin is known', () => {
    const errorTab = target('71', 'chrome-error://chromewebdata/', 'Privacy error');
    expect(certificateWarningFor({ target: errorTab, page: WARNING_PAGE, expectedOrigin: origin })).toMatchObject({ address: origin });
    expect(certificateWarningFor({ target: errorTab, page: WARNING_PAGE })).toBeUndefined();
  });

  it('without a share origin, needs a Stereofold path or a pairing fragment', () => {
    expect(certificateWarningFor({ target: target('71', `${origin}/viewer`, 'Privacy error') })).toMatchObject({ address: origin });
    expect(certificateWarningFor({ target: target('71', launchUrl, 'Privacy error') })).toMatchObject({ address: origin });
    expect(certificateWarningFor({ target: target('71', `${origin}/`, 'Privacy error') })).toBeUndefined();
  });

  it('leads a tool result with the address and the words to relay', () => {
    const warning = certificateWarningFor({ target: target('71', launchUrl, 'Privacy error'), page: WARNING_PAGE, expectedOrigin: origin })!;
    const sentence = describeCertificateWarning(warning);
    expect(sentence).toMatch(/^Quest Browser is showing a certificate warning for https:\/\/192\.168\.77\.24:8443 \(NET::ERR_CERT_AUTHORITY_INVALID\)/u);
    expect(sentence).toContain(`Tell the user: ${warning.instruction}`);
  });
});

describe('the page expression', () => {
  const run = (location: { protocol: string; href: string }, document: { title: string; body: { innerText: string } | null }) =>
    new Function('location', 'document', `return ${CERTIFICATE_PAGE_EXPRESSION};`)(location, document) as CertificatePage;

  it('reads the error code off the warning page', () => {
    expect(run({ protocol: 'chrome-error:', href: 'chrome-error://chromewebdata/' },
      { title: 'Privacy error', body: { innerText: 'Your connection is not private\nNET::ERR_CERT_AUTHORITY_INVALID\nAdvanced' } }))
      .toEqual({ href: 'chrome-error://chromewebdata/', title: 'Privacy error', code: 'NET::ERR_CERT_AUTHORITY_INVALID' });
  });

  it('never reads the text of a page that loaded', () => {
    const body = { get innerText(): string { throw Error('the viewer text was read'); } };
    expect(run({ protocol: 'https:', href: `${origin}/viewer` }, { title: 'Stereofold', body }))
      .toEqual({ href: `${origin}/viewer`, title: 'Stereofold', code: null });
  });
});

describe('looking for the warning on the headset', () => {
  it('finds it on the tab in front and leaves the viewer tab alone', async () => {
    const { transport, opened } = fakeDevtools([target('70', `${origin}/viewer`, 'Stereofold'), target('71', launchUrl, 'Privacy error')],
      { 71: WARNING_PAGE });
    const reading = await readCertificateWarning(transport, { port: 9333, expectedOrigin: origin, worn: false });
    expect(reading).toMatchObject({ read: true, warning: { tab: '71', code: 'NET::ERR_CERT_AUTHORITY_INVALID', host: '192.168.77.24' } });
    expect(opened).toEqual(['71']);
  });

  it('still finds it when the warning tab is frozen', async () => {
    const { transport } = fakeDevtools([target('71', launchUrl, 'Privacy error')], {});
    const reading = await readCertificateWarning(transport, { port: 9333, expectedOrigin: origin, probeMs: 5 });
    expect(reading).toMatchObject({ read: true, warning: { tab: '71', evidence: ['title'] } });
  });

  it('reports nothing when the headset shows the page', async () => {
    const { transport, opened } = fakeDevtools([target('70', `${origin}/viewer`, 'Stereofold')], {});
    expect(await readCertificateWarning(transport, { port: 9333, expectedOrigin: origin })).toEqual({ read: true });
    expect(opened).toEqual([]);
  });

  it('says it could not look when no debugger answers', async () => {
    const { transport } = fakeDevtools([], {}, Error('connect ECONNREFUSED 127.0.0.1:9333'));
    expect(await readCertificateWarning(transport, { port: 9333, expectedOrigin: origin }))
      .toEqual({ read: false, reason: 'connect ECONNREFUSED 127.0.0.1:9333' });
  });

  it('asks at most three frozen pages', async () => {
    const tabs = ['60', '61', '62', '63', '64'].map(id => target(id, `${origin}/`, 'Loading'));
    const { transport, opened } = fakeDevtools(tabs, {});
    expect(await readCertificateWarning(transport, { port: 9333, expectedOrigin: origin, probeMs: 5 })).toEqual({ read: true });
    // Newest first, because the tab a launch just opened is the one in front.
    expect(opened).toEqual(['64', '63', '62']);
  });
});
