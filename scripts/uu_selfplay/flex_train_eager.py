"""Let amago's flex-attention TRAINING call run uncompiled (eager) when AMAGO_FLEX_TRAIN_EAGER=1.

On GB10 with torch 2.11, compiled flex attention BACKWARD returns wrong gradients at some sequence lengths
(max grad error 311 at L=100 and 420 at L=127, under several block configs; correct at 64/96/120/128), while
the forward and the eager path are correct at every length tested (grad error <= 2.8e-5); see
`prep/flex_probe.py`. Kakuna trains on L <= 128, so the eager math path is cheap. Inference (self-play,
live) is untouched; unset = upstream. Apply after flex_train_kernel.py. Usage: flex_train_eager.py RUN_SOURCE_DIR
"""
import hashlib, pathlib, sys
p = pathlib.Path(sys.argv[1]) / "amago/nets/transformer.py"; s = p.read_text()
old = "            out = self.flex_attention(q, k, v, self.score_mod, mask)\n"
assert s.count(old) == 1, "training flex call site not found"
s = s.replace(old, "            # shwdn2op: eager training path (see kit flex_train_eager.py).\n"
                   "            out = (flex_attention(q, k, v, self.score_mod, mask) if _FLEX_TRAIN_EAGER\n"
                   "                   else self.flex_attention(q, k, v, self.score_mod, mask))\n")
anchor = '_FLEX_TRAIN_KERNEL_OPTIONS = _json.loads(_os.environ.get("AMAGO_FLEX_TRAIN_KERNEL_OPTIONS", "null"))\n'
assert s.count(anchor) == 1, "apply flex_train_kernel.py first"
s = s.replace(anchor, anchor + '_FLEX_TRAIN_EAGER = _os.environ.get("AMAGO_FLEX_TRAIN_EAGER") == "1"\n')
p.write_text(s, newline="\n"); print("amago/nets/transformer.py", hashlib.sha256(s.encode()).hexdigest())
