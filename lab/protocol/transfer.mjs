import { checkSourceFacts, copy, fields, requireValue, same, sha256,
  validateManifest } from './contracts.mjs';

export class Transfer {
  #receiver; #limits; #inspectSource; #pending = null; #nextAttempt = 0; #parsingAttempt = null;

  constructor({ receiver, limits, inspectSource }) {
    fields(limits, ['maxSourceBytes', 'maxChunkBytes', 'maxSelectionKeys']);
    requireValue(Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
      && limits.maxChunkBytes <= limits.maxSourceBytes, 'invalid_transfer_limits');
    this.#receiver = receiver;
    this.#limits = copy(limits);
    this.#inspectSource = inspectSource;
  }

  #current(attempt) {
    requireValue(this.#pending === attempt, 'transfer_retired');
    requireValue(same(attempt.stamp, this.#receiver.stamp()), 'transfer_conflict');
  }

  #discard(attempt) {
    attempt.chunks.length = 0;
    attempt.prepared = false;
    if (this.#pending === attempt) this.#pending = null;
  }

  begin(manifestInput) {
    requireValue(this.#pending === null, 'transfer_busy');
    requireValue(!this.#receiver.inspect().grabbed, 'local_manipulation_active');
    const manifest = validateManifest(manifestInput, this.#limits);
    const stamp = this.#receiver.stamp();
    requireValue(manifest.sceneId !== stamp.sceneId, 'scene_id_reused');
    const attempt = { id: ++this.#nextAttempt, stamp, manifest, chunks: [], received: 0, preparing: false, prepared: false };
    this.#pending = attempt;
    return { attemptId: attempt.id, expectedBytes: manifest.source.byteLength };
  }

  append(attemptId, offset, bytes) {
    const attempt = this.#pending;
    requireValue(attempt && attempt.id === attemptId, 'transfer_retired');
    try {
      this.#current(attempt);
      requireValue(!attempt.preparing && !attempt.prepared, 'transfer_already_preparing');
      requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0
        && bytes.byteLength <= this.#limits.maxChunkBytes, 'chunk_size_limit');
      requireValue(Number.isSafeInteger(offset) && offset >= 0, 'invalid_chunk_offset');
      const duplicate = attempt.chunks.find((entry) => entry.offset === offset);
      if (duplicate) {
        requireValue(Buffer.from(bytes).equals(duplicate.bytes), 'chunk_conflict');
        return { receivedBytes: attempt.received, duplicate: true };
      }
      requireValue(offset === attempt.received, 'chunk_out_of_order');
      requireValue(offset + bytes.byteLength <= attempt.manifest.source.byteLength, 'source_size_limit');
      attempt.chunks.push({ offset, bytes: Buffer.from(bytes) });
      attempt.received += bytes.byteLength;
      return { receivedBytes: attempt.received, duplicate: false };
    } catch (error) {
      this.#discard(attempt);
      throw error;
    }
  }

  async prepare(attemptId) {
    const attempt = this.#pending;
    requireValue(attempt && attempt.id === attemptId, 'transfer_retired');
    // Cancellation invalidates ownership, but an unresolved parser can still hold its input buffer.
    requireValue(this.#parsingAttempt === null, 'parser_busy');
    try {
      this.#current(attempt);
      requireValue(!attempt.preparing && !attempt.prepared, 'transfer_already_preparing');
      requireValue(attempt.received === attempt.manifest.source.byteLength, 'source_truncated');
      attempt.preparing = true;
      this.#parsingAttempt = attempt;
      const bytes = Buffer.concat(attempt.chunks.map((entry) => entry.bytes));
      requireValue(sha256(bytes) === attempt.manifest.source.sha256, 'source_hash_mismatch');
      // The parser receives a copy, and its facts must describe the exact source/model/assembly/selection.
      const facts = await this.#inspectSource(Buffer.from(bytes));
      this.#current(attempt);
      checkSourceFacts(attempt.manifest, facts);
      attempt.prepared = true;
      attempt.preparing = false;
      attempt.chunks.length = 0;
      return { attemptId, status: 'prepared', sourceSha256: attempt.manifest.source.sha256 };
    } catch (error) {
      this.#discard(attempt);
      throw error;
    } finally {
      if (this.#parsingAttempt === attempt) this.#parsingAttempt = null;
    }
  }

  commit(attemptId) {
    const attempt = this.#pending;
    requireValue(attempt && attempt.id === attemptId, 'transfer_retired');
    try {
      this.#current(attempt);
      requireValue(attempt.prepared, 'transfer_not_prepared');
      const result = this.#receiver.replaceScene(attempt.stamp, attempt.manifest);
      this.#discard(attempt);
      return result;
    } catch (error) {
      this.#discard(attempt);
      throw error;
    }
  }

  cancel(attemptId) {
    const attempt = this.#pending;
    requireValue(attempt && attempt.id === attemptId, 'transfer_retired');
    this.#discard(attempt);
    return { attemptId, status: 'cancelled' };
  }

  inspect() {
    return this.#pending ? { attemptId: this.#pending.id, receivedBytes: this.#pending.received,
      preparing: this.#pending.preparing, prepared: this.#pending.prepared } : null;
  }

  resources() { return { activeParsers: this.#parsingAttempt === null ? 0 : 1, pendingStages: this.#pending === null ? 0 : 1 }; }
}
