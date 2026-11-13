"""Read quota metadata, never run model prompts. agy manages its own session."""
import concurrent.futures
import json
import math
import re
import selectors
import shutil
import signal
import tempfile
import os
from pathlib import Path
import subprocess
import time
import sys
import urllib.error
import urllib.request


def window(label, used, reset):
    if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used) or not 0 <= used <= 100:
        return None
    return {'label': label, 'used': used, 'reset': reset}


def get_json(url, headers):
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=12) as response:
        return json.load(response)


def codex():
    auth = json.loads((Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex'))) / 'auth.json').read_text())
    tokens = auth.get('tokens') or {}
    if not tokens.get('access_token'):
        return {'name': 'Codex', 'error': 'No subscription session'}
    headers = {'Authorization': 'Bearer ' + tokens['access_token']}
    if tokens.get('account_id'):
        headers['ChatGPT-Account-Id'] = tokens['account_id']
    data = get_json('https://chatgpt.com/backend-api/wham/usage', headers)
    rows = []
    groups = [('', data.get('rate_limit') or {})]
    for extra in data.get('additional_rate_limits') or []:
        groups.append((extra.get('limit_name') or extra.get('metered_feature') or 'Model', extra.get('rate_limit') or {}))
    for prefix, group in groups:
        for key in ('primary_window', 'secondary_window'):
            item = group.get(key)
            if not item:
                continue
            seconds = item.get('limit_window_seconds')
            label = {18000: '5 hours', 604800: '7 days', 2592000: '30 days'}.get(seconds, f'{seconds//3600} hours' if isinstance(seconds, int) else 'Limit')
            rows.append(window((prefix + ' · ' if prefix else '') + label, item.get('used_percent'), item.get('reset_at')))
    return {'name': 'Codex', 'windows': [r for r in rows if r]}


def claude():
    folder = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home()/'.claude')))
    path = folder/'.credentials.json'
    if path.exists():
        auth = json.loads(path.read_text())
    elif 'CLAUDE_CONFIG_DIR' not in os.environ:
        result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'], capture_output=True, text=True, timeout=5)
        if result.returncode:
            return {'name': 'Claude', 'error': 'Cannot access credentials'}
        auth = json.loads(result.stdout)
    else:
        return {'name': 'Claude', 'error': 'Not signed in to this profile'}
    token = (auth.get('claudeAiOauth') or {}).get('accessToken')
    if not token:
        return {'name': 'Claude', 'error': 'Sign in to Claude Code'}
    data = get_json('https://api.anthropic.com/api/oauth/usage', {'Authorization': 'Bearer '+token, 'anthropic-beta': 'oauth-2025-04-20'})
    labels = {'five_hour': '5 hours', 'seven_day': '7 days', 'seven_day_sonnet': 'Sonnet · 7 days', 'seven_day_opus': 'Opus · 7 days'}
    rows = [window(label, data[key].get('utilization'), data[key].get('resets_at')) for key, label in labels.items() if isinstance(data.get(key), dict)]
    return {'name': 'Claude', 'windows': [r for r in rows if r]}


def post_json(url, headers, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={**headers, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def fraction_window(label, remaining, reset):
    if isinstance(remaining, bool) or not isinstance(remaining, (int, float)) or not math.isfinite(remaining) or not 0 <= remaining <= 1:
        return None
    return window(label, round((1 - remaining) * 100, 4), reset)


def gemini_windows(data):
    rows = {}
    for bucket in data.get('buckets') or []:
        if not isinstance(bucket, dict) or not isinstance(bucket.get('modelId'), str):
            continue
        model = bucket['modelId']
        row = fraction_window(model, bucket.get('remainingFraction'), bucket.get('resetTime'))
        if row and (model not in rows or row['used'] > rows[model]['used']):
            rows[model] = row
    return list(rows.values())


def gemini():
    # Gemini CLI 0.66 uses GEMINI_CLI_HOME as a home override, then adds .gemini.
    folder = Path(os.environ.get('GEMINI_CLI_HOME', str(Path.home()))) / '.gemini'
    settings = json.loads((folder / 'settings.json').read_text())
    auth_type = settings.get('security', {}).get('auth', {}).get('selectedType')
    if auth_type != 'oauth-personal':
        return {'name': 'Gemini', 'error': 'Usage requires a Gemini CLI Google login'}
    auth = json.loads((folder / 'oauth_creds.json').read_text())
    token = auth.get('access_token')
    if not token:
        return {'name': 'Gemini', 'error': 'Sign in to Gemini CLI'}
    if isinstance(auth.get('expiry_date'), (int, float)) and auth['expiry_date'] <= time.time() * 1000:
        return {'name': 'Gemini', 'error': 'Open Gemini CLI to renew your session'}
    headers = {'Authorization': 'Bearer ' + token}
    base = 'https://cloudcode-pa.googleapis.com/v1internal:'
    project = os.environ.get('GOOGLE_CLOUD_PROJECT') or os.environ.get('GOOGLE_CLOUD_PROJECT_ID')
    body = {'metadata': {'ideType': 'IDE_UNSPECIFIED', 'platform': 'PLATFORM_UNSPECIFIED', 'pluginType': 'GEMINI'}}
    if project:
        body['cloudaicompanionProject'] = project
        body['metadata']['duetProject'] = project
    setup = post_json(base + 'loadCodeAssist', headers, body)
    project = setup.get('cloudaicompanionProject') or project
    if not isinstance(project, str) or not project:
        return {'name': 'Gemini', 'error': 'Quota unavailable for this Gemini CLI account'}
    data = post_json(base + 'retrieveUserQuota', headers, {'project': project})
    return {'name': 'Gemini', 'windows': gemini_windows(data)}


def antigravity_binary():
    override = os.environ.get('ANTIGRAVITY_CLI_PATH')
    candidates = [override] if override is not None else [
        shutil.which('agy'), '/Applications/Antigravity.app/Contents/Helpers/agy',
        '/Applications/Gemini.app/Contents/Helpers/agy',
        str(Path.home() / 'Applications/Antigravity.app/Contents/Helpers/agy'),
        str(Path.home() / 'Applications/Gemini.app/Contents/Helpers/agy')]
    return next((p for p in candidates if p and Path(p).is_file() and os.access(p, os.X_OK)), None)


def antigravity_windows(report):
    command = report.get('command') or {}
    if report.get('status') != 'SUCCESS' or command.get('name') != 'usage':
        return []
    rows = []
    for group in (command.get('data') or {}).get('groups') or []:
        label = group.get('display_name') or group.get('displayName') or group.get('name') or 'Quota'
        for bucket in group.get('buckets') or []:
            if bucket.get('disabled'):
                continue
            remaining = bucket.get('remaining_fraction', bucket.get('remainingFraction'))
            if remaining is None and isinstance(bucket.get('remaining'), dict):
                value = bucket['remaining']
                remaining = value.get('remaining_fraction', value.get('remainingFraction'))
                if remaining is None and value.get('case') in ('remainingFraction', 'remaining_fraction'):
                    remaining = value.get('value')
            name = bucket.get('display_name') or bucket.get('displayName') or bucket.get('name') or bucket.get('bucket_id') or bucket.get('bucketId')
            if not name:
                continue
            row = fraction_window(f'{label} · {name}', remaining, bucket.get('reset_time', bucket.get('resetTime')))
            if row:
                rows.append(row)
    return rows


def bounded_command(args, env, cwd, seconds):
    # Only the private probe's group is cleaned up; existing agy sessions stay intact.
    process = subprocess.Popen(args, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    chunks, size = [], 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + seconds
            while selector.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError('Usage timed out')
                for key, _ in selector.select(min(left, 0.5)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(chunk)
                    if size > 1024 * 1024:
                        raise ValueError('Usage output too large')
                    chunks.append(chunk)
            code = process.wait(timeout=max(.1, deadline - time.monotonic()))
            if code:
                raise ValueError('Usage command failed')
        return b''.join(chunks).decode('utf-8')
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)
        process.stdout.close()


def antigravity():
    binary = antigravity_binary()
    if not binary:
        return {'name': 'Antigravity', 'error': 'Install the agy CLI to read usage'}
    if os.name != 'posix':
        return {'name': 'Antigravity', 'error': 'Usage requires macOS or Linux'}
    with tempfile.TemporaryDirectory(prefix='herdr-usage-') as folder:
        env = {**os.environ, 'AGY_CLI_DISABLE_AUTO_UPDATE': 'true'}
        # A passive refresh must not open an OAuth browser when login has expired.
        for name in ('open', 'xdg-open', 'browser'):
            launcher = Path(folder) / name
            launcher.write_text('#!/bin/sh\nexit 1\n')
            launcher.chmod(0o700)
        env['PATH'] = folder + os.pathsep + env.get('PATH', '')
        env['BROWSER'] = str(Path(folder) / 'browser')
        version = bounded_command([binary, '--version'], env, folder, 3)
        match = re.search(r'(\d+)\.(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (1, 1, 11):
            return {'name': 'Antigravity', 'error': 'Update agy to version 1.1.11 or later'}
        report = bounded_command([binary, '-p', '/usage', '--output-format', 'json',
                                  '--print-timeout', '15s', '--log-file', str(Path(folder) / 'probe.log')],
                                 env, folder, 16)
        return {'name': 'Antigravity', 'windows': antigravity_windows(json.loads(report))}


def read(provider):
    name, fn = provider
    try:
        result = fn()
        if not result.get('windows') and not result.get('error'):
            result['error'] = 'No usage data'
        return result
    except urllib.error.HTTPError as e:
        return {'name': name, 'error': 'Sign in again in the CLI' if e.code in (401, 403) else 'Too many requests — try again later' if e.code == 429 else f'Usage unavailable (HTTP {e.code})'}
    except (TimeoutError, subprocess.TimeoutExpired):
        return {'name': name, 'error': 'Usage timed out — open the CLI and sign in'}
    except FileNotFoundError:
        return {'name': name, 'error': 'Not signed in to the CLI'}
    except Exception:
        return {'name': name, 'error': 'Usage unavailable'}


if __name__ == '__main__':
    selected = set(sys.argv[1:])
    if '--discover' in selected:
        print(json.dumps({'providers': ['Antigravity'] if antigravity_binary() else []}))
    else:
        readers = [('Codex', codex), ('Claude', claude), ('Gemini', gemini), ('Antigravity', antigravity)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            providers = list(pool.map(read, [(name, fn) for name, fn in readers if name in selected]))
        print(json.dumps({'checkedAt': time.time(), 'providers': providers}, ensure_ascii=False))
