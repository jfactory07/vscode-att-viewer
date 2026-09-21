#!/usr/bin/env python3
"""Serve the ATT bottleneck reports to a chat model as MCP tools over stdio.

The analysis panel hands a model one flattened document and the conversation ends there: the
model cannot ask for the disassembly outside the hot loop, or for a second dispatch to compare
against. These tools invert that -- the model is given an index of every trace on disk and
pulls only the slice it needs, so a question about one `s_waitcnt` costs a few hundred tokens
instead of forty kilobytes.

Reports are materialised lazily. Listing runs only stats directories, and the ~2s analysis of
a dispatch runs the first time something asks about it, then is cached against the trace's
mtime.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
ANALYZE = HERE / "att_analyze.py"

# rocprofv3 names each shader engine's trace `<prefix>_<agent>_shader_engine_<se>_<dispatch>.att`.
# The prefix is greedy because some captures put a pid in front of the agent id. A few hand-made
# captures drop the prefix and agent entirely, so those fall through to the looser pattern.
ATT_RE = re.compile(r"^(?P<prefix>.+)_(?P<agent>\d+)_shader_engine_(?P<se>\d+)_(?P<dispatch>\d+)\.att$")
ATT_RE_LOOSE = re.compile(r"^(?:(?P<prefix>.*)_)?shader_engine_(?P<se>\d+)_(?P<dispatch>.+)\.att$")

DEFAULT_ROOTS = [p for p in os.environ.get("ATT_MCP_ROOTS", "").split(os.pathsep) if p] or [
    "/mnt/att_output",
    "/tmp/att_pe",
]
ROCM = Path(os.environ.get("ROCM_PATH", "/opt/rocm"))
CACHE = Path(os.environ.get("ATT_MCP_CACHE", Path.home() / ".cache" / "att_mcp"))
MAX_CHARS = 60000
SCHEMA = 3  # bump whenever the analyzer's report gains a field the tools read


def log(msg: str) -> None:
    """Write to stderr; stdout carries the JSON-RPC stream and nothing else."""
    print(f"[att-mcp] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------- run discovery


class Run:
    """One dispatch's worth of traces: the .att files of every shader engine in one directory."""

    def __init__(self, directory: Path, prefix: str, agent: str, dispatch: str):
        self.dir = directory
        self.prefix = prefix
        self.agent = agent
        self.dispatch = dispatch
        self.atts: List[Path] = []
        self.id = directory.name

    @property
    def rep(self) -> Path:
        """The trace the analyzer is pointed at; it finds the sibling engines itself."""
        return sorted(self.atts)[0]

    @property
    def snapshot_dir(self) -> Optional[Path]:
        d = self.dir / f"ui_output_agent_{self.agent}_dispatch_{self.dispatch}"
        return d if d.is_dir() else None

    def results_db(self) -> Optional[Path]:
        by_prefix = self.dir / f"{self.prefix.split('_')[0]}_results.db"
        if by_prefix.exists():
            return by_prefix
        cands = sorted(self.dir.glob("*_results.db"))
        return cands[0] if len(cands) == 1 else None

    def stamp(self) -> str:
        st = self.rep.stat()
        return f"{self.rep}|{st.st_mtime_ns}|{st.st_size}"


def discover(roots: Optional[List[str]] = None) -> Dict[str, Run]:
    """Index every dispatch under the search roots by walking directories, never analyzing."""
    runs: Dict[Tuple, Run] = {}
    rel_of: Dict[Path, str] = {}
    for root in roots or DEFAULT_ROOTS:
        base = Path(root)
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            # Each dispatch carries a ui_output_* tree of per-wave JSON and no traces.
            dirnames[:] = [x for x in dirnames if not x.startswith("ui_output_")]
            d = Path(dirpath)
            for name in sorted(filenames):
                if not name.endswith(".att"):
                    continue
                m = ATT_RE.match(name) or ATT_RE_LOOSE.match(name)
                if not m:
                    continue
                agent = m.groupdict().get("agent") or ""
                prefix = m["prefix"] or ""
                key = (d, prefix, agent, m["dispatch"])
                runs.setdefault(key, Run(d, prefix, agent, m["dispatch"])).atts.append(d / name)
                rel_of[d] = str(d.relative_to(base)) if d != base else base.name

    # The id is the capture's path below its root, which stays readable when several runs share
    # a leaf name. One directory can hold several dispatches, and several agents can share a
    # dispatch number within it, so qualify only as far as it takes to make the id unique --
    # anything less silently drops runs from the index.
    out: Dict[str, Run] = {}
    pending = list(runs.values())
    for name in (lambda r: rel_of[r.dir],
                 lambda r: f"{rel_of[r.dir]}#{r.dispatch}",
                 lambda r: f"{rel_of[r.dir]}#{r.dispatch}@{r.agent}",
                 lambda r: f"{rel_of[r.dir]}#{r.dispatch}@{r.agent}.{r.prefix}"):
        groups: Dict[str, List[Run]] = {}
        for r in pending:
            groups.setdefault(name(r), []).append(r)
        pending = []
        for rid, group in groups.items():
            if len(group) == 1 and rid not in out:
                group[0].id = rid
                out[rid] = group[0]
            else:
                pending += group
        if not pending:
            break
    for r in pending:  # pathological duplicates still get a reachable id
        r.id = f"{rel_of[r.dir]}@{hashlib.sha1(str(r.rep).encode()).hexdigest()[:6]}"
        out[r.id] = r
    return out


def resolve(runs: Dict[str, Run], ref: str) -> Run:
    """Accept a run id, a capture directory, a .att path, or an unambiguous partial id."""
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("no run given; call att_current for the trace the viewer has open")
    if ref in runs:
        return runs[ref]
    p = Path(ref)
    # A capture directory can hold many dispatches, so a named .att picks the run holding it.
    # Falling straight back to the parent directory returns whichever dispatch is first, which
    # is how the viewer's own trace used to resolve to a different one.
    if p.suffix == ".att":
        for r in runs.values():
            if p in r.atts:
                return r
    target = p.parent if p.suffix == ".att" else p
    for r in runs.values():
        if r.dir == target:
            return r
    hits = [r for rid, r in runs.items() if ref.lower() in rid.lower()]
    if len(hits) == 1:
        return hits[0]
    if hits:
        names = ", ".join(sorted(h.id for h in hits)[:12])
        raise ValueError(f'"{ref}" matches {len(hits)} runs: {names}')
    # No listing tool any more, so say what is on disk rather than pointing at one.
    known = ", ".join(sorted(runs)[:20]) or "none found"
    raise ValueError(f'no run matches "{ref}". On disk: {known}'
                     + (f' (+{len(runs) - 20} more)' if len(runs) > 20 else ''))


# ---------------------------------------------------------------------------- report building


def cache_path(run: Run) -> Path:
    # Part of the key so that adding a field to the report invalidates what is on disk; the
    # trace's mtime alone cannot notice that the analyzer started emitting something new.
    key = f"{SCHEMA}|{run.stamp()}"
    return CACHE / f"{hashlib.sha1(key.encode()).hexdigest()}.json"


def report(run: Run) -> dict:
    """Return the run's analysis, running the ~2s analyzer only on a cache miss."""
    out = cache_path(run)
    if out.exists():
        try:
            return json.loads(out.read_text())
        except (json.JSONDecodeError, OSError):
            out.unlink(missing_ok=True)

    CACHE.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(ANALYZE),
        "--att", str(run.rep),
        "--codeobj-dir", str(run.dir),
        "--out", str(out),
        "--decoder-lib-path", str(ROCM / "lib"),
        "--llvm-objdump", str(ROCM / "llvm" / "bin" / "llvm-objdump"),
    ]
    db = run.results_db()
    if db:
        cmd += ["--results-db", str(db)]

    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = os.pathsep.join(filter(None, [str(ROCM / "lib"), env.get("LD_LIBRARY_PATH", "")]))
    log(f"analyzing {run.id}")
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(HERE), timeout=600)
    if p.returncode != 0 or not out.exists():
        tail = (p.stderr or p.stdout or "no output").strip().splitlines()[-12:]
        raise RuntimeError(f"analysis of {run.id} failed:\n" + "\n".join(tail))
    return json.loads(out.read_text())


# ---------------------------------------------------------------------------- formatting


def n(x: Any) -> str:
    return f"{int(x):,}" if isinstance(x, (int, float)) else str(x)


def hx(a: Any) -> str:
    return f"0x{int(a):x}"


def short(path: Optional[str]) -> str:
    return Path(path).name if path else ""


def site_line(s: dict) -> str:
    stall = s.get("stall")
    if stall is None:
        stall = (s.get("wait_cycles") or 0) + (s.get("barrier_cycles") or 0)
    where = f"  {short(s.get('file'))}:{s.get('line')}" if s.get("file") else ""
    return f"  {hx(s['addr']):>8}  {n(stall):>12} cyc  {s.get('asm','')}{where}"


def table(rows: List[List[str]], head: List[str]) -> str:
    """Render fixed-width columns; the model reads these far more reliably than JSON."""
    cols = [[str(c) for c in col] for col in zip(*([head] + rows))] if rows else [[h] for h in head]
    w = [max(len(c) for c in col) for col in cols]
    out = ["  ".join(h.ljust(wi) for h, wi in zip(head, w)).rstrip()]
    out.append("  ".join("-" * wi for wi in w))
    for r in rows:
        out.append("  ".join(str(c).ljust(wi) for c, wi in zip(r, w)).rstrip())
    return "\n".join(out)


def clip(text: str) -> str:
    if len(text) <= MAX_CHARS:
        return text
    return text[:MAX_CHARS] + f"\n… truncated at {MAX_CHARS} chars; narrow the range or lower `limit`."


# ---------------------------------------------------------------------------- tools


def t_current(runs: Dict[str, Run], **_) -> str:
    """Name the run the viewer panel last had open, so 'this trace' resolves to something."""
    state = CACHE / "current.json"
    if not state.exists():
        return ("The ATT Viewer panel has not opened a trace in this install, so there is no "
                "current trace. Ask the user to open one in the viewer, or to name it.")
    try:
        d = json.loads(state.read_text())
        # The .att first: it names the dispatch, and the directory alone does not.
        r = resolve(runs, d.get("att") or d.get("dir") or "")
    except (json.JSONDecodeError, OSError, ValueError) as e:
        return f"could not read the viewer's current trace: {e}"

    age = int(time.time()) - int(d.get("updated") or 0)
    when = f"{age//3600}h ago" if age >= 3600 else (f"{age//60}m ago" if age >= 60 else "just now")
    o = [f"The viewer last opened `{d.get('name','?')}` ({when}).",
         "",
         f"That is run `{r.id}` — pass it as `run` to the other tools.",
         ""]
    o += _selection(d.get("selection"))
    return clip("\n".join(o) + "\n" + t_summary(runs, run=r.id))


def _selection(sel) -> List[str]:
    """Render the instructions the user highlighted in the panel, if they attached any."""
    if not isinstance(sel, dict) or not sel.get("lines"):
        return []
    lines, lo, hi = sel["lines"], sel.get("begin"), sel.get("end")
    age = int(time.time()) - int(sel.get("attached") or 0)
    when = f"{age//3600}h ago" if age >= 3600 else (f"{age//60}m ago" if age >= 60 else "just now")

    o = [f"## The user selected {sel.get('count', len(lines))} instructions in this trace "
         f"({when})", ""]
    if sel.get("codeobj"):
        o += [f"Code object `{sel['codeobj']}`", ""]
    o.append(table([[f"0x{int(x.get('addr', 0)):x}", str(x.get("text", "")), n(x.get("hits", 0))]
                    for x in lines],
                   ["addr", "instruction", "executions"]))
    if sel.get("truncated"):
        o.append(f"\n(listing truncated to {len(lines)} of {sel.get('count')} lines)")
    hint = "Treat this selection as what the user means by 'these instructions' or 'this code'."
    if lo is not None and hi is not None:
        hint += (" For surrounding context and per-instruction stall cycles, call att_disasm "
                 f"with begin=0x{int(lo):x} end=0x{int(hi):x}.")
    o += ["", hint, ""]
    return o


PHASE_BLURB = {
    "prologue": "setup before the loop is entered",
    "mainline": "the loop the trace spun in",
    "epilogue": "what runs after the loop falls through",
}


def t_phases(runs: Dict[str, Run], run: str = "", **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    ph = d.get("phases")
    if not ph:
        return (f"`{r.id}` has no loop the trace spun in, so there is nothing to cut at and no "
                "prologue/mainline/epilogue to mark. Call att_summary for the run as a whole.")

    phases = ph["phases"]
    o = [f"# {r.id} — prologue / mainline / epilogue", ""]
    o.append(f"Cut at the loop the trace actually ran: {n(ph.get('iterations'))} iterations of "
             f"{n(round(ph.get('cycles_per_iter') or 0))} cycles. Addresses are what the "
             "hardware executed, so a phase's range can be sparse.")
    o += ["", table([[p["name"],
                      f"{hx(p['lo'])}-{hx(p['hi'])}" if p["lo"] is not None else "-",
                      n(p["insts"]), n(p["hits"]), n(p["cycles"]), f"{p['pct']:.1f}%"]
                     for p in phases],
                    ["phase", "addresses", "insts", "issued", "cycles", "share"]), ""]

    div = {x["after"]: x for x in ph.get("dividers") or []}
    rule = "=" * 78
    for p in phases:
        name = p["name"]
        b = div.get(name)
        title = f"{hx(b['addr'])}  {name} begins" if b else name
        o += ["", rule, f"{title} — {PHASE_BLURB[name]}", rule, ""]
        if b:
            if b.get("prev_addr") is not None:
                o.append(f"  last before  {hx(b['prev_addr'])}  {b['prev_asm']}")
            o.append(f"  first        {hx(b['addr'])}  {b['asm']}"
                     + (f"   {short(b['file'])}:{b['line']}" if b.get("file") else ""))
            o.append("")
        if not p["insts"]:
            o.append("Nothing in the trace ran here.")
            continue
        o.append(f"{n(p['insts'])} distinct instructions, issued {n(p['hits'])} times, "
                 f"{n(p['cycles'])} cycles ({n(p['stall'])} stalled, {n(p['exec'])} executing) "
                 f"— {p['pct']:.1f}% of the dispatch's wave time.")
        if p["reasons"]:
            o += ["", table([[x["label"], f"{x['pct']:.1f}%", n(x["cycles"])]
                             for x in p["reasons"]],
                            ["stalled on", "share of phase", "cycles"])]
        if p["top"]:
            o += ["", "Costliest instructions here:", "",
                  table([[hx(x["pc"]), x["asm"], n(x["hits"]), n(x["stall"]),
                          f"{short(x['file'])}:{x['line']}" if x["file"] else ""]
                         for x in p["top"]],
                        ["addr", "instruction", "issued", "stall", "source"])]
    return clip("\n".join(o))


def t_summary(runs: Dict[str, Run], run: str = "", **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    t, meta, asm = d["totals"], d["meta"], d.get("asm") or {}
    k, occ = asm.get("kernel") or {}, asm.get("occupancy") or {}
    o = [f"# {r.id}  (agent {meta.get('agent')}, dispatch {meta.get('dispatch')})", ""]

    if asm.get("symbol"):
        o += [f"Kernel  {asm['symbol']}", f"Target  {asm.get('gfx','?')}", ""]
    if k:
        o.append(f"Registers  {k.get('vgpr')} VGPR, {k.get('agpr',0)} AGPR, {k.get('sgpr')} SGPR"
                 f"   spills {k.get('vgpr_spill')}/{k.get('sgpr_spill')}, scratch {k.get('scratch')} B")
        o.append(f"LDS        {n(k.get('lds'))} B per workgroup, workgroup size {k.get('max_wg')}")
    if occ:
        o.append(f"Occupancy  {occ.get('limit')} waves/SIMD "
                 f"(VGPRs allow {occ.get('by_vgpr')}, LDS allows {occ.get('by_lds')}); "
                 f"trace peaked at {asm.get('peak_waves_per_cu')} waves/CU")
    o.append("")

    o.append(f"{t['waves']} waves on {t['shader_engines']} SEs, {n(t['instructions'])} instructions "
             f"issued over a {n(t['span'])}-cycle dispatch.")
    o.append(f"Of {n(t['life'])} wave-cycles: {t['exec_pct']:.1f}% executing, "
             f"{t['stall_pct']:.1f}% stalled, {t['idle_pct']:.1f}% unattributed. "
             f"IPC/wave {t['ipc_per_wave']:.3f}.")
    o += ["", "Stall cycles by reason:", ""]
    o.append(table([[x["label"], f"{x['pct']:.1f}%", n(x["cycles"])] for x in d["reasons"] if x["pct"] >= 0.1],
                   ["reason", "share", "cycles"]))

    L = asm.get("loop")
    if L:
        o += ["", f"Hot loop {hx(L['begin'])}-{hx(L['end'])}: {L['instructions']} instructions "
                  f"({L['mfma']} MFMA, {L['vmem']} VMEM, {L['lds']} LDS, {L['barriers']} barriers, "
                  f"{L['waits']} waitcnt), {n(L['iterations'])} iterations, "
                  f"{n(round(L['cycles_per_iter']))} cycles/iter, {L['pct']:.1f}% of wave time."]

    issues = asm.get("issues") or []
    if issues:
        o += ["", f"{len(issues)} static findings -- call att_issues for the list."]
    return clip("\n".join(o))


def t_issues(runs: Dict[str, Run], run: str = "", **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    asm = d.get("asm") or {}
    o = [f"# Findings for {r.id}", ""]

    issues = asm.get("issues") or []
    if issues:
        o += ["## Static checks on the machine code", ""]
        for i, it in enumerate(issues):
            o.append(f"[{i}] ({it['severity']}) {it['title']}")
            o.append(f"     {it['metric']}   sites={len(it.get('sites') or [])}"
                     f"   kind={it.get('kind','')}")
        o += ["", "Call att_issue with the index for the detail and every evidence site.", ""]

    if d.get("findings"):
        o += ["## What the trace alone says", ""]
        for f in d["findings"]:
            o.append(f"({f['severity']}) {f['title']}")
            o.append(f"     {f['metric']}")
    return clip("\n".join(o))


def t_issue(runs: Dict[str, Run], run: str = "", index: Any = 0, **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    issues = (d.get("asm") or {}).get("issues") or []
    if not issues:
        return f"{r.id} has no static findings."

    it = None
    if isinstance(index, str) and not index.isdigit():
        for c in issues:
            if index.lower() in (c.get("kind", "") + " " + c["title"]).lower():
                it = c
                break
    else:
        i = int(index)
        if not 0 <= i < len(issues):
            return f"index {i} out of range; {r.id} has {len(issues)} findings (0-{len(issues)-1})."
        it = issues[i]
    if it is None:
        return f'no finding of {r.id} matches "{index}".'

    o = [f"[{it['severity']}] {it['title']}", "", it["detail"], "", f"Measured: {it['metric']}"]
    sites = it.get("sites") or []
    if sites:
        o += ["", f"{len(sites)} evidence sites (addr / stall cycles / instruction / source):", ""]
        o += [site_line(s) for s in sites]
        o += ["", "Call att_disasm around any of these addresses to see what surrounds it."]
    return clip("\n".join(o))


def t_disasm(runs: Dict[str, Run], run: str = "", begin: Any = None, end: Any = None,
             around: Any = None, limit: int = 200, **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    asm = d.get("asm") or {}
    listing = asm.get("listing") or []
    if not listing:
        return f"{r.id} has no annotated listing."

    def num(v):
        if v is None or v == "":
            return None
        return int(v, 16) if isinstance(v, str) and v.lower().startswith("0x") else int(v)

    lo, hi, ctr = num(begin), num(end), num(around)
    if ctr is not None:
        lo, hi = ctr - 128, ctr + 128
    rows = [x for x in listing if (lo is None or x["addr"] >= lo) and (hi is None or x["addr"] <= hi)]
    if not rows:
        span = f"{hx(listing[0]['addr'])}-{hx(listing[-1]['addr'])}"
        return f"no instructions in that range; the listing covers {span}."

    body = [[hx(x["addr"]), n(x["hits"]), n(x["stall"]), n(x["exec"]), x["asm"],
             f"{short(x.get('file'))}:{x['line']}" if x.get("file") else ""]
            for x in rows[:limit]]
    head = ["addr", "issues", "stall", "exec", "instruction", "source"]
    note = f"\n\n{len(rows)} instructions in range"
    note += f", showing {limit}." if len(rows) > limit else "."
    note += "  stall = cycles waves waited before issuing; exec = cycles executing."
    return clip(table(body, head) + note)


def t_hot(runs: Dict[str, Run], run: str = "", by: str = "line", limit: int = 20, **_) -> str:
    r = resolve(runs, run)
    d = report(r)
    if by == "inst":
        rows = [[hx(x["pc"]), n(x["hits"]), n(x["stall"]), x["reason"], x["asm"],
                 f"{short(x.get('file'))}:{x['line']}" if x.get("file") else ""]
                for x in d["hot_inst"][:limit]]
        return clip(table(rows, ["addr", "issues", "stall", "reason", "instruction", "source"]))
    rows = [[f"{x['pct']:.1f}%", n(x["stall"]), n(x["exec"]), x["reason"],
             f"{x['file']}:{x['line']}"] for x in d["hot_lines"][:limit]]
    note = "\n\nPaths are the compile-time paths; call att_source to read the captured text."
    return clip(table(rows, ["share", "stall", "exec", "reason", "source"]) + note)


def t_source(runs: Dict[str, Run], run: str = "", file: str = "", line: Any = 1,
             context: int = 20, **_) -> str:
    """Read the source rocprofv3 copied at capture time, not the working tree.

    The line tables point into the text the code object was built from. The tree has moved on
    since -- one kernel header here is 54 lines longer than its capture -- so reading the tree
    silently attributes cycles to the wrong statement.
    """
    r = resolve(runs, run)
    snap = r.snapshot_dir
    want = Path(file).name
    src, origin = None, ""
    if snap:
        for cand in sorted(snap.glob("source_*")):
            if cand.name.split("_", 2)[-1] == want:
                src, origin = cand, "capture-time snapshot"
                break
    if src is None:
        disk = Path(file)
        if not disk.is_file():
            have = ", ".join(sorted(p.name.split("_", 2)[-1] for p in snap.glob("source_*"))) if snap else "none"
            return f'"{want}" is not in the capture snapshot and not on disk. Captured: {have}'
        src, origin = disk, "WORKING TREE -- may have drifted from the capture"

    text = src.read_text(errors="replace").splitlines()
    ln = int(line)
    lo, hi = max(1, ln - context), min(len(text), ln + context)
    o = [f"{file}:{ln}   ({origin}: {src})", ""]
    for i in range(lo, hi + 1):
        o.append(f"{'>' if i == ln else ' '} {i:6d}  {text[i-1]}")
    return clip("\n".join(o))


TOOLS: List[Tuple[str, str, dict, Callable]] = [
    ("att_current",
     "The trace the ATT Viewer panel currently has open, with its summary, plus any "
     "instructions the user highlighted and sent over with the panel's \"Add to chat\" button. "
     "Call this first whenever the user says \"this trace\", \"the current trace\", \"the one I "
     "have open\", \"these instructions\", \"the code I selected\", or asks about a kernel "
     "without naming a run.",
     {},
     t_current),
    ("att_summary",
     "Kernel footprint, occupancy, cycle budget, stall breakdown and hot loop for one run. "
     "The first call on a run analyzes it (~2s).",
     {"run": ("string", "run id, capture directory, or .att path")},
     t_summary),
    ("att_phases",
     "Mark where the traced code stops setting up, starts iterating and starts draining: the "
     "prologue, mainline and epilogue split at the hot loop's edges, with the cycles, stall "
     "reasons and costliest instructions of each. Use it to see whether a dispatch is paying "
     "for setup or drain rather than for the loop.",
     {"run": ("string", "run id, capture directory, or .att path")},
     t_phases),
    ("att_issues",
     "List the static machine-code findings and the trace-level findings for a run, with the "
     "cycles each costs. Use att_issue for the evidence behind one.",
     {"run": ("string", "run id, capture directory, or .att path")},
     t_issues),
    ("att_issue",
     "One finding in full: why it fires, what it cost, and every instruction site backing it.",
     {"run": ("string", "run id, capture directory, or .att path"),
      "index": ("string", "index from att_issues, or a substring of its title/kind")},
     t_issue),
    ("att_disasm",
     "Annotated disassembly for an address range: per-instruction issue count, stall cycles, "
     "execution cycles and source line. Defaults to the whole analyzed listing.",
     {"run": ("string", "run id, capture directory, or .att path"),
      "begin": ("string", "first address, decimal or 0x hex"),
      "end": ("string", "last address, decimal or 0x hex"),
      "around": ("string", "centre on this address instead, +/-128 bytes"),
      "limit": ("integer", "max instructions to print (default 200)")},
     t_disasm),
    ("att_hot",
     "The hottest source lines or instructions of a run, ranked by stall cycles.",
     {"run": ("string", "run id, capture directory, or .att path"),
      "by": ("string", '"line" (default) or "inst"'),
      "limit": ("integer", "how many rows (default 20)")},
     t_hot),
    ("att_source",
     "Read source around a line from the copy rocprofv3 saved at capture time. Use this rather "
     "than opening the file from the working tree, whose line numbers have drifted.",
     {"run": ("string", "run id, capture directory, or .att path"),
      "file": ("string", "path or basename as the report reports it"),
      "line": ("integer", "line to centre on"),
      "context": ("integer", "lines either side (default 20)")},
     t_source),
]


def tool_schema() -> List[dict]:
    out = []
    for name, desc, params, _ in TOOLS:
        props = {}
        for pname, (ptype, pdesc) in params.items():
            props[pname] = {"type": ptype, "description": pdesc}
            if ptype == "array":
                props[pname]["items"] = {"type": "string"}
        required = ["run"] if "run" in props else (["refs"] if "refs" in props else [])
        out.append({"name": name, "description": desc,
                    "inputSchema": {"type": "object", "properties": props, "required": required}})
    return out


# ---------------------------------------------------------------------------- JSON-RPC loop


def call_tool(name: str, args: dict) -> str:
    fn = next((f for n_, _, _, f in TOOLS if n_ == name), None)
    if fn is None:
        raise ValueError(f"unknown tool {name}")
    return fn(discover(), **(args or {}))


def serve() -> None:
    """Read line-delimited JSON-RPC on stdin, answer on stdout, log on stderr."""
    proto = "2024-11-05"
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue

        method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
        result, error = None, None
        try:
            if method == "initialize":
                proto = params.get("protocolVersion", proto)
                result = {"protocolVersion": proto,
                          "capabilities": {"tools": {}},
                          "serverInfo": {"name": "att-analysis", "version": "0.1.0"}}
            elif method in ("notifications/initialized", "notifications/cancelled"):
                continue
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tool_schema()}
            elif method == "tools/call":
                text = call_tool(params.get("name", ""), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": text}], "isError": False}
            else:
                error = {"code": -32601, "message": f"method not found: {method}"}
        except Exception as e:  # a tool failure is an answer, not a dead server
            log(traceback.format_exc().strip().splitlines()[-1])
            if method == "tools/call":
                result = {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True}
            else:
                error = {"code": -32603, "message": str(e)}

        if rid is None:
            continue
        msg = {"jsonrpc": "2.0", "id": rid}
        msg["error" if error else "result"] = error or result
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def main() -> None:
    # A plain `--selftest <run>` run makes the tools debuggable without an MCP client attached.
    if len(sys.argv) > 2 and sys.argv[1] == "--selftest":
        runs = discover()
        print(t_summary(runs, run=sys.argv[2]))
        return
    # The viewer panel draws the same split on the timeline, and asking for it here reuses
    # the run resolution and the report cache instead of re-deriving either in the extension.
    if len(sys.argv) > 2 and sys.argv[1] == "--phases":
        d = report(resolve(discover(), sys.argv[2]))
        asm, loop = d.get("asm") or {}, ((d.get("asm") or {}).get("loop") or {})
        ph = d.get("phases") or {}
        json.dump({
            "codeobj": asm.get("codeobj"),
            "begin": loop.get("begin"),
            "end": loop.get("end"),
            "phases": ph.get("phases") or [],
            "dividers": ph.get("dividers") or [],
        }, sys.stdout)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        for rid in sorted(discover()):
            print(rid)
        return
    serve()


if __name__ == "__main__":
    main()
