import test from 'node:test';
import assert from 'node:assert/strict';
import { primePushToTalkMicrophone, releasePushToTalkMicrophone,
  primedPushToTalkStream, pushToTalkMicrophoneState } from './push-to-talk-audio.mjs';

function microphone() {
  let stops = 0;
  const track = { readyState: 'live', enabled: true,
    stop() { stops++; this.readyState = 'ended'; } };
  return { getTracks: () => [track], stops: () => stops };
}

test('a microphone grant arriving after XR exit is stopped, never adopted', async () => {
  releasePushToTalkMicrophone();
  const stream = microphone();
  let grant;
  const pending = primePushToTalkMicrophone({media:{getUserMedia:() => new Promise(resolve => {grant=resolve;})}});
  releasePushToTalkMicrophone();
  grant(stream);
  await pending;
  try {
    assert.equal(stream.stops(), 1);
    assert.equal(primedPushToTalkStream(), undefined);
    assert.equal(pushToTalkMicrophoneState(), 'idle');
  } finally { releasePushToTalkMicrophone(); }
});

test('XR exit releases a pending microphone prompt for the next entry', async () => {
  releasePushToTalkMicrophone();
  const oldStream = microphone(), nextStream = microphone();
  let grant, nextRequests = 0;
  const first = primePushToTalkMicrophone({media:{getUserMedia:() => new Promise(resolve => {grant=resolve;})}});
  releasePushToTalkMicrophone();
  const next = primePushToTalkMicrophone({media:{getUserMedia:async() => { nextRequests++; return nextStream; }}});
  grant(oldStream);
  await Promise.all([first,next]);
  try {
    assert.equal(nextRequests, 1, 'the retired prompt must not own the next entry');
    assert.equal(oldStream.stops(), 1);
    assert.equal(primedPushToTalkStream(), nextStream);
    assert.equal(pushToTalkMicrophoneState(), 'granted');
  } finally { releasePushToTalkMicrophone(); }
});
