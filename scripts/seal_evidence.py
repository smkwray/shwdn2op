"""Seal evidence: zip spec files/trees into tmp/<name>.zip, copy to the eval host, verify every entry there, write receipts.
Usage: python3 scripts/seal_evidence.py SPEC.json  (keys: name, files[{source,path}], trees[], classification,
scope, parents, optional remoteDir). The archive includes this producer and the spec. Host and remote project come
from the device-local eval runtime, config/local/uu-eval-runtime.json."""
import datetime, hashlib, json, os, pathlib, shlex, subprocess, sys, zipfile

os.umask(0o077)
spec_path = pathlib.Path(sys.argv[1])
spec = json.loads(spec_path.read_text())
ROOT = pathlib.Path(__file__).resolve().parents[1]
runtime = json.loads((ROOT / 'config/local/uu-eval-runtime.json').read_text())
archive = ROOT / 'tmp' / (spec['name'] + '.zip')
assert spec['name'].replace('-', '').isalnum()
files = {}
for item in spec['files']:
    source = pathlib.Path(item['source'])
    assert source.is_file() and not source.is_symlink(), str(source)
    assert item['path'] not in files
    files[item['path']] = source
for source_path in spec.get('trees', []):
    source = pathlib.Path(source_path)
    for item in source.rglob('*'):
        if item.is_file() and not item.is_symlink():
            arc = source.name + '/' + str(item.relative_to(source))
            assert arc not in files
            files[arc] = item
files['sealing-producer.py'] = pathlib.Path(__file__)
files['sealing-input.json'] = spec_path
entries = []
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
    for name, source in sorted(files.items()):
        assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
        before = source.stat()
        data = source.read_bytes()
        after = source.stat()
        assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), str(source)
        output.writestr(name, data)
        entries.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    manifest = {key: spec[key] for key in ['classification', 'scope', 'parents']}
    manifest['entries'] = entries
    output.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
sha = hashlib.sha256(archive.read_bytes()).hexdigest()
# Eval-host copy: spec 'remoteDir' (default the eval host project's tmp/) + name; verified there, receipt beside it.
remote = spec.get('remoteDir', runtime['project'] + '/tmp') + '/' + spec['name']
ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ProxyJump=none', '-o', 'ConnectTimeout=10', runtime['host']]
subprocess.run(ssh + [shlex.join(['mkdir', '-m', '700', remote])], check=True, timeout=30)
subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ProxyJump=none', str(archive), runtime['host'] + ':' + remote + '/evidence.zip'], check=True, timeout=60)
verify = """import hashlib,json,pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1]);sha=sys.argv[2]
assert hashlib.sha256(p.read_bytes()).hexdigest()==sha
with zipfile.ZipFile(p) as z:
 m=json.loads(z.read('manifest.json'))
 for e in m['entries']:assert hashlib.sha256(z.read(e['path'])).hexdigest()==e['sha256']
p.chmod(0o600)
r={k:m[k]for k in ['classification','scope','parents']};r.update({'archive':str(p),'archiveSha256':sha,'archiveBytes':p.stat().st_size,'verifiedEntries':len(m['entries'])})
p.with_name('receipt.json').write_text(json.dumps(r,indent=2)+'\\n');print(json.dumps(r))
"""
result = subprocess.run(ssh + [shlex.join(['/usr/bin/python3', '-c', verify, remote + '/evidence.zip', sha])], check=True, capture_output=True, text=True, timeout=60)
receipt = {'archive': str(archive), 'sha256': sha, 'remote': remote, 'remoteReceipt': json.loads(result.stdout)}
archive.with_suffix('.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
