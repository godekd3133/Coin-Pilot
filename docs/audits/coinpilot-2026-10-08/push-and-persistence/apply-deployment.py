import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile
import urllib.request
from datetime import datetime, timezone

stage = Path('/tmp/coinpilot-push-persistence-20261008')
backup = Path('/root/coinpilot-backups/20261008-push-persistence')
rows = json.loads((stage / 'manifest.json').read_text())
profiles = {
    'live': {'release': Path('/opt/coinpilot-live/current'), 'env': Path('/etc/coinpilot/coinpilot-live.env'),
             'port': 3101, 'mode': 'LIVE', 'state': Path('/var/lib/coinpilot-live')},
    'paper': {'release': Path('/opt/coinpilot/app'), 'env': Path('/etc/coinpilot.env'),
              'port': 3000, 'mode': 'DRY_RUN', 'state': Path('/var/lib/coinpilot/paper')}
}

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def values(text):
    return {k.strip(): v.strip().strip('"').strip("'")
            for k, v in (line.split('=', 1) for line in text.splitlines()
                         if '=' in line and not line.lstrip().startswith('#'))}

def status(profile):
    env = values(profile['env'].read_text())
    token = env.get('DASHBOARD_MOBILE_TOKEN') or env.get('DASHBOARD_TOKEN')
    request = urllib.request.Request(f"http://127.0.0.1:{profile['port']}/api/system-status",
                                    headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    assert body['mode'] == profile['mode']
    assert isinstance(body.get('isRunning'), bool)
    assert isinstance(body.get('currentPositions'), int)
    return body

def atomic(file, content, uid=None, gid=None, mode=0o600):
    if file.exists():
        stat = file.stat()
        uid, gid, mode = stat.st_uid, stat.st_gid, stat.st_mode & 0o777
    fd, temporary = tempfile.mkstemp(prefix='.coinpilot-deploy-', dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            if uid is not None: os.fchown(stream.fileno(), uid, gid)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        descriptor = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

assert not backup.exists(), 'Inspect the existing backup before repeating deployment'
for row in rows:
    original = profiles[row['profile']]['release'] / row['path']
    if row['originalSha256']:
        assert digest(original) == row['originalSha256'], 'Source drift: ' + str(original)
    else:
        assert not original.exists(), 'Unexpected pre-existing file: ' + str(original)
    assert digest(stage / row['profile'] / row['path']) == row['newSha256']
    subprocess.run(['/usr/bin/node', '--check', str(stage / row['profile'] / row['path'])], check=True)
before = {name: status(profile) for name, profile in profiles.items()}
backup.mkdir(mode=0o700, parents=True)
for row in rows:
    if row['originalSha256']:
        target = backup / row['profile'] / row['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(profiles[row['profile']]['release'] / row['path'], target)
for name, profile in profiles.items():
    shutil.copy2(profile['env'], backup / f'{name}.env')

ubuntu = pwd.getpwnam('ubuntu')
key_dir = Path('/etc/coinpilot-apns')
key_dir.mkdir(mode=0o750, exist_ok=True)
os.chown(key_dir, 0, ubuntu.pw_gid)
key = key_dir / 'provider.p8'
assert not key.exists(), 'Inspect existing APNs credentials instead of overwriting them'
atomic(key, (stage / 'provider-key.p8').read_bytes(), uid=0, gid=ubuntu.pw_gid, mode=0o640)

applied = []
try:
    for row in rows:
        profile = profiles[row['profile']]
        destination = profile['release'] / row['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        atomic(destination, (stage / row['profile'] / row['path']).read_bytes(), uid=ubuntu.pw_uid, gid=ubuntu.pw_gid)
        applied.append(row)
    for name, profile in profiles.items():
        directory = profile['state']
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(directory, ubuntu.pw_uid, ubuntu.pw_gid)
        intent = directory / 'automation_intent.json'
        flags = {'AUTO_RECOVERY_STATE_FILE': str(intent), 'ORDER_PUSH_STATE_FILE': str(directory / 'orders-push.json'),
                 'APNS_KEY_FILE': str(key), 'APNS_KEY_ID': 'V74C27LFMA', 'APNS_TEAM_ID': 'A23ZPKGMW9',
                 'APNS_TOPIC': 'com.godekd3133.coinpilot'}
        # Read the old process again immediately before migration, rather than
        # assuming yesterday's or the pre-deployment snapshot is still current.
        observed = status(profile)
        desired = observed['isRunning'] or observed.get('stopReason') in {
            'risk_data_gap', 'analysis_data_gap', 'exchange_state_unverified'}
        if not intent.exists():
            record = {'version': 1, 'desiredRunning': desired,
                      'updatedAt': datetime.now(timezone.utc).isoformat(), 'source': 'existing_runtime_migration'}
            atomic(intent, (json.dumps(record) + '\n').encode(), uid=ubuntu.pw_uid, gid=ubuntu.pw_gid)
        else:
            record = json.loads(intent.read_text())
            assert isinstance(record.get('desiredRunning'), bool)
        before[name]['savedDesiredRunning'] = record['desiredRunning']
        lines = [line for line in profile['env'].read_text().splitlines()
                 if not any(line.startswith(k + '=') for k in flags)]
        lines += [f'{k}={v}' for k, v in flags.items()]
        atomic(profile['env'], ('\n'.join(lines) + '\n').encode())
    for row in rows:
        assert digest(profiles[row['profile']]['release'] / row['path']) == row['newSha256']
except BaseException:
    for row in applied:
        destination = profiles[row['profile']]['release'] / row['path']
        if row['originalSha256']:
            atomic(destination, (backup / row['profile'] / row['path']).read_bytes())
        elif destination.exists(): destination.unlink()
    for name, profile in profiles.items():
        atomic(profile['env'], (backup / f'{name}.env').read_bytes())
    raise
print(json.dumps({'applied': True, 'backup': str(backup), 'profiles': {
    name: {k: body.get(k) for k in ['mode', 'isRunning', 'currentPositions', 'stopReason', 'savedDesiredRunning']}
    for name, body in before.items()}, 'files': len(rows)}, ensure_ascii=False))
