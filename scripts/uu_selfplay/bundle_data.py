"""Bundle an admitted native pile and its audit without changing manifest bytes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import unicodedata
import zipfile

import filter_families


def check_names(names):
    reserved={'CON','PRN','AUX','NUL',*[f'{p}{i}' for p in ('COM','LPT') for i in range(1,10)]}
    if len({n.casefold() for n in names})!=len(names):raise ValueError('Duplicate archive path')
    for name in names:
        path=PurePosixPath(name)
        if (path.is_absolute() or '..' in path.parts or path.as_posix()!=name
                or any(c in name for c in '<>:"|?*\\')
                or any(unicodedata.category(c)=='Cc' for c in name)
                or any(p.endswith(('.',' ')) or p.split('.')[0].upper() in reserved for p in path.parts)):
            raise ValueError('Unsafe or nonportable archive path')


def bundle(data, panel, audit, out):
    if out.exists() or Path(str(out)+'.json').exists():raise FileExistsError(out)
    manifest=data/'manifest.json'
    payload=manifest.read_bytes();rows=json.loads(payload)
    indices=sorted({r['sourcePile'] for r in rows['kept']})
    proof=filter_families.validate_training_data(manifest,panel,[data/f'pile-{i}/UUKakuna/metamon' for i in indices])
    audit_bytes=audit.read_bytes();audited=json.loads(audit_bytes)
    if (audited.get('complete') is not True or audited.get('inputMismatchFiles')!=0
            or hashlib.sha256(payload).hexdigest()!=proof['manifestSha256']
            or audited['proof']['manifestSha256']!=proof['manifestSha256']
            or audited['proof']['panelSha256']!=proof['panelSha256']):
        raise ValueError('Complete matching input audit required')
    files={'data/manifest.json':(manifest,proof['manifestSha256']),
           'data/producer.py':(data/'producer.py',rows['producerSha256']),
           'panel.json':(panel,proof['panelSha256']),
           'input-audit.json':(audit,hashlib.sha256(audit_bytes).hexdigest()),
           'bundle-validator.py':(Path(filter_families.__file__),hashlib.sha256(Path(filter_families.__file__).read_bytes()).hexdigest()),
           'bundle-producer.py':(Path(__file__),hashlib.sha256(Path(__file__).read_bytes()).hexdigest())}
    for row in rows['kept']:
        name=f"pile-{row['sourcePile']}/UUKakuna/metamon/gen9uu/{row['file']}"
        files['data/'+name]=(data/name,row['sha256'])
        files['data/'+name+'.meta']=(data/(name+'.meta'),None)
    # Preflight every named file before opening the new archive. Do not traverse
    # raw runs, unadmitted trajectories or unrelated local files.
    check_names(list(files))
    for path,_ in files.values():
        if path.is_symlink() or not path.is_file():raise ValueError('Regular bundle input required')
    with zipfile.ZipFile(out,'x',zipfile.ZIP_STORED,allowZip64=True) as archive:
        for name,(path,expected) in files.items():
            content=path.read_bytes()
            if expected is not None and hashlib.sha256(content).hexdigest()!=expected:
                raise ValueError('Frozen bundle input changed')
            archive.writestr(name,content)
    with out.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    report={'complete':True,'archiveSha256':digest,'archiveBytes':out.stat().st_size,
            'entries':len(files),'trajectories':len(rows['kept']),'battles':rows['battles'],
            'manifestSha256':proof['manifestSha256'],'panelSha256':proof['panelSha256'],
            'inputAuditSha256':files['input-audit.json'][1],
            'producerSha256':files['bundle-producer.py'][1],
            'validatorSha256':files['bundle-validator.py'][1]}
    with Path(str(out)+'.json').open('x') as stream:json.dump(report,stream,indent=2)
    return report


def unpack(archive, receipt, out):
    if out.exists():raise FileExistsError(out)
    declared=json.loads(receipt.read_bytes())
    with archive.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    if (declared.get('complete') is not True or digest!=declared['archiveSha256']
            or archive.stat().st_size!=declared['archiveBytes']):
        raise ValueError('Transferred archive hash/size mismatch')
    with zipfile.ZipFile(archive) as z:
        names=z.namelist()
        if len(names)!=declared['entries']:raise ValueError('Archive entry count')
        check_names(names)
        out.mkdir()
        z.extractall(out)
    for name,key in [('data/manifest.json','manifestSha256'),('panel.json','panelSha256'),
                     ('input-audit.json','inputAuditSha256'),('bundle-producer.py','producerSha256'),
                     ('bundle-validator.py','validatorSha256')]:
        if hashlib.sha256((out/name).read_bytes()).hexdigest()!=declared[key]:
            raise ValueError('Materialized bundle proof mismatch')
    if hashlib.sha256(Path(filter_families.__file__).read_bytes()).hexdigest()!=declared['validatorSha256']:
        raise ValueError('Frozen bundle validator changed')
    manifest=out/'data/manifest.json';data=json.loads(manifest.read_bytes())
    indices=sorted({r['sourcePile'] for r in data['kept']})
    proof=filter_families.validate_training_data(manifest,out/'panel.json',
        [out/f'data/pile-{i}/UUKakuna/metamon' for i in indices])
    if (data['trajectories']!=declared['trajectories'] or data['battles']!=declared['battles']
            or sum(proof['verifiedPOVs'].values())!=declared['trajectories']):
        raise ValueError('Materialized trajectory count mismatch')
    report={'complete':True,'archiveSha256':digest,'proof':proof,
            'trajectories':declared['trajectories'],'battles':declared['battles'],
            'inputAuditSha256':declared['inputAuditSha256'],
            'unpackProducerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    with (out/'materialization.json').open('x') as stream:json.dump(report,stream,indent=2)
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    commands=p.add_subparsers(dest='action',required=True)
    pack=commands.add_parser('pack');extract=commands.add_parser('unpack')
    for name in ('data','panel','audit','out'):pack.add_argument('--'+name,required=True,type=Path)
    for name in ('archive','receipt','out'):extract.add_argument('--'+name,required=True,type=Path)
    a=p.parse_args()
    print(json.dumps(bundle(a.data,a.panel,a.audit,a.out) if a.action=='pack' else unpack(a.archive,a.receipt,a.out)))


if __name__=='__main__':main()
