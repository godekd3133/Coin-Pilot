import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

release = Path('/opt/coinpilot-live/current')
stage = Path('/tmp/coinpilot-performance-option-20261008')
env_file = Path('/etc/coinpilot/coinpilot-live.env')
backup = Path('/root/coinpilot-backups/20261008-performance-option')
manifest = json.loads((stage / 'manifest.json').read_text())
env_text = env_file.read_text()
values = {}
for line in env_text.splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
assert values.get('DASHBOARD_START_TRADER_ON_BOOT') == 'false', 'Boot must remain stopped'
token = values.get('DASHBOARD_MOBILE_TOKEN') or values.get('DASHBOARD_TOKEN')
assert token, 'Authenticated preflight token unavailable'
req = urllib.request.Request('http://127.0.0.1:3101/api/system-status',
                             headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(req, timeout=15) as response:
    status = json.load(response)
assert status.get('mode') == 'LIVE'
assert status.get('isRunning') is False
assert status.get('runtimeState') == 'STOPPED'
assert status.get('currentPositions') == 0
assert status.get('exchangeStateKnown') is True

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

for row in manifest:
    assert digest(release / row['path']) == row['originalSha256'], 'Production source changed: ' + row['path']
    assert digest(stage / row['path']) == row['newSha256'], 'Staged source mismatch: ' + row['path']
    subprocess.run(['/usr/bin/node', '--check', str(stage / row['path'])], check=True)
assert not backup.exists(), 'Backup already exists; inspect before repeating'
backup.mkdir(parents=True, mode=0o700)
for row in manifest:
    target = backup / row['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(release / row['path'], target)
shutil.copy2(env_file, backup / 'coinpilot-live.env')

def replace_preserving_metadata(destination, data):
    stat = destination.stat()
    fd, name = tempfile.mkstemp(prefix='.performance-option-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), stat.st_mode & 0o777)
            os.fchown(stream.fileno(), stat.st_uid, stat.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)

lines = env_text.splitlines()
lines = [line for line in lines if not line.startswith('SCALP_REQUIRE_VALIDATION_PASS=')]
lines.append('SCALP_REQUIRE_VALIDATION_PASS=false')
try:
    for row in manifest:
        replace_preserving_metadata(release / row['path'], (stage / row['path']).read_bytes())
    replace_preserving_metadata(env_file, ('\n'.join(lines) + '\n').encode())
    for row in manifest:
        assert digest(release / row['path']) == row['newSha256']
        subprocess.run(['/usr/bin/node', '--check', str(release / row['path'])], check=True)
except BaseException:
    for row in manifest:
        replace_preserving_metadata(release / row['path'], (backup / row['path']).read_bytes())
    replace_preserving_metadata(env_file, (backup / 'coinpilot-live.env').read_bytes())
    raise
print(json.dumps({'applied': True, 'backup': str(backup), 'files': manifest,
                  'performanceValidationRequired': False, 'tradingStartRequested': False}))
