/**
 * Reading a download without trusting its size.
 *
 * The server, or wherever it redirects, decides how long a body runs and how
 * far it inflates, and a deadline limits time rather than allocation.
 * Measuring after `text()` or `arrayBuffer()` means the whole body is already
 * in memory. This reads the decoded body as a stream, counts its bytes as they
 * arrive and cancels the request as soon as the count passes the limit, so no
 * more than the limit plus one chunk is ever held.
 */

export function downloadTooLarge(maxBytes: number): Error {
  return Error(`it sent more than ${maxBytes.toLocaleString('en-US')} bytes.`);
}

/** The whole decoded body, or a refusal the moment it passes `maxBytes`. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw downloadTooLarge(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw downloadTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** An https URL without embedded credentials, fragment dropped, or a refusal. */
export function httpsDownloadUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw Error('The source URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Insecure URLs and embedded credentials are refused.');
  url.hash = '';
  return url;
}

/**
 * A GET that stays on https, following redirects by hand.
 *
 * Automatic redirects would request whatever a server names, including plain
 * http to loopback or the private network, before any later check could
 * refuse the body. Here every hop must itself be https without credentials
 * and is checked before it is requested, and a sixth redirect is refused.
 * Returns the first response that is not a redirect.
 */
export async function fetchFollowingHttpsRedirects(
  href: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let url = httpsDownloadUrl(href);
  for (let redirects = 0; ; redirects++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal: init.signal, headers: init.headers });
    if (response.url) httpsDownloadUrl(response.url);
    if (!REDIRECT_STATUSES.includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= 5) throw Error('The source exceeds the five-redirect limit.');
    const location = response.headers.get('location');
    if (!location) throw Error('The redirect has no location.');
    url = httpsDownloadUrl(new URL(location, url).href);
  }
}
