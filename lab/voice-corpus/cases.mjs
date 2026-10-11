/**
 * What each of the forty cases needs staged, and how it is driven.
 *
 * The corpus file says what a case MEANS. This file says how to put the host
 * into the state the case describes and, where the case is a fault rather than
 * a sentence, how to create the fault. Nothing here decides an outcome: the
 * host's receipts do that, and `runner.mjs` reads them.
 *
 * `coverage` is the honest half. `scripted` means everything the case asks for
 * happened on this host. `partial` means the command half ran and the named
 * observations did not, because they need a worn headset, a real microphone or
 * a real transport. `environment` means nothing ran at all.
 */

const IDENTITY = { file: 'identity-edge.cif', modelNumber: 1 };
const IDENTITY_BOTH_COPIES = { file: 'identity-edge.cif', modelNumber: 1, assemblyId: '1' };
const LIGAND = { file: 'voice-ligand.cif', modelNumber: 1 };
const AMBIGUITY = { file: 'voice-ambiguity.cif', modelNumber: 1 };
const CRN = { file: '1CRN.cif', modelNumber: 1 };
const CARTOON = {
  representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
  opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0,
};

/** The audio and wearer observations no in-process host can make. */
const WEARER_AUDIO = [
  'native speech recognition of this sentence',
  'spoken reply audibility in the worn headset',
];

export const CASES = {
  V01: { fixture: CRN, coverage: 'partial', unproven: WEARER_AUDIO },
  V02: { fixture: CRN, coverage: 'partial', unproven: WEARER_AUDIO },
  V03: { fixture: CRN, coverage: 'partial', unproven: WEARER_AUDIO },
  V04: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V05: { fixture: LIGAND, coverage: 'partial', unproven: WEARER_AUDIO },
  V06: { fixture: { ...CRN, appearance: CARTOON }, coverage: 'partial', unproven: WEARER_AUDIO },
  V07: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V08: {
    fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO,
    // "The selected residue" has to be one, before anyone says the words.
    stage: async (ctx, lib) => { await lib.selectResidue(ctx.session, { authorChain: 'X', authorResidue: 50 }); },
  },
  V09: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V10: {
    fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO,
    stage: async (ctx, lib) => {
      await lib.saveView(ctx.session, 'Inspection start');
      // Move the scene off the saved view, so a restore has something to undo.
      await lib.command(ctx.session, 'update_inspection', { change: { kind: 'placement', patch: { scale: 1.5 } } });
      lib.expectRendered(ctx, await lib.settle(ctx.session), 'the scene the restore has to come back from');
    },
  },

  V11: {
    fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO,
    stage: async (ctx, lib) => {
      const stale = await lib.selectResidue(ctx.session, { authorChain: 'X', authorResidue: 50 });
      const fresh = await lib.rowKey(ctx.session, { authorChain: 'X', authorResidue: 15, insertionCode: '' });
      ctx.pointing = { residueKey: fresh };
      ctx.expectTarget = [fresh];
      ctx.priorSelection = stale;
    },
  },
  V12: { fixture: AMBIGUITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V13: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V14: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V15: { fixture: AMBIGUITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V16: { fixture: IDENTITY_BOTH_COPIES, coverage: 'partial', unproven: WEARER_AUDIO },
  V17: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V18: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V19: {
    fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO, requiresClock: true,
    stage: async (ctx, lib) => {
      ctx.pointing = { residueKey: await lib.rowKey(ctx.session, { authorChain: 'X', authorResidue: 50 }) };
      // The press happens now; the answer comes back after the freshness limit.
      ctx.afterInjection = () => { ctx.host.clock.now += 60_000; };
    },
  },
  V20: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO, alternateSites: true },

  V21: {
    fixture: CRN, coverage: 'partial',
    unproven: ['audible interruption of a spoken reply on the native host', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      const first = await lib.utteranceEdit(ctx.session, 'shown', { kind: 'appearance', patch: { opacity: 0.5 } });
      const rendered = await lib.settle(ctx.session);
      lib.expectRendered(ctx, rendered, 'the representation change before the interruption');
      const injected = await lib.inject(ctx);
      const lifecycle = await lib.lifecycle(ctx.session, 'cancel', { commandId: 'stop-speaking', utteranceId: injected.utteranceId });
      // An interruption may not reach back into work that is already drawn.
      const receipt = await lib.receiptFor(ctx.session, first.commandId);
      ctx.record.lifecycleCancelled = lifecycle.commands.length;
      ctx.record.priorReceiptStatus = receipt.status;
      return {
        injected,
        outcome: lifecycle.commands.length === 0 && receipt.status === 'rendered' ? 'intended' : 'false-completion',
        detail: `The interruption cancelled ${lifecycle.commands.length} pending commands and left the drawn change at "${receipt.status}".`,
      };
    },
  },
  V22: {
    fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO,
    drive: async (ctx, lib) => {
      const target = await lib.rowKey(ctx.session, { authorChain: 'X', authorResidue: 50 });
      const first = await lib.utteranceEdit(ctx.session, 'first-hide', { kind: 'selection', patch: { selectionKeys: [target] } });
      const injected = await lib.inject(ctx);
      const correction = await lib.lifecycle(ctx.session, 'correct', { commandId: 'correction-begin', utteranceId: injected.utteranceId });
      const superseded = correction.commands.find(entry => entry.commandId === 'first-hide');
      // The old request must be unable to come back after the correction.
      const replay = await lib.expectRefusal(ctx.session, 'update_inspection', {
        commandId: 'replay-first', utteranceId: first.utteranceId,
        change: { kind: 'selection', patch: { selectionKeys: [target] } },
      });
      const replacement = await lib.rowKey(ctx.session, { authorChain: 'Y', authorResidue: 50 });
      await lib.command(ctx.session, 'update_inspection', {
        commandId: 'correction', utteranceId: correction.utterance.utteranceId,
        change: { kind: 'selection', patch: { selectionKeys: [replacement] } },
      });
      const rendered = await lib.settle(ctx.session);
      lib.expectRendered(ctx, rendered, 'the corrected selection');
      ctx.record.supersededStatus = superseded?.status ?? null;
      ctx.record.replayRefusal = replay;
      ctx.record.renderedSelection = ctx.session.scene.selectionKeys;
      return {
        injected,
        outcome: superseded?.status === 'superseded' && ctx.session.scene.selectionKeys.join() === replacement ? 'intended' : 'wrong-target',
        detail: `The queued request was ${superseded?.status ?? 'not found'} and only the replacement rendered.`,
      };
    },
  },
  V23: {
    fixture: IDENTITY, coverage: 'partial',
    unproven: ['an incomplete scene transfer paused before commit; this host has no chunked transfer to pause', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      const before = ctx.session.binding.baseInspectionRevision;
      await lib.utteranceEdit(ctx.session, 'pending', { kind: 'appearance', patch: { opacity: 0.5 } });
      const injected = await lib.inject(ctx);
      const cancelled = await lib.lifecycle(ctx.session, 'cancel', { commandId: 'cancel-begin', utteranceId: injected.utteranceId });
      const delivery = await lib.poll(ctx.session);
      const after = (await lib.refresh(ctx.session)).inspectionRevision;
      ctx.record.cancelledStatus = cancelled.commands[0]?.status ?? null;
      return {
        injected,
        outcome: cancelled.commands[0]?.status === 'cancelled' && delivery === undefined && after === before ? 'intended' : 'false-completion',
        detail: `The pending command was ${cancelled.commands[0]?.status ?? 'not found'}, nothing was delivered, and the saved revision stayed at ${after}.`,
      };
    },
  },
  V24: {
    fixture: { ...CRN, appearance: CARTOON }, coverage: 'partial', unproven: WEARER_AUDIO,
    stage: async (ctx, lib) => {
      await lib.command(ctx.session, 'update_inspection', { change: { kind: 'appearance', patch: { representation: 'ball-and-stick' } } });
      const rendered = await lib.settle(ctx.session);
      lib.expectRendered(ctx, rendered, 'the change the undo takes back');
      ctx.record.representationBeforeUndo = ctx.session.scene.inspection.appearance.representation;
    },
    after: async (ctx, lib) => {
      ctx.record.representationAfterUndo = ctx.session.scene.inspection.appearance.representation;
      if (ctx.session.scene.inspection.appearance.representation !== 'cartoon') {
        ctx.record.mismatch = 'The undo did not restore cartoon.';
      }
      return lib.noop();
    },
  },
  V25: {
    fixture: CRN, coverage: 'partial', unproven: WEARER_AUDIO,
    drive: async (ctx, lib) => {
      const receipts = [];
      let injected;
      for (const pass of ['first', 'second']) {
        injected = await lib.inject(ctx);
        const decided = await lib.consume(ctx, injected);
        if (decided.action !== 'command') return { injected, outcome: 'needs-model', detail: 'The repetition rule did not produce a command.' };
        await lib.command(ctx.session, decided.tool, { ...decided.args, commandId: `scale-${pass}`, utteranceId: injected.utteranceId });
        const rendered = await lib.settle(ctx.session);
        lib.expectRendered(ctx, rendered, `the ${pass} spoken scale`);
        receipts.push(rendered.receipt.status);
      }
      const scale = ctx.session.scene.inspection.placement.scale;
      ctx.record.receipts = receipts;
      ctx.record.scale = scale;
      return {
        injected,
        outcome: scale === 1.25 ? 'intended' : 'duplicate',
        detail: `Two separate utterances each rendered, and the absolute scale settled at ${scale} rather than compounding.`,
      };
    },
  },
  V26: {
    fixture: CRN, coverage: 'partial',
    unproven: ['a transport that actually duplicates a delivery; this host is handed the duplicate directly', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      const injected = await lib.inject(ctx);
      const decided = await lib.consume(ctx, injected);
      if (decided.action !== 'command') return { injected, outcome: 'needs-model', detail: 'The rotation rule did not produce a command.' };
      const args = { ...decided.args, commandId: 'rotate', utteranceId: injected.utteranceId };
      const first = await lib.command(ctx.session, decided.tool, args);
      const second = await lib.command(ctx.session, decided.tool, args);
      const sameReceipt = JSON.stringify(first.structuredContent.command) === JSON.stringify(second.structuredContent.command);
      const delivery = await lib.poll(ctx.session);
      const admitted = await lib.admit(ctx.session, delivery);
      const admittedTwice = await lib.admit(ctx.session, delivery);
      const before = ctx.session.binding.baseInspectionRevision;
      const rendered = await lib.render(ctx.session, delivery);
      lib.expectRendered(ctx, { receipt: rendered.answer.structuredContent.command }, 'the rotation');
      const after = ctx.session.binding.baseInspectionRevision;
      ctx.record.sameReceipt = sameReceipt;
      ctx.record.admissions = [admitted, admittedTwice];
      ctx.record.revisionsAdvanced = after - before;
      return {
        injected,
        outcome: sameReceipt && admitted && !admittedTwice && after - before === 1 ? 'intended' : 'duplicate',
        detail: `The repeated delivery returned the same receipt, was admitted once, and advanced the saved revision by ${after - before}.`,
      };
    },
  },
  V27: {
    fixture: IDENTITY, coverage: 'partial',
    unproven: ['a transport that actually withholds the acknowledgment', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      await lib.utteranceEdit(ctx.session, 'held', { kind: 'appearance', patch: { opacity: 0.5 } });
      const delivery = await lib.poll(ctx.session);
      const duringHold = await lib.receiptFor(ctx.session, 'held');
      const secondDelivery = await lib.poll(ctx.session);
      const injected = await lib.inject(ctx);
      const decided = await lib.consume(ctx, injected);
      // The consumer's only honest answer while a receipt is missing is to read
      // the state, which is what the query rule does.
      const reported = decided.action === 'query' ? duringHold.status : 'not-read';
      const reconciled = await lib.render(ctx.session, delivery);
      ctx.record.duringHold = duringHold.status;
      ctx.record.secondDelivery = secondDelivery === undefined ? 'none' : secondDelivery.commandId;
      return {
        injected,
        outcome: reported === 'rendering' && secondDelivery === undefined
          && reconciled.answer.structuredContent.command.status === 'rendered' ? 'intended' : 'duplicate',
        detail: `While the acknowledgment was withheld the receipt read "${duringHold.status}", no second delivery was handed out, and reconciliation rendered it once.`,
      };
    },
  },
  V28: {
    fixture: IDENTITY, coverage: 'partial', unproven: ['two separately bound live agent tasks', ...WEARER_AUDIO],
    second: IDENTITY, // "inspection A": a second session this task does not own.
    drive: async (ctx, lib) => {
      const injected = await lib.inject(ctx);
      const target = await lib.rowKey(ctx.other, { authorChain: 'X', authorResidue: 50 });
      const refusal = await lib.expectRefusal(ctx.other, 'update_inspection', {
        commandId: 'cross-task', utteranceId: injected.utteranceId,
        change: { kind: 'selection', patch: { selectionKeys: [target] } },
      });
      const here = await lib.poll(ctx.session);
      const there = await lib.poll(ctx.other);
      ctx.record.refusal = refusal;
      return {
        injected,
        outcome: refusal && here === undefined && there === undefined ? 'refusal' : 'wrong-target',
        detail: `The other inspection refused the utterance ("${refusal}") and neither session was handed a command.`,
      };
    },
  },
  V29: {
    fixture: IDENTITY, coverage: 'partial', unproven: ['a real stale delivery across a transport', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      await lib.selectResidue(ctx.session, { authorChain: 'X', authorResidue: 50 });
      const injected = await lib.inject(ctx);
      const staleUtterance = injected.utteranceId;
      await lib.command(ctx.session, 'update_inspection', {
        commandId: 'old-scene', utteranceId: staleUtterance, change: { kind: 'appearance', patch: { opacity: 0.6 } },
      });
      await lib.poll(ctx.session);
      // Scene B commits underneath the old request.
      const moved = structuredClone(ctx.session.scene);
      moved.inspection.appearance.opacity = 0.8;
      const saved = await lib.command(ctx.session, 'sync_inspection', { scene: moved });
      ctx.session.scene = moved;
      ctx.session.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
      const refusal = await lib.expectRefusal(ctx.session, 'update_inspection', {
        commandId: 'late', utteranceId: staleUtterance, change: { kind: 'appearance', patch: { opacity: 0.5 } },
      });
      ctx.record.refusal = refusal;
      return {
        injected,
        outcome: refusal ? 'refusal' : 'wrong-target',
        detail: `The old-scene request was refused after the new revision committed: "${refusal}".`,
      };
    },
  },
  V30: {
    fixture: CRN, coverage: 'partial', requiresTranscriberSeam: true,
    unproven: ['the native voice service in its own unavailable state', 'local controller inspection while voice is down'],
    drive: async (ctx, lib) => {
      ctx.host.setTranscription(false);
      const injected = await lib.inject(ctx, { expectSilence: true });
      const before = ctx.session.binding.baseInspectionRevision;
      const after = (await lib.refresh(ctx.session)).inspectionRevision;
      ctx.host.setTranscription(true);
      ctx.record.audioOutcome = injected.audioReason;
      return {
        injected,
        outcome: injected.transcript === null && after === before ? 'intended' : 'false-completion',
        detail: `The host reported "${injected.audioReason}", produced no transcript, and nothing was dispatched or changed.`,
      };
    },
  },

  V31: { fixture: { ...IDENTITY, appearance: CARTOON }, coverage: 'partial', unproven: ['both declared background-noise conditions', ...WEARER_AUDIO] },
  V32: { fixture: IDENTITY, coverage: 'partial', unproven: ['both predeclared seated positions in the worn headset', ...WEARER_AUDIO] },
  V33: { fixture: IDENTITY, coverage: 'partial', unproven: WEARER_AUDIO },
  V34: {
    fixture: IDENTITY, coverage: 'partial', unproven: ['spoken reply audibility under the declared background condition'],
    stage: async (ctx, lib) => { ctx.expectTarget = [await lib.selectResidue(ctx.session, { authorChain: 'X', authorResidue: 15, insertionCode: 'A' })]; },
  },
  V35: {
    fixture: IDENTITY, coverage: 'partial', unproven: ['a real controller grab held on the object', ...WEARER_AUDIO],
    stage: async (ctx, lib) => { await lib.selectResidue(ctx.session, { authorChain: 'X', authorResidue: 50 }); },
    drive: async (ctx, lib) => {
      const injected = await lib.inject(ctx);
      const decided = await lib.consume(ctx, injected);
      if (decided.action !== 'command') return { injected, outcome: 'needs-model', detail: 'The focus rule did not produce a command.' };
      await lib.command(ctx.session, decided.tool, { ...decided.args, commandId: 'held-focus', utteranceId: injected.utteranceId });
      // The grab is the panel saying it is busy. Nothing may be handed over.
      const duringGrab = await lib.poll(ctx.session, 'busy');
      const queued = await lib.receiptFor(ctx.session, 'held-focus');
      const afterRelease = await lib.settle(ctx.session);
      lib.expectRendered(ctx, afterRelease, 'the focus after the grab was released');
      ctx.record.deliveredDuringGrab = duringGrab === undefined ? 'none' : duringGrab.commandId;
      ctx.record.statusDuringGrab = queued.status;
      return {
        injected,
        outcome: duringGrab === undefined && queued.status === 'queued' && afterRelease.receipt.status === 'rendered' ? 'intended' : 'wrong-target',
        detail: `Nothing was delivered while the panel reported busy, the receipt read "${queued.status}", and it rendered once after release.`,
      };
    },
  },
  V36: {
    fixture: IDENTITY, coverage: 'partial',
    unproven: ['a real headset transport disconnect', 'local inspection on the disconnected device', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      const injected = await lib.inject(ctx);
      await lib.detach(ctx.session);
      const target = await lib.rowKey(ctx.session, { authorChain: 'Y', authorResidue: 50 });
      const refusal = await lib.expectRefusal(ctx.session, 'update_inspection', {
        commandId: 'to-disconnected', utteranceId: injected.utteranceId,
        change: { kind: 'selection', patch: { selectionKeys: [target] } },
      });
      const panelId = await lib.reattach(ctx.session);
      const replayed = await lib.poll(ctx.session);
      ctx.record.refusal = refusal;
      ctx.record.panelAfterReconnect = panelId;
      return {
        injected,
        outcome: refusal && replayed === undefined ? 'refusal' : 'duplicate',
        detail: `The disconnected target was refused ("${refusal}") and the reconnected panel was handed nothing.`,
      };
    },
  },
  V37: {
    fixture: IDENTITY, coverage: 'partial',
    unproven: ['a real acknowledgment lost across a reconnect', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      await lib.utteranceEdit(ctx.session, 'lost-ack', { kind: 'appearance', patch: { opacity: 0.5 } });
      const delivery = await lib.poll(ctx.session);
      await lib.detach(ctx.session);
      await lib.reattach(ctx.session);
      const injected = await lib.inject(ctx);
      const decided = await lib.consume(ctx, injected);
      const state = await lib.refresh(ctx.session);
      const receipt = await lib.receiptFor(ctx.session, 'lost-ack');
      const redelivered = await lib.poll(ctx.session);
      ctx.record.reportedVia = decided.action;
      ctx.record.pendingAfterReconnect = (state.pendingCommand ?? []).map(entry => `${entry.commandId}:${entry.status}`);
      ctx.record.lostAcknowledgment = { status: receipt.status, reason: receipt.reason ?? null };
      ctx.record.staleDelivery = redelivered === undefined ? 'none' : redelivered.commandId;
      ctx.record.unusedDelivery = delivery.commandId;
      // "unconfirmed" is the honest answer: the host cannot know whether the
      // panel drew it before it went, so it must not be reported as done.
      const reconciled = receipt.status === 'unconfirmed' && redelivered === undefined;
      return {
        injected,
        outcome: decided.action === 'query' && reconciled ? 'intended' : 'duplicate',
        detail: `After the reconnect the consumer read the state rather than resending. The command whose acknowledgment was lost reads "${receipt.status}" (${receipt.reason ?? 'no reason given'}), and the new panel was handed nothing.`,
      };
    },
  },
  V38: {
    fixture: IDENTITY, coverage: 'partial', unproven: ['a second named device that is genuinely unpaired', ...WEARER_AUDIO],
    drive: async (ctx, lib) => {
      const injected = await lib.inject(ctx);
      const target = await lib.rowKey(ctx.session, { authorChain: 'X', authorResidue: 50 });
      const before = ctx.session.binding.baseInspectionRevision;
      const refusal = await lib.expectRefusal(ctx.session, 'update_inspection', {
        commandId: 'other-device', utteranceId: injected.utteranceId,
        panelId: '00000000-0000-4000-8000-000000000000',
        change: { kind: 'selection', patch: { selectionKeys: [target] } },
      });
      const after = (await lib.refresh(ctx.session)).inspectionRevision;
      ctx.record.refusal = refusal;
      return {
        injected,
        outcome: refusal && after === before ? 'refusal' : 'wrong-target',
        detail: `A command named at an unknown device was refused ("${refusal}") and the paired session was untouched.`,
      };
    },
  },
  V39: {
    fixture: CRN, coverage: 'environment',
    unproven: ['an actual microphone-denied host condition, which only the real host can create'],
    blocked: 'Microphone permission is a host and operating-system state. No in-process seam can create it, and simulating it would prove nothing about the real denial.',
  },
  V40: {
    fixture: IDENTITY, coverage: 'partial',
    unproven: ['an actual loss of the selected Mac input route mid-utterance'],
  },
};
