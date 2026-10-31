"""Training metrics of a fine-tune run, recorded locally by finetune.sh's METRICS=offline (amago --log, W&B offline).
Usage: train_metrics.py CKPT_RUN_DIR > metrics.jsonl     (CKPT_RUN_DIR = RUN/checkpoints/NAME)
Prints one JSON object per amago log call (keys like train-update/Actor Loss, plus amago's x-axis metrics), read from
CKPT_RUN_DIR/wandb_logs/wandb/offline-run-*/run-*.wandb with W&B's own protobuf. That file is W&B's LevelDB-log framing
(header ':W&B' 0xBEE1 v0, 32 KiB blocks, records 'crc32 length type' with crc32 over type+data); any other header,
a bad checksum, or a run dir without exactly one offline run is an error."""
import json, pathlib, struct, sys, zlib
from wandb.proto import wandb_internal_pb2 as pb

BLOCK, HEAD = 32768, 7


def records(data):
    if data[:HEAD] != b":W&B" + struct.pack("<HB", 0xBEE1, 0):
        raise SystemExit(f"unknown W&B log header {data[:HEAD]!r}")
    pos, part = HEAD, None
    while pos + HEAD <= len(data):
        if BLOCK - pos % BLOCK < HEAD:  # block trailer padding
            pos += BLOCK - pos % BLOCK
            continue
        crc, n, kind = struct.unpack_from("<IHB", data, pos)
        body = data[pos + HEAD:pos + HEAD + n]
        if kind == 0 and n == 0:  # zero-filled tail of a block
            pos += BLOCK - pos % BLOCK
            continue
        if len(body) != n or zlib.crc32(body, zlib.crc32(bytes([kind]))) & 0xFFFFFFFF != crc:
            raise SystemExit(f"bad W&B record at byte {pos}")
        pos += HEAD + n
        if kind == 1:
            yield body
        elif kind == 2:
            part = body
        elif kind == 3:
            part += body
        elif kind == 4:
            yield part + body
            part = None
        else:
            raise SystemExit(f"unknown W&B record type {kind} at byte {pos}")


runs = sorted(pathlib.Path(sys.argv[1]).glob("wandb_logs/wandb/offline-run-*/run-*.wandb"))
if len(runs) != 1:
    raise SystemExit(f"expected one offline W&B run under {sys.argv[1]}/wandb_logs, found {len(runs)}")
rows = 0
for raw in records(runs[0].read_bytes()):
    rec = pb.Record()
    rec.ParseFromString(raw)
    if rec.WhichOneof("record_type") == "history":
        row = {("/".join(i.nested_key) if i.nested_key else i.key): json.loads(i.value_json) for i in rec.history.item}
        print(json.dumps(row))
        rows += 1
if not rows:
    raise SystemExit(f"no history rows in {runs[0]}")
