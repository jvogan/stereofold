import { randomUUID } from 'node:crypto';
import { ContractError, canonical, copy, fields, identifier, requireValue, revision, same, validateCommand,
  validateTarget } from './contracts.mjs';

// Pure receiver model: callers simulate commit and renderer callbacks explicitly.
export class Receiver {
  #clock; #lastClock = -Infinity; #lastAccess; #expired = false;
  #target; #serverEpoch; #receiverEpoch; #lease; #policy; #actors;
  #state; #records = new Map(); #generation = 0; #grabOwner = null; #commitCount = 0;

  constructor({ clock, target, serverEpoch, receiverEpoch, leaseId, scene, actors, policy }) {
    validateTarget(target);
    for (const value of [serverEpoch, receiverEpoch, leaseId, ...actors]) requireValue(identifier(value), 'invalid_identity');
    fields(policy, ['inactivityMs', 'leaseMs', 'maxCommands']);
    requireValue(Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0), 'invalid_policy');
    requireValue(identifier(scene.sceneId) && revision(scene.revision), 'invalid_scene');
    this.#clock = clock;
    this.#target = copy(target);
    this.#serverEpoch = serverEpoch;
    this.#receiverEpoch = receiverEpoch;
    this.#policy = copy(policy);
    this.#actors = new Set(actors);
    const now = this.#now();
    this.#lastAccess = now;
    this.#lease = { id: leaseId, expiresAt: now + policy.leaseMs };
    this.#state = { ...copy(scene), representation: scene.representation ?? 'cartoon',
      scale: 1, orientation: [0, 0, 0, 1], rotations: { x: 0, y: 0, z: 0 }, renderedRevision: null };
  }

  #now() {
    const now = this.#clock();
    requireValue(Number.isFinite(now) && now >= this.#lastClock, 'clock_not_monotonic');
    this.#lastClock = now;
    return now;
  }

  #active() {
    const now = this.#now();
    if (now - this.#lastAccess >= this.#policy.inactivityMs) this.#expired = true;
    requireValue(!this.#expired, 'session_expired');
    requireValue(now < this.#lease.expiresAt, 'lease_expired');
    return now;
  }

  #reply(record) {
    return { ...copy(record.outcome), currentScene: record.command.sceneId === this.#state.sceneId,
      currentRevision: this.#state.revision, currentlyRendered: record.outcome.status === 'rendered'
        && record.command.sceneId === this.#state.sceneId
        && record.outcome.renderedRevision === this.#state.renderedRevision
        && this.#state.renderedRevision === this.#state.revision };
  }

  #reject(code) { return { status: 'rejected', reason: code }; }

  #terminatePending(reason) {
    for (const record of this.#records.values()) {
      if (record.outcome.status === 'accepted' || record.outcome.status === 'committed') {
        record.outcome.status = 'superseded';
        record.outcome.reason = reason;
        record.ticket = null;
      }
    }
  }

  binding() {
    this.#active();
    return { target: copy(this.#target), serverEpoch: this.#serverEpoch, receiverEpoch: this.#receiverEpoch,
      lease: copy(this.#lease) };
  }

  getState() {
    this.#lastAccess = this.#active();
    return this.inspect();
  }

  // Test diagnostics do not refresh inactivity. A wire API must use an authorized read path.
  inspect() {
    return { state: copy(this.#state), grabbed: this.#grabOwner !== null, commitCount: this.#commitCount,
      retainedCommands: this.#records.size, generation: this.#generation };
  }

  stamp() {
    this.#active();
    return this.#stampUnchecked();
  }

  #stampUnchecked() {
    return { target: copy(this.#target), serverEpoch: this.#serverEpoch, receiverEpoch: this.#receiverEpoch,
      leaseId: this.#lease.id, sceneId: this.#state.sceneId, revision: this.#state.revision,
      generation: this.#generation };
  }

  receive(input) {
    try {
      const command = validateCommand(input);
      const now = this.#active();
      requireValue(same(command.target, this.#target), 'wrong_target');
      requireValue(command.serverEpoch === this.#serverEpoch && command.receiverEpoch === this.#receiverEpoch,
        'wrong_epoch');
      requireValue(command.leaseId === this.#lease.id, 'wrong_lease');
      requireValue(this.#actors.has(command.actorId), 'unknown_actor');
      requireValue(command.deadline <= this.#lease.expiresAt, 'deadline_outside_lease');
      const fingerprint = canonical(command);
      const known = this.#records.get(command.commandId);
      if (known) {
        requireValue(known.fingerprint === fingerprint, 'command_id_conflict');
        if (known.outcome.status === 'accepted' && now >= known.command.deadline) {
          known.outcome.status = 'rejected';
          known.outcome.reason = 'command_expired';
        }
        this.#lastAccess = now;
        return this.#reply(known);
      }
      requireValue(now < command.deadline, 'command_expired');
      requireValue(command.sceneId === this.#state.sceneId, 'wrong_scene');
      requireValue(command.expectedRevision === this.#state.revision, 'revision_conflict');
      requireValue(this.#grabOwner === null, 'local_manipulation_active');
      requireValue(this.#records.size < this.#policy.maxCommands, 'command_history_full');
      const outcome = { commandId: command.commandId, target: copy(command.target), sceneId: command.sceneId,
        serverEpoch: command.serverEpoch, receiverEpoch: command.receiverEpoch,
        status: 'accepted', committedRevision: null, renderedRevision: null, reason: null };
      const record = { command, fingerprint, outcome, ticket: null };
      this.#records.set(command.commandId, record);
      this.#lastAccess = now;
      return this.#reply(record);
    } catch (error) {
      if (error instanceof ContractError) return this.#reject(error.code);
      throw error;
    }
  }

  commit(commandId) {
    const record = this.#records.get(commandId);
    if (!record) return this.#reject('unknown_command');
    if (record.outcome.status !== 'accepted') return this.#reply(record);
    try {
      const now = this.#active();
      const command = record.command;
      requireValue(now < command.deadline, 'command_expired');
      requireValue(command.sceneId === this.#state.sceneId, 'wrong_scene');
      requireValue(command.expectedRevision === this.#state.revision, 'revision_conflict');
      requireValue(this.#grabOwner === null, 'local_manipulation_active');
      requireValue(this.#state.revision < Number.MAX_SAFE_INTEGER, 'revision_exhausted');
      const next = copy(this.#state);
      const operation = command.operation;
      if (operation.kind === 'set_representation') next.representation = operation.value;
      if (operation.kind === 'set_scale') next.scale = operation.value;
      if (operation.kind === 'rotate_object') {
        const halfAngle = operation.degrees * Math.PI / 360;
        const delta = [0, 0, 0, Math.cos(halfAngle)];
        delta[{ x: 0, y: 1, z: 2 }[operation.axis]] = Math.sin(halfAngle);
        const [x, y, z, w] = next.orientation;
        const [a, b, c, d] = delta;
        // Post-multiplication applies the requested rotation about an object-relative axis.
        const orientation = [w * a + x * d + y * c - z * b, w * b - x * c + y * d + z * a,
          w * c + x * b - y * a + z * d, w * d - x * a - y * b - z * c];
        const length = Math.hypot(...orientation);
        next.orientation = orientation.map(value => value / length);
        next.rotations[operation.axis] += operation.degrees;
      }
      next.revision += 1;
      const ticket = { nonce: randomUUID(), commandId, ...this.#stampUnchecked(), revision: next.revision };
      // A newer commit can overtake a callback. Only a callback for its exact revision can confirm it.
      for (const older of this.#records.values()) {
        if (older.outcome.status === 'committed') {
          older.outcome.status = 'superseded';
          older.outcome.reason = 'newer_commit_before_render_confirmation';
          older.ticket = null;
        }
      }
      this.#state = next;
      this.#commitCount += 1;
      record.outcome.status = 'committed';
      record.outcome.committedRevision = next.revision;
      record.ticket = ticket;
      this.#lastAccess = now;
      return this.#reply(record);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      record.outcome.status = 'rejected';
      record.outcome.reason = error.code;
      return this.#reply(record);
    }
  }

  renderTicket(commandId) { return copy(this.#records.get(commandId)?.ticket ?? null); }

  confirmRendered(ticket) {
    try {
      this.#active();
      requireValue(ticket !== null && typeof ticket === 'object', 'invalid_render_ticket');
      const record = this.#records.get(ticket.commandId);
      requireValue(record && record.ticket && same(ticket, record.ticket), 'invalid_render_ticket');
      const { nonce, commandId, ...stamp } = ticket;
      requireValue(same(stamp, this.stamp()), 'stale_render_ticket');
      requireValue(record.outcome.status === 'committed' || record.outcome.status === 'rendered', 'stale_render_ticket');
      record.outcome.status = 'rendered';
      record.outcome.renderedRevision = this.#state.revision;
      this.#state.renderedRevision = this.#state.revision;
      return this.#reply(record);
    } catch (error) {
      if (error instanceof ContractError) return this.#reject(error.code);
      throw error;
    }
  }

  cancel(commandId) {
    const record = this.#records.get(commandId);
    if (!record) return this.#reject('unknown_command');
    if (record.outcome.status !== 'accepted') return this.#reject('already_committed_or_terminal');
    record.outcome.status = 'cancelled';
    record.outcome.reason = 'cancelled_before_commit';
    return this.#reply(record);
  }

  setGrabbed(value, ownerId = 'controller') {
    this.#active();
    requireValue(typeof value === 'boolean' && identifier(ownerId), 'invalid_grab');
    requireValue(this.#grabOwner === null || this.#grabOwner === ownerId, 'wrong_grab_owner');
    this.#grabOwner = value ? ownerId : null;
  }

  replaceScene(expected, manifest) {
    const now = this.#active();
    requireValue(same(expected, this.#stampUnchecked()), 'transfer_conflict');
    requireValue(this.#grabOwner === null, 'local_manipulation_active');
    requireValue(manifest.sceneId !== this.#state.sceneId, 'scene_id_reused');
    requireValue(this.#state.revision < Number.MAX_SAFE_INTEGER, 'revision_exhausted');
    const next = { sceneId: manifest.sceneId, sourceSha256: manifest.source.sha256,
      revision: this.#state.revision + 1, renderedRevision: null, representation: manifest.representation,
      scale: 1, orientation: copy(manifest.view.orientation), rotations: { x: 0, y: 0, z: 0 }, manifest: copy(manifest) };
    this.#terminatePending('scene_replaced');
    this.#generation += 1;
    this.#state = next;
    this.#lastAccess = now;
    return this.inspect();
  }

  renewLease() {
    // A trusted rebind is required. Renewal preserves state but retires every old command and callback.
    const now = this.#now();
    this.#terminatePending('lease_retired');
    this.#records.clear();
    this.#generation += 1;
    this.#lease = { id: randomUUID(), expiresAt: now + this.#policy.leaseMs };
    this.#expired = false;
    this.#lastAccess = now;
    return { target: copy(this.#target), serverEpoch: this.#serverEpoch, receiverEpoch: this.#receiverEpoch,
      lease: copy(this.#lease) };
  }
}
