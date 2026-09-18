#!/usr/bin/env python3
"""Aggregate one dispatch's ATT traces into the bottleneck report the analysis panel renders.

The timeline view answers "what did this wave do at cycle N". This answers "where did the
dispatch spend its cycles", which needs every shader engine's trace summed and every stall
attributed to a reason a reader can act on -- a memory wait, a barrier, an MFMA dependency --
rather than to the instruction category the decoder reports.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import att_asm_checks
from att_decode_ctypes import DecodedWave, decode_att_waves

CAT_NAMES = {
    0: "NONE",
    1: "SMEM",
    2: "SALU",
    3: "VMEM",
    4: "FLAT",
    5: "LDS",
    6: "VALU",
    7: "JUMP",
    8: "NEXT",
    9: "IMMED",
    10: "CONTEXT",
    11: "MESSAGE",
    12: "BVH",
}

# Stall reasons, in the order the report lists them. The key is what the code emits; the
# value is the reader-facing label and the class of fix it points at.
REASONS = {
    "wait_vmem": ("Waiting for VMEM data", "memory"),
    "wait_lds": ("Waiting for LDS/scalar data", "memory"),
    "wait_mixed": ("Waiting on several counters", "memory"),
    "wait_other": ("Waiting on other counters", "memory"),
    "barrier": ("Barrier / workgroup sync", "sync"),
    "mfma": ("MFMA issue or dependency", "compute"),
    "vmem_issue": ("VMEM issue backpressure", "memory"),
    "lds_issue": ("LDS issue / bank conflicts", "memory"),
    "smem_issue": ("SMEM issue", "memory"),
    "valu": ("VALU dependency or issue", "compute"),
    "salu": ("SALU dependency or issue", "compute"),
    "branch": ("Branch", "control"),
    "sleep": ("Sleep / priority", "other"),
    "other": ("Other", "other"),
}

_VMEM_PREFIX = ("buffer_", "global_", "flat_", "scratch_", "image_", "tbuffer_", "tensor_")
_MFMA_PREFIX = ("v_mfma", "v_smfmac", "v_wmma")
_VM_COUNTERS = ("vmcnt", "vscnt", "loadcnt", "storecnt", "bvhcnt", "samplecnt")
_LGKM_COUNTERS = ("lgkmcnt", "dscnt", "kmcnt")


def mnemonic(asm: str) -> str:
    a = (asm or "").strip()
    if not a:
        return ""
    return a.split(None, 1)[0]


def classify_stall(asm: str, category: int) -> str:
    """Name the reason a wave sat stalled at this instruction.

    ATT charges a wave's stall cycles to the instruction it was about to issue, so the
    mnemonic is the reason: an `s_waitcnt vmcnt(0)` holding 400 cycles is global-memory
    latency, the same 400 on a `ds_read` is LDS issue pressure. Only fall back to the
    decoder's category when the mnemonic says nothing.
    """
    m = mnemonic(asm).lower()
    if m.startswith("s_waitcnt") or m.startswith("s_wait_"):
        text = (asm or "").lower()
        vm = any(c in text for c in _VM_COUNTERS)
        lgkm = any(c in text for c in _LGKM_COUNTERS)
        if vm and lgkm:
            return "wait_mixed"
        if vm:
            return "wait_vmem"
        if lgkm:
            return "wait_lds"
        return "wait_other"
    if m.startswith("s_barrier"):
        return "barrier"
    if m.startswith("s_sleep") or m.startswith("s_setprio"):
        return "sleep"
    if m.startswith(_MFMA_PREFIX):
        return "mfma"
    if m.startswith("ds_"):
        return "lds_issue"
    if m.startswith(_VMEM_PREFIX):
        return "vmem_issue"
    if m.startswith("s_load") or m.startswith("s_buffer_load"):
        return "smem_issue"
    if m.startswith("v_"):
        return "valu"
    if m.startswith("s_cbranch") or m.startswith("s_branch") or m.startswith("s_endpgm"):
        return "branch"
    if m.startswith("s_"):
        return "salu"
    cat = CAT_NAMES.get(category, "NONE")
    return {
        "VMEM": "vmem_issue",
        "FLAT": "vmem_issue",
        "LDS": "lds_issue",
        "SMEM": "smem_issue",
        "VALU": "valu",
        "SALU": "salu",
        "JUMP": "branch",
    }.get(cat, "other")


def is_mfma(asm: str) -> bool:
    return mnemonic(asm).lower().startswith(_MFMA_PREFIX)


def category_of(asm: str, category: int) -> str:
    cat = CAT_NAMES.get(category, "NONE")
    return "MFMA" if cat == "VALU" and is_mfma(asm) else cat


_POS_RE = re.compile(r"^(.+?):(\d+)(?::\d+)?$")


_CO_ID_RE = re.compile(r"code_object_id_(\d+)\.out$")
_ATT_RE = re.compile(r"^(.*?)_(\d+)_shader_engine_(\d+)_(\d+)\.att$")


def parse_att_name(p: Path) -> Optional[Tuple[str, int, int, int]]:
    """Split `pe_27048_shader_engine_0_24.att` into (prefix, agent, shader engine, dispatch)."""
    m = _ATT_RE.match(p.name)
    if not m:
        return None
    return m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))


def sibling_att_files(att: Path) -> List[Path]:
    """Every shader engine's trace for the dispatch `att` belongs to."""
    parsed = parse_att_name(att)
    if not parsed:
        return [att]
    prefix, agent, _se, dispatch = parsed
    found = [
        p
        for p in sorted(att.parent.glob("*.att"))
        if (q := parse_att_name(p)) and q[0] == prefix and q[1] == agent and q[3] == dispatch
    ]
    return found or [att]


def read_codeobj_table(results_db: Optional[Path]) -> List[Tuple[int, int, int]]:
    if not results_db or not results_db.exists() or results_db.stat().st_size == 0:
        return []
    con = sqlite3.connect(str(results_db))
    cur = con.cursor()
    cur.execute(
        "select name from sqlite_master where type='table' "
        "and name like 'rocpd_info_code_object_%' limit 1"
    )
    row = cur.fetchone()
    if not row:
        con.close()
        return []
    cur.execute(f"select id, load_base, load_size from {row[0]} order by id")
    rows = [(int(a), int(b), int(c)) for (a, b, c) in cur.fetchall()]
    con.close()
    return rows


def find_code_objects(codeobj_dir: Path, results_db: Optional[Path]) -> List[Tuple[int, int, int, Path]]:
    by_id: Dict[int, Path] = {}
    for p in sorted(codeobj_dir.glob("*code_object_id_*.out")):
        m = _CO_ID_RE.search(p.name)
        if m:
            by_id[int(m.group(1))] = p
    rows = read_codeobj_table(results_db)
    if rows:
        out = [(cid, base, size, by_id[cid]) for (cid, base, size) in rows if cid in by_id]
        if out:
            return out
    return [(cid, 0, p.stat().st_size, p) for cid, p in sorted(by_id.items())]


def find_stats_csv(att: Path) -> Optional[Path]:
    parsed = parse_att_name(att)
    if parsed:
        _prefix, agent, _se, dispatch = parsed
        exact = att.parent / f"stats_ui_output_agent_{agent}_dispatch_{dispatch}.csv"
        if exact.exists():
            return exact
    cands = sorted(att.parent.glob("stats_ui_output_*.csv"))
    return cands[0] if len(cands) == 1 else None


def read_stats_csv(path: Path, top: int) -> Optional[dict]:
    """Summarize rocprof's own per-instruction stats table, when the capture wrote one.

    It covers the whole dispatch rather than the traced waves, so it is the cross-check on
    the decoded numbers, not a substitute for them.
    """
    rows = []
    with path.open(newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            try:
                hits = int(r.get("Hitcount") or 0)
                latency = int(r.get("Latency") or 0)
                stall = int(r.get("Stall") or 0)
                idle = int(r.get("Idle") or 0)
            except ValueError:
                continue
            asm = (r.get("Instruction") or "").strip()
            if asm.startswith(";"):
                continue
            src = (r.get("Source") or "").strip()
            m = _POS_RE.match(src)
            rows.append(
                {
                    "codeobj": int(r.get("CodeObj") or 0),
                    "pc": int(r.get("Vaddr") or 0),
                    "asm": asm,
                    "hits": hits,
                    "latency": latency,
                    "stall": stall,
                    "idle": idle,
                    "file": m.group(1) if m else "",
                    "line": int(m.group(2)) if m else 0,
                }
            )
    if not rows:
        return None
    by_line: Dict[Tuple[str, int], dict] = {}
    for r in rows:
        if not r["file"]:
            continue
        key = (r["file"], r["line"])
        acc = by_line.setdefault(
            key, {"file": r["file"], "line": r["line"], "hits": 0, "latency": 0, "stall": 0, "idle": 0}
        )
        for k in ("hits", "latency", "stall", "idle"):
            acc[k] += r[k]
    totals = {k: sum(r[k] for r in rows) for k in ("hits", "latency", "stall", "idle")}
    return {
        "path": str(path),
        "totals": totals,
        "by_inst": sorted(rows, key=lambda r: -r["latency"])[:top],
        "by_line": sorted(by_line.values(), key=lambda r: -r["latency"])[:top],
    }


class Accumulator:
    """Sums one dispatch's decoded waves into the report's tables."""

    def __init__(self, buckets: int) -> None:
        self.buckets = buckets
        self.waves: List[dict] = []
        self.reason_cycles: Counter = Counter()
        self.reason_insts: Counter = Counter()
        self.cat_insts: Counter = Counter()
        self.cat_stall: Counter = Counter()
        self.cat_exec: Counter = Counter()
        self.mnem: Dict[str, dict] = {}
        self.by_pc: Dict[Tuple[int, int], dict] = {}
        self.per_se: Dict[int, dict] = {}
        self.timeline: Dict[str, List[int]] = {}
        self.issue_hist: List[int] = [0] * buckets
        self.occupancy: Dict[int, List[int]] = {}
        self.wave_spans: Dict[int, List[Tuple[int, int]]] = {}
        self.life = 0
        self.exec_cycles = 0
        self.stall_cycles = 0
        self.instructions = 0
        self.t_min = 0
        self.t_max = 0

    def bucket_of(self, t: int) -> int:
        span = max(1, self.t_max - self.t_min)
        b = ((t - self.t_min) * self.buckets) // span
        return min(self.buckets - 1, max(0, b))

    def finish_occupancy(self) -> None:
        """Turn the wave lifetimes into waves-in-flight per bucket.

        Counting every wave whose lifetime touches a bucket overcounts: at 1200 cycles a
        bucket, waves that ran one after the other inside one bucket both get counted, which
        put the peak above what the register file can even host. Sweeping begin/end events
        gives the real concurrency, and each bucket reports the highest it reached.
        """
        for se, spans in self.wave_spans.items():
            series = [0] * self.buckets
            events = sorted(
                [(b, 1) for (b, _e) in spans] + [(e, -1) for (_b, e) in spans],
                key=lambda t: (t[0], -t[1]),
            )
            live = 0
            prev = self.t_min
            for (t, delta) in events:
                if live and t > prev:
                    for b in range(self.bucket_of(prev), self.bucket_of(min(t, self.t_max)) + 1):
                        series[b] = max(series[b], live)
                live += delta
                prev = t
            self.occupancy[se] = series

    def add_reason_bucket(self, reason: str, t: int, cycles: int) -> None:
        series = self.timeline.get(reason)
        if series is None:
            series = [0] * self.buckets
            self.timeline[reason] = series
        series[self.bucket_of(t)] += cycles


def analyze(
    att_files: List[Path],
    codeobjs: List[Tuple[int, int, int, Path]],
    decoder_lib_path: Path,
    rocprofiler_sdk: Path,
    llvm_objdump: Path,
    llvm_readelf: Path,
    buckets: int,
    top: int,
) -> dict:
    listings: Dict[int, List[att_asm_checks.Insn]] = {}
    dis: Dict[int, Dict[int, Tuple[str, str, int]]] = {}
    for (cid, _base, _size, p) in codeobjs:
        try:
            listings[cid] = att_asm_checks.disasm_listing(p, llvm_objdump)
        except Exception:
            listings[cid] = []
        dis[cid] = {i.addr: (i.asm, i.file, i.line) for i in listings[cid]}

    decoded: List[Tuple[int, List[DecodedWave]]] = []
    gfxip = 0
    for att in att_files:
        parsed = parse_att_name(att)
        se = parsed[2] if parsed else len(decoded)
        g, waves = decode_att_waves(att, codeobjs, decoder_lib_path, rocprofiler_sdk)
        gfxip = g or gfxip
        decoded.append((se, waves))

    acc = Accumulator(buckets)
    all_waves = [w for _se, ws in decoded for w in ws]
    if not all_waves:
        raise RuntimeError("no waves decoded from " + ", ".join(p.name for p in att_files))
    acc.t_min = min(w.begin for w in all_waves)
    acc.t_max = max(w.end for w in all_waves)

    for se, waves in decoded:
        se_acc = acc.per_se.setdefault(
            se,
            {
                "se": se,
                "waves": 0,
                "instructions": 0,
                "life": 0,
                "stall": 0,
                "exec": 0,
                "begin": min(w.begin for w in waves) if waves else 0,
                "end": max(w.end for w in waves) if waves else 0,
                "cus": [],
            },
        )
        spans = acc.wave_spans.setdefault(se, [])
        cus = set()
        for w in waves:
            life = max(0, w.end - w.begin)
            w_stall = 0
            w_exec = 0
            for i in w.insts:
                asm, file, line = dis.get(i.marker_id, {}).get(i.pc, ("", "", 0))
                reason = classify_stall(asm, i.category)
                cat = category_of(asm, i.category)
                mn = mnemonic(asm) or f"cat:{cat}"
                exec_cycles = max(0, i.duration - i.stall)
                w_stall += i.stall
                w_exec += exec_cycles

                acc.reason_cycles[reason] += i.stall
                acc.reason_insts[reason] += 1
                acc.cat_insts[cat] += 1
                acc.cat_stall[cat] += i.stall
                acc.cat_exec[cat] += exec_cycles
                if i.stall:
                    acc.add_reason_bucket(reason, i.issue, i.stall)
                acc.issue_hist[acc.bucket_of(i.issue)] += 1

                m = acc.mnem.get(mn)
                if m is None:
                    m = acc.mnem[mn] = {"mnem": mn, "cat": cat, "insts": 0, "stall": 0, "exec": 0}
                m["insts"] += 1
                m["stall"] += i.stall
                m["exec"] += exec_cycles

                key = (i.marker_id, i.pc)
                h = acc.by_pc.get(key)
                if h is None:
                    h = acc.by_pc[key] = {
                        "codeobj": i.marker_id,
                        "pc": i.pc,
                        "asm": asm,
                        "file": file,
                        "line": line,
                        "cat": cat,
                        "reason": reason,
                        "hits": 0,
                        "stall": 0,
                        "exec": 0,
                        "max_stall": 0,
                    }
                h["hits"] += 1
                h["stall"] += i.stall
                h["exec"] += exec_cycles
                h["max_stall"] = max(h["max_stall"], i.stall)

            spans.append((w.begin, w.end))
            cus.add(w.cu)
            acc.waves.append(
                {
                    "se": se,
                    "cu": w.cu,
                    "simd": w.simd,
                    "slot": w.slot,
                    "begin": w.begin,
                    "end": w.end,
                    "life": life,
                    "instructions": len(w.insts),
                    "stall": w_stall,
                    "exec": w_exec,
                }
            )
            acc.life += life
            acc.stall_cycles += w_stall
            acc.exec_cycles += w_exec
            acc.instructions += len(w.insts)
            se_acc["waves"] += 1
            se_acc["instructions"] += len(w.insts)
            se_acc["life"] += life
            se_acc["stall"] += w_stall
            se_acc["exec"] += w_exec
        se_acc["cus"] = sorted(cus)

    acc.finish_occupancy()
    life = max(1, acc.life)
    idle = max(0, acc.life - acc.exec_cycles - acc.stall_cycles)

    reasons = [
        {
            "key": k,
            "label": REASONS.get(k, (k, "other"))[0],
            "kind": REASONS.get(k, (k, "other"))[1],
            "cycles": c,
            "pct": 100.0 * c / life,
            "insts": acc.reason_insts[k],
        }
        for k, c in acc.reason_cycles.most_common()
        if c > 0
    ]
    categories = [
        {
            "cat": c,
            "insts": n,
            "stall": acc.cat_stall[c],
            "exec": acc.cat_exec[c],
            "pct": 100.0 * (acc.cat_stall[c] + acc.cat_exec[c]) / life,
        }
        for c, n in acc.cat_insts.most_common()
    ]
    mnems = sorted(acc.mnem.values(), key=lambda m: -(m["stall"] + m["exec"]))[:top]

    hot_inst = sorted(acc.by_pc.values(), key=lambda h: -h["stall"])[:top]
    by_line: Dict[Tuple[str, int], dict] = {}
    for h in acc.by_pc.values():
        if not h["file"]:
            continue
        key = (h["file"], h["line"])
        acc_line = by_line.get(key)
        if acc_line is None:
            acc_line = by_line[key] = {
                "file": h["file"],
                "line": h["line"],
                "stall": 0,
                "exec": 0,
                "hits": 0,
                "pcs": 0,
                "reasons": Counter(),
            }
        acc_line["stall"] += h["stall"]
        acc_line["exec"] += h["exec"]
        acc_line["hits"] += h["hits"]
        acc_line["pcs"] += 1
        acc_line["reasons"][h["reason"]] += h["stall"]
    hot_lines = []
    for r in sorted(by_line.values(), key=lambda r: -r["stall"])[:top]:
        mix = r["reasons"].most_common(3)
        hot_lines.append(
            {
                "file": r["file"],
                "line": r["line"],
                "stall": r["stall"],
                "exec": r["exec"],
                "hits": r["hits"],
                "pcs": r["pcs"],
                "pct": 100.0 * r["stall"] / life,
                "reason": mix[0][0] if mix else "other",
                "mix": [{"key": k, "cycles": c} for k, c in mix if c > 0],
            }
        )

    per_se = sorted(acc.per_se.values(), key=lambda s: s["se"])
    for s in per_se:
        s["stall_pct"] = 100.0 * s["stall"] / max(1, s["life"])
        s["span"] = max(0, s["end"] - s["begin"])

    waves_sorted = sorted(acc.waves, key=lambda w: w["life"])
    span = max(1, acc.t_max - acc.t_min)
    report = {
        "meta": {
            "gfxip_major": gfxip,
            "att_files": [str(p) for p in att_files],
            "codeobj_files": {str(cid): str(p) for (cid, _b, _s, p) in codeobjs},
            "generated": int(time.time()),
        },
        "totals": {
            "shader_engines": len(per_se),
            "waves": len(acc.waves),
            "instructions": acc.instructions,
            "span": span,
            "t_min": acc.t_min,
            "t_max": acc.t_max,
            "life": acc.life,
            "exec": acc.exec_cycles,
            "stall": acc.stall_cycles,
            "idle": idle,
            "stall_pct": 100.0 * acc.stall_cycles / life,
            "exec_pct": 100.0 * acc.exec_cycles / life,
            "idle_pct": 100.0 * idle / life,
            "ipc_per_wave": acc.instructions / max(1, acc.life),
            "cycles_per_inst": acc.life / max(1, acc.instructions),
        },
        "reasons": reasons,
        "categories": categories,
        "mnemonics": mnems,
        "hot_inst": hot_inst,
        "hot_lines": hot_lines,
        "per_se": per_se,
        "waves": acc.waves,
        "wave_life": {
            "min": waves_sorted[0]["life"],
            "p50": waves_sorted[len(waves_sorted) // 2]["life"],
            "max": waves_sorted[-1]["life"],
        },
        "timeline": {
            "buckets": buckets,
            "t_min": acc.t_min,
            "t_max": acc.t_max,
            "cycles_per_bucket": span / buckets,
            "issue": acc.issue_hist,
            "stall": {k: v for k, v in sorted(acc.timeline.items(), key=lambda kv: -sum(kv[1]))},
            "occupancy": {str(se): v for se, v in sorted(acc.occupancy.items())},
        },
        "reason_labels": {k: {"label": v[0], "kind": v[1]} for k, v in REASONS.items()},
    }
    report["asm"] = review_machine_code(acc, codeobjs, listings, llvm_readelf, life)
    report["phases"] = split_phases(acc, report["asm"], listings, life)
    report["findings"] = build_findings(report)
    return report


_GFX_RE = re.compile(r"(gfx\d+[a-z]?)", re.IGNORECASE)


def review_machine_code(
    acc: "Accumulator",
    codeobjs: List[Tuple[int, int, int, Path]],
    listings: Dict[int, List[att_asm_checks.Insn]],
    llvm_readelf: Path,
    life: int,
) -> Optional[dict]:
    """Run the static checks against the code object the trace actually spent its time in."""
    by_codeobj: Counter = Counter()
    for h in acc.by_pc.values():
        by_codeobj[h["codeobj"]] += h["stall"] + h["exec"]
    if not by_codeobj:
        return None
    cid = by_codeobj.most_common(1)[0][0]
    listing = listings.get(cid) or []
    if not listing:
        return None
    path = next((p for (c, _b, _s, p) in codeobjs if c == cid), None)

    stats = {
        h["pc"]: att_asm_checks.Stat(hits=h["hits"], stall=h["stall"], exec=h["exec"])
        for h in acc.by_pc.values()
        if h["codeobj"] == cid
    }
    hottest = max(stats.items(), key=lambda kv: kv[1].stall, default=None)
    symbol = ""
    if hottest:
        symbol = next((i.sym for i in listing if i.addr == hottest[0]), "")

    meta = {}
    if path:
        kernels = att_asm_checks.kernel_metadata(path, llvm_readelf)
        meta = next((k for k in kernels if k.get("name") == symbol), {})
        if not meta and len(kernels) == 1:
            meta = kernels[0]
    gfx = ""
    if path:
        m = _GFX_RE.search(path.name)
        gfx = m.group(1).lower() if m else ""

    peak = 0
    for series in acc.occupancy.values():
        peak = max(peak, max(series) if series else 0)

    out = att_asm_checks.analyze(
        listing=listing,
        stats=stats,
        meta=meta,
        gfx=gfx,
        life=life,
        waves=len(acc.waves),
        peak_waves_per_cu=peak,
    )
    out["codeobj"] = cid
    out["codeobj_path"] = str(path) if path else ""
    out["symbol"] = symbol
    out["gfx"] = gfx
    return out


PHASE_NAMES = ("prologue", "mainline", "epilogue")


def split_phases(acc: "Accumulator", asm: Optional[dict],
                 listings: Dict[int, List[att_asm_checks.Insn]], life: int) -> Optional[dict]:
    """Cut the traced code into setup, steady state and drain at the hot loop's edges.

    The loop the trace actually spun in is the only boundary the hardware agrees on. A symbol
    table and the source structure both describe the kernel the compiler was given; after
    inlining, unrolling and scheduling, neither says where the emitted code stops preparing
    and starts iterating.
    """
    loop = (asm or {}).get("loop") or {}
    begin, end = loop.get("begin"), loop.get("end")
    if begin is None or end is None:
        return None
    cid = asm.get("codeobj")

    acc_phase = {
        p: {"insts": 0, "hits": 0, "stall": 0, "exec": 0, "lo": None, "hi": None,
            "reasons": Counter(), "sites": []}
        for p in PHASE_NAMES
    }
    for h in acc.by_pc.values():
        if h["codeobj"] != cid:
            continue
        pc = h["pc"]
        name = "mainline" if begin <= pc <= end else ("prologue" if pc < begin else "epilogue")
        b = acc_phase[name]
        b["insts"] += 1
        b["hits"] += h["hits"]
        b["stall"] += h["stall"]
        b["exec"] += h["exec"]
        b["lo"] = pc if b["lo"] is None else min(b["lo"], pc)
        b["hi"] = pc if b["hi"] is None else max(b["hi"], pc)
        b["reasons"][h["reason"]] += h["stall"]
        b["sites"].append(h)

    phases = []
    for name in PHASE_NAMES:
        b = acc_phase[name]
        cycles = b["stall"] + b["exec"]
        phases.append({
            "name": name,
            "lo": b["lo"],
            "hi": b["hi"],
            "insts": b["insts"],
            "hits": b["hits"],
            "stall": b["stall"],
            "exec": b["exec"],
            "cycles": cycles,
            "pct": 100.0 * cycles / life if life else 0.0,
            "reasons": [
                {"key": k, "label": REASONS.get(k, (k, ""))[0], "cycles": v,
                 "pct": 100.0 * v / b["stall"] if b["stall"] else 0.0}
                for k, v in b["reasons"].most_common(4) if v
            ],
            "top": [
                {"pc": h["pc"], "asm": h["asm"], "hits": h["hits"], "stall": h["stall"],
                 "exec": h["exec"], "file": h["file"], "line": h["line"]}
                for h in sorted(b["sites"], key=lambda x: -x["stall"])[:6]
            ],
        })

    static = {i.addr: i for i in (listings.get(cid) or [])}
    ordered = sorted(static)

    def divider(pc: int) -> dict:
        """The instruction a phase starts on, and the one that falls through into it."""
        i = ordered.index(pc) if pc in static else -1
        prev = static[ordered[i - 1]] if i > 0 else None
        here = static.get(pc)
        return {
            "addr": pc,
            "asm": here.asm if here else "",
            "file": here.file if here else "",
            "line": here.line if here else 0,
            "prev_addr": prev.addr if prev else None,
            "prev_asm": prev.asm if prev else "",
        }

    return {
        "phases": phases,
        "dividers": [
            {"before": "prologue", "after": "mainline", **divider(begin)},
            {"before": "mainline", "after": "epilogue",
             **divider(next((a for a in ordered if a > end), end))},
        ],
        "iterations": loop.get("iterations"),
        "cycles_per_iter": loop.get("cycles_per_iter"),
    }


def build_findings(report: dict) -> List[dict]:
    """Turn the aggregates into ranked, quantified statements about what limits the kernel.

    Every finding names the measurement behind it; none of them guess at a fix the numbers
    do not support.
    """
    t = report["totals"]
    life = max(1, t["life"])
    findings: List[dict] = []
    reasons = {r["key"]: r for r in report["reasons"]}

    def pct(key: str) -> float:
        return reasons[key]["pct"] if key in reasons else 0.0

    mem_wait = pct("wait_vmem") + pct("wait_mixed")
    lds_wait = pct("wait_lds")
    barrier = pct("barrier")
    mfma = pct("mfma")
    vmem_issue = pct("vmem_issue")
    lds_issue = pct("lds_issue")

    if mem_wait >= 10:
        findings.append(
            {
                "severity": "high" if mem_wait >= 25 else "medium",
                "title": f"Global-memory latency dominates: {mem_wait:.1f}% of wave time",
                "detail": (
                    "Waves sit on `s_waitcnt` for VMEM counters. Either the loads are not issued "
                    "far enough ahead of their use, or there are not enough waves in flight to "
                    "cover the latency."
                ),
                # Both reasons, to match the percentage in the title: a wait on several
                # counters at once is still the memory wait the title is about.
                "metric": (
                    f"{reasons.get('wait_vmem', {}).get('cycles', 0) + reasons.get('wait_mixed', {}).get('cycles', 0):,}"
                    " cycles on VMEM waits"
                ),
            }
        )
    if lds_wait >= 10:
        findings.append(
            {
                "severity": "high" if lds_wait >= 25 else "medium",
                "title": f"LDS/scalar data waits: {lds_wait:.1f}% of wave time",
                "detail": (
                    "`lgkmcnt`/`dscnt` waits cover LDS reads, scalar loads and flat traffic. "
                    "Check the distance between the LDS write/read and the wait, and whether the "
                    "reads conflict on banks."
                ),
                "metric": f"{reasons.get('wait_lds', {}).get('cycles', 0):,} cycles on LDS/scalar waits",
            }
        )
    if barrier >= 8:
        findings.append(
            {
                "severity": "high" if barrier >= 20 else "medium",
                "title": f"Barrier wait: {barrier:.1f}% of wave time",
                "detail": (
                    "Waves in a workgroup reach `s_barrier` at different times, so the early ones "
                    "pay for the late one. That is work imbalance inside the workgroup, or one "
                    "stage of a pipelined loop being much longer than the others."
                ),
                "metric": f"{reasons.get('barrier', {}).get('cycles', 0):,} cycles at barriers",
            }
        )
    if mfma >= 15:
        findings.append(
            {
                "severity": "medium",
                "title": f"MFMA issue/dependency: {mfma:.1f}% of wave time",
                "detail": (
                    "Time charged to MFMA is the matrix pipe being busy or back-to-back MFMAs "
                    "waiting on their accumulators. Unlike a memory wait this is work getting "
                    "done, and a high share here means the kernel is close to compute bound."
                ),
                "metric": f"{reasons.get('mfma', {}).get('cycles', 0):,} cycles on MFMA",
            }
        )
    if vmem_issue >= 8:
        findings.append(
            {
                "severity": "medium",
                "title": f"VMEM issue backpressure: {vmem_issue:.1f}% of wave time",
                "detail": (
                    "Stalls charged to the load/store itself, not to the wait, mean the texture "
                    "unit's request queue is full. Fewer, wider accesses usually help more than "
                    "prefetching further ahead."
                ),
                "metric": f"{reasons.get('vmem_issue', {}).get('cycles', 0):,} cycles issuing VMEM",
            }
        )
    if lds_issue >= 8:
        findings.append(
            {
                "severity": "medium",
                "title": f"LDS issue pressure: {lds_issue:.1f}% of wave time",
                "detail": (
                    "Stalls on the `ds_*` instruction itself point at bank conflicts or simply at "
                    "more LDS traffic than the unit can retire."
                ),
                "metric": f"{reasons.get('lds_issue', {}).get('cycles', 0):,} cycles issuing LDS ops",
            }
        )

    if t["idle_pct"] >= 10:
        findings.append(
            {
                "severity": "info",
                "title": f"{t['idle_pct']:.1f}% of wave time is unattributed",
                "detail": (
                    "Cycles inside a wave's lifetime that carry neither an issue nor a stall "
                    "record. Large gaps usually mean the trace buffer dropped tokens, so treat "
                    "the percentages above as shares of what was recorded."
                ),
                "metric": f"{t['idle']:,} cycles",
            }
        )

    wl = report["wave_life"]
    if wl["max"] > 0 and wl["max"] >= 1.3 * max(1, wl["p50"]):
        findings.append(
            {
                "severity": "medium",
                "title": "Wave lifetimes are uneven",
                "detail": (
                    "The longest wave runs well past the median one. With a barrier in the loop "
                    "every other wave waits for it, so this is worth chasing before anything else "
                    "in the list."
                ),
                "metric": f"min {wl['min']:,} / median {wl['p50']:,} / max {wl['max']:,} cycles",
            }
        )

    lines = report["hot_lines"]
    if lines:
        top_line = lines[0]
        findings.append(
            {
                "severity": "info",
                "title": f"Hottest source line: {Path(top_line['file']).name}:{top_line['line']}",
                "detail": (
                    f"{top_line['pct']:.1f}% of all wave time is charged to this one line, across "
                    f"{top_line['pcs']} instruction addresses."
                ),
                "metric": f"{top_line['stall']:,} stall cycles",
            }
        )

    order = {"high": 0, "medium": 1, "info": 2}
    findings.sort(key=lambda f: order.get(f["severity"], 3))
    return findings


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggregate ATT traces into a bottleneck report")
    ap.add_argument("--att", required=True, type=Path, help="any .att of the dispatch")
    ap.add_argument("--single", action="store_true", help="analyze only the given trace file")
    ap.add_argument("--results-db", type=Path)
    ap.add_argument("--codeobj-dir", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--decoder-lib-path", type=Path, default=Path("/opt/rocm/lib"))
    ap.add_argument(
        "--rocprofiler-sdk", type=Path, default=Path("/opt/rocm/lib/librocprofiler-sdk.so")
    )
    ap.add_argument("--llvm-objdump", type=Path, default=Path("/opt/rocm/llvm/bin/llvm-objdump"))
    ap.add_argument("--llvm-readelf", type=Path)
    ap.add_argument("--buckets", type=int, default=400)
    ap.add_argument("--top", type=int, default=200)
    args = ap.parse_args()

    codeobj_dir = args.codeobj_dir or args.att.parent
    codeobjs = find_code_objects(codeobj_dir, args.results_db)
    if not codeobjs:
        raise RuntimeError(f"No code objects found under {codeobj_dir}")

    # llvm-readelf ships next to llvm-objdump; only its name differs.
    llvm_readelf = args.llvm_readelf or Path(
        re.sub(r"objdump([^/\\]*)$", r"readelf\1", str(args.llvm_objdump))
    )

    att_files = [args.att] if args.single else sibling_att_files(args.att)
    report = analyze(
        att_files=att_files,
        codeobjs=codeobjs,
        decoder_lib_path=args.decoder_lib_path,
        rocprofiler_sdk=args.rocprofiler_sdk,
        llvm_objdump=args.llvm_objdump,
        llvm_readelf=llvm_readelf,
        buckets=args.buckets,
        top=args.top,
    )

    stats_path = find_stats_csv(args.att)
    report["stats_csv"] = read_stats_csv(stats_path, args.top) if stats_path else None

    parsed = parse_att_name(args.att)
    if parsed:
        report["meta"]["agent"] = parsed[1]
        report["meta"]["dispatch"] = parsed[3]
        report["meta"]["prefix"] = parsed[0]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    print(f"wrote: {args.out}")


if __name__ == "__main__":
    main()
