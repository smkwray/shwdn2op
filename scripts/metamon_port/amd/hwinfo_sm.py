"""Read HWiNFO64 shared memory (Global\\HWiNFO_SENS_SM2). Usage: hwinfo_sm.py list | sample SECONDS INTERVAL LABEL_REGEX..."""
import ctypes, ctypes.wintypes as wt, re, struct, sys, time, json
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenFileMappingW.restype = wt.HANDLE; k32.OpenFileMappingW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
k32.MapViewOfFile.restype = ctypes.c_void_p; k32.MapViewOfFile.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_size_t]
FILE_MAP_READ = 4
def snapshot():
    h = k32.OpenFileMappingW(FILE_MAP_READ, False, "Global\\HWiNFO_SENS_SM2")
    if not h: raise SystemExit(f"open failed: winerror {ctypes.get_last_error()}")
    base = k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
    hdr = ctypes.string_at(base, 44)
    sig, ver, rev, poll, s_off, s_size, s_num, r_off, r_size, r_num = struct.unpack("<IIIqIIIIII", hdr)
    sensors = [ctypes.string_at(base + s_off + i * s_size, 8 + 256)[8:136].split(b"\0")[0].decode("latin1") for i in range(s_num)]
    out = []
    for i in range(r_num):
        b = ctypes.string_at(base + r_off + i * r_size, 316)
        t, si, rid = struct.unpack("<III", b[:12])
        label = b[12:140].split(b"\0")[0].decode("latin1"); unit = b[268:284].split(b"\0")[0].decode("latin1")
        val = struct.unpack("<d", b[284:292])[0]
        out.append((sensors[si] if si < len(sensors) else "?", label, unit, val))
    k32.UnmapViewOfFile(ctypes.c_void_p(base)); k32.CloseHandle(h)
    return sig, poll, out
if sys.argv[1] == "list":
    sig, poll, rows = snapshot()
    print("signature", hex(sig), "poll", poll, "readings", len(rows))
    for s, l, u, v in rows:
        if u in ("W",) or "Power" in l: print(f"{s} | {l} | {v:.2f} {u}")
else:
    secs, step, pats = float(sys.argv[2]), float(sys.argv[3]), [re.compile(p) for p in sys.argv[4:]]
    t0 = time.time(); samples = []
    while time.time() - t0 < secs:
        _, poll, rows = snapshot()
        samples.append({"t": round(time.time() - t0, 2), **{f"{s}|{l}": v for s, l, u, v in rows if any(p.search(f"{s}|{l}") for p in pats)}})
        time.sleep(step)
    keys = sorted({k for x in samples for k in x if k != "t"})
    print(json.dumps({"n": len(samples), "mean": {k: round(sum(x[k] for x in samples if k in x) / max(1, sum(k in x for x in samples)), 2) for k in keys},
                      "min": {k: round(min(x[k] for x in samples if k in x), 2) for k in keys}, "max": {k: round(max(x[k] for x in samples if k in x), 2) for k in keys}}))
