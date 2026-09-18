#!/usr/bin/env python3
"""Static checks on the traced kernel's machine code, weighted by what the trace measured.

A disassembly listing on its own says what the compiler emitted; the trace says what it cost.
Neither alone identifies a problem worth fixing -- a `vmcnt(0)` two instructions after its load
is only a bug if waves actually sat on it -- so every check here reports the code pattern
together with the cycles the trace charged to it, and stays quiet when it cannot measure one.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Every CDNA generation gives a SIMD 512 VGPRs, allocated to a wave64 in blocks of 8, and the
# accumulation registers come out of the same file from gfx90a on.
VGPR_PER_SIMD = 512
VGPR_ALLOC_GRANULE = 8
SIMDS_PER_CU = 4

# LDS per compute unit, by target. Used only to report what bounds occupancy, and the
# assumption is repeated in the finding so a wrong entry is visible rather than silent.
LDS_PER_CU = {
    "gfx950": 160 * 1024,
    "gfx942": 64 * 1024,
    "gfx941": 64 * 1024,
    "gfx940": 64 * 1024,
    "gfx90a": 64 * 1024,
    "gfx908": 64 * 1024,
}
DEFAULT_LDS_PER_CU = 64 * 1024

_VMEM_PREFIX = ("buffer_", "global_", "flat_", "scratch_", "image_", "tbuffer_", "tensor_")
_MFMA_PREFIX = ("v_mfma", "v_smfmac", "v_wmma")


@dataclass
class Insn:
    """One disassembled instruction, with the source position and branch target if known."""

    addr: int
    asm: str
    file: str = ""
    line: int = 0
    sym: str = ""
    target: Optional[int] = None


@dataclass
class Stat:
    """What the trace measured at one address, summed over every wave that reached it."""

    hits: int = 0
    stall: int = 0
    exec: int = 0


def mnemonic(asm: str) -> str:
    a = (asm or "").strip()
    return a.split(None, 1)[0] if a else ""


def is_mfma(asm: str) -> bool:
    return mnemonic(asm).lower().startswith(_MFMA_PREFIX)


def is_vmem(asm: str) -> bool:
    return mnemonic(asm).lower().startswith(_VMEM_PREFIX)


def is_lds(asm: str) -> bool:
    return mnemonic(asm).lower().startswith("ds_")


def is_vmem_load(asm: str) -> bool:
    m = mnemonic(asm).lower()
    return is_vmem(asm) and ("load" in m or "sample" in m)


_LABEL_RE = re.compile(r"^0*([0-9A-Fa-f]+)\s+<(.+)>:\s*$")
_INSN_RE = re.compile(r"^(.*?)//\s*([0-9A-Fa-f]+):\s*([0-9A-Fa-f ]+?)(?:\s+<(.+)>)?\s*$")
_POS_RE = re.compile(r"^(.+?):(\d+)(?::\d+)?$")
_TARGET_RE = re.compile(r"^(.+?)(?:\+0x([0-9A-Fa-f]+))?$")


def disasm_listing(codeobj: Path, llvm_objdump: Path) -> List[Insn]:
    """Disassemble a code object into an ordered listing with source positions.

    Branch targets are read from the symbol-relative comment llvm-objdump prints after the
    encoding (`<kernel+0x19bc>`), which is the only place the absolute target appears.
    """
    out = subprocess.check_output(
        [str(llvm_objdump), "-d", "--line-numbers", str(codeobj)],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    listing: List[Insn] = []
    sym_base: Dict[str, int] = {}
    cur_file, cur_line, cur_sym = "", 0, ""
    for ln in out.splitlines():
        lbl = _LABEL_RE.match(ln)
        if lbl:
            cur_sym = lbl.group(2)
            sym_base.setdefault(cur_sym, int(lbl.group(1), 16))
            cur_file, cur_line = "", 0
            continue
        if ln.startswith(";"):
            tail = ln[1:].strip()
            if tail.endswith("():"):
                cur_file, cur_line = "", 0
            else:
                m = _POS_RE.match(tail)
                if m and m.group(1) != "??":
                    cur_file, cur_line = m.group(1), int(m.group(2))
            continue
        m = _INSN_RE.match(ln)
        if not m:
            continue
        text = m.group(1).strip()
        if not text or text.endswith(":"):
            continue
        target = None
        if m.group(4):
            tm = _TARGET_RE.match(m.group(4))
            if tm and tm.group(1) in sym_base:
                target = sym_base[tm.group(1)] + int(tm.group(2) or "0", 16)
        listing.append(
            Insn(
                addr=int(m.group(2), 16),
                asm=text,
                file=cur_file,
                line=cur_line,
                sym=cur_sym,
                target=target,
            )
        )
    listing.sort(key=lambda i: i.addr)
    return listing


_META_KEYS = {
    ".name": "name",
    ".vgpr_count": "vgpr",
    ".agpr_count": "agpr",
    ".sgpr_count": "sgpr",
    ".vgpr_spill_count": "vgpr_spill",
    ".sgpr_spill_count": "sgpr_spill",
    ".group_segment_fixed_size": "lds",
    ".private_segment_fixed_size": "scratch",
    ".max_flat_workgroup_size": "max_wg",
    ".wavefront_size": "wave_size",
}
_META_LINE_RE = re.compile(r"^\s*(?:-\s+)?(\.[a-z_]+):\s+(.+?)\s*$")


def kernel_metadata(codeobj: Path, llvm_readelf: Path) -> List[dict]:
    """Read each kernel's register, LDS and spill counts from the code object's metadata note.

    The note is msgpack printed as YAML. Only a handful of scalar keys are wanted, so it is
    scanned line by line rather than taking a YAML dependency.
    """
    try:
        out = subprocess.check_output(
            [str(llvm_readelf), "--notes", str(codeobj)],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    kernels: List[dict] = []
    cur: Optional[dict] = None
    for ln in out.splitlines():
        m = _META_LINE_RE.match(ln)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        if ln.lstrip().startswith("- "):
            # Records are printed with their keys sorted, so any key can open a new one.
            if cur:
                kernels.append(cur)
            cur = {}
        if cur is None or key not in _META_KEYS:
            continue
        field_name = _META_KEYS[key]
        cur[field_name] = value if field_name == "name" else _as_int(value)
    if cur:
        kernels.append(cur)
    return [k for k in kernels if k.get("name")]


def _as_int(s: str) -> int:
    try:
        return int(s)
    except ValueError:
        return 0


def occupancy_limits(meta: dict, gfx: str) -> dict:
    """Waves per SIMD the kernel's register and LDS footprint allow."""
    vgprs = int(meta.get("vgpr", 0)) + int(meta.get("agpr", 0))
    granted = max(
        VGPR_ALLOC_GRANULE,
        -(-vgprs // VGPR_ALLOC_GRANULE) * VGPR_ALLOC_GRANULE if vgprs else VGPR_ALLOC_GRANULE,
    )
    by_vgpr = max(1, min(8, VGPR_PER_SIMD // granted))

    lds = int(meta.get("lds", 0))
    wave_size = int(meta.get("wave_size", 64)) or 64
    waves_per_wg = max(1, -(-int(meta.get("max_wg", wave_size)) // wave_size))
    lds_capacity = LDS_PER_CU.get(gfx, DEFAULT_LDS_PER_CU)
    if lds > 0:
        wgs_per_cu = lds_capacity // lds
        by_lds = max(0, (wgs_per_cu * waves_per_wg) // SIMDS_PER_CU)
    else:
        wgs_per_cu = 0
        by_lds = 8
    return {
        "vgprs": vgprs,
        "vgprs_granted": granted,
        "by_vgpr": by_vgpr,
        "lds": lds,
        "lds_capacity": lds_capacity,
        "wgs_per_cu": wgs_per_cu,
        "waves_per_wg": waves_per_wg,
        "by_lds": by_lds,
        "limit": max(1, min(by_vgpr, by_lds if by_lds else by_vgpr)),
    }


_VMCNT_RE = re.compile(r"\b(?:vmcnt|loadcnt)\((\d+)\)")
_LGKM_RE = re.compile(r"\b(?:lgkmcnt|dscnt|kmcnt)\((\d+)\)")


def _issue(kind, severity, title, detail, metric, **extra) -> dict:
    d = {"kind": kind, "severity": severity, "title": title, "detail": detail, "metric": metric}
    d.update(extra)
    return d


@dataclass
class Context:
    """Everything the checks read: the listing, what the trace measured, and the kernel facts."""

    listing: List[Insn]
    stats: Dict[int, Stat]
    index: Dict[int, int] = field(default_factory=dict)
    life: int = 1
    waves: int = 1
    meta: dict = field(default_factory=dict)
    gfx: str = ""
    peak_waves_per_cu: int = 0

    def stat(self, addr: int) -> Stat:
        return self.stats.get(addr, Stat())

    def pct(self, cycles: int) -> float:
        return 100.0 * cycles / max(1, self.life)

    def executed(self, i: Insn) -> bool:
        return self.stat(i.addr).hits > 0


def find_hot_loop(ctx: Context) -> Optional[dict]:
    """The innermost loop the trace spent the most time in.

    Found from backward branches rather than from source structure: the branch the trace took
    most often bounds the body that matters, whatever the compiler did to the source loop.
    """
    best = None
    for i in ctx.listing:
        if i.target is None or i.target >= i.addr:
            continue
        if not mnemonic(i.asm).lower().startswith(("s_cbranch", "s_branch")):
            continue
        st = ctx.stat(i.addr)
        if st.hits <= 0:
            continue
        body = [x for x in ctx.listing if i.target <= x.addr <= i.addr]
        cycles = sum(ctx.stat(x.addr).stall + ctx.stat(x.addr).exec for x in body)
        if best is None or cycles > best["cycles"]:
            best = {
                "begin": i.target,
                "end": i.addr,
                "branch": i.asm,
                "iterations": st.hits,
                "cycles": cycles,
                "body": body,
            }
    if not best:
        return None
    body = best.pop("body")
    best["instructions"] = len(body)
    best["mfma"] = sum(1 for x in body if is_mfma(x.asm))
    best["vmem"] = sum(1 for x in body if is_vmem(x.asm))
    best["lds"] = sum(1 for x in body if is_lds(x.asm))
    best["barriers"] = sum(1 for x in body if mnemonic(x.asm).lower().startswith("s_barrier"))
    best["waits"] = sum(1 for x in body if mnemonic(x.asm).lower().startswith("s_waitcnt"))
    best["cycles_per_iter"] = best["cycles"] / max(1, best["iterations"])
    best["pct"] = ctx.pct(best["cycles"])
    return best


def check_occupancy(ctx: Context) -> List[dict]:
    """Report what bounds the number of waves a SIMD can host, and what the trace saw."""
    if not ctx.meta:
        return []
    occ = occupancy_limits(ctx.meta, ctx.gfx)
    bound = "VGPRs" if occ["by_vgpr"] <= occ["by_lds"] else "LDS"
    detail = (
        f"{occ['vgprs']} VGPRs (granted {occ['vgprs_granted']} of {VGPR_PER_SIMD} per SIMD) "
        f"allow {occ['by_vgpr']} waves/SIMD"
    )
    if occ["lds"]:
        detail += (
            f"; {occ['lds'] // 1024} KB of LDS per workgroup allows {occ['wgs_per_cu']} workgroup"
            f"{'s' if occ['wgs_per_cu'] != 1 else ''} of {occ['waves_per_wg']} waves per CU, so "
            f"{occ['by_lds']} waves/SIMD (assuming {occ['lds_capacity'] // 1024} KB of LDS per CU "
            f"on {ctx.gfx or 'this target'})"
        )
    detail += (
        f". {bound} bound it to {occ['limit']} waves/SIMD, which is what there is to hide memory "
        "latency with: a wave that stalls has at most that many peers to issue in its place."
    )
    severity = "high" if occ["limit"] <= 1 else "medium" if occ["limit"] <= 2 else "info"
    metric = f"{occ['limit']} waves/SIMD"
    if ctx.peak_waves_per_cu:
        metric += f", trace peaked at {ctx.peak_waves_per_cu} waves per CU"
    return [
        _issue(
            "occupancy",
            severity,
            f"Occupancy is {occ['limit']} wave{'s' if occ['limit'] != 1 else ''}/SIMD, bound by {bound}",
            detail,
            metric,
            data=occ,
        )
    ]


def check_spills(ctx: Context) -> List[dict]:
    """Scratch traffic and the compiler's own spill counts."""
    meta = ctx.meta or {}
    spill_v = int(meta.get("vgpr_spill", 0))
    spill_s = int(meta.get("sgpr_spill", 0))
    scratch_bytes = int(meta.get("scratch", 0))
    sites = [i for i in ctx.listing if mnemonic(i.asm).lower().startswith("scratch_")]
    executed = [i for i in sites if ctx.executed(i)]
    if not (spill_v or spill_s or scratch_bytes or executed):
        return []
    cycles = sum(ctx.stat(i.addr).stall + ctx.stat(i.addr).exec for i in executed)
    return [
        _issue(
            "spill",
            "high" if executed else "medium",
            "The kernel spills registers to scratch",
            "Scratch lives in device memory. Spilling in an inner loop costs a memory round trip "
            "per access and the traffic competes with the kernel's real loads.",
            f"{spill_v} VGPR / {spill_s} SGPR spills, {scratch_bytes} B private segment, "
            f"{len(executed)} scratch instructions executed, {cycles:,} cycles",
            sites=[_site(ctx, i) for i in executed[:20]],
        )
    ]


def check_drain_then_barrier(ctx: Context) -> List[dict]:
    """Find `s_waitcnt vmcnt(0)` immediately before `s_barrier`, and price it.

    This pair serializes the workgroup against the slowest outstanding load: every wave drains
    its memory traffic, then waits for every other wave to do the same. It is what a
    single-buffered pipeline compiles to, and it is usually the most expensive thing in one.
    """
    out = []
    n = len(ctx.listing)
    for idx, i in enumerate(ctx.listing):
        if not mnemonic(i.asm).lower().startswith("s_waitcnt"):
            continue
        m = _VMCNT_RE.search(i.asm)
        if not m or int(m.group(1)) != 0:
            continue
        barrier = None
        for j in range(idx + 1, min(n, idx + 5)):
            if mnemonic(ctx.listing[j].asm).lower().startswith("s_barrier"):
                barrier = ctx.listing[j]
                break
            if not mnemonic(ctx.listing[j].asm).lower().startswith("s_"):
                break
        if barrier is None:
            continue
        wait_cycles = ctx.stat(i.addr).stall
        barrier_cycles = ctx.stat(barrier.addr).stall
        if wait_cycles + barrier_cycles <= 0:
            continue
        out.append((i, barrier, wait_cycles, barrier_cycles))
    if not out:
        return []
    out.sort(key=lambda t: -(t[2] + t[3]))
    total = sum(w + b for (_i, _bar, w, b) in out)
    sites = [
        {
            **_site(ctx, i),
            "barrier_addr": bar.addr,
            "wait_cycles": w,
            "barrier_cycles": b,
            "pct": ctx.pct(w + b),
        }
        for (i, bar, w, b) in out[:20]
    ]
    return [
        _issue(
            "drain_barrier",
            "high" if ctx.pct(total) >= 15 else "medium",
            f"{len(out)} places drain all VMEM then barrier: {ctx.pct(total):.1f}% of wave time",
            "`s_waitcnt vmcnt(0)` followed by `s_barrier` stops the workgroup until the slowest "
            "load of the slowest wave has returned, with nothing issued in between. Double "
            "buffering -- issuing the next tile's loads before the barrier and waiting on them "
            "after it -- is what removes this, at the cost of the registers to hold the tile.",
            f"{total:,} cycles across {len(out)} sites",
            sites=sites,
        )
    ]


def check_latency_hiding(ctx: Context, top: int = 12) -> List[dict]:
    """For the costliest waits, measure how much work was issued between the load and the wait.

    `vmcnt(N)` releases when all but the last N VMEM operations have returned, so the operation
    a wait blocks on is the (N+1)-th preceding one. The instructions between the two are the
    kernel's entire opportunity to hide that memory latency.
    """
    waits = []
    for idx, i in enumerate(ctx.listing):
        if not mnemonic(i.asm).lower().startswith("s_waitcnt"):
            continue
        stall = ctx.stat(i.addr).stall
        if stall <= 0:
            continue
        m = _VMCNT_RE.search(i.asm)
        if not m:
            continue
        want = int(m.group(1))
        seen = 0
        src = None
        for j in range(idx - 1, -1, -1):
            if is_vmem(ctx.listing[j].asm):
                if seen == want:
                    src = (j, ctx.listing[j])
                    break
                seen += 1
        if src is None:
            continue
        gap = idx - src[0] - 1
        between = ctx.listing[src[0] + 1 : idx]
        mfma_between = sum(1 for x in between if is_mfma(x.asm))
        waits.append(
            {
                **_site(ctx, i),
                "stall": stall,
                "pct": ctx.pct(stall),
                "load_addr": src[1].addr,
                "load_asm": src[1].asm,
                "gap": gap,
                "mfma_between": mfma_between,
                "avg_stall": stall / max(1, ctx.stat(i.addr).hits),
            }
        )
    if not waits:
        return []
    waits.sort(key=lambda w: -w["stall"])
    waits = waits[:top]
    exposed = [w for w in waits if w["gap"] < 8 and w["avg_stall"] >= 40]
    issues = [
        _issue(
            "wait_sites",
            "info",
            "Where the memory waits are, and what was issued ahead of them",
            "Each wait is paired with the load it blocks on and the number of instructions "
            "between the two. That gap is all the kernel has to cover the latency with.",
            f"{len(waits)} wait sites, {sum(w['stall'] for w in waits):,} stall cycles",
            sites=waits,
        )
    ]
    if exposed:
        worst = exposed[0]
        issues.append(
            _issue(
                "exposed_latency",
                "high",
                f"{len(exposed)} waits sit within 8 instructions of the load they wait on",
                "The load has barely been issued before the wave blocks on it, so the full "
                "memory latency is exposed. Hoisting the load earlier, or software-pipelining "
                "the loop so the wait is for the previous iteration's load, is what closes this.",
                f"worst: 0x{worst['addr']:x} waits {worst['avg_stall']:.0f} cycles on average, "
                f"{worst['gap']} instructions after its load",
                sites=exposed,
            )
        )
    return issues


def check_mfma_interleaving(ctx: Context, loop: Optional[dict]) -> List[dict]:
    """Whether the matrix pipe has memory work alongside it, or the two take turns."""
    if not loop:
        return []
    body = [i for i in ctx.listing if loop["begin"] <= i.addr <= loop["end"]]
    if loop["mfma"] == 0:
        return []
    runs: List[int] = []
    cur = 0
    for i in body:
        if is_mfma(i.asm):
            cur += 1
        elif cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    longest = max(runs) if runs else 0
    mem_ops = loop["vmem"] + loop["lds"]
    detail = (
        f"The hot loop issues {loop['mfma']} MFMA and {mem_ops} memory instructions over "
        f"{loop['instructions']} instructions, in {len(runs)} uninterrupted MFMA runs, the "
        f"longest {longest} long."
    )
    severity = "info"
    if longest >= 16 and mem_ops:
        severity = "medium"
        detail += (
            " Long unbroken MFMA runs mean the loads for the next tile are not issued while the "
            "matrix pipe is busy, which is the window that would hide them for free."
        )
    return [
        _issue(
            "mfma_interleave",
            severity,
            f"MFMA runs up to {longest} instructions without a memory operation",
            detail,
            f"{loop['mfma']} MFMA / {mem_ops} memory ops per iteration",
        )
    ]


def check_nops(ctx: Context) -> List[dict]:
    """Hazard padding the compiler inserted, and what the trace paid for it."""
    sites = [i for i in ctx.listing if mnemonic(i.asm).lower() in ("s_nop", "s_sleep")]
    executed = [i for i in sites if ctx.executed(i)]
    if not executed:
        return []
    cycles = sum(ctx.stat(i.addr).stall + ctx.stat(i.addr).exec for i in executed)
    if ctx.pct(cycles) < 0.5:
        return []
    return [
        _issue(
            "nops",
            "medium" if ctx.pct(cycles) >= 2 else "info",
            f"Hazard padding costs {ctx.pct(cycles):.1f}% of wave time",
            "`s_nop` is the compiler waiting out a register hazard it could not fill with real "
            "work. A lot of it usually means a dependency chain too tight to schedule around.",
            f"{len(executed)} sites, {cycles:,} cycles",
            sites=[_site(ctx, i) for i in sorted(executed, key=lambda x: -ctx.stat(x.addr).stall)[:12]],
        )
    ]


def _site(ctx: Context, i: Insn) -> dict:
    st = ctx.stat(i.addr)
    return {
        "addr": i.addr,
        "asm": i.asm,
        "file": i.file,
        "line": i.line,
        "hits": st.hits,
        "stall": st.stall,
        "exec": st.exec,
    }


def annotated_listing(ctx: Context, loop: Optional[dict], limit: int = 400) -> List[dict]:
    """The stretch of code worth showing a reader, annotated with what it cost.

    The hot loop when there is one, otherwise the window around the costliest instruction.
    """
    if loop:
        lo, hi = loop["begin"], loop["end"]
        body = [i for i in ctx.listing if lo <= i.addr <= hi]
    else:
        hot = max(ctx.stats.items(), key=lambda kv: kv[1].stall, default=None)
        if not hot:
            return []
        idx = ctx.index.get(hot[0], 0)
        body = ctx.listing[max(0, idx - limit // 2) : idx + limit // 2]
    if len(body) > limit:
        # Keep the ends: a loop's head and tail are where the pipelining decisions show.
        head = body[: limit // 2]
        tail = body[-(limit // 2) :]
        body = head + tail
    return [_site(ctx, i) for i in body]


def analyze(
    listing: List[Insn],
    stats: Dict[int, Stat],
    meta: dict,
    gfx: str,
    life: int,
    waves: int,
    peak_waves_per_cu: int,
) -> dict:
    """Run every check and return the issues, the hot loop, and the annotated listing."""
    ctx = Context(
        listing=listing,
        stats=stats,
        index={i.addr: n for n, i in enumerate(listing)},
        life=max(1, life),
        waves=max(1, waves),
        meta=meta or {},
        gfx=gfx,
        peak_waves_per_cu=peak_waves_per_cu,
    )
    loop = find_hot_loop(ctx)
    issues: List[dict] = []
    issues += check_occupancy(ctx)
    issues += check_spills(ctx)
    issues += check_drain_then_barrier(ctx)
    issues += check_latency_hiding(ctx)
    issues += check_mfma_interleaving(ctx, loop)
    issues += check_nops(ctx)

    order = {"high": 0, "medium": 1, "info": 2}
    issues.sort(key=lambda i: order.get(i["severity"], 3))
    return {
        "issues": issues,
        "loop": loop,
        "peak_waves_per_cu": peak_waves_per_cu,
        "listing": annotated_listing(ctx, loop),
        "kernel": ctx.meta,
        "occupancy": occupancy_limits(ctx.meta, gfx) if ctx.meta else None,
    }
