"""Let amago's flex-attention TRAINING call take kernel_options from AMAGO_FLEX_TRAIN_KERNEL_OPTIONS (JSON).

GPUs with less than about 180 KB of shared memory per block (GB10 and consumer Blackwell: 101,376 B) cannot
compile the default flex backward kernel at Kakuna's head dim (75, padded to 128). `{"num_stages": 1}` fits and
matches a masked-attention reference (out 8e-7, grad 1.9e-5). The inference call (self-play, live) is untouched;
unset = upstream behavior. Usage: flex_train_kernel.py RUN_SOURCE_DIR
"""
import hashlib, pathlib, sys
p = pathlib.Path(sys.argv[1]) / "amago/nets/transformer.py"; s = p.read_text()
old = "    @torch.compile\n    def flex_attention(self, q, k, v, score_mod, block_mask):\n        return flex_attention(q, k, v, score_mod, block_mask)\n"
assert s.count(old) == 1, "training flex call not found (already patched?)"
s = s.replace(old, "    @torch.compile\n    def flex_attention(self, q, k, v, score_mod, block_mask):\n"
                   "        # shwdn2op: optional kernel_options for small-shared-memory GPUs (see kit flex_train_kernel.py).\n"
                   "        return flex_attention(q, k, v, score_mod, block_mask, kernel_options=_FLEX_TRAIN_KERNEL_OPTIONS)\n")
anchor = "class FlexAttention(SelfAttention):"
assert s.count(anchor) == 1
s = s.replace(anchor, 'import json as _json, os as _os\n_FLEX_TRAIN_KERNEL_OPTIONS = _json.loads(_os.environ.get("AMAGO_FLEX_TRAIN_KERNEL_OPTIONS", "null"))\n\n\n' + anchor)
p.write_text(s, newline="\n"); print("amago/nets/transformer.py", hashlib.sha256(s.encode()).hexdigest())
