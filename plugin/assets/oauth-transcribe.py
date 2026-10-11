#!/usr/bin/env python3
"""Transcribe one bounded PCM recording through the established Codex OAuth route."""
import asyncio
import base64
import importlib.util
import json
import os
import sys
from pathlib import Path

MODEL = 'gpt-realtime-2.1'
TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
SAMPLE_RATE = 24_000
MAX_BYTES = 576_000
AUTH_HELPER_ENV = 'STEREOFOLD_OAUTH_AUTH_HELPER'
AUTH_HELPER_CONFIG_KEY = 'oauthAuthHelper'
AUTH_HELPER_NAME = 'stereofold-oauth-auth.py'
MAX_CONFIG_BYTES = 64 * 1024

def auth_helper_path():
    named_config = os.environ.get('STEREOFOLD_CONFIG', '').strip()
    config_path = Path(named_config) if named_config else Path.home() / '.stereofold/config.json'
    config_name = str(config_path) if config_path.is_absolute() else '~/.stereofold/config.json'
    advice = (f'Set {AUTH_HELPER_ENV} to its absolute path, put {AUTH_HELPER_NAME} on PATH, '
              f'or add "{AUTH_HELPER_CONFIG_KEY}" to {config_name}.')
    named = os.environ.get(AUTH_HELPER_ENV, '').strip()
    if not named:
        if not config_path.is_absolute():
            raise RuntimeError(f'STEREOFOLD_CONFIG must be an absolute path. {advice}')
        try:
            with config_path.open('rb') as config_file:
                raw = config_file.read(MAX_CONFIG_BYTES + 1)
            settings = json.loads(raw) if len(raw) <= MAX_CONFIG_BYTES else {}
            configured = settings.get(AUTH_HELPER_CONFIG_KEY) if isinstance(settings, dict) else None
            named = configured.strip() if isinstance(configured, str) else ''
        except (OSError, ValueError):
            pass
    if named:
        path = Path(named)
        if not path.is_absolute():
            raise RuntimeError(f'The OAuth auth helper must be an absolute path. {advice}')
        if not path.is_file() or not os.access(path, os.R_OK):
            raise RuntimeError(f'The OAuth auth helper is not readable. {advice}')
        return path
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        if directory and Path(directory).is_absolute():
            candidate = Path(directory) / AUTH_HELPER_NAME
            if candidate.is_file() and os.access(candidate, os.R_OK):
                return candidate
    raise RuntimeError(f'Voice recognition is off: no OAuth auth helper was found. {advice}')

def oauth_secret():
    spec = importlib.util.spec_from_file_location('stereofold_voice_oauth', auth_helper_path())
    if not spec or not spec.loader:
        raise RuntimeError('The configured OAuth helper could not be loaded.')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Do not call the helper's API-key fallback. This route is OAuth only.
    return module.create_realtime_oauth_client_secret()

async def transcribe(pcm: bytes):
    secret = oauth_secret()
    import websockets
    async with websockets.connect(
        f'wss://api.openai.com/v1/realtime?model={MODEL}',
        additional_headers={'Authorization': 'Bearer ' + secret},
        open_timeout=20, close_timeout=5, max_size=1_000_000,
    ) as ws:
        del secret
        await ws.send(json.dumps({'type': 'session.update', 'session': {
            'type': 'realtime', 'model': MODEL, 'output_modalities': ['text'],
            'audio': {'input': {
                'format': {'type': 'audio/pcm', 'rate': SAMPLE_RATE},
                'transcription': {'model': TRANSCRIPTION_MODEL},
                'turn_detection': None,
            }},
        }}))
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if event.get('type') == 'error':
                raise RuntimeError(event.get('error', {}).get('message', 'OAuth voice setup failed'))
            if event.get('type') == 'session.updated':
                break
        await ws.send(json.dumps({'type': 'input_audio_buffer.append', 'audio': base64.b64encode(pcm).decode('ascii')}))
        await ws.send(json.dumps({'type': 'input_audio_buffer.commit'}))
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            if event.get('type') == 'error':
                raise RuntimeError(event.get('error', {}).get('message', 'OAuth transcription failed'))
            if event.get('type') == 'conversation.item.input_audio_transcription.completed':
                return event.get('transcript') or ''

def main():
    pcm = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(pcm) < 2 or len(pcm) > MAX_BYTES or len(pcm) % 2:
        raise RuntimeError('Expected bounded 24 kHz mono PCM16 audio on standard input.')
    transcript = asyncio.run(transcribe(pcm))
    if not isinstance(transcript, str) or len(transcript) > 2_000:
        raise RuntimeError('OAuth transcription returned invalid text.')
    # The parent process retains only the bounded result; no credentials or raw
    # audio are printed or persisted.
    print(json.dumps({'transcript': transcript}, separators=(',', ':')))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'OAuth transcription failed: {str(error)[:1000]}', file=sys.stderr)
        raise SystemExit(1)
