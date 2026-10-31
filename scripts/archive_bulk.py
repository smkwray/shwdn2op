"""Archive registered closed-run files; unlink only after both SHA256 checks."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import time


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    job_path = parser.parse_args().job
    job = json.loads(job_path.read_bytes())
    if job['schema'] != 'closed-bulk-archive@1':
        raise ValueError('Registered closed-run archive required')
    for path, digest in job['hashes'].items():
        if sha(path) != digest:
            raise ValueError('Archive authority/producer drift: ' + path)
    root = Path(job['root']).resolve()
    scopes = [root / name for name in job['scopes']]
    protected = {Path(p).resolve() for p in job['protectedPaths']}
    files = []
    for row in job['files']:
        path = root / row['path']
        if (path.is_symlink() or not path.resolve().is_relative_to(root)
                or not any(path.is_relative_to(scope) for scope in scopes) or path.resolve() in protected):
            raise ValueError('Unqualified archive path: ' + str(path))
        stat = path.stat()
        if stat.st_size != row['bytes'] or stat.st_mtime_ns != row['mtimeNs'] or stat.st_size <= 50 * 2**20:
            raise ValueError('Closed bulk changed: ' + str(path))
        files.append(path)
    out = Path(job['out'])
    out.mkdir(parents=True, exist_ok=False)
    report = dict(phase='ARCHIVING', jobSha256=sha(job_path), files=[], deletedBytes=0)

    def save():
        report['updatedUnix'] = time.time()
        temporary = out / 'status.tmp'
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(out / 'status.json')

    def remote(code):
        result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', job['destinationHost'],
                                 'python3'], input=code, capture_output=True, text=True,
                                check=True, timeout=180)
        return json.loads(result.stdout)

    save()
    try:
        for path, row in zip(files, job['files']):
            if time.time() >= job['stopByUnix']:
                raise TimeoutError('Archive boundary; verified prefix retained')
            digest = sha(path)
            destination = str(PurePosixPath(job['destinationRoot']) / row['path'])
            probe = remote('from pathlib import Path;import hashlib,json,shutil\n'
                           'p=Path(' + repr(destination) + ');p.parent.mkdir(parents=True,exist_ok=True)\n'
                           'u=shutil.disk_usage(p.parent)\n'
                           'print(json.dumps({"sha256":hashlib.file_digest(p.open("rb"),"sha256").hexdigest() if p.exists() else None,'
                           '"freeBytes":u.free,"totalBytes":u.total}))')
            if probe['sha256'] not in (None, digest):
                raise ValueError('Archive destination collision: ' + destination)
            existing = job.get('deduplicateObjects', {}).get(digest)
            if probe['sha256'] is None and existing:
                proof = remote('from pathlib import Path;import hashlib,json,os\n'
                               'source=Path(' + repr(existing) + ');target=Path(' + repr(destination) + ')\n'
                               'digest=hashlib.file_digest(source.open("rb"),"sha256").hexdigest()\n'
                               'assert digest==' + repr(digest) + ' and source.stat().st_size==' + str(row['bytes']) + '\n'
                               'assert not target.exists();os.link(source,target)\n'
                               'actual=hashlib.file_digest(target.open("rb"),"sha256").hexdigest()\n'
                               'assert actual==digest\nprint(json.dumps({"sha256":actual}))')
                if proof['sha256'] != digest:
                    raise ValueError('Deduplicated destination verification mismatch')
                probe['sha256'] = digest
            if probe['sha256'] is None:
                if (probe['freeBytes'] - row['bytes']) / probe['totalBytes'] <= .15:
                    raise RuntimeError('Archive destination would fall below fifteen percent free')
                temporary = destination + '.part'
                remote('from pathlib import Path;import json\np=Path(' + repr(temporary) + ')\n'
                       'assert not p.exists(),"Unknown partial transfer retained"\nprint("{}")')
                subprocess.run(['scp', '-q', str(path), job['destinationHost'] + ':' + temporary],
                               check=True, timeout=1800)
                proof = remote('from pathlib import Path;import hashlib,json\np=Path(' + repr(temporary) + ')\n'
                               'digest=hashlib.file_digest(p.open("rb"),"sha256").hexdigest()\n'
                               'assert digest==' + repr(digest) + '\n'
                               'target=Path(' + repr(destination) + ');assert not target.exists();p.rename(target)\n'
                               'print(json.dumps({"sha256":digest}))')
                if proof['sha256'] != digest:
                    raise ValueError('Archive verification mismatch')
            if sha(path) != digest:
                raise ValueError('Source changed during archive; source retained')
            entry = dict(path=row['path'], bytes=row['bytes'], sourceSha256=digest,
                         destination=destination, destinationSha256=digest, deleted=False)
            report['files'].append(entry)
            save()  # Retain both-side verification before unlinking the source.
            path.unlink()
            entry['deleted'] = True
            report['deletedBytes'] += row['bytes']
            for scope in scopes:
                if path.is_relative_to(scope):
                    (scope / 'ARCHIVED.txt').write_text('Verified large files archived to '
                        + job['destinationHost'] + ':' + str(PurePosixPath(job['destinationRoot']) / scope.relative_to(root).as_posix())
                        + '\nPer-file SHA256 and deletion receipts: ' + str(out / 'status.json') + '\nSmall records retained.\n')
            save()
        report['phase'] = 'COMPLETED'
    except BaseException as error:
        report.update(phase='FAILED_OR_UNKNOWN_RETAINED', error=repr(error))
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
