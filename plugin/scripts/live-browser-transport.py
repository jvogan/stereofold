"""Opt-in single-session paid Live transport; no backend model and no browser credentials."""
import argparse, asyncio, base64, collections, json, os, pathlib, struct, subprocess, sys, time, wave
import websockets


def emit(value):
    print(json.dumps(value), flush=True)


def credential():
    # The key comes from the environment only; it stays in this server process.
    value = os.environ.get('OPENAI_API_KEY')
    if not value:
        value = subprocess.run(['launchctl', 'getenv', 'OPENAI_API_KEY'], capture_output=True, text=True).stdout.strip()
    if not value:
        raise RuntimeError('API credential unavailable: set OPENAI_API_KEY for this process')
    return value


async def main(args):
    out = pathlib.Path(args.output)
    with wave.open(args.input, 'rb') as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 24000)
        pcm = source.readframes(source.getnframes())
    assert 0 < len(pcm) < 48000 * 12
    stream = bytes(48000) + pcm
    report = {'model': 'gpt-live-1', 'route': 'project-api-key', 'backend': 'fixed client action driver; no backend API',
              'status': 'failed', 'maximumSeconds': 35, 'physicalHeadset': False, 'timing': {}}
    started = time.monotonic()
    elapsed = lambda: round((time.monotonic() - started) * 1000)
    ready, closed = asyncio.Event(), asyncio.Event()
    counts, texts, audio = collections.Counter(), {'input': [], 'output': [], 'outputAfterResult': []}, bytearray()
    result_at = None
    tasks = []
    try:
        async with websockets.connect('wss://api.openai.com/v1/live/sessions',
                additional_headers={'Authorization': 'Bearer ' + credential()},
                open_timeout=8, close_timeout=2, max_size=4 * 1024 * 1024) as ws:
            report['timing']['connectedMs'] = elapsed()
            async def send(value): await ws.send(json.dumps(value))
            async def receiver():
                async for raw in ws:
                    event = json.loads(raw); kind = event.get('type', 'unknown'); counts[kind] += 1
                    if kind == 'session.started':
                        report['timing']['readyMs'] = elapsed(); ready.set()
                    elif kind == 'session.output_audio.delta':
                        report['timing'].setdefault('firstAudioMs', elapsed())
                        if result_at is not None: report['timing'].setdefault('firstAudioAfterResultMs', elapsed())
                        chunk = base64.b64decode(event['delta']); audio.extend(chunk)
                        if any(abs(value[0]) > 328 for value in struct.iter_unpack('<h', chunk)):
                            report['timing'].setdefault('firstNonSilentAudioMs', elapsed())
                            if result_at is not None: report['timing'].setdefault('firstNonSilentAudioAfterResultMs', elapsed())
                        emit({'type': 'audio', 'pcm': event['delta'], 'atMs': elapsed()})
                    elif kind in ['session.input_transcript.delta', 'session.output_transcript.delta']:
                        side = 'input' if 'input_transcript' in kind else 'output'
                        texts[side].append(event.get('delta', ''))
                        if side == 'output' and result_at is not None: texts['outputAfterResult'].append(event.get('delta', ''))
                        report['timing'].setdefault(side + 'TranscriptMs', elapsed())
                        emit({'type': 'transcript', 'side': side, 'text': ''.join(texts[side]), 'atMs': elapsed()})
                    elif kind == 'session.delegation.created':
                        report['timing'].setdefault('delegationMs', elapsed())
                        emit({'type': 'delegation', 'id': event['delegation']['id'], 'target': event['delegation'].get('target'), 'atMs': elapsed()})
                    elif kind == 'session.closed':
                        report['finalUsage'] = event.get('usage'); report['closeReason'] = event.get('reason')
                        report['finalized'] = True; closed.set(); break
                    elif kind == 'session.usage.updated': report['latestUsage'] = event.get('usage')
                    elif kind == 'error':
                        # Codes/types only: server error text is unnecessary in credential-adjacent logs.
                        item = {'type': event.get('error', {}).get('type'), 'code': event.get('error', {}).get('code')}
                        report.setdefault('errors', []).append(item); emit({'type': 'api-error', **item})
                    elif kind == 'response.event':
                        report.setdefault('errors', []).append({'type': 'unexpected_backend_response'})
                        raise RuntimeError('Unexpected paid backend response event')
            async def commands():
                nonlocal result_at
                reader = asyncio.StreamReader(); protocol = asyncio.StreamReaderProtocol(reader)
                await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
                while line := await reader.readline():
                    command = json.loads(line)
                    if command.get('type') == 'result' and result_at is None:
                        result_at = elapsed(); report['timing']['renderedResultMs'] = result_at
                        await send({'type': 'session.commentary.append', 'event_id': 'verified_render_result',
                                    'delegation_id': command['id'], 'content': command['content']})
            receive = asyncio.create_task(receiver()); control = asyncio.create_task(commands()); tasks = [receive, control]
            await send({'type': 'session.start', 'event_id': 'acceptance_start', 'session': {
                'model': 'gpt-live-1', 'store': False,
                'instructions': 'You are an AI voice interface for a molecular viewer. Wait for speech. Delegate every molecular action to the client. Never claim a change before the client confirms rendering. After a verified result, say one short sentence confirming exactly that result. Do not greet or continue talking afterwards.',
                'audio': {'format': {'type': 'audio/pcm', 'rate': 24000}, 'output': {'voice': 'marin'}},
                'delegation': {'type': 'client'}}})
            try:
                await asyncio.wait_for(ready.wait(), 8)
                ticks = time.monotonic()
                for offset in range(0, 48000 * 30, 2400):
                    if receive.done() or elapsed() >= 30000: break
                    chunk = stream[offset:offset + 2400].ljust(2400, b'\0')
                    await send({'type': 'session.input_audio.append', 'audio': base64.b64encode(chunk).decode()})
                    if offset + 2400 >= len(stream): report['timing'].setdefault('inputFinishedMs', elapsed())
                    if result_at is not None and elapsed() - result_at >= 9000 and 'orange' in ''.join(texts['outputAfterResult']).lower(): break
                    await asyncio.sleep(max(0, ticks + (offset + 2400) / 48000 - time.monotonic()))
            finally:
                if not closed.is_set():
                    await send({'type': 'session.close'})
                    try: await asyncio.wait_for(closed.wait(), 5)
                    except asyncio.TimeoutError: report['finalized'] = False
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            if report.get('finalized') and counts['session.commentary.appended'] > 0 and result_at is not None and 'orange' in ''.join(texts['outputAfterResult']).lower() and not report.get('errors'):
                report['status'] = 'passed'
    except Exception as error:
        report['errorType'] = type(error).__name__
    finally:
        for task in tasks: task.cancel()
        report['wallMs'] = elapsed(); report['events'] = dict(counts)
        report['transcripts'] = {side: ''.join(values) for side, values in texts.items()}
        report['outputAudioSeconds'] = round(len(audio) / 48000, 3)
        usage = report.get('finalUsage') or report.get('latestUsage') or {}
        report['estimatedVoiceUsd'] = round(usage.get('seconds', 35) * .05 / 60, 6)
        report['backendApiUsd'] = 0
        if audio:
            with wave.open(str(out / 'live-output.wav'), 'wb') as target:
                target.setnchannels(1); target.setsampwidth(2); target.setframerate(24000); target.writeframes(audio)
        (out / 'live-api-report.json').write_text(json.dumps(report, indent=2) + '\n')
        emit({'type': 'finished', 'report': report})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--allow-paid-live1', action='store_true')
    parser.add_argument('--input', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not args.allow_paid_live1: parser.error('Explicit --allow-paid-live1 is required; one session <=35seconds, estimated <=$0.03.')
    asyncio.run(asyncio.wait_for(main(args), 43))
