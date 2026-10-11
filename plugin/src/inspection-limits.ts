/** Source admission policies are distinct from device rendering capacity. */
/**
 * POLICY: largest decoded text source downloaded or read locally. Desktop
 * extraction of ribosomal entries up to 28.8 MB motivated raising 16 to 64 MiB;
 * this is headroom for transport, not a measured safe heap or headset ceiling.
 * Parsing, catalog expansion and representation construction have separate costs.
 */
export const MAX_STRUCTURE_SOURCE_BYTES = 64 * 1024 * 1024;
export const STRUCTURE_SOURCE_SIZE_LABEL = `${MAX_STRUCTURE_SOURCE_BYTES / (1024 * 1024)} MiB`;
/** POLICY: total HTTPS download deadline, including redirects and body transfer. */
export const STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** POLICY: cold staged growth downloads have a separate, bounded fetch budget. */
export const GROWTH_FETCH_TIMEOUT_MS = 180_000;
/**
 * POLICY: what one hydration response keeps INLINE, after the coordinates and
 * the compressed catalog have moved to their own transports. A desktop panel
 * pulls both in 96 KiB chunks (`MAX_INSPECTION_CHUNK_BYTES`) and the headset
 * takes its primary coordinates off the LAN `/source` route. A comparison
 * structure travels the chunk route on both surfaces and leaves only a
 * descriptor inline, so this covers the saved scene, a scene import, a custom
 * tour and those descriptors.
 */
export const MAX_INSPECTION_HYDRATION_BYTES = 8 * 1024 * 1024;
/**
 * POLICY: the largest saved scene one panel may push into the server's
 * per-session memory in a single `sync_inspection`, and therefore the largest
 * scene every later hydration carries back inline. A scene is client-supplied
 * JSON the server retains for the life of the session, so it is the one
 * payload here that an unbounded caller could grow without limit.
 */
export const MAX_INSPECTION_SCENE_BYTES = 2 * 1024 * 1024;
/**
 * POLICY: how long the headset waits for its `/source` fetch.
 *
 * The deadline is a base for the request and the digest check, plus the time
 * the declared bytes take at a floor of 1 MiB/s (about 8 Mbit/s). It grows with
 * the declared size and stops at `MAX_STRUCTURE_SOURCE_BYTES`, so a stalled
 * request still ends: 94 s for the largest admitted source. The floor is a
 * chosen minimum, not a measured headset throughput.
 */
export const HEADSET_TRANSFER_BASE_MS = 30_000;
export const HEADSET_TRANSFER_FLOOR_BYTES_PER_SECOND = 1024 * 1024;
export function headsetSourceDeadlineMs(bytes: number): number {
  const declared = Number.isFinite(bytes) ? Math.min(Math.max(0, bytes), MAX_STRUCTURE_SOURCE_BYTES) : MAX_STRUCTURE_SOURCE_BYTES;
  return HEADSET_TRANSFER_BASE_MS + Math.ceil(declared / HEADSET_TRANSFER_FLOOR_BYTES_PER_SECOND) * 1000;
}
/**
 * POLICY: how long a headset page waits for `navigate_experience`. A cold
 * journey downloads, extracts and checks each declared source before it
 * returns a first scene, which no ordinary 15 s request has room for.
 */
export const COMPANION_JOURNEY_DEADLINE_MS = 120_000;
/**
 * POLICY: how long a listener lets one request from a headset page run before
 * it cuts the socket. 55 s is the 45 s limit of the voice helpers plus a
 * delivery margin, and every tool but one has a page deadline of 55 s or less.
 * `navigate_experience` has a longer page deadline, so it gets that deadline
 * plus the same 10 s margin instead of being cut mid-answer. Every request
 * still ends at a bound.
 */
export const COMPANION_REQUEST_CEILING_MS = 55_000;
export const COMPANION_REQUEST_MARGIN_MS = 10_000;
export function companionRequestCeilingMs(tool: unknown): number {
  return tool === 'navigate_experience' ? COMPANION_JOURNEY_DEADLINE_MS + COMPANION_REQUEST_MARGIN_MS : COMPANION_REQUEST_CEILING_MS;
}
/**
 * The cap on a DENSITY map, which has its own route.
 *
 * 12 MB holds the `filament` tier's 8,389,632 bytes with room for a larger
 * crop or a 3x downsample, and is well under what one LAN transfer to a
 * headset can carry in the wearer's patience. POLICY, for the wearer's wait.
 */
export const MAX_INSPECTION_DENSITY_BYTES = 12 * 1024 * 1024;
/**
 * The largest raw slice one `stereo_structure.get_inspection_bytes` call
 * returns, so that no structure size depends on what a host bridge will carry
 * in a single tool result.
 *
 * Claude's MCP Apps troubleshooting page
 * (https://claude.com/docs/connectors/building/mcp-apps/troubleshooting) says a
 * tool result over about 150,000 characters is written to the code-execution
 * sandbox instead of being delivered inline on Claude.ai and Claude Desktop,
 * and that Claude Code applies a separate 25,000-token default through
 * `MAX_MCP_OUTPUT_TOKENS`. Its stated remedy is app-initiated tool calls that
 * fetch data on demand, and the ext-apps Patterns document spells the same
 * shape out as offset/byteCount/totalBytes/hasMore. No ceiling is documented
 * for the ChatGPT host and none has been measured.
 *
 * 96 KiB base64-encodes to exactly 131,072 characters, which leaves room for
 * the rest of the envelope under that 150,000 threshold. It is also a multiple
 * of 3, so each chunk's base64 carries no padding and the chunks concatenate.
 */
export const MAX_INSPECTION_CHUNK_BYTES = 96 * 1024;
/**
 * WHAT FITS, IN NUMBERS A MODEL CAN ANSWER A PERSON WITH.
 *
 * The earlier version of this sentence quoted a 6 MB source bound and a 4 MiB
 * compressed-catalog bound. Neither was measured against any viewer or host:
 * both were invented to keep one JSON tool result small, and between them they
 * refused 1AON (GroEL), 1XCK and 1S5L. Chunked hydration removed the reason for
 * both, so the sentence now carries the one bound somebody measured and says
 * plainly which of the rest is policy.
 */
export const INSPECTION_SIZE_GUIDE =
  `The desktop viewer has no measured ceiling. This plugin accepts source text up to ${STRUCTURE_SOURCE_SIZE_LABEL} as its own download/read policy, not a guarantee of rendering capacity. The paired Quest 2 growth workflow uses a 43,066 atom-site tier tested as cartoon; it is not a universal arbitrary-structure limit.`;
/** The same thing said to the wearer, who is not choosing the next structure. */
export const INSPECTION_SIZE_GUIDE_CAPTION = 'This exceeds the current transfer policy; it is not a measured headset capacity.';
const megabytes = (bytes:number) => `${(bytes/1_000_000).toFixed(1)} MB`;
export function assertInspectionBudget(value:unknown, limit:number, label:string):void {
  const bytes=Buffer.byteLength(JSON.stringify(value),'utf8');
  if(bytes>limit) throw Error(`${label} exceeds the ${megabytes(limit)} this plugin keeps inline in one hydration response.`
    +` It is ${megabytes(bytes)}. ${INSPECTION_SIZE_GUIDE}`);
}
