"""Convert a hash-bound collection-team archive into the native TeamSet layout."""
import argparse
import hashlib
import json
from pathlib import Path,PurePosixPath
import sys
import zipfile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive",required=True,type=Path)
    p.add_argument("--panel",required=True,type=Path)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a = p.parse_args()
    panel_bytes = a.panel.read_bytes();panel = json.loads(panel_bytes)
    if panel["schema"]!="uu-progress-panel@1" or panel["certification"] is not False:
        raise ValueError("Collection/progress panel required")
    expected = {r["family"]:r["sha256"] for r in panel["collection"]}
    forbidden = {r["family"] for r in panel["progress"]}|set(panel["excludedCertificationFamilies"])
    if len(expected)!=len(panel["collection"]) or len(expected)<2 or set(expected)&forbidden:
        raise ValueError("Collection-family identity overlap")
    sys.path.insert(0,str(a.source))
    from metamon.backend.team_prediction.team_index import team_file_suffix
    from metamon.env.wrappers import TeamSet
    with zipfile.ZipFile(a.archive) as z:
        manifests = [n for n in z.namelist() if n.endswith("/manifest.json")]
        if len(manifests)!=1:raise ValueError("Exactly one team archive manifest required")
        name = manifests[0];prefix = str(PurePosixPath(name).parent)
        manifest = json.loads(z.read(name))
        if manifest["panelSha256"]!=hashlib.sha256(panel_bytes).hexdigest() or manifest["purpose"]!="collection only":
            raise ValueError("Archive panel or purpose drift")
        rows = manifest["files"]
        if manifest["families"]!=len(rows) or {r["family"] for r in rows}!=set(expected) or len(rows)!=len(expected):
            raise ValueError("Missing, duplicate or unknown collection family")
        if set(z.namelist())!={name,*(prefix+"/"+r["file"] for r in rows)}:
            raise ValueError("Unexpected archive content")
        payloads = []
        for r in rows:
            if not all(c in "0123456789abcdef" for c in r["family"]) or len(r["family"])!=64:
                raise ValueError("Portable family hash required")
            data = z.read(prefix+"/"+r["file"])
            if hashlib.sha256(data).hexdigest()!=expected[r["family"]] or r["sha256"]!=expected[r["family"]]:
                raise ValueError("Team payload hash mismatch")
            payloads.append((r,data))
    a.out.mkdir(parents=True,exist_ok=False)
    directory = a.out/"gen9uu";directory.mkdir()
    written = []
    for r,data in payloads:
        path = directory/(r["family"]+team_file_suffix("gen9uu"))
        with path.open("xb") as stream:stream.write(data)
        written.append({**r,"sourceFile":r["file"],"file":str(path.relative_to(a.out))})
    native = TeamSet(str(a.out),"gen9uu")
    if len(native.team_files)!=len(expected) or {Path(f).resolve() for f in native.team_files}!={directory.joinpath(r["family"]+team_file_suffix("gen9uu")).resolve() for r in rows}:
        raise ValueError("Native sampler did not load every selected team")
    producer = Path(__file__).read_bytes();(a.out/"producer.py").write_bytes(producer)
    with a.archive.open("rb") as stream:archive_sha = hashlib.file_digest(stream,"sha256").hexdigest()
    report = {"panelSha256":hashlib.sha256(panel_bytes).hexdigest(),"archiveSha256":archive_sha,
        "producerSha256":hashlib.sha256(producer).hexdigest(),"purpose":"collection only",
        "families":len(expected),"nativeTeamsLoaded":len(native.team_files),"files":written}
    (a.out/"manifest.json").write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!="files"}),flush=True)


if __name__ == "__main__":main()
