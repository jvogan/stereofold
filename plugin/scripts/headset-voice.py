#!/usr/bin/env python3
"""Active-agent access to a standalone Stereofold voice queue; no idle task wakeup."""
import argparse
import json
import time
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('action', choices=['state', 'listen', 'say'])
    parser.add_argument('--seconds', type=int, default=45)
    parser.add_argument('--panel')
    parser.add_argument('--text-file', type=Path)
    args = parser.parse_args()
    if not args.control.is_absolute() or args.control.is_symlink():
        parser.error('Use the absolute private control file printed by the host.')
    if args.control.stat().st_mode & 0o077:
        parser.error('The control file must be private to its owner (mode 0600).')
    if not 1 <= args.seconds <= 55:
        parser.error('Listen duration must be 1–55 seconds.')
    control = json.loads(args.control.read_text())
    origin = urlsplit(control['origin'])
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        parser.error('This helper only calls the local standalone host.')

    def call(name, payload):
        request = urllib.request.Request(control['origin'] + '/agent',
            data=json.dumps({'name': name, 'arguments': payload}).encode(),
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + control['token']})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    def state():
        return call('get_inspection_state', {})['structuredContent']

    def binding(value, panel):
        return dict(sessionId=value['sessionId'], serverEpoch=value['serverEpoch'], sourceToken=value['sourceToken'],
                    baseStateRevision=value['stateRevision'], baseInspectionRevision=value['inspectionRevision'], panelId=panel)

    if args.action == 'state':
        value = state()
        print(json.dumps({'voice': value.get('voice'), 'panels': value.get('panels')}))
        return
    if args.action == 'say':
        if not args.panel or not args.text_file:
            parser.error('say requires --panel and --text-file.')
        message = args.text_file.read_text().strip()
        if not message or len(message) > 180 or '\n' in message:
            parser.error('A spoken reply must be one line of 1–180 characters.')
        value = state()
        result = call('speak_to_headset', {**binding(value, args.panel), 'message': message})
        print(json.dumps(result.get('structuredContent', result)))
        return
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline:
        value = state()
        if value.get('voice', {}).get('pendingIntents', 0):
            panel = next((p for p in value.get('panels', []) if p['surface'] == 'desktop'
                          and p['current'] and p['availability'] == 'ready'), None)
            if panel:
                result = call('claim_voice_intent', binding(value, panel['panelId']))
                claim = result.get('_meta', {}).get('stereo_structure/inspection', {}).get('voiceIntent')
                if claim:
                    # The tool output is the intentional delivery to the active
                    # agent. No audio or credential is printed or written.
                    print(json.dumps({'spokenRequest': claim['intent']}, ensure_ascii=False), flush=True)
                    call('acknowledge_voice_intent', {**binding(state(), panel['panelId']),
                        'intentId': claim['intent']['id'], 'claimToken': claim['claimToken']})
                    return
        time.sleep(1)
    print(json.dumps({'waiting': True, 'message': 'No spoken request arrived during this active listen window.'}))


if __name__ == '__main__':
    main()
