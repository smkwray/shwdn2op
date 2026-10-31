"""Freeze a progress panel from public train families, without opening test teams.

The complement is the ONLY team set allowed in new flywheel training collection.
Existing piles have seen these families and are benchmark-only until filtered.
"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(pool, out, count=24):
    manifest = json.loads((pool/"manifest.json").read_text())
    families = manifest["families"]
    forbidden = {f["sha256"] for f in families if f["split"] in ("dev","held-out")}
    train = [f for f in families if f["split"]=="train"]
    if len({f["sha256"] for f in train})!=len(train) or any(f["sha256"] in forbidden for f in train):
        raise ValueError("Family split overlap")
    if not 3<=count<len(train):
        raise ValueError("Progress count must leave training families")
    train.sort(key=lambda f:hashlib.sha256(("uu-flywheel-progress-v1:"+f["sha256"]).encode()).hexdigest())
    panel = {"schema":"uu-progress-panel@1","poolManifestSha256":digest(pool/"manifest.json"),
             "selection":"first N train families in salted SHA256 order, before outcomes",
             "certification":False,"progress":[],"collection":[],"excludedCertificationFamilies":sorted(forbidden)}
    for i,family in enumerate(train):
        path = (pool/family["representative"]).resolve()
        if not path.is_relative_to((pool/"teams/uu_train_v1").resolve()):
            raise ValueError("Only public train team files may be read")
        record = {"family":family["sha256"],"key":family["key"],
                  "source":family["representative"],"sha256":digest(path)}
        panel["progress" if i<count else "collection"].append(record)
    out.mkdir(parents=True,exist_ok=False)
    (out/"panel.json").write_text(json.dumps(panel,indent=2)+"\n")
    return panel


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pool",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--count",type=int,default=24)
    a = p.parse_args()
    panel = prepare(a.pool,a.out,a.count)
    print(json.dumps({k:len(panel[k]) for k in ("progress","collection","excludedCertificationFamilies")}))
