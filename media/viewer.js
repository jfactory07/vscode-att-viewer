/* global window */

(async function () {
  // VS Code webview messaging
  const vscode = acquireVsCodeApi();

  const jsonUri = window.__ATT_JSON_URI__;
  const traceKey = window.__ATT_TRACE_KEY__ || "";
  const metaEl = document.getElementById("meta");
  const legendEl = document.getElementById("legend");
  const viewport = document.getElementById("viewport");
  const canvas = document.getElementById("c");
  const tip = document.getElementById("tip");
  const loading = document.getElementById("loading");
  const colorsBtn = document.getElementById("colorsBtn");
  const cfg = document.getElementById("cfg");
  const cfgBody = document.getElementById("cfgBody");
  const cfgClose = document.getElementById("cfgClose");
  const cfgReset = document.getElementById("cfgReset");
  const divider = document.getElementById("divider");
  const srcMeta = document.getElementById("srcMeta");
  const srcBody = document.getElementById("srcBody");
  const ctx = canvas.getContext("2d");

  // webview state persistence (fallback when VS Code reloads the webview)
  function getUiState() {
    try { return vscode.getState() || null; } catch { return null; }
  }
  function setUiState(state) {
    try { vscode.setState(state); } catch { /* ignore */ }
  }
  // Read once to avoid TDZ issues with later `const` declarations.
  const SAVED_UI_STATE = getUiState();
  // Guard against early message events before the timeline state is initialized.
  // (Using `typeof view` is unsafe due to TDZ when `view` is a later `let`.)
  let _uiReady = false;
  let _drawRequestedBeforeReady = false;
  let _uiStateTimer = null;
  function scheduleSaveUiState() {
    if (!_uiReady) return;
    if (_uiStateTimer) clearTimeout(_uiStateTimer);
    _uiStateTimer = setTimeout(() => {
      _uiStateTimer = null;
      let v = null;
      let cm = null;
      let sel = null;
      let sm = null;
      let lf = null;
      let rs = null;
      let ds = null;
      try { v = view ? { min: view.min, max: view.max } : null; } catch { v = null; }
      try { cm = currentMarkerId; } catch { cm = null; }
      try { sel = selected; } catch { sel = null; }
      try { sm = sourceMode; } catch { sm = null; }
      try { lf = occLaneFilter; } catch { lf = null; }
      try {
        rs = regSel
          ? { key: regSel.key, focusLine: regSel.focusLine, atomsKey: Array.from(regSel.atoms || []).join(",") }
          : null;
      } catch { rs = null; }
      try {
        ds = disSearch
          ? { query: disSearch.query, regex: disSearch.regex, icase: disSearch.icase, all: disSearch.all }
          : null;
      } catch { ds = null; }

      let hp = null;
      try {
        hp = { open: hipOpen, file: hipFile, w: hipW, sel: hipSel };
      } catch { hp = null; }

      const st = {
        view: v,
        viewportScrollTop: viewport ? viewport.scrollTop : 0,
        srcScrollTop: srcBody ? srcBody.scrollTop : 0,
        currentMarkerId: cm,
        selected: sel,
        sourceMode: sm,
        occLaneFilter: lf,
        regSel: rs,
        disSearch: ds,
        hip: hp,
      };
      setUiState(st);
    }, 180);
  }

  const ROW_H = 14;
  const ROW_PAD = 2;
  // On gfx10+ the decoder reports duration as stall + *execution* time, so a wave issues the
  // next instruction while the previous one is still running: an 8-cycle WMMA with SALU issuing
  // behind it, or four 3-cycle ds_store_b128 issued one per cycle. Those windows genuinely
  // overlap, so a slot's row is split into sub-rows and overlapping windows are stacked. Real
  // traces need at most three sub-rows; a deeper pile-up shares the last one.
  const SUB_CAP = 4;
  const SUB_GAP = 1;
  // Cap on a slot's total row height, so stacking makes bars thinner instead of the timeline
  // taller. A slot with no overlap keeps the original single-row look, and a stacked bar is
  // never thicker than that one.
  const LANE_H_MAX = 30;
  // leave room for the cycle axis labels so wave0 doesn't overlap
  const TOP_PAD = 24;
  const LEFT_PAD = 80;
  const GRID_STEP_PX = 120;
  // Built-in defaults (shipped with the extension). User config can override these.
  // NOTE: extracted from the legend screenshot (pixel-accurate).
  const DEFAULT_STALL_COLOR = "#f90617";
  const BUILTIN_DEFAULT_COLORS = {
    SMEM: "#cad256",
    SALU: "#5e31c9",
    VMEM: "#e59138",
    FLAT: "#d4b18c",
    LDS: "#a87329",
    MFMA: "#114d05",
    VALU: "#ae74d8",
    JUMP: "#8e7cc3",
    NEXT: "#b4a7d6",
    IMMED: "#7f228c",
    CONTEXT: "#76a5af",
    MESSAGE: "#b8c318",
    BVH: "#8eb87a",
    NONE: "#777777",
  };

  let stallColor = DEFAULT_STALL_COLOR;

  function hideLoading() {
    if (loading) loading.style.display = "none";
  }

  function showLoading(msg) {
    if (!loading) return;
    loading.textContent = msg;
    loading.style.display = "block";
  }

  // Surface runtime errors instead of a blank webview.
  window.addEventListener("error", (ev) => {
    try {
      const msg = ev && ev.error && ev.error.stack ? String(ev.error.stack) : String(ev && ev.message ? ev.message : ev);
      showLoading("ATT Viewer error:\n" + msg);
    } catch { /* ignore */ }
  });
  window.addEventListener("unhandledrejection", (ev) => {
    try {
      const r = ev && ev.reason;
      const msg = r && r.stack ? String(r.stack) : String(r);
      showLoading("ATT Viewer error:\n" + msg);
    } catch { /* ignore */ }
  });

  showLoading("Loading trace…");
  /** @type {any} */
  let DATA = null;
  try {
    const res = await fetch(jsonUri);
    if (!res.ok) throw new Error(`Failed to load trace JSON (${res.status} ${res.statusText})`);
    DATA = await res.json();
  } catch (e) {
    const msg = (e && e.stack) ? String(e.stack) : String(e);
    showLoading("ATT Viewer error:\n" + msg);
    // eslint-disable-next-line no-console
    console.error(e);
    return;
  }
  hideLoading();

  // Mutable colors map (category -> color hex).
  // IMPORTANT: use built-in defaults as the baseline, regardless of any cached trace JSON.
  // (Older cached JSON files may contain outdated colors.)
  let COLORS = { ...BUILTIN_DEFAULT_COLORS };
  const CAT_NAMES = DATA.cat_names;

  const lanes = DATA.lanes;

  // A row is a wave *slot* on one (CU/WGP, SIMD), not a wave. ATT only produces per-wave
  // records for the single target CU + target SIMD, and a slot hosts a new wave whenever the
  // previous one retires, so rows are labelled by slot id rather than by row index. Older
  // cached JSON has no lane_info, so fall back to reading it off the events.
  const laneInfo = (() => {
    const arr = new Array(lanes).fill(null);
    if (Array.isArray(DATA.lane_info)) {
      for (let i = 0; i < lanes && i < DATA.lane_info.length; i++) {
        const l = DATA.lane_info[i];
        if (l) arr[i] = { cu: l.cu, simd: l.simd, slot: l.slot };
      }
    }
    for (const e of DATA.events) {
      if (e.lane < 0 || e.lane >= lanes || arr[e.lane]) continue;
      arr[e.lane] = { cu: e.cu, simd: e.simd, slot: e.slot };
    }
    for (let i = 0; i < lanes; i++) if (!arr[i]) arr[i] = { cu: 0, simd: 0, slot: i };
    return arr;
  })();
  const sameCu = laneInfo.every((l) => l.cu === laneInfo[0].cu);
  const sameSimd = laneInfo.every((l) => l.simd === laneInfo[0].simd);
  // gfx10+ reports a WGP id where gfx9 reports a CU id
  const CU_WORD = (DATA.meta && Number(DATA.meta.gfxip_major) >= 10) ? "wgp" : "cu";

  function laneLabel(i) {
    const l = laneInfo[i];
    if (!l) return `slot ${i}`;
    if (sameCu && sameSimd) return `slot ${l.slot}`;
    if (sameCu) return `sm${l.simd} sl${l.slot}`;
    return `${l.cu}.${l.simd}.${l.slot}`;
  }
  // narrow variant for the per-slot disasm columns
  function laneLabelShort(i) {
    const l = laneInfo[i];
    if (!l) return `s${i}`;
    return (sameCu && sameSimd) ? `s${l.slot}` : `${l.simd}.${l.slot}`;
  }
  function laneTitle(i) {
    const l = laneInfo[i];
    if (!l) return `row ${i}`;
    return `${CU_WORD}=${l.cu} simd=${l.simd} slot=${l.slot}`;
  }

  const eventsByLane = [];
  for (let i = 0; i < lanes; i++) eventsByLane.push([]);
  for (const e of DATA.events) eventsByLane[e.lane].push(e);
  for (const lane of eventsByLane) lane.sort((a, b) => a.issue - b.issue);
  // Longest event per lane, so drawEvents can rewind far enough to catch events that
  // start left of the viewport but still extend into it.
  const maxSpanByLane = eventsByLane.map((evs) =>
    evs.reduce((m, e) => Math.max(m, e.duration || 1), 1)
  );

  // Pack overlapping execution windows into sub-rows, first fit in issue order: an instruction
  // takes the topmost sub-row that is free at its issue cycle, so a row reads top-down in issue
  // order and concurrent instructions stay countable instead of painting over each other.
  const subRowsByLane = new Array(lanes).fill(1);
  for (let lane = 0; lane < lanes; lane++) {
    const ends = [];
    let deepest = 0;
    for (const e of eventsByLane[lane]) {
      const s = eventSpan(e);
      const start = s.barStart;
      let d = 0;
      while (d < ends.length && ends[d] > start) d++;
      if (d >= SUB_CAP) d = SUB_CAP - 1;
      ends[d] = s.barStart + Math.max(1, s.barLen);
      e.depth = d;
      if (d > deepest) deepest = d;
    }
    subRowsByLane[lane] = deepest + 1;
  }

  const subHByLane = subRowsByLane.map((n) =>
    n <= 1
      ? ROW_H - ROW_PAD * 2
      : Math.min(
          ROW_H - ROW_PAD * 2,
          Math.max(3, Math.floor((LANE_H_MAX - ROW_PAD * 2 - (n - 1) * SUB_GAP) / n))
        )
  );
  const laneHByLane = subRowsByLane.map(
    (n, i) => ROW_PAD * 2 + n * subHByLane[i] + (n - 1) * SUB_GAP
  );
  const laneYByLane = [];
  {
    let y = TOP_PAD;
    for (let i = 0; i < lanes; i++) {
      laneYByLane.push(y);
      y += laneHByLane[i];
    }
  }
  const lanesTotalH = laneHByLane.reduce((a, b) => a + b, 0);

  function laneAtY(y) {
    for (let i = 0; i < lanes; i++) {
      if (y >= laneYByLane[i] && y < laneYByLane[i] + laneHByLane[i]) return i;
    }
    return -1;
  }

  function subRowAtY(lane, y) {
    const n = subRowsByLane[lane];
    if (n <= 1) return 0;
    const step = subHByLane[lane] + SUB_GAP;
    const d = Math.floor((y - (laneYByLane[lane] + ROW_PAD)) / step);
    return Math.max(0, Math.min(n - 1, d));
  }

  function subRowY(lane, depth) {
    const d = Math.max(0, Math.min(subRowsByLane[lane] - 1, depth || 0));
    return laneYByLane[lane] + ROW_PAD + d * (subHByLane[lane] + SUB_GAP);
  }

  // index: marker|pc -> stats + list of event refs
  // stats include per-lane counts and dominant category for coloring disasm
  const pcIndex = new Map();
  for (let idx = 0; idx < DATA.events.length; idx++) {
    const e = DATA.events[idx];
    const k = `${e.marker_id}|${e.pc}`;
    let v = pcIndex.get(k);
    if (!v) {
      v = { first: e.issue, idxs: [idx], laneCounts: new Map(), catCounts: new Map() };
      pcIndex.set(k, v);
    } else {
      v.idxs.push(idx);
      if (e.issue < v.first) v.first = e.issue;
    }
    v.laneCounts.set(e.lane, (v.laneCounts.get(e.lane) || 0) + 1);
    const c = e.cat || "NONE";
    v.catCounts.set(c, (v.catCounts.get(c) || 0) + 1);
  }
  for (const v of pcIndex.values()) {
    // compute dominant category (mode)
    let bestCat = "NONE";
    let bestN = -1;
    for (const [c, n] of v.catCounts.entries()) {
      if (n > bestN) { bestN = n; bestCat = c; }
    }
    v.cat = bestCat;
    delete v.catCounts;
  }

  const codeobjFiles = (DATA.meta && DATA.meta.codeobj_files) ? DATA.meta.codeobj_files : {};

  const scopeText = (sameCu && sameSimd)
    ? `${CU_WORD}=${laneInfo[0].cu} simd=${laneInfo[0].simd}  `
    : "";
  metaEl.textContent = `${scopeText}slots=${lanes}  events=${DATA.events.length}  cycles=[${DATA.min_cycle}, ${DATA.max_cycle}]`;

  function renderLegend() {
    legendEl.innerHTML = "";
    for (const [cat, col] of Object.entries(COLORS)) {
      const d = document.createElement("div");
      d.className = "chip";
      d.innerHTML = `<span class="swatch" style="background:${col}"></span><span>${cat}</span>`;
      legendEl.appendChild(d);
    }
    const d = document.createElement("div");
    d.className = "chip";
    d.innerHTML = `<span class="swatch" style="background:${stallColor}"></span><span>STALL (line)</span>`;
    legendEl.appendChild(d);
  }

  renderLegend();

  function openCfg() { cfg.style.display = "block"; }
  function closeCfg() { cfg.style.display = "none"; }
  if (colorsBtn) colorsBtn.addEventListener("click", () => (cfg.style.display === "none" ? openCfg() : closeCfg()));
  if (cfgClose) cfgClose.addEventListener("click", closeCfg);

  function buildCfgUI() {
    cfgBody.innerHTML = "";
    // categories
    const keys = Object.keys(COLORS).sort();
    for (const k of keys) {
      const row = document.createElement("div");
      row.className = "cfgRow";
      const lab = document.createElement("label");
      lab.textContent = k;
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = COLORS[k];
      inp.addEventListener("input", () => {
        COLORS[k] = inp.value;
        renderLegend();
        requestDraw();
        saveColors();
      });
      row.appendChild(lab);
      row.appendChild(inp);
      cfgBody.appendChild(row);
    }
    // stall line
    {
      const row = document.createElement("div");
      row.className = "cfgRow";
      const lab = document.createElement("label");
      lab.textContent = "STALL (line)";
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = stallColor;
      inp.addEventListener("input", () => {
        stallColor = inp.value;
        renderLegend();
        requestDraw();
        saveColors();
      });
      row.appendChild(lab);
      row.appendChild(inp);
      cfgBody.appendChild(row);
    }
  }

  function saveColors() {
    vscode.postMessage({ type: "saveColors", value: { colors: COLORS, stallColor } });
  }

  function resetColors() {
    COLORS = { ...BUILTIN_DEFAULT_COLORS };
    stallColor = DEFAULT_STALL_COLOR;
    buildCfgUI();
    renderLegend();
    requestDraw();
    // Ask the extension host to atomically reset persisted overrides to defaults.
    // This avoids message ordering races between saveColors/requestColors.
    vscode.postMessage({ type: "resetColors" });
  }

  if (cfgReset) cfgReset.addEventListener("click", resetColors);
  buildCfgUI();

  // load persisted config (if any)
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "colors") {
      // If value is null/empty, treat as "no overrides" and revert to built-in defaults.
      if (!msg.value) {
        COLORS = { ...BUILTIN_DEFAULT_COLORS };
        stallColor = DEFAULT_STALL_COLOR;
      } else {
        const v = msg.value;
        if (v.colors && typeof v.colors === "object") COLORS = { ...COLORS, ...v.colors };
        if (typeof v.stallColor === "string") stallColor = v.stallColor;
      }
      buildCfgUI();
      renderLegend();
      requestDraw();
    } else if (msg.type === "markers" && Array.isArray(msg.value)) {
      MARKERS = msg.value.map((x) => Number(x)).filter((x) => Number.isFinite(x));
      MARKERS.sort((a, b) => a - b);
      requestDraw();
    }
  });
  vscode.postMessage({ type: "requestColors" });
  vscode.postMessage({ type: "requestMarkers", traceKey });

  // ---- source/disassembly pane ----
  let currentMarkerId = null;
  let disasmLines = []; // [{addr,text,file?,line?}]
  let disasmAddrToEl = new Map();
  let selected = null; // { marker_id, pc, lane, issue }
  let sourceMode = "disasm"; // "disasm" | "occ"
  let occSelectedKey = null; // `${lane}|${issue}|${pc}`
  let occLaneFilter = null; // null = all lanes, else lane id number
  // register selection/highlighting in disasm
  let regSel = null; // { key: string, atoms: Set<string>, focusLine: number }
  let regSelVersion = 0;
  const REG_HL_FORWARD_LINES = 200;
  // waitcnt target arrows (derived from disasm text)
  let waitSel = null; // { fromLine:number, targets:Array<{type:string, cls:"lgkm"|"vm", label:string, n:number, line:number, pc:number}> }
  let waitSelVersion = 0;
  const WAIT_SCAN_BACK_LIMIT = 4096;
  // disasm row-range selection, used for copying assembly text out of the panel.
  // The grid is virtualized, so the range lives in line indices and the copied text is
  // rebuilt from `disasmLines` rather than scraped from the DOM.
  let disRange = null; // { a:number, b:number } inclusive, unordered
  let disRangeVersion = 0;
  // disasm search. Only the matching line indices are kept; the per-line match ranges are
  // recomputed for the few visible rows, so a query that hits most of a large listing stays
  // cheap. `cur` indexes into `lines`. The listing covers the whole code object, most of which
  // never issued in the traced dispatch, so by default only sampled lines are searched and
  // `skipped` counts the matches that were left out.
  let disSearch = {
    query: "", regex: false, icase: true, all: false,
    invalid: false, lines: [], cur: -1, skipped: 0,
  };
  // HIP source pane, to the right of the listing. Every position comes from the code object's
  // DWARF line table, so the pane stays unavailable for one built without -gline-tables-only.
  let hipOpen = false;
  let hipW = 460; // pane width in px
  let hipFile = ""; // file on show
  let hipLines = null; // its text split into lines, null while the host is reading it
  let hipError = "";
  let hipSel = null; // { file, line } picked in the pane; tints the instructions it compiled to
  let hipSelVersion = 0;
  let hipCur = null; // { file, line } the pane is pointed at, from the last instruction followed
  let hipStack = null; // [{ func, file, line }] innermost first, from llvm-symbolizer --inlining
  let hipStackFrame = 0; // which stack entry hipCur follows
  let hipStackReq = 0;
  let hipStackLoading = false;
  const hipTextCache = new Map(); // path -> string[]
  const hipSnapOf = new Map(); // compile-time path -> the capture-time copy it was read from
  let srcSnapshot = null; // { dir, files } the host found next to the trace
  let srcLineIndex = new Map(); // "file|line" -> ascending disasm row indices
  let srcFiles = []; // [{ file, count }], most instructions first
  const HIP_ROW_H = 18;
  let disSearchSet = null; // Set of matching line indices, for O(1) lookup while rendering
  let disSearchVersion = 0;

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Wraps every [a,b) slice of `s` listed in `ranges` in a search-highlight span. Ranges are
  // relative to `s`, sorted and non-overlapping.
  function markRangesHtml(s, ranges) {
    const str = String(s);
    if (!ranges || ranges.length === 0) return escapeHtml(str);
    let out = "";
    let last = 0;
    for (const r of ranges) {
      const lo = Math.max(last, Math.min(str.length, r[0]));
      const hi = Math.max(lo, Math.min(str.length, r[1]));
      if (hi <= lo) continue;
      if (lo > last) out += escapeHtml(str.slice(last, lo));
      out += `<span class="searchMark">${escapeHtml(str.slice(lo, hi))}</span>`;
      last = hi;
    }
    if (last < str.length) out += escapeHtml(str.slice(last));
    return out;
  }

  // Same, for a sub-slice of `s`; `ranges` stay in whole-string coordinates.
  function markSliceHtml(s, a, b, ranges) {
    if (!ranges || ranges.length === 0) return escapeHtml(s.slice(a, b));
    const local = [];
    for (const r of ranges) {
      const lo = Math.max(a, r[0]);
      const hi = Math.min(b, r[1]);
      if (hi > lo) local.push([lo - a, hi - a]);
    }
    return markRangesHtml(s.slice(a, b), local);
  }

  const _regTokenCache = new Map(); // token -> {atoms:Array<string>, key:string}
  function atomsFromRegToken(token) {
    const t = String(token);
    const cached = _regTokenCache.get(t);
    if (cached) return cached;
    const atoms = [];
    const addAtom = (a) => { if (a && !atoms.includes(a)) atoms.push(a); };
    const mRange = t.match(/^([vsa])\[(\d+):(\d+)\]$/);
    if (mRange) {
      const p = mRange[1];
      let a = Number(mRange[2]);
      let b = Number(mRange[3]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (a > b) { const tmp = a; a = b; b = tmp; }
        const span = Math.min(256, Math.max(0, b - a + 1)); // safety cap
        for (let i = 0; i < span; i++) addAtom(`${p}${a + i}`);
      }
    } else {
      const mSingle = t.match(/^([vsa])(\d+)$/);
      if (mSingle) {
        addAtom(`${mSingle[1]}${Number(mSingle[2])}`);
      } else {
        // special regs / names
        addAtom(t);
      }
    }
    atoms.sort();
    const key = atoms.join(",");
    const out = { atoms, key };
    _regTokenCache.set(t, out);
    return out;
  }

  function intersectsAtoms(tokenAtoms, selAtoms) {
    if (!selAtoms || !tokenAtoms || tokenAtoms.length === 0) return false;
    for (const a of tokenAtoms) if (selAtoms.has(a)) return true;
    return false;
  }

  // NOTE: do NOT use \b at end for array regs like v[0:3] (']' breaks \b)
  // We do manual boundary checks in renderAsmHtmlWithRegs.
  const REG_RE = /(?:[vsa]\[\d+:\d+\]|[vsa]\d+|ttmp\d+|vcc|exec|scc|m0)/g;
  function renderAsmHtmlWithRegs(text, enableHighlightForLine, hlRanges) {
    const s = String(text || "");
    let out = "";
    let last = 0;
    let m;
    while ((m = REG_RE.exec(s)) !== null) {
      const a = m.index;
      const b = a + m[0].length;
      if (a > last) out += markSliceHtml(s, last, a, hlRanges);
      const tok = m[0];
      // boundary check: avoid matching inside identifiers
      const pre = a > 0 ? s[a - 1] : "";
      const post = b < s.length ? s[b] : "";
      const isWord = (ch) => /[A-Za-z0-9_]/.test(ch);
      if ((pre && isWord(pre)) || (post && isWord(post))) {
        out += markSliceHtml(s, a, b, hlRanges);
        last = b;
        continue;
      }
      const info = atomsFromRegToken(tok);
      const isSel = !!(enableHighlightForLine && regSel && intersectsAtoms(info.atoms, regSel.atoms));
      out += `<span class="regTok${isSel ? " sel" : ""}" data-regtok="${escapeHtml(tok)}">${markSliceHtml(s, a, b, hlRanges)}</span>`;
      last = b;
    }
    if (last < s.length) out += markSliceHtml(s, last, s.length, hlRanges);
    return out || markSliceHtml(s, 0, s.length, hlRanges);
  }

  function mnemOfLineText(text) {
    const s = String(text || "").trim();
    if (!s) return "";
    return (s.split(/\s+/)[0] || "").trim();
  }

  // Producer predicates, one per hardware counter. gfx12 renamed the DS ops
  // (ds_read/ds_write -> ds_load/ds_store) and split the old vmcnt/lgkmcnt pair
  // into one counter per traffic class, so both spellings are matched here.
  function isDsOp(text) {
    // DS_CNT (LGKM_CNT's LDS half pre-gfx12): any LDS/GDS access.
    return /^ds_/.test(mnemOfLineText(text));
  }
  function isAsyncLdsCopy(text) {
    // ASYNC_CNT (gfx1250): asynchronous global <-> LDS copies.
    return /_async/.test(mnemOfLineText(text));
  }
  function isTensorOp(text) {
    // TENSOR_CNT (gfx1250): tensor_load_to_lds / tensor_store_from_lds.
    return /^tensor_/.test(mnemOfLineText(text));
  }
  function isVmemLoad(text) {
    if (isAsyncLdsCopy(text)) return false;
    return /^(global|buffer|flat|scratch|image)_load/.test(mnemOfLineText(text));
  }
  function isVmemStore(text) {
    if (isAsyncLdsCopy(text)) return false;
    // A non-returning atomic retires on STORE_CNT. A returning one retires on
    // LOAD_CNT instead, which the mnemonic alone does not distinguish, so
    // atomics are attributed to STORE_CNT (the common case in compute code).
    return /^(global|buffer|flat|scratch|image)_(store|atomic)/.test(mnemOfLineText(text));
  }
  function isVmemOp(text) {
    return isVmemLoad(text) || isVmemStore(text);
  }
  function isSmemLoad(text) {
    return /^s_(load|buffer_load)/.test(mnemOfLineText(text));
  }
  function isKmOp(text) {
    // KM_CNT (LGKM_CNT's scalar half pre-gfx12): scalar reads and messages.
    return isSmemLoad(text) || /^s_sendmsg/.test(mnemOfLineText(text));
  }
  function isExpOp(text) {
    return /^(exp|lds_direct_load|lds_param_load)/.test(mnemOfLineText(text));
  }
  function isImageSample(text) {
    return /^image_(sample|gather)/.test(mnemOfLineText(text));
  }
  function isImageBvh(text) {
    return /^image_bvh/.test(mnemOfLineText(text));
  }
  function isLgkmOp(text) {
    // Pre-gfx12 LGKM_CNT lumps LDS, scalar memory and messages into one counter.
    return isDsOp(text) || isKmOp(text);
  }
  function isXcntOp(text) {
    // X_CNT (gfx1250) counts memory ops that have not finished address
    // translation: VMEM and SMEM. LDS never leaves the WGP, so it is excluded.
    return isVmemOp(text) || isSmemLoad(text);
  }

  // `cls` selects one of the two row/badge highlight styles; `label` is the
  // badge text.
  const WAIT_COUNTERS = {
    ds: { label: "DS", cls: "lgkm", match: isDsOp },
    lgkm: { label: "LGKM", cls: "lgkm", match: isLgkmOp },
    km: { label: "KM", cls: "lgkm", match: isKmOp },
    load: { label: "LOAD", cls: "vm", match: isVmemLoad },
    store: { label: "STORE", cls: "vm", match: isVmemStore },
    vm: { label: "VM", cls: "vm", match: isVmemOp },
    tensor: { label: "TENSOR", cls: "vm", match: isTensorOp },
    async: { label: "ASYNC", cls: "vm", match: isAsyncLdsCopy },
    exp: { label: "EXP", cls: "vm", match: isExpOp },
    sample: { label: "SAMPLE", cls: "vm", match: isImageSample },
    bvh: { label: "BVH", cls: "vm", match: isImageBvh },
    x: { label: "X", cls: "vm", match: isXcntOp }
  };

  // gfx12+ per-counter waits. The operand is a bare immediate ("s_wait_dscnt
  // 0x2"), not the gfx9-style vmcnt(N)/lgkmcnt(N) list.
  const SINGLE_WAIT_COUNTER = {
    s_wait_loadcnt: "load",
    s_wait_storecnt: "store",
    s_wait_dscnt: "ds",
    s_wait_kmcnt: "km",
    s_wait_expcnt: "exp",
    s_wait_samplecnt: "sample",
    s_wait_bvhcnt: "bvh",
    s_wait_tensorcnt: "tensor",
    s_wait_asynccnt: "async",
    s_wait_xcnt: "x"
  };
  // The gfx12+ combined waits pack two counters into simm16: bits 15:8 hold the
  // load/store count and bits 7:0 the DS count (LLVM encodeLoadcntDscnt).
  const COMBINED_WAIT_COUNTERS = {
    s_wait_loadcnt_dscnt: ["load", "ds"],
    s_wait_storecnt_dscnt: ["store", "ds"]
  };
  // Counters are at most 6 bits wide; a larger immediate is a "do not wait"
  // encoding (e.g. 0xffff) with no instruction to point at.
  const WAIT_MAX_N = 63;

  function parseImmOperand(text) {
    const m = String(text || "").trim().match(/^(0x[0-9a-fA-F]+|\d+)/);
    if (!m) return null;
    const v = /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1], 10);
    return Number.isFinite(v) ? v : null;
  }

  // Returns [{ key, n }] naming each counter the instruction waits on, or null
  // when the line is not a wait instruction.
  function parseWaitcnt(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const mnem = mnemOfLineText(s);
    const operand = s.slice(mnem.length).trim();

    const combined = COMBINED_WAIT_COUNTERS[mnem];
    if (combined) {
      const v = parseImmOperand(operand);
      if (v == null) return null;
      return [
        { key: combined[0], n: (v >> 8) & 0xff },
        { key: combined[1], n: v & 0xff }
      ];
    }
    const single = SINGLE_WAIT_COUNTER[mnem];
    if (single) {
      const v = parseImmOperand(operand);
      if (v == null) return null;
      return [{ key: single, n: v }];
    }
    if (mnem === "s_waitcnt") {
      const out = [];
      const vmM = s.match(/vmcnt\((\d+)\)/);
      const lgkmM = s.match(/lgkmcnt\((\d+)\)/);
      const expM = s.match(/expcnt\((\d+)\)/);
      if (vmM) out.push({ key: "vm", n: Number(vmM[1]) });
      if (lgkmM) out.push({ key: "lgkm", n: Number(lgkmM[1]) });
      if (expM) out.push({ key: "exp", n: Number(expM[1]) });
      return out.length ? out : null;
    }
    return null;
  }

  function findNthPrevLine(fromLineIdx, predicate, nPlus1) {
    let found = 0;
    let steps = 0;
    for (let i = fromLineIdx - 1; i >= 0 && steps < WAIT_SCAN_BACK_LIMIT; i--, steps++) {
      const t = disasmLines[i] && disasmLines[i].text;
      if (!t) continue;
      if (predicate(t)) {
        found++;
        if (found === nPlus1) return i;
      }
    }
    return null;
  }

  function updateWaitSelFromSelected() {
    if (!selected || !srcBody || !srcBody._pcToLine || !disasmLines || disasmLines.length === 0) {
      if (waitSel) { waitSel = null; waitSelVersion++; }
      return;
    }
    if (String(selected.marker_id) !== String(currentMarkerId)) {
      if (waitSel) { waitSel = null; waitSelVersion++; }
      return;
    }
    const fromLine = srcBody._pcToLine.get(Number(selected.pc));
    if (fromLine == null) {
      if (waitSel) { waitSel = null; waitSelVersion++; }
      return;
    }
    const ln = disasmLines[fromLine];
    const info = ln ? parseWaitcnt(ln.text) : null;
    if (!info || info.length === 0) {
      if (waitSel) { waitSel = null; waitSelVersion++; }
      return;
    }
    const targets = [];
    for (const c of info) {
      const spec = WAIT_COUNTERS[c.key];
      if (!spec || !Number.isFinite(c.n) || c.n < 0 || c.n > WAIT_MAX_N) continue;
      // Waiting for at most N outstanding ops means the instruction being waited
      // on is the (N+1)-th preceding one that bumps this counter.
      const tLine = findNthPrevLine(Number(fromLine), spec.match, Number(c.n) + 1);
      if (tLine != null && disasmLines[tLine]) {
        targets.push({
          type: c.key,
          cls: spec.cls,
          label: spec.label,
          n: Number(c.n),
          line: Number(tLine),
          pc: Number(disasmLines[tLine].addr)
        });
      }
    }
    // Only update version if value changed (reduce redraw churn)
    const next = { fromLine: Number(fromLine), targets };
    const same =
      waitSel &&
      waitSel.fromLine === next.fromLine &&
      JSON.stringify(waitSel.targets) === JSON.stringify(next.targets);
    if (!same) {
      waitSel = next;
      waitSelVersion++;
      if (srcBody && typeof srcBody._requestWaitLinks === "function") srcBody._requestWaitLinks();
    }
  }

  const sourceHeader = srcMeta ? srcMeta.parentElement : null;
  const sourcePane = sourceHeader ? sourceHeader.parentElement : null;
  let pathBtn = null;
  let currentCodeobjPath = "";
  let hipBtn = null;
  let hipPane = null;
  let hipDivider = null;
  let hipBody = null;
  let hipFileSel = null;
  let hipMetaEl = null;
  let hipStackEl = null;
  let tabDisasmBtn = null;
  let tabOccBtn = null;
  let copyBtn = null;
  let findInput = null;
  let findWrap = null;
  let findCountEl = null;
  let findPrevBtn = null;
  let findNextBtn = null;
  let findCaseBtn = null;
  let findReBtn = null;
  let findAllBtn = null;
  if (sourceHeader) {
    // The header names the code object by file name only -- the directory is long, always the
    // same within a capture, and pushes the tabs around -- so keep the full path one click away.
    pathBtn = document.createElement("button");
    pathBtn.className = "tabBtn";
    pathBtn.id = "srcPathBtn";
    pathBtn.textContent = "copy path";
    pathBtn.addEventListener("click", async () => {
      if (!currentCodeobjPath) return;
      await writeClipboard(currentCodeobjPath);
      showToast(`Copied ${currentCodeobjPath}`);
    });
    sourceHeader.appendChild(pathBtn);

    const tabs = document.createElement("div");
    tabs.className = "srcTabs";

    findWrap = document.createElement("div");
    findWrap.className = "srcFind";
    findInput = document.createElement("input");
    findInput.className = "findInput";
    findInput.type = "text";
    findInput.spellcheck = false;
    findInput.placeholder = "Find instruction";
    findInput.title =
      "Search the disassembly (Ctrl/Cmd+F), matching the instruction text and the addr column.\n" +
      "Enter = next match, Shift+Enter = previous, Esc = clear.";
    findWrap.appendChild(findInput);
    const mkFindBtn = (text, title) => {
      const b = document.createElement("button");
      b.className = "tabBtn iconBtn";
      b.textContent = text;
      b.title = title;
      findWrap.appendChild(b);
      return b;
    };
    findCaseBtn = mkFindBtn("Aa", "Match case");
    findReBtn = mkFindBtn(".*", "Use a regular expression, e.g. ^v_mfma or s_wait_.*cnt");
    findAllBtn = mkFindBtn(
      "all",
      "Also match instructions the trace never sampled (total = 0).\n" +
        "Off by default: the listing is the whole code object, most of which the dispatch never ran."
    );
    findCountEl = document.createElement("span");
    findCountEl.className = "findCount";
    findCountEl.title = "current match / matching lines";
    findWrap.appendChild(findCountEl);
    findPrevBtn = mkFindBtn("↑", "Previous match (Shift+Enter)");
    findNextBtn = mkFindBtn("↓", "Next match (Enter)");
    tabs.appendChild(findWrap);

    copyBtn = document.createElement("button");
    copyBtn.className = "tabBtn";
    copyBtn.textContent = "Copy";
    copyBtn.title =
      "Copy the selected disassembly lines (Ctrl/Cmd+C).\n" +
      "Click or drag rows to select, Shift+click to extend, Ctrl/Cmd+A for all lines, Esc to clear.\n" +
      "Right-click the listing for other copy formats.";
    tabs.appendChild(copyBtn);
    tabDisasmBtn = document.createElement("button");
    tabDisasmBtn.className = "tabBtn active";
    tabDisasmBtn.textContent = "Disasm";
    tabOccBtn = document.createElement("button");
    tabOccBtn.className = "tabBtn";
    tabOccBtn.textContent = "Occurrences";
    hipBtn = document.createElement("button");
    hipBtn.className = "tabBtn";
    hipBtn.textContent = "HIP";
    tabs.appendChild(hipBtn);
    hipBtn.addEventListener("click", () => setHipOpen(!hipOpen));
    tabs.appendChild(tabDisasmBtn);
    tabs.appendChild(tabOccBtn);
    sourceHeader.appendChild(tabs);
  }

  // ---- HIP source pane ----
  //
  // .sourcePane is a two-row grid (header, body); opening the pane turns it into a two-column
  // one and drops the divider and the pane into the new column, so the listing keeps its own
  // DOM untouched and closing the pane costs nothing.
  function buildSrcIndex() {
    srcLineIndex = new Map();
    const per = new Map();
    for (let i = 0; i < disasmLines.length; i++) {
      const ln = disasmLines[i];
      if (!ln.file) continue;
      const k = `${ln.file}|${ln.line}`;
      let a = srcLineIndex.get(k);
      if (!a) srcLineIndex.set(k, (a = []));
      a.push(i);
      per.set(ln.file, (per.get(ln.file) || 0) + 1);
    }
    srcFiles = [...per.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : 1));
  }

  function hasLineInfo() {
    return srcFiles.length > 0;
  }

  // The pane only ever shows the copies rocprof saved with the trace, so it needs both a line
  // table to place the instructions and a capture that actually saved the sources.
  function hasSourceSnapshot() {
    return !!(srcSnapshot && srcSnapshot.files > 0);
  }

  function hipAvailable() {
    return hasLineInfo() && hasSourceSnapshot();
  }

  function baseName(p) {
    const s = String(p || "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function ensureHipDom() {
    if (hipPane || !sourcePane) return;
    hipDivider = document.createElement("div");
    hipDivider.className = "vdivider";
    hipDivider.title = "Drag to resize the HIP source pane";
    hipPane = document.createElement("div");
    hipPane.className = "hipPane";

    const head = document.createElement("div");
    head.className = "hipHeader";
    hipFileSel = document.createElement("select");
    hipFileSel.className = "hipFileSel";
    hipFileSel.title = "Source files this code object was compiled from";
    hipFileSel.addEventListener("change", () => showHipFile(hipFileSel.value));
    head.appendChild(hipFileSel);
    hipMetaEl = document.createElement("span");
    hipMetaEl.className = "hipMeta";
    head.appendChild(hipMetaEl);
    const closeBtn = document.createElement("button");
    closeBtn.className = "tabBtn iconBtn";
    closeBtn.textContent = "×";
    closeBtn.title = "Close the HIP source pane";
    closeBtn.addEventListener("click", () => setHipOpen(false));
    head.appendChild(closeBtn);

    hipStackEl = document.createElement("div");
    hipStackEl.className = "hipStack";
    hipStackEl.title = "Inline call stack for the selected instruction; click a frame to jump";

    hipBody = document.createElement("div");
    hipBody.className = "hipBody";
    hipBody.addEventListener("click", (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest(".hipRow") : null;
      // A line that compiled to nothing has nothing to point at, so leave it inert.
      if (!row || !row.classList.contains("hasAsm")) return;
      selectHipLine(Number(row.dataset.line));
    });

    hipPane.appendChild(head);
    hipPane.appendChild(hipStackEl);
    hipPane.appendChild(hipBody);
    sourcePane.appendChild(hipDivider);
    sourcePane.appendChild(hipPane);
    bindHipDivider();
  }

  function bindHipDivider() {
    let dragging = false;
    hipDivider.addEventListener("mousedown", (ev) => {
      dragging = true;
      ev.preventDefault();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging || !sourcePane) return;
      const r = sourcePane.getBoundingClientRect();
      // Leave the listing at least a third of the pane; it is still the primary view.
      hipW = Math.max(220, Math.min(r.width * 0.67, r.right - ev.clientX));
      applyHipLayout();
      scheduleSaveUiState();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function applyHipLayout() {
    if (!sourcePane) return;
    sourcePane.classList.toggle("withHip", hipOpen);
    sourcePane.style.setProperty("--hipW", `${Math.round(hipW)}px`);
    if (hipPane) hipPane.style.display = hipOpen ? "" : "none";
    if (hipDivider) hipDivider.style.display = hipOpen ? "" : "none";
  }

  function updateHipBtn() {
    if (!hipBtn) return;
    const on = hipAvailable();
    hipBtn.disabled = !on;
    hipBtn.classList.toggle("active", hipOpen && on);
    hipBtn.title = on
      ? "Show the HIP source next to the listing, as rocprof captured it with the trace.\n" +
        "Click an instruction to reach its source line; click a source line to mark every " +
        "instruction it compiled to."
      : !hasLineInfo()
        ? "This code object carries no DWARF line table, so no instruction can be traced back to " +
          "HIP. Rebuild with -gline-tables-only (in hipconv: -DHIPCONV_LINE_TABLES=ON) and " +
          "profile again."
        : "This capture saved no HIP sources next to the trace, and the pane will not read the " +
          "working tree instead: its line numbers are the ones the code object was built with, " +
          "and an edited file silently shifts them.";
  }

  function setHipOpen(open) {
    if (open && !hipAvailable()) return;
    hipOpen = !!open;
    if (hipOpen) {
      ensureHipDom();
      // Default to the file most of the code came from, usually the kernel header.
      if (!hipFile && srcFiles.length) showHipFile(srcFiles[0].file);
      else renderHipFileSel();
      syncHipToSelected();
      if (selected && selected.marker_id === currentMarkerId) requestHipStack(selected.pc);
    }
    applyHipLayout();
    updateHipBtn();
    scheduleSaveUiState();
  }

  function renderHipFileSel() {
    if (!hipFileSel) return;
    hipFileSel.innerHTML = "";
    for (const f of srcFiles) {
      const opt = document.createElement("option");
      opt.value = f.file;
      opt.textContent = `${baseName(f.file)}  (${f.count})`;
      opt.title = hipFileHint(f.file);
      hipFileSel.appendChild(opt);
    }
    hipFileSel.value = hipFile;
    hipFileSel.title = hipFile ? hipFileHint(hipFile) : "Source files this code object was compiled from";
  }

  // The path in the line table is where the file was compiled from, which is also where the
  // working tree keeps it -- so naming it on its own reads as though the pane were showing that
  // file. Say which one is on screen.
  function hipFileHint(file) {
    const snap = hipSnapOf.get(file);
    const where = snap
      ? snap
      : srcSnapshot && srcSnapshot.dir
        ? `${srcSnapshot.dir}/source_*_${baseName(file)}`
        : "the copy captured with the trace";
    return `${file}\nthe path the code object was compiled from.\nOn screen is the copy captured with the trace:\n${where}`;
  }

  function showHipFile(pathStr) {
    const p = String(pathStr || "");
    if (!p) return;
    hipFile = p;
    hipError = "";
    renderHipFileSel();
    const cached = hipTextCache.get(p);
    if (cached) {
      hipLines = cached;
      renderHipBody();
      return;
    }
    hipLines = null;
    renderHipBody();
    vscode.postMessage({ type: "requestSource", path: p });
  }

  function onSourceText(pathStr, text, snapshotPath) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    hipTextCache.set(pathStr, lines);
    // The dropdown was built before the host said which copy it read, so let it say so now.
    if (snapshotPath && hipSnapOf.get(pathStr) !== snapshotPath) {
      hipSnapOf.set(pathStr, snapshotPath);
      renderHipFileSel();
    }
    if (pathStr !== hipFile) return;
    hipLines = lines;
    hipError = "";
    renderHipBody();
    if (hipCur && hipCur.file === hipFile) {
      scrollHipTo(hipCur.line);
      paintHipMarks();
    }
  }

  function onSourceError(pathStr, error) {
    if (pathStr !== hipFile) return;
    hipLines = null;
    hipError = String(error || "unavailable");
    renderHipBody();
  }

  // Rows are plain and fixed height, so scrolling to a line is arithmetic and a whole kernel
  // header stays cheap to hold in the DOM.
  function renderHipBody() {
    if (!hipBody) return;
    hipBody.innerHTML = "";
    if (hipMetaEl) hipMetaEl.textContent = "";
    if (hipError) {
      const m = document.createElement("div");
      m.className = "hipNote";
      m.textContent = `Cannot read ${hipFile}: ${hipError}`;
      hipBody.appendChild(m);
      return;
    }
    if (!hipLines) {
      const m = document.createElement("div");
      m.className = "hipNote";
      m.textContent = "Loading…";
      hipBody.appendChild(m);
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < hipLines.length; i++) {
      const lineNo = i + 1;
      const idxs = srcLineIndex.get(`${hipFile}|${lineNo}`);
      const row = document.createElement("div");
      row.className = "hipRow";
      row.dataset.line = String(lineNo);
      row.style.height = `${HIP_ROW_H}px`;
      if (idxs) {
        row.classList.add("hasAsm");
        row.title = `${idxs.length} instruction${idxs.length === 1 ? "" : "s"}`;
      }
      const num = document.createElement("div");
      num.className = "hipNum";
      num.textContent = String(lineNo);
      const txt = document.createElement("div");
      txt.className = "hipTxt";
      txt.textContent = hipLines[i];
      row.appendChild(num);
      row.appendChild(txt);
      frag.appendChild(row);
    }
    hipBody.appendChild(frag);
    const n = srcFiles.find((f) => f.file === hipFile);
    if (hipMetaEl) {
      hipMetaEl.textContent = `${n ? `${n.count} instr · ` : ""}snapshot`;
      const snap = hipSnapOf.get(hipFile);
      hipMetaEl.title =
        `The text is the copy rocprof saved with the trace${snap ? `:\n${snap}` : ""}\n` +
        "not the file in the working tree, which the line numbers would no longer fit once it " +
        "is edited.";
    }
    paintHipMarks();
  }

  function hipRowAt(lineNo) {
    if (!hipBody) return null;
    return hipBody.querySelector(`.hipRow[data-line="${lineNo}"]`);
  }

  // The pane marks two lines: the one the instruction last followed came from, and the one the
  // reader clicked here (they differ while a click is being followed into the listing).
  function paintHipMarks() {
    if (!hipBody) return;
    const curLine = hipCur && hipCur.file === hipFile ? hipCur.line : -1;
    const selLine = hipSel && hipSel.file === hipFile ? hipSel.line : -1;
    for (const row of hipBody.querySelectorAll(".hipRow")) {
      const ln = Number(row.dataset.line);
      row.classList.toggle("cur", ln === curLine);
      row.classList.toggle("sel", ln === selLine);
    }
  }

  function scrollHipTo(lineNo) {
    if (!hipBody || !hipLines) return;
    const top = (lineNo - 1) * HIP_ROW_H;
    const view = hipBody.clientHeight || 0;
    if (top < hipBody.scrollTop || top > hipBody.scrollTop + view - HIP_ROW_H) {
      hipBody.scrollTop = Math.max(0, top - view * 0.4);
    }
  }

  function srcPosOfLine(idx) {
    const ln = idx == null ? null : disasmLines[idx];
    return ln && ln.file ? { file: ln.file, line: ln.line } : null;
  }

  function clearHipStack() {
    hipStack = null;
    hipStackFrame = 0;
    hipStackLoading = false;
    renderHipStack();
  }

  function requestHipStack(pc) {
    if (!hipOpen || !currentCodeobjPath) {
      clearHipStack();
      return;
    }
    const pcNum = Number(pc);
    if (!Number.isFinite(pcNum)) {
      clearHipStack();
      return;
    }
    hipStackLoading = true;
    hipStack = null;
    renderHipStack();
    const reqId = ++hipStackReq;
    vscode.postMessage({
      type: "requestInlineStack",
      reqId,
      markerId: currentMarkerId,
      codeobjPath: currentCodeobjPath,
      addr: pcNum,
    });
  }

  function renderHipStack() {
    if (!hipStackEl) return;
    hipStackEl.innerHTML = "";
    if (hipStackLoading) {
      const note = document.createElement("div");
      note.className = "hipStackNote";
      note.textContent = "Resolving call stack…";
      hipStackEl.appendChild(note);
      hipStackEl.style.display = "";
      return;
    }
    if (!hipStack || !hipStack.length) {
      hipStackEl.style.display = "none";
      return;
    }
    hipStackEl.style.display = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < hipStack.length; i++) {
      const fr = hipStack[i];
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hipStackFrame";
      row.classList.toggle("active", i === hipStackFrame);
      const where = `${baseName(fr.file)}:${fr.line}`;
      row.textContent = `#${i}  ${fr.func || "?"}  ${where}`;
      row.title = `${fr.func || "?"}\n${fr.file}:${fr.line}`;
      row.addEventListener("click", () => selectHipStackFrame(i));
      frag.appendChild(row);
    }
    hipStackEl.appendChild(frag);
  }

  function selectHipStackFrame(i) {
    if (!hipStack || i < 0 || i >= hipStack.length) return;
    hipStackFrame = i;
    renderHipStack();
    syncHipTo({ file: hipStack[i].file, line: hipStack[i].line });
  }

  function selectedStackPos() {
    if (hipStack && hipStack.length > hipStackFrame) {
      const fr = hipStack[hipStackFrame];
      if (fr && fr.file) return { file: fr.file, line: fr.line };
    }
    return selectedSrcPos();
  }

  function selectedSrcPos() {
    if (!selected || selected.marker_id !== currentMarkerId) return null;
    const idx = srcBody && srcBody._pcToLine ? srcBody._pcToLine.get(Number(selected.pc)) : null;
    return srcPosOfLine(idx);
  }

  // Points the pane at a source position, switching files when it names another one. The
  // position is remembered so a file arriving later, or a re-render, still marks the line.
  function syncHipTo(pos) {
    if (pos) hipCur = pos;
    if (!hipOpen) return;
    if (!pos) {
      paintHipMarks();
      return;
    }
    if (pos.file !== hipFile) {
      showHipFile(pos.file);
      // The text arrives asynchronously; onSourceText syncs again once it does.
      if (!hipLines) return;
    }
    scrollHipTo(pos.line);
    paintHipMarks();
  }

  function syncHipToSelected() {
    syncHipTo(selectedStackPos());
  }

  // Clicking a source line marks every instruction that line compiled to and takes the listing
  // to the first of them, without moving the timeline selection.
  function selectHipLine(lineNo) {
    if (!Number.isFinite(lineNo)) return;
    const same = hipSel && hipSel.file === hipFile && hipSel.line === lineNo;
    hipSel = same ? null : { file: hipFile, line: lineNo };
    hipSelVersion++;
    paintHipMarks();
    const idxs = hipSel ? srcLineIndex.get(`${hipFile}|${lineNo}`) : null;
    if (idxs && idxs.length && srcBody && srcBody._disRowH) {
      const top = Math.max(0, idxs[0] * srcBody._disRowH - srcBody.clientHeight * 0.35);
      srcBody.scrollTop = top;
    }
    if (srcBody && srcBody._updateDis) srcBody._updateDis();
    scheduleSaveUiState();
  }

  function setSourceMode(mode) {
    sourceMode = mode;
    if (tabDisasmBtn) tabDisasmBtn.classList.toggle("active", mode === "disasm");
    if (tabOccBtn) tabOccBtn.classList.toggle("active", mode === "occ");
    if (srcBody) srcBody.classList.toggle("noPad", mode === "disasm");
    hideDisMenu();
    if (mode === "disasm") {
      renderDisasm(disasmLines);
      if (selected && selected.marker_id === currentMarkerId) highlightDisasm(selected.pc);
    } else {
      if (selected) renderOccurrences(selected.marker_id, selected.pc);
    }
    updateCopyBtn();
    updateFindUI();
  }
  if (tabDisasmBtn) tabDisasmBtn.addEventListener("click", () => setSourceMode("disasm"));
  if (tabOccBtn) tabOccBtn.addEventListener("click", () => setSourceMode("occ"));
  if (copyBtn) copyBtn.addEventListener("click", () => copySelection("addr"));
  if (findInput) {
    findInput.addEventListener("input", () => {
      disSearch.query = findInput.value;
      scheduleDisSearch();
    });
    findInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        flushDisSearch();
        disSearchGo(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        clearDisSearch();
      }
    });
  }
  // The buttons hand focus back to the box so Enter/Shift+Enter keep stepping through matches.
  const refocusFind = () => { if (findInput) findInput.focus(); };
  if (findPrevBtn) findPrevBtn.addEventListener("click", () => { disSearchGo(-1); refocusFind(); });
  if (findNextBtn) findNextBtn.addEventListener("click", () => { disSearchGo(1); refocusFind(); });
  if (findCaseBtn) {
    findCaseBtn.addEventListener("click", () => {
      disSearch.icase = !disSearch.icase;
      runDisSearch();
      refocusFind();
    });
  }
  if (findReBtn) {
    findReBtn.addEventListener("click", () => {
      disSearch.regex = !disSearch.regex;
      runDisSearch();
      refocusFind();
    });
  }
  if (findAllBtn) {
    findAllBtn.addEventListener("click", () => {
      disSearch.all = !disSearch.all;
      runDisSearch();
      refocusFind();
    });
  }

  // ---------------------------------------------------------------------------
  // Disasm selection + copy
  // ---------------------------------------------------------------------------

  if (srcBody) srcBody.tabIndex = -1;

  function disRangeBounds() {
    if (!disRange || !disasmLines.length) return null;
    const lo = Math.max(0, Math.min(disRange.a, disRange.b));
    const hi = Math.min(disasmLines.length - 1, Math.max(disRange.a, disRange.b));
    if (hi < lo) return null;
    return { lo, hi };
  }

  function setDisRange(a, b) {
    if (a == null) {
      if (!disRange) return;
      disRange = null;
    } else {
      const nb = b == null ? a : b;
      if (disRange && disRange.a === a && disRange.b === nb) return;
      disRange = { a, b: nb };
    }
    disRangeVersion++;
    updateCopyBtn();
    if (srcBody && srcBody._updateDis) srcBody._updateDis();
  }

  function selectAllDisasm() {
    if (!disasmLines.length) return;
    setDisRange(0, disasmLines.length - 1);
  }

  function updateCopyBtn() {
    if (!copyBtn) return;
    copyBtn.style.display = sourceMode === "disasm" ? "" : "none";
    const r = disRangeBounds();
    const n = r ? r.hi - r.lo + 1 : 0;
    copyBtn.textContent = n > 0 ? `Copy ${n}` : "Copy";
  }

  function disasmAddrText(pc) {
    return "0x" + Number(pc).toString(16).padStart(4, "0");
  }

  // mode: "addr" (addr + instruction), "text" (instruction only), "counts" (TSV, per-slot counts)
  function buildDisasmText(mode) {
    const r = disRangeBounds();
    if (!r) return "";
    const out = [];
    if (mode === "counts") {
      const hdr = ["addr", "instruction", "total"];
      for (let w = 0; w < lanes; w++) hdr.push(laneLabelShort(w));
      out.push(hdr.join("\t"));
    }
    let addrW = 0;
    if (mode === "addr") {
      for (let i = r.lo; i <= r.hi; i++) {
        if (disasmLines[i]) addrW = Math.max(addrW, disasmAddrText(disasmLines[i].addr).length);
      }
    }
    for (let i = r.lo; i <= r.hi; i++) {
      const ln = disasmLines[i];
      if (!ln) continue;
      const text = String(ln.text || "");
      if (mode === "text") {
        out.push(text);
        continue;
      }
      const pc = Number(ln.addr);
      const addr = disasmAddrText(pc);
      if (mode === "counts") {
        const hit = pcIndex.get(`${currentMarkerId}|${pc}`);
        const row = [addr, text, String(hit ? hit.idxs.length : 0)];
        for (let w = 0; w < lanes; w++) row.push(String(hit ? hit.laneCounts.get(w) || 0 : 0));
        out.push(row.join("\t"));
        continue;
      }
      out.push(`${addr.padEnd(addrW)}  ${text}`);
    }
    return out.join("\n");
  }

  let _toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById("copyToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "copyToast";
      el.className = "copyToast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.display = "none"; }, 1500);
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return;
    } catch { /* fall through to the extension host */ }
    vscode.postMessage({ type: "copyText", text });
  }

  async function copySelection(mode) {
    const r = disRangeBounds();
    if (!r) {
      showToast("No disasm lines selected");
      return;
    }
    await writeClipboard(buildDisasmText(mode));
    const n = r.hi - r.lo + 1;
    showToast(`Copied ${n} line${n === 1 ? "" : "s"}`);
  }

  let disMenuEl = null;
  function hideDisMenu() {
    if (!disMenuEl) return;
    disMenuEl.remove();
    disMenuEl = null;
  }

  function showDisMenu(clientX, clientY) {
    hideDisMenu();
    const menu = document.createElement("div");
    menu.className = "disMenu";
    const items = [
      ["Copy (addr + instruction)", () => copySelection("addr")],
      ["Copy instruction text only", () => copySelection("text")],
      ["Copy with per-slot counts (TSV)", () => copySelection("counts")],
      null,
      ["Select all lines", () => selectAllDisasm()],
      ["Clear selection", () => setDisRange(null)],
    ];
    for (const it of items) {
      if (!it) {
        const sep = document.createElement("div");
        sep.className = "disMenuSep";
        menu.appendChild(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "disMenuItem";
      el.textContent = it[0];
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideDisMenu();
        it[1]();
      });
      menu.appendChild(el);
    }
    menu.style.left = clientX + "px";
    menu.style.top = clientY + "px";
    document.body.appendChild(menu);
    disMenuEl = menu;
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - box.width - 4) + "px";
    if (box.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - box.height - 4) + "px";
  }

  function disLineFromPointer(clientY) {
    const bodyEl = srcBody && srcBody._disBodyEl;
    if (!bodyEl || !disasmLines.length) return null;
    const rowH = srcBody._disRowH || 20;
    const idx = Math.floor((clientY - bodyEl.getBoundingClientRect().top) / rowH);
    return Math.max(0, Math.min(disasmLines.length - 1, idx));
  }

  // Drag-select rows. A press that never leaves its starting row stays a plain click, so
  // native text selection inside one instruction keeps working.
  let disDrag = null; // { anchor:number, moved:boolean }
  let disDragClientY = 0;
  let disDragRaf = 0;
  let suppressRowClick = false;

  function disDragTo(clientY) {
    if (!disDrag) return;
    const idx = disLineFromPointer(clientY);
    if (idx == null) return;
    if (!disDrag.moved) {
      if (idx === disDrag.anchor) return;
      disDrag.moved = true;
      const c = srcBody && srcBody._disContainerEl;
      if (c) c.classList.add("dragging");
    }
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    } catch { /* ignore */ }
    setDisRange(disDrag.anchor, idx);
  }

  function disDragAutoScroll() {
    disDragRaf = 0;
    if (!disDrag || !disDrag.moved || !srcBody) return;
    const rect = srcBody.getBoundingClientRect();
    const EDGE = 24;
    let dv = 0;
    if (disDragClientY < rect.top + EDGE) dv = -Math.min(28, (rect.top + EDGE - disDragClientY) * 0.6);
    else if (disDragClientY > rect.bottom - EDGE) dv = Math.min(28, (disDragClientY - (rect.bottom - EDGE)) * 0.6);
    if (!dv) return;
    srcBody.scrollTop += dv;
    if (srcBody._updateDis) srcBody._updateDis();
    disDragTo(disDragClientY);
    disDragRaf = requestAnimationFrame(disDragAutoScroll);
  }

  function onDisMouseDown(ev) {
    if (ev.button !== 0 || sourceMode !== "disasm") return;
    // register tokens keep their own click-to-highlight behavior. A search mark can nest
    // inside the token span, so match the ancestor rather than the event target itself.
    if (ev.target && ev.target.closest && ev.target.closest(".regTok")) return;
    const idx = disLineFromPointer(ev.clientY);
    if (idx == null) return;
    suppressRowClick = false;
    if (srcBody) {
      try { srcBody.focus({ preventScroll: true }); } catch { srcBody.focus(); }
    }
    if (ev.shiftKey) {
      const anchor = disRange ? disRange.a : idx;
      disDrag = { anchor, moved: true };
      suppressRowClick = true;
      setDisRange(anchor, idx);
      ev.preventDefault();
      return;
    }
    disDrag = { anchor: idx, moved: false };
  }

  function onDisContextMenu(ev) {
    if (sourceMode !== "disasm") return;
    ev.preventDefault();
    const idx = disLineFromPointer(ev.clientY);
    const r = disRangeBounds();
    if (idx != null && (!r || idx < r.lo || idx > r.hi)) setDisRange(idx, idx);
    showDisMenu(ev.clientX, ev.clientY);
  }

  window.addEventListener("mousemove", (ev) => {
    if (!disDrag) return;
    disDragClientY = ev.clientY;
    disDragTo(ev.clientY);
    if (disDrag.moved && !disDragRaf) disDragRaf = requestAnimationFrame(disDragAutoScroll);
  });

  window.addEventListener("mouseup", () => {
    if (!disDrag) return;
    if (disDrag.moved) suppressRowClick = true;
    disDrag = null;
    if (disDragRaf) {
      cancelAnimationFrame(disDragRaf);
      disDragRaf = 0;
    }
    const c = srcBody && srcBody._disContainerEl;
    if (c) c.classList.remove("dragging");
  });

  window.addEventListener("mousedown", (ev) => {
    if (disMenuEl && !disMenuEl.contains(ev.target)) hideDisMenu();
  }, true);

  function srcPaneHasFocus() {
    const ae = document.activeElement;
    return !!(srcBody && ae && (ae === srcBody || srcBody.contains(ae)));
  }

  function hasNativeSelectionInSrc() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      const node = sel.anchorNode;
      if (!node || !srcBody) return false;
      return srcBody.contains(node.nodeType === 1 ? node : node.parentNode);
    } catch {
      return false;
    }
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      hideDisMenu();
      if (srcPaneHasFocus()) setDisRange(null);
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    // Find works from anywhere in the panel, including right after clicking the timeline.
    if (String(ev.key || "").toLowerCase() === "f") {
      ev.preventDefault();
      focusFind();
      return;
    }
    if (sourceMode !== "disasm" || !srcPaneHasFocus()) return;
    const k = String(ev.key || "").toLowerCase();
    if (k === "c") {
      // a real text highlight inside the panel wins: let the browser copy it verbatim
      if (hasNativeSelectionInSrc()) return;
      if (!disRangeBounds()) return;
      ev.preventDefault();
      copySelection("addr");
    } else if (k === "a") {
      ev.preventDefault();
      selectAllDisasm();
    }
  });

  // ---------------------------------------------------------------------------
  // Disasm search
  // ---------------------------------------------------------------------------

  // A literal query is matched with indexOf rather than a regex so that operand syntax
  // (`v[0:3]`, `s_add_u32 s0, s0, 4`) needs no escaping.
  function disSearchMatcher() {
    if (!disSearch.query) return null;
    if (disSearch.regex) {
      try {
        return { re: new RegExp(disSearch.query, disSearch.icase ? "gi" : "g") };
      } catch {
        return { bad: true };
      }
    }
    return { needle: disSearch.icase ? disSearch.query.toLowerCase() : disSearch.query };
  }

  // Cap the marks on one line; a pathological regex can otherwise match at every position.
  const DIS_SEARCH_MAX_MARKS = 64;

  function disSearchRangesIn(m, s) {
    const out = [];
    const str = String(s || "");
    if (!m || m.bad || !str) return out;
    if (m.needle) {
      const hay = disSearch.icase ? str.toLowerCase() : str;
      let from = 0;
      while (out.length < DIS_SEARCH_MAX_MARKS) {
        const i = hay.indexOf(m.needle, from);
        if (i < 0) break;
        out.push([i, i + m.needle.length]);
        from = i + m.needle.length;
      }
      return out;
    }
    m.re.lastIndex = 0;
    let mm;
    while ((mm = m.re.exec(str)) !== null && out.length < DIS_SEARCH_MAX_MARKS) {
      const a = mm.index;
      const b = a + mm[0].length;
      if (b > a) out.push([a, b]);
      // an empty match would spin forever on the same index
      m.re.lastIndex = b > a ? b : a + 1;
    }
    return out;
  }

  function disSearchTestsAgainst(m, str) {
    if (m.needle) {
      const hay = disSearch.icase ? String(str).toLowerCase() : String(str);
      return hay.includes(m.needle);
    }
    m.re.lastIndex = 0;
    return m.re.test(String(str));
  }

  function disSearchTest(m, lineIdx) {
    const ln = disasmLines[lineIdx];
    if (!ln) return false;
    if (disSearchTestsAgainst(m, ln.text || "")) return true;
    return disSearchTestsAgainst(m, disasmAddrText(ln.addr));
  }

  // A line "ran" when the trace holds at least one sample for it in the current code object.
  // The listing is the whole object, so without this most hits are in code the dispatch never
  // entered.
  function disLineExecuted(ln) {
    if (!ln) return false;
    const hit = pcIndex.get(`${currentMarkerId}|${Number(ln.addr)}`);
    return !!(hit && hit.idxs && hit.idxs.length);
  }

  // Ranges to mark on one line, or null when the line does not match.
  function disSearchHits(m, lineIdx) {
    const ln = disasmLines[lineIdx];
    if (!ln) return null;
    const text = disSearchRangesIn(m, ln.text || "");
    const addr = disSearchRangesIn(m, disasmAddrText(ln.addr));
    if (text.length === 0 && addr.length === 0) return null;
    return { text, addr };
  }

  // Rows live inside `disBody`, which sits below the sticky column header.
  function disBodyOffset() {
    const body = srcBody && srcBody._disBodyEl;
    if (!body || !srcBody) return 0;
    return body.getBoundingClientRect().top - srcBody.getBoundingClientRect().top + srcBody.scrollTop;
  }

  function firstVisibleDisLine() {
    if (!srcBody) return 0;
    const rowH = srcBody._disRowH || 20;
    return Math.max(0, Math.floor((srcBody.scrollTop - disBodyOffset()) / rowH));
  }

  // Leaves the scroll position alone when the row is already on screen, so that typing does
  // not make the listing jump around on every keystroke.
  function revealDisLine(lineIdx) {
    if (!srcBody || lineIdx == null) return;
    const rowH = srcBody._disRowH || 20;
    const top = disBodyOffset() + Number(lineIdx) * rowH;
    // the sticky header hides the top row's worth of the viewport
    const visTop = srcBody.scrollTop + rowH;
    const visBot = srcBody.scrollTop + srcBody.clientHeight;
    if (top < visTop || top + rowH > visBot) {
      srcBody.scrollTop = Math.max(0, top - Math.max(rowH * 2, srcBody.clientHeight * 0.4));
    }
    if (srcBody._updateDis) srcBody._updateDis();
  }

  function currentDisSearchLine() {
    if (disSearch.cur < 0) return -1;
    const l = disSearch.lines[disSearch.cur];
    return l == null ? -1 : Number(l);
  }

  function recomputeDisSearch() {
    const prevLine = currentDisSearchLine();
    const m = disSearchMatcher();
    disSearch.invalid = !!(m && m.bad);
    const lines = [];
    let skipped = 0;
    if (m && !m.bad) {
      for (let i = 0; i < disasmLines.length; i++) {
        if (!disSearchTest(m, i)) continue;
        if (!disSearch.all && !disLineExecuted(disasmLines[i])) {
          skipped++;
          continue;
        }
        lines.push(i);
      }
    }
    disSearch.skipped = skipped;
    disSearch.lines = lines;
    disSearchSet = lines.length ? new Set(lines) : null;
    if (lines.length === 0) {
      disSearch.cur = -1;
    } else {
      // stay on the match the user was on, else take the first one at or below the viewport
      const anchor = prevLine >= 0 ? prevLine : firstVisibleDisLine();
      let k = 0;
      while (k < lines.length - 1 && lines[k] < anchor) k++;
      disSearch.cur = k;
    }
    disSearchVersion++;
    updateFindUI();
    if (srcBody && srcBody._updateDis) srcBody._updateDis();
  }

  let _disSearchTimer = null;
  function scheduleDisSearch() {
    if (_disSearchTimer) clearTimeout(_disSearchTimer);
    _disSearchTimer = setTimeout(() => {
      _disSearchTimer = null;
      runDisSearch();
    }, 90);
  }

  function flushDisSearch() {
    if (!_disSearchTimer) return;
    clearTimeout(_disSearchTimer);
    _disSearchTimer = null;
    runDisSearch();
  }

  function runDisSearch() {
    recomputeDisSearch();
    const line = currentDisSearchLine();
    if (line >= 0) revealDisLine(line);
    scheduleSaveUiState();
  }

  function disSearchGo(delta) {
    if (!disSearch.lines.length) return;
    const n = disSearch.lines.length;
    disSearch.cur = disSearch.cur < 0 ? 0 : (((disSearch.cur + delta) % n) + n) % n;
    disSearchVersion++;
    updateFindUI();
    revealDisLine(disSearch.lines[disSearch.cur]);
  }

  function clearDisSearch() {
    if (_disSearchTimer) {
      clearTimeout(_disSearchTimer);
      _disSearchTimer = null;
    }
    if (findInput) findInput.value = "";
    disSearch.query = "";
    recomputeDisSearch();
    if (srcBody) {
      try { srcBody.focus({ preventScroll: true }); } catch { srcBody.focus(); }
    }
  }

  function focusFind() {
    if (sourceMode !== "disasm") setSourceMode("disasm");
    if (!findInput) return;
    findInput.focus();
    findInput.select();
  }

  function updateFindUI() {
    if (!findWrap) return;
    findWrap.style.display = sourceMode === "disasm" ? "" : "none";
    if (findCaseBtn) findCaseBtn.classList.toggle("active", !disSearch.icase);
    if (findReBtn) findReBtn.classList.toggle("active", disSearch.regex);
    if (findAllBtn) findAllBtn.classList.toggle("active", disSearch.all);
    if (findInput) findInput.classList.toggle("invalid", !!disSearch.invalid);
    if (findCountEl) {
      let txt = "";
      if (disSearch.invalid) txt = "bad re";
      else if (disSearch.query) txt = disSearch.lines.length ? `${disSearch.cur + 1}/${disSearch.lines.length}` : "0";
      findCountEl.textContent = txt;
      findCountEl.classList.toggle("hasSkipped", !disSearch.all && disSearch.skipped > 0);
      findCountEl.title = disSearch.all
        ? "current match / matching lines"
        : disSearch.skipped
          ? `current match / matching lines that ran.\n${disSearch.skipped} more line${disSearch.skipped === 1 ? "" : "s"} match but were never sampled — use "all" to include them.`
          : "current match / matching lines that ran";
    }
    const none = disSearch.lines.length === 0;
    if (findPrevBtn) findPrevBtn.disabled = none;
    if (findNextBtn) findNextBtn.disabled = none;
  }

  function setSrcMeta(text, fullPath) {
    currentCodeobjPath = fullPath || "";
    if (srcMeta) {
      srcMeta.textContent = text;
      srcMeta.title = currentCodeobjPath;
    }
    if (pathBtn) {
      pathBtn.disabled = !currentCodeobjPath;
      pathBtn.title = currentCodeobjPath
        ? `Copy the code object's full path:\n${currentCodeobjPath}`
        : "No code object path for this marker";
    }
  }

  function requestDisasm(markerId) {
    const p = codeobjFiles[String(markerId)];
    if (!p) {
      setSrcMeta(`Source: marker=${markerId} (no code object path)`, "");
      return;
    }
    currentMarkerId = markerId;
    setSrcMeta(`Source: marker=${markerId}  ${baseName(p)}`, p);
    vscode.postMessage({ type: "requestDisasm", markerId, codeobjPath: p, gpuArch: (DATA.meta && DATA.meta.gpu_arch) || "gfx950" });
  }

  function renderDisasm(lines) {
    const nextLines = lines || [];
    if (nextLines !== disasmLines) {
      // a different code object was loaded; line indices no longer mean anything
      disRange = null;
      disRangeVersion++;
      disSearch.lines = [];
      disSearch.cur = -1;
      disSearchSet = null;
      disSearchVersion++;
    }
    disasmLines = nextLines;
    disasmAddrToEl = new Map();
    buildSrcIndex();
    if (hipSel && !srcFiles.some((f) => f.file === hipSel.file)) {
      hipSel = null;
      hipSelVersion++;
    }
    if (hipFile && !srcFiles.some((f) => f.file === hipFile)) hipFile = "";
    // A position from the previous code object is stale unless this one still compiles something
    // to it, so the mark cannot outlive the instruction it pointed at.
    if (hipCur && !srcLineIndex.has(`${hipCur.file}|${hipCur.line}`)) hipCur = null;
    clearHipStack();
    if (hipOpen && !hipAvailable()) hipOpen = false;
    updateHipBtn();
    if (hipOpen) {
      ensureHipDom();
      // Route through showHipFile even for the file already on show: after a webview reload the
      // pane knows the path but holds none of its text, and showHipFile is what asks for it.
      const want = hipFile || (srcFiles.length ? srcFiles[0].file : "");
      if (want) showHipFile(want);
      else renderHipBody();
    }
    applyHipLayout();
    hideDisMenu();
    if (!srcBody) return;
    // virtualized grid: only render visible rows to avoid huge DOM
    srcBody.innerHTML = "";

    const disContainer = document.createElement("div");
    disContainer.className = "disContainer";

    // A channel down the left of the addr column, indented past by the addresses themselves, so
    // a wait link can be drawn between two rows without covering the addresses it points at.
    // The addr column is widened by it rather than sharing its width with the link.
    const ROW_PAD = 6; // .disRow padding-left
    const LINK_CH = 16;
    const ADDR_W = 74 + LINK_CH;
    disContainer.style.setProperty("--addrChannel", `${LINK_CH}px`);

    // grid columns: addr | text | total | wave columns
    const cols = [`${ADDR_W}px`, "1fr", "52px"];
    for (let w = 0; w < lanes; w++) cols.push("38px");
    const gridTemplateColumns = cols.join(" ");

    const header = document.createElement("div");
    header.className = "disHeader disRow";
    header.style.gridTemplateColumns = gridTemplateColumns;
    // header cells
    const hAddr = document.createElement("div");
    hAddr.className = "disCell disAddrCell";
    hAddr.textContent = "addr";
    const hTxt = document.createElement("div");
    hTxt.className = "disCell";
    hTxt.textContent = "instruction";
    const hTot = document.createElement("div");
    hTot.className = "disCell disNumCell";
    hTot.textContent = "total";
    header.appendChild(hAddr);
    header.appendChild(hTxt);
    header.appendChild(hTot);
    for (let w = 0; w < lanes; w++) {
      const hw = document.createElement("div");
      hw.className = "disCell disNumCell";
      hw.textContent = laneLabelShort(w);
      hw.title = laneTitle(w);
      header.appendChild(hw);
    }
    disContainer.appendChild(header);

    const body = document.createElement("div");
    body.className = "disBody";
    const spacer = document.createElement("div");
    spacer.className = "disSpacer";
    const ROW_H = 20;
    spacer.style.height = (disasmLines.length * ROW_H) + "px";
    body.appendChild(spacer);
    const layer = document.createElement("div");
    layer.className = "disLayer";
    body.appendChild(layer);
    disContainer.appendChild(body);
    srcBody.appendChild(disContainer);

    srcBody._disBodyEl = body;
    srcBody._disContainerEl = disContainer;
    body.addEventListener("mousedown", onDisMouseDown);
    body.addEventListener("contextmenu", onDisContextMenu);

    // overlay SVG for waitcnt links (folded polyline with arrow)
    // IMPORTANT: attach to disBody so it scrolls with rows (no scrollTop compensation needed).
    const SVG_NS = "http://www.w3.org/2000/svg";
    const waitSvg = document.createElementNS(SVG_NS, "svg");
    waitSvg.classList.add("waitLinkOverlay");
    waitSvg.setAttribute("width", "100%");
    waitSvg.setAttribute("height", "100%");
    const defs = document.createElementNS(SVG_NS, "defs");
    // glow/outline to make the link very visible
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", "waitGlow");
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-20%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "140%");
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
    blur.setAttribute("in", "SourceGraphic");
    blur.setAttribute("stdDeviation", "1.2");
    blur.setAttribute("result", "blur");
    const merge = document.createElementNS(SVG_NS, "feMerge");
    const m1 = document.createElementNS(SVG_NS, "feMergeNode");
    m1.setAttribute("in", "blur");
    const m2 = document.createElementNS(SVG_NS, "feMergeNode");
    m2.setAttribute("in", "SourceGraphic");
    merge.appendChild(m1);
    merge.appendChild(m2);
    filter.appendChild(blur);
    filter.appendChild(merge);
    defs.appendChild(filter);

    const mk = (id, color) => {
      const marker = document.createElementNS(SVG_NS, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("markerWidth", "8");
      marker.setAttribute("markerHeight", "8");
      marker.setAttribute("refX", "7");
      marker.setAttribute("refY", "4");
      marker.setAttribute("orient", "auto");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M0,0 L8,4 L0,8 Z");
      path.setAttribute("fill", color);
      marker.appendChild(path);
      return marker;
    };
    // Use a vivid red like the screenshot. (Both link types share the same look; badges still differentiate.)
    defs.appendChild(mk("mkLgkm", "#ff3b30"));
    defs.appendChild(mk("mkVm", "#ff3b30"));
    waitSvg.appendChild(defs);
    const linkG = document.createElementNS(SVG_NS, "g");
    linkG.setAttribute("data-role", "wait-links");
    waitSvg.appendChild(linkG);
    body.appendChild(waitSvg);

    let _waitLinkPending = false;
    function drawWaitLinks() {
      // Clear
      while (linkG.firstChild) linkG.removeChild(linkG.firstChild);
      if (!waitSel || !waitSel.targets || waitSel.targets.length === 0) return;

      // Coordinates are in disBody content space.
      const yFrom = (waitSel.fromLine * ROW_H) + ROW_H * 0.5;
      // The elbow stays inside the channel the addr column reserves for it: the arrow stops just
      // short of where the addresses start, so a link never sits on top of the two it connects.
      const xEdge = ROW_PAD + LINK_CH - 7;
      const xGutter = ROW_PAD + 1;

      for (const t of waitSel.targets) {
        const yTo = (t.line * ROW_H) + ROW_H * 0.5;
        const color = "#ff3b30";
        const markerId = t.cls === "lgkm" ? "mkLgkm" : "mkVm";

        // folded polyline: from -> gutter -> gutter -> target
        const pts = `${xEdge},${yFrom} ${xGutter},${yFrom} ${xGutter},${yTo} ${xEdge},${yTo}`;
        // outline underlay
        const under = document.createElementNS(SVG_NS, "polyline");
        under.setAttribute("points", pts);
        under.setAttribute("fill", "none");
        under.setAttribute("stroke", "rgba(0,0,0,0.65)");
        under.setAttribute("stroke-width", "5");
        under.setAttribute("stroke-linejoin", "round");
        under.setAttribute("stroke-linecap", "round");
        under.setAttribute("opacity", "0.85");
        linkG.appendChild(under);
        // main line
        const poly = document.createElementNS(SVG_NS, "polyline");
        poly.setAttribute("points", pts);
        poly.setAttribute("fill", "none");
        poly.setAttribute("stroke", color);
        poly.setAttribute("stroke-width", "3");
        poly.setAttribute("stroke-linejoin", "round");
        poly.setAttribute("stroke-linecap", "round");
        poly.setAttribute("opacity", "0.98");
        poly.setAttribute("filter", "url(#waitGlow)");
        poly.setAttribute("marker-end", `url(#${markerId})`);
        linkG.appendChild(poly);

        // endpoints
        const c1 = document.createElementNS(SVG_NS, "circle");
        c1.setAttribute("cx", String(xEdge));
        c1.setAttribute("cy", String(yFrom));
        c1.setAttribute("r", "3.5");
        c1.setAttribute("fill", color);
        linkG.appendChild(c1);
        const c2 = document.createElementNS(SVG_NS, "circle");
        c2.setAttribute("cx", String(xEdge));
        c2.setAttribute("cy", String(yTo));
        c2.setAttribute("r", "3.5");
        c2.setAttribute("fill", color);
        linkG.appendChild(c2);
      }
    }

    function requestWaitLinks() {
      if (_waitLinkPending) return;
      _waitLinkPending = true;
      requestAnimationFrame(() => {
        _waitLinkPending = false;
        drawWaitLinks();
      });
    }
    // allow other codepaths (selection changes) to trigger redraw
    srcBody._requestWaitLinks = requestWaitLinks;

    // map pc -> line index for scrolling/highlight
    const pcToLine = new Map();
    for (let i = 0; i < disasmLines.length; i++) pcToLine.set(Number(disasmLines[i].addr), i);

    let pool = [];
    let lastFirst = -1;
    let lastCount = -1;
    let lastRegVer = -1;
    let lastWaitVer = -1;
    let lastRangeVer = -1;
    let lastSearchVer = -1;
    let lastSelKey = null;
    let lastHipVer = -1;

    function ensurePool(n) {
      while (pool.length < n) {
        const row = document.createElement("div");
        row.className = "disRow disDataRow";
        row.style.position = "absolute";
        row.style.left = "0";
        row.style.right = "0";
        row.style.gridTemplateColumns = gridTemplateColumns;
        // precreate cells (fixed count)
        const cellCount = 3 + lanes;
        for (let i = 0; i < cellCount; i++) {
          const c = document.createElement("div");
          c.className = "disCell";
          row.appendChild(c);
        }
        layer.appendChild(row);
        pool.push(row);
      }
    }

    function updateVisible() {
      const scrollTop = srcBody.scrollTop;
      const viewH = srcBody.clientHeight;
      const overscan = 20;
      const first = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
      const count = Math.min(disasmLines.length - first, Math.ceil(viewH / ROW_H) + overscan * 2);
      // The selection is part of the row state, so a click landing in the same virtualized
      // window (a neighbouring instruction, or another sub-row of the same stack) must still
      // repaint; otherwise the highlight stays on the previously selected line.
      const selKey = selected ? `${selected.marker_id}|${selected.pc}` : null;
      // Wait links are attached to disBody and scroll naturally with rows.
      if (first === lastFirst && count === lastCount && lastRegVer === regSelVersion
        && lastWaitVer === waitSelVersion && lastRangeVer === disRangeVersion
        && lastSearchVer === disSearchVersion && lastSelKey === selKey
        && lastHipVer === hipSelVersion) return;
      lastFirst = first; lastCount = count;
      lastSelKey = selKey;
      lastHipVer = hipSelVersion;
      lastRegVer = regSelVersion;
      lastWaitVer = waitSelVersion;
      lastRangeVer = disRangeVersion;
      lastSearchVer = disSearchVersion;
      const range = disRangeBounds();
      // Match ranges are computed here, for visible rows only.
      const searchM = disSearchSet ? disSearchMatcher() : null;
      const searchCurLine = currentDisSearchLine();
      ensurePool(count);
      for (let i = 0; i < pool.length; i++) {
        const row = pool[i];
        const idx = first + i;
        if (i >= count || idx >= disasmLines.length) {
          row.style.display = "none";
          continue;
        }
        row.style.display = "grid";
        row.style.top = (idx * ROW_H) + "px";
        const ln = disasmLines[idx];
        const pc = Number(ln.addr);
        const hit = pcIndex.get(`${currentMarkerId}|${pc}`);
        const total = hit ? hit.idxs.length : 0;
        // Disasm instruction text uses per-category coloring (register tokens override to default color).
        const cat = hit && hit.cat ? hit.cat : "NONE";
        const color = COLORS[cat] || "#ddd";

        row.classList.toggle("selected", selected && selected.marker_id === currentMarkerId && selected.pc === pc);
        row.classList.toggle("rangeSel", !!range && idx >= range.lo && idx <= range.hi);
        row.classList.toggle("lineSel", !!hipSel && ln.file === hipSel.file && ln.line === hipSel.line);
        const searchHits = searchM && disSearchSet.has(idx) ? disSearchHits(searchM, idx) : null;
        row.classList.toggle("searchHit", !!searchHits);
        row.classList.toggle("searchCur", !!searchHits && idx === searchCurLine);
        const isWaitFrom = !!(waitSel && Number(idx) === Number(waitSel.fromLine));
        const waitTargetOfCls = (cls) => (
          waitSel && waitSel.targets
            ? waitSel.targets.find((t) => t.cls === cls && Number(t.line) === Number(idx))
            : null
        );
        const waitTlgkm = waitTargetOfCls("lgkm");
        const waitTvm = waitTargetOfCls("vm");
        const isWaitTlgkm = !!waitTlgkm;
        const isWaitTvm = !!waitTvm;
        row.classList.toggle("waitFrom", isWaitFrom);
        row.classList.toggle("waitTargetLgkm", isWaitTlgkm);
        row.classList.toggle("waitTargetVmcnt", isWaitTvm);

        // fill cells
        const cells = row.children;
        cells[0].className = "disCell disAddrCell";
        {
          const addr = disasmAddrText(pc);
          let badges = "";
          if (waitTlgkm) badges += ` <span class="waitBadge lgkm">${escapeHtml(waitTlgkm.label)}</span>`;
          if (waitTvm) badges += ` <span class="waitBadge vm">${escapeHtml(waitTvm.label)}</span>`;
          cells[0].innerHTML = markRangesHtml(addr, searchHits ? searchHits.addr : null) + badges;
        }
        cells[1].className = "disCell disTextCell";
        // Highlight selected register occurrences in the selected line, as well as:
        // - all prior lines
        // - following lines up to REG_HL_FORWARD_LINES (bounded for performance)
        let txtHtml = renderAsmHtmlWithRegs(
          ln.text,
          !!(regSel && Number(idx) <= (Number(regSel.focusLine) + REG_HL_FORWARD_LINES)),
          searchHits ? searchHits.text : null
        );
        if (isWaitFrom && waitSel && waitSel.targets && waitSel.targets.length) {
          const parts = waitSel.targets.map((t) => {
            const p = "0x" + Number(t.pc).toString(16);
            return `${t.label}(${t.n}) ↖ ${p}`;
          });
          txtHtml += ` <span class="waitHint">${escapeHtml(parts.join("   "))}</span>`;
        }
        cells[1].innerHTML = txtHtml;
        cells[1].style.color = color;
        cells[2].className = "disCell disNumCell";
        cells[2].textContent = total ? String(total) : "";
        for (let w = 0; w < lanes; w++) {
          const c = hit ? (hit.laneCounts.get(w) || 0) : 0;
          const cell = cells[3 + w];
          cell.className = "disCell disNumCell";
          cell.textContent = c ? String(c) : "";
        }

        // bind click handlers once
        if (!row._bound) {
          row.addEventListener("click", (ev) => {
            // if clicking a register token, select/highlight registers (do not change selected instruction)
            const regEl = ev && ev.target && ev.target.closest ? ev.target.closest(".regTok") : null;
            if (regEl) {
              const tok = regEl.getAttribute("data-regtok") || "";
              const lineIdx = Number(row.dataset.line || "0");
              const info = atomsFromRegToken(tok);
              const nextKey = `${lineIdx}|${info.key}`;
              if (regSel && regSel.key === nextKey) {
                regSel = null;
              } else {
                regSel = { key: nextKey, atoms: new Set(info.atoms), focusLine: lineIdx };
              }
              regSelVersion++;
              ev.stopPropagation();
              ev.preventDefault();
              if (srcBody && srcBody._updateDis) srcBody._updateDis();
              return;
            }
            if (suppressRowClick) {
              // tail of a drag-select; the range is already set
              suppressRowClick = false;
              return;
            }
            const pcNow = Number(row.dataset.addr);
            const lineNow = Number(row.dataset.line);
            setDisRange(lineNow);
            // Follow the row into the source pane whether or not the trace sampled it: most of
            // the listing belongs to code this dispatch never entered, and reading where an
            // instruction came from should not require it to have run.
            syncHipTo(srcPosOfLine(lineNow));
            const hitNow = pcIndex.get(`${currentMarkerId}|${pcNow}`);
            if (!hitNow) {
              requestHipStack(pcNow);
              return;
            }
            panToIssue(hitNow.first);
            const e0 = DATA.events[hitNow.idxs[0]];
            selected = { marker_id: currentMarkerId, pc: pcNow, lane: e0.lane, issue: e0.issue };
            updateWaitSelFromSelected();
            highlightDisasm(pcNow);
            requestDraw();
          });
          row.addEventListener("dblclick", () => {
            const pcNow = Number(row.dataset.addr);
            selected = { marker_id: currentMarkerId, pc: pcNow, lane: selected ? selected.lane : 0, issue: selected ? selected.issue : 0 };
            setSourceMode("occ");
          });
          row._bound = true;
        }
        row.dataset.addr = String(pc);
        row.dataset.line = String(idx);
        disasmAddrToEl.set(pc, row);
      }
    }

    // scroll handler for virtualization
    const onScroll = () => updateVisible();
    srcBody.removeEventListener("scroll", srcBody._disScroll || (()=>{}));
    srcBody._disScroll = onScroll;
    srcBody.addEventListener("scroll", onScroll, { passive: true });

    // expose for highlight
    srcBody._pcToLine = pcToLine;
    srcBody._disRowH = ROW_H;
    srcBody._updateDis = updateVisible;

    // recompute wait arrows and search matches when disasm changes
    updateWaitSelFromSelected();
    requestWaitLinks();
    recomputeDisSearch();
    updateVisible();
    updateCopyBtn();
  }

  function highlightDisasm(pc) {
    // If disasm is virtualized, scroll to the line first
    const pcNum = Number(pc);
    if (srcBody && srcBody._pcToLine && srcBody._disRowH) {
      const idx = srcBody._pcToLine.get(pcNum);
      if (idx != null) {
        const top = Math.max(0, idx * srcBody._disRowH - srcBody.clientHeight * 0.5);
        srcBody.scrollTop = top;
        if (srcBody._updateDis) srcBody._updateDis();
      }
    }
    // update row selection state for currently rendered rows
    if (srcBody && srcBody._updateDis) srcBody._updateDis();
    requestHipStack(pcNum);
    syncHipToSelected();
  }

  function panToIssue(issue) {
    const span = view.max - view.min;
    const center = issue;
    view.min = center - span * 0.35;
    view.max = view.min + span;
    if (view.min < DATA.min_cycle) { view.max += (DATA.min_cycle - view.min); view.min = DATA.min_cycle; }
    if (view.max > DATA.max_cycle) { view.min -= (view.max - DATA.max_cycle); view.max = DATA.max_cycle; }
  }

  async function renderOccurrences(markerId, pc) {
    if (!srcBody) return;
    const key = `${markerId}|${pc}`;
    const hit = pcIndex.get(key);
    srcBody.innerHTML = "";
    if (!hit) {
      const d = document.createElement("div");
      d.className = "occHint";
      d.textContent = "No occurrences found for this instruction.";
      srcBody.appendChild(d);
      return;
    }
    const allEvents = (hit.idxs || []).map((i) => DATA.events[i]).slice().sort((a, b) => a.issue - b.issue);
    const events = occLaneFilter == null ? allEvents : allEvents.filter((e) => e.lane === occLaneFilter);

    // lane filter UI
    const controls = document.createElement("div");
    controls.className = "occControls";
    const lab = document.createElement("span");
    lab.className = "occHint";
    lab.style.margin = "0";
    lab.textContent = "Slot:";
    const sel = document.createElement("select");
    sel.className = "occLaneSel";
    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "all";
    sel.appendChild(optAll);
    for (let l = 0; l < lanes; l++) {
      const o = document.createElement("option");
      o.value = String(l);
      o.textContent = laneLabel(l);
      o.title = laneTitle(l);
      sel.appendChild(o);
    }
    sel.value = occLaneFilter == null ? "all" : String(occLaneFilter);
    sel.addEventListener("change", () => {
      const v = sel.value;
      occLaneFilter = v === "all" ? null : Number(v);
      occSelectedKey = null; // selection may be filtered out
      renderOccurrences(markerId, pc);
    });
    controls.appendChild(lab);
    controls.appendChild(sel);
    srcBody.appendChild(controls);

    // Take the instruction text from the unfiltered list: a lane filter can legitimately match
    // nothing, and the header should still say which instruction is being inspected.
    const asm = (allEvents[0] && allEvents[0].asm) || "";
    const hint = document.createElement("div");
    hint.className = "occHint";
    const laneSuffix = occLaneFilter == null ? "" : `   ${laneTitle(occLaneFilter)}`;
    hint.textContent = `${asm || "(unknown)"}   marker=${markerId} pc=0x${Number(pc).toString(16)}   count=${events.length}${laneSuffix}`;
    srcBody.appendChild(hint);

    if (events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "occHint";
      empty.textContent = occLaneFilter == null
        ? "No occurrences recorded for this instruction."
        : `This instruction never issued on ${laneLabel(occLaneFilter)}. Pick another slot or "all".`;
      srcBody.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "occTable";
    table.innerHTML = `
      <thead><tr>
        <th>#</th><th>slot</th><th>t0</th><th>Δt0</th><th>stall</th><th>exec</th><th>dur</th><th>cat</th>
      </tr></thead>
      <tbody></tbody>`;
    srcBody.appendChild(table);
    const tbody = table.querySelector("tbody");

    const CHUNK = 800;
    let idx = 0;

    function addChunk() {
      const frag = document.createDocumentFragment();
      const end = Math.min(events.length, idx + CHUNK);
      for (let i = idx; i < end; i++) {
        const e = events[i];
        const stall = Math.max(0, e.stall || 0);
        const dur = Math.max(1, e.duration || 1);
        const t0 = e.issue;
        const exec = Math.max(0, dur - stall);
        const dt0 = i > 0 ? (t0 - (events[i - 1].issue || 0)) : null;
        const tr = document.createElement("tr");
        tr.className = "occRow";
        const rowKey = `${e.lane}|${e.issue}|${e.pc}`;
        tr.dataset.key = rowKey;
        tr.innerHTML = `
          <td>${i}</td>
          <td>${e.slot}</td>
          <td>${t0}</td>
          <td>${dt0 == null ? "" : dt0}</td>
          <td>${stall}</td>
          <td>${exec}</td>
          <td>${dur}</td>
          <td>${e.cat}</td>
        `;
        tr.addEventListener("click", () => {
          // select this occurrence
          occSelectedKey = rowKey;
          for (const r of tbody.querySelectorAll(".occRow.selected")) r.classList.remove("selected");
          tr.classList.add("selected");
          selected = { marker_id: e.marker_id, pc: e.pc, lane: e.lane, issue: e.issue };
          // sync trace
          if (e.marker_id && String(e.marker_id) !== String(currentMarkerId)) requestDisasm(e.marker_id);
          panToIssue(e.issue);
          requestDraw();
          // sync disasm highlight (without switching mode)
          updateWaitSelFromSelected();
          highlightDisasm(e.pc);
        });
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      idx = end;
      if (idx < events.length) {
        requestAnimationFrame(addChunk);
      } else if (occSelectedKey) {
        const all = tbody.querySelectorAll(".occRow");
        for (const r of all) {
          if (r.dataset && r.dataset.key === occSelectedKey) {
            r.classList.add("selected");
            break;
          }
        }
      }
    }
    addChunk();
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "disasm" && msg.lines) {
      // Before rendering: the pane's availability is decided while the new listing is indexed.
      if (msg.sourceSnapshot !== undefined) srcSnapshot = msg.sourceSnapshot;
      renderDisasm(msg.lines);
      updateWaitSelFromSelected();
      if (selected && selected.marker_id === msg.markerId) highlightDisasm(selected.pc);
    } else if (msg.type === "disasmError") {
      const p = msg.codeobjPath || currentCodeobjPath;
      setSrcMeta(`Source: ${baseName(p) || "?"} failed (${msg.error || "error"})`, p);
    } else if (msg.type === "source") {
      onSourceText(msg.path, msg.text, msg.snapshotPath);
    } else if (msg.type === "sourceError") {
      onSourceError(msg.path, msg.error);
    } else if (msg.type === "inlineStack") {
      if (msg.reqId !== hipStackReq) return;
      if (msg.markerId !== currentMarkerId) return;
      hipStackLoading = false;
      hipStack = Array.isArray(msg.stack) && msg.stack.length ? msg.stack : null;
      hipStackFrame = 0;
      renderHipStack();
      syncHipToSelected();
    }
  });

  // pick default code object: most frequent marker_id
  const markerCount = new Map();
  for (const e of DATA.events) {
    if (!e.marker_id || e.marker_id <= 0) continue;
    markerCount.set(e.marker_id, (markerCount.get(e.marker_id) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [k, n] of markerCount.entries()) { if (n > bestN) { bestN = n; best = k; } }
  // Restore the search box; the matches themselves are recomputed once the disasm arrives.
  if (SAVED_UI_STATE && SAVED_UI_STATE.disSearch) {
    const _ds = SAVED_UI_STATE.disSearch;
    disSearch.query = typeof _ds.query === "string" ? _ds.query : "";
    disSearch.regex = !!_ds.regex;
    disSearch.icase = _ds.icase !== false;
    disSearch.all = !!_ds.all;
    if (findInput) findInput.value = disSearch.query;
  }
  updateFindUI();
  // Restore the HIP pane. Whether it can open at all depends on the line table and on the
  // captured sources, both of which arrive with the disassembly, so renderDisasm is what finally
  // shows or drops it.
  if (SAVED_UI_STATE && SAVED_UI_STATE.hip) {
    const _h = SAVED_UI_STATE.hip;
    hipOpen = !!_h.open;
    if (typeof _h.file === "string") hipFile = _h.file;
    if (Number.isFinite(_h.w)) hipW = Math.max(220, _h.w);
    if (_h.sel && typeof _h.sel.file === "string" && Number.isFinite(_h.sel.line)) hipSel = _h.sel;
  }
  updateHipBtn();
  // Restore current code object and selection if present
  if (SAVED_UI_STATE && SAVED_UI_STATE.currentMarkerId != null) {
    requestDisasm(SAVED_UI_STATE.currentMarkerId);
  } else if (best != null) {
    requestDisasm(best);
  }
  // default to disasm mode for layout (no padding for virtualized table)
  if (srcBody) srcBody.classList.add("noPad");

  // ---- divider resize ----
  if (divider) {
    let dragging = false;
    let startY = 0;
    let startBottom = 320;
    divider.addEventListener("mousedown", (ev) => {
      dragging = true;
      startY = ev.clientY;
      const main = divider.parentElement;
      const rect = main.getBoundingClientRect();
      // approximate current bottom height from grid row
      startBottom = Math.max(120, rect.height * 0.35);
      ev.preventDefault();
    });
    window.addEventListener("mouseup", () => (dragging = false));
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const dy = ev.clientY - startY;
      const newBottom = Math.max(120, startBottom - dy);
      const main = divider.parentElement;
      main.style.gridTemplateRows = `1fr 6px ${newBottom}px`;
      resize();
    });
  }

  let view = { min: DATA.min_cycle, max: DATA.max_cycle };
  // Restore persisted UI state (fallback). Primary fix is retainContextWhenHidden in extension host.
  const _saved = SAVED_UI_STATE;
  if (_saved && _saved.view && Number.isFinite(_saved.view.min) && Number.isFinite(_saved.view.max)) {
    view.min = _saved.view.min;
    view.max = _saved.view.max;
    if (view.min < DATA.min_cycle) { view.max += (DATA.min_cycle - view.min); view.min = DATA.min_cycle; }
    if (view.max > DATA.max_cycle) { view.min -= (view.max - DATA.max_cycle); view.max = DATA.max_cycle; }
  }
  if (_saved && typeof _saved.occLaneFilter !== "undefined") occLaneFilter = _saved.occLaneFilter;
  if (_saved && _saved.regSel && typeof _saved.regSel.key === "string") {
    const atomsKey = String(_saved.regSel.atomsKey || "");
    const atoms = atomsKey ? atomsKey.split(",").filter(Boolean) : [];
    regSel = { key: _saved.regSel.key, atoms: new Set(atoms), focusLine: Number(_saved.regSel.focusLine || 0) };
    regSelVersion++;
  }
  // From here on, it is safe to render and persist state.
  _uiReady = true;
  if (_drawRequestedBeforeReady) {
    _drawRequestedBeforeReady = false;
    requestDraw();
  }
  // user markers (vertical lines)
  let MARKERS = [];
  const MARKER_COLOR = "#ff3b30";

  function saveMarkers() {
    vscode.postMessage({ type: "saveMarkers", traceKey, value: MARKERS });
  }

  function findMarkerNear(xPx, tolPx) {
    if (!MARKERS.length) return null;
    let best = null;
    let bestDx = Infinity;
    for (const cyc of MARKERS) {
      const dx = Math.abs(xScale(cyc) - xPx);
      if (dx < bestDx) { bestDx = dx; best = cyc; }
    }
    return bestDx <= tolPx ? best : null;
  }

  function resize() {
    const width = viewport.clientWidth;
    const height = Math.max(viewport.clientHeight, TOP_PAD + lanesTotalH + 30);
    // keep canvas width == viewport to avoid horizontal scroll hiding wave labels
    canvas.width = Math.max(1, width);
    canvas.height = height;
    requestDraw();
  }

  function xScale(cycle) {
    const w = canvas.width - LEFT_PAD - 10;
    const t = (cycle - view.min) / (view.max - view.min || 1);
    return LEFT_PAD + t * w;
  }

  function cycleAtX(x) {
    const w = canvas.width - LEFT_PAD - 10;
    const t = (x - LEFT_PAD) / (w || 1);
    return view.min + t * (view.max - view.min);
  }

  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = "11px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";

    const w = canvas.width - LEFT_PAD - 10;
    const steps = Math.floor(w / GRID_STEP_PX);
    for (let i = 0; i <= steps; i++) {
      const x = LEFT_PAD + i * GRID_STEP_PX;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      const cyc = Math.round(cycleAtX(x));
      ctx.fillText(String(cyc), x + 3, 4);
    }

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (let i = 0; i < lanes; i++) {
      ctx.fillText(laneLabel(i), 8, laneYByLane[i] + 1);
    }

    // Slot separators: without them, stacked sub-rows of adjacent slots read as one block.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (let i = 1; i < lanes; i++) {
      const y = Math.round(laneYByLane[i]) + 0.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_PAD - 8, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  function fillRoundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fill();
  }

  // Wait-like instructions (s_wait_*, s_barrier_wait) are reported with duration == stall + 1,
  // so their issue slice alone would be a sub-pixel sliver: draw the whole span as one bar.
  function eventSpan(e) {
    const t0 = e.issue;
    const stall = Math.max(0, e.stall || 0);
    const dur = Math.max(1, e.duration || 1);
    const exec = Math.max(0, dur - stall);
    const spanBar = e.cat === "IMMED" && stall > 0;
    return {
      t0,
      stall,
      hasBar: spanBar || exec > 0,
      barStart: spanBar ? t0 : t0 + stall,
      barLen: spanBar ? dur : exec,
      hasStallLine: stall > 0 && !spanBar,
    };
  }

  function drawEvents() {
    for (let lane = 0; lane < lanes; lane++) {
      const rowH = subHByLane[lane];
      const evs = eventsByLane[lane];

      const pad = (view.max - view.min) * 0.05;
      let lo = 0,
        hi = evs.length;
      const target = view.min - pad - maxSpanByLane[lane];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (evs[mid].issue < target) lo = mid + 1;
        else hi = mid;
      }

      for (let i = lo; i < evs.length; i++) {
        const e = evs[i];
        if (e.issue > view.max + pad) break;
        const s = eventSpan(e);
        const rowY = subRowY(lane, e.depth);

        if (s.hasBar) {
          const x1 = xScale(s.barStart);
          const x2 = xScale(s.barStart + Math.max(1, s.barLen));
          const ww = Math.max(1, x2 - x1);
          ctx.fillStyle = COLORS[e.cat] || "#999";
          // rounded bars to make separation clearer
          fillRoundRect(x1, rowY, ww, rowH, 3);
        }

        // stall line (aligned to the bottom edge of this event's sub-row): [t0, t0 + stall]
        if (s.hasStallLine) {
          const sx1 = xScale(s.t0);
          const sx2 = xScale(s.t0 + s.stall);
          // bottom edge of the bar, keep inside pixels
          const yy = rowY + rowH - 1;
          ctx.save();
          ctx.strokeStyle = stallColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx1, yy);
          ctx.lineTo(Math.max(sx1 + 1, sx2), yy);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  let _drawPending = false;
  function requestDraw() {
    if (!_uiReady) { _drawRequestedBeforeReady = true; return; }
    if (_drawPending) return;
    _drawPending = true;
    requestAnimationFrame(() => {
      _drawPending = false;
      draw();
    });
    scheduleSaveUiState();
  }

  // ---- measure range (left-drag) ----
  // State is defined here so both draw() and event handlers can access it.
  // Left mouse drag: measure cycle interval (shaded selection + delta label).
  // Right mouse drag: pan (see handlers below).
  let measure = null; // { active:boolean, start:number, end:number, justFinished:boolean }

  function drawMeasureOverlay() {
    if (!measure) return;
    if (!measure.active && measure.start === measure.end) return;

    const t1 = Math.min(measure.start, measure.end);
    const t2 = Math.max(measure.start, measure.end);
    const x1 = xScale(t1);
    const x2 = xScale(t2);
    const left = Math.min(x1, x2);
    const width = Math.max(1, Math.abs(x2 - x1));

    ctx.save();
    // shaded region + boundary lines
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(left, 0, width, canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(left, canvas.height);
    ctx.moveTo(left + width, 0);
    ctx.lineTo(left + width, canvas.height);
    ctx.stroke();

    // label
    const dt = Math.round(t2 - t1);
    const label = `Δ ${dt} cycles   [${Math.round(t1)}, ${Math.round(t2)}]`;
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    const padX = 6;
    const padY = 4;
    const tw = ctx.measureText(label).width;
    const bw = tw + padX * 2;
    const bh = 20;
    const bx = Math.max(LEFT_PAD + 4, Math.min(left + 4, canvas.width - bw - 4));
    const by = 4;
    ctx.fillStyle = "rgba(0,0,0,0.60)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(label, bx + padX, by + padY);
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    // Everything below is placed by xScale, whose origin is LEFT_PAD, so panning
    // right slides content into the gutter and paints over the lane labels.
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_PAD, 0, Math.max(0, canvas.width - LEFT_PAD), canvas.height);
    ctx.clip();

    drawEvents();
    // user markers (draw over events)
    if (MARKERS && MARKERS.length) {
      ctx.save();
      for (const cyc of MARKERS) {
        const x = Math.round(xScale(cyc)) + 0.5;
        // black outline underlay
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
        // main marker
        ctx.strokeStyle = MARKER_COLOR;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      ctx.restore();
    }
    drawMeasureOverlay();
    // selected outline
    if (selected) {
      const lane = selected.lane;
      const rowH = subHByLane[lane];
      // find the event at this pc near this issue
      const evs = eventsByLane[lane] || [];
      let e = null;
      let bestDist = Infinity;
      for (let i = 0; i < evs.length; i++) {
        const it = evs[i];
        if (it.pc !== selected.pc || it.marker_id !== selected.marker_id) continue;
        const d = Math.abs((it.issue || 0) - (selected.issue || 0));
        if (d < bestDist) { bestDist = d; e = it; }
      }
      if (e) {
        const s = eventSpan(e);
        const rowY = subRowY(lane, e.depth);
        ctx.save();
        if (s.hasBar) {
          // Selection highlight should include stall-line span when present.
          const hlStart = s.hasStallLine ? s.t0 : s.barStart;
          const hlEnd = s.barStart + Math.max(1, s.barLen);
          const x1 = xScale(hlStart);
          const x2 = xScale(hlEnd);
          // stronger highlight: translucent fill + thicker stroke
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          ctx.fillRect(x1 - 2, rowY - 2, Math.max(4, x2 - x1 + 4), rowH + 4);
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 - 2, rowY - 2, Math.max(4, x2 - x1 + 4), rowH + 4);
        } else {
          // stall-only event: highlight the stall line span
          const sx1 = xScale(s.t0);
          const sx2 = xScale(s.t0 + s.stall);
          const yy = rowY + rowH - 1;
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx1, yy);
          ctx.lineTo(Math.max(sx1 + 1, sx2), yy);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // Several events can cover one cycle once their windows overlap, so the hovered sub-row picks
  // which one: without it, hovering the stack would always report whichever happens to be found
  // first. depth == null means "closest to the top".
  function findEvent(lane, cycle, depth) {
    const evs = eventsByLane[lane];
    if (!evs || evs.length === 0) return null;
    let lo = 0,
      hi = evs.length;
    const target = cycle - maxSpanByLane[lane] - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (evs[mid].issue < target) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    let bestScore = Infinity;
    for (let i = lo; i < evs.length; i++) {
      const e = evs[i];
      if (e.issue > cycle) break;
      const s = eventSpan(e);
      if (cycle > s.barStart + Math.max(1, s.barLen)) continue;
      const score = Math.abs((e.depth || 0) - (depth || 0));
      if (score < bestScore) {
        bestScore = score;
        best = e;
        if (score === 0) break;
      }
    }
    return best;
  }

  function showTip(x, y, e) {
    const name = e.asm && e.asm.length ? e.asm : "(unknown)";
    const pc = `marker=${e.marker_id} pc=0x${e.pc.toString(16)}`;
    const stall = Math.max(0, e.stall || 0);
    const dur = Math.max(1, e.duration || 1);
    const t0 = e.issue;
    const tIssue = t0 + stall;
    const exec = Math.max(0, dur - stall);
    const tEnd = t0 + dur;
    const nSub = subRowsByLane[e.lane] || 1;
    const sub = nSub > 1 ? `sub-row=${(e.depth || 0) + 1}/${nSub} (overlapping execution)\n` : "";
    tip.textContent =
      `${name}\n` +
      `${pc}\n` +
      `category=${e.cat}  raw=${CAT_NAMES[String(e.category)] || ""}\n` +
      `t0=${t0}  t_issue=${tIssue}  t_end=${tEnd}\n` +
      `duration=${dur}  stall=${stall}  exec(duration-stall)=${exec}\n` +
      sub +
      `${CU_WORD}=${e.cu} simd=${e.simd} slot=${e.slot}`;
    tip.style.display = "block";
    const pad = 14;
    tip.style.left = x + pad + "px";
    tip.style.top = y + pad + "px";
  }

  function hideTip() {
    tip.style.display = "none";
  }

  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left + viewport.scrollLeft;
    const y = ev.clientY - rect.top + viewport.scrollTop;
    const lane = laneAtY(y);
    if (lane < 0) {
      hideTip();
      return;
    }
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle, subRowAtY(lane, y));
    if (!e) {
      hideTip();
      return;
    }
    showTip(ev.clientX - rect.left, ev.clientY - rect.top, e);
  });
  canvas.addEventListener("mouseleave", hideTip);

  // click trace -> select + sync source
  canvas.addEventListener("click", (ev) => {
    // Ignore click after a ctrl+drag measurement to avoid accidental selection.
    if (measure && (measure.active || measure.justFinished)) return;
    // Alt+click: add/remove a marker at this cycle
    if (ev.altKey) {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left + viewport.scrollLeft;
      const cycle = cycleAtX(x);
      const cyc = Math.round(cycle);
      const near = findMarkerNear(x, 6);
      if (near != null && Math.abs(near - cyc) <= Math.max(2, Math.round((view.max - view.min) / canvas.width) * 3)) {
        MARKERS = MARKERS.filter((v) => v !== near);
      } else {
        if (!MARKERS.includes(cyc)) MARKERS.push(cyc);
      }
      MARKERS.sort((a, b) => a - b);
      saveMarkers();
      requestDraw();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left + viewport.scrollLeft;
    const y = ev.clientY - rect.top + viewport.scrollTop;
    const lane = laneAtY(y);
    if (lane < 0) return;
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle, subRowAtY(lane, y));
    if (!e) return;
    selected = { marker_id: e.marker_id, pc: e.pc, lane: e.lane, issue: e.issue };
    // ensure correct disasm is loaded
    if (e.marker_id && String(e.marker_id) !== String(currentMarkerId)) requestDisasm(e.marker_id);
    updateWaitSelFromSelected();
    highlightDisasm(e.pc);
    requestDraw();
  });

  // double click trace -> open occurrences list
  canvas.addEventListener("dblclick", (ev) => {
    // Ignore dblclick after a ctrl+drag measurement.
    if (measure && (measure.active || measure.justFinished)) return;
    if (ev.altKey) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left + viewport.scrollLeft;
    const y = ev.clientY - rect.top + viewport.scrollTop;
    const lane = laneAtY(y);
    if (lane < 0) return;
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle, subRowAtY(lane, y));
    if (!e) return;
    selected = { marker_id: e.marker_id, pc: e.pc, lane: e.lane, issue: e.issue };
    if (e.marker_id && String(e.marker_id) !== String(currentMarkerId)) requestDisasm(e.marker_id);
    updateWaitSelFromSelected();
    setSourceMode("occ");
  });

  // Ctrl + left-drag measures; left/right drag pans. Disable context menu on canvas.
  let dragging = false;
  let dragX0 = 0;
  let view0 = null;
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  canvas.addEventListener("mousedown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left + viewport.scrollLeft;
    const c = cycleAtX(x);
    // Measurement mode: Ctrl + left mouse
    if (ev.button === 0 && ev.ctrlKey) {
      measure = { active: true, start: c, end: c, justFinished: false };
      requestDraw();
      ev.preventDefault();
      return;
    }
    // Pan mode (default): left or right mouse drag
    if (ev.button === 0 || ev.button === 2) {
      dragging = true;
      dragX0 = ev.clientX;
      view0 = { ...view };
      ev.preventDefault();
    }
  });

  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      view0 = null;
    }
    if (measure && measure.active) {
      measure.active = false;
      measure.justFinished = true;
      requestDraw();
      setTimeout(() => {
        if (measure) measure.justFinished = false;
      }, 60);
    }
  });

  window.addEventListener("mousemove", (ev) => {
    if (measure && measure.active) {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left + viewport.scrollLeft;
      measure.end = cycleAtX(x);
      requestDraw();
      return;
    }
    if (!dragging || !view0) return;
    const dx = ev.clientX - dragX0;
    const w = canvas.width - LEFT_PAD - 10;
    const frac = dx / (w || 1);
    const span = view0.max - view0.min;
    const shift = -frac * span;
    view.min = view0.min + shift;
    view.max = view0.max + shift;
    if (view.min < DATA.min_cycle) {
      view.max += DATA.min_cycle - view.min;
      view.min = DATA.min_cycle;
    }
    if (view.max > DATA.max_cycle) {
      view.min -= view.max - DATA.max_cycle;
      view.max = DATA.max_cycle;
    }
    requestDraw();
  });

  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left + viewport.scrollLeft;
      const center = cycleAtX(x);
      const zoom = ev.deltaY < 0 ? 0.85 : 1.18;
      const span = (view.max - view.min) * zoom;
      const minSpan = 200;
      const maxSpan = DATA.max_cycle - DATA.min_cycle;
      const newSpan = Math.min(maxSpan, Math.max(minSpan, span));
      const t = (center - view.min) / (view.max - view.min || 1);
      view.min = center - t * newSpan;
      view.max = view.min + newSpan;
      if (view.min < DATA.min_cycle) {
        view.max += DATA.min_cycle - view.min;
        view.min = DATA.min_cycle;
      }
      if (view.max > DATA.max_cycle) {
        view.min -= view.max - DATA.max_cycle;
        view.max = DATA.max_cycle;
      }
      requestDraw();
    },
    { passive: false }
  );

  // perfetto-like keyboard shortcuts: WASD to navigate the timeline.
  function clampView() {
    if (view.min < DATA.min_cycle) {
      view.max += DATA.min_cycle - view.min;
      view.min = DATA.min_cycle;
    }
    if (view.max > DATA.max_cycle) {
      view.min -= view.max - DATA.max_cycle;
      view.max = DATA.max_cycle;
    }
    // Avoid degenerate span
    const minSpan = 200;
    if (view.max - view.min < minSpan) view.max = view.min + minSpan;
  }

  function zoomAt(center, zoomFactor) {
    const span = (view.max - view.min) * zoomFactor;
    const minSpan = 200;
    const maxSpan = DATA.max_cycle - DATA.min_cycle;
    const newSpan = Math.min(maxSpan, Math.max(minSpan, span));
    const t = (center - view.min) / (view.max - view.min || 1);
    view.min = center - t * newSpan;
    view.max = view.min + newSpan;
    clampView();
  }

  function panByCycles(delta) {
    view.min += delta;
    view.max += delta;
    clampView();
  }

  window.addEventListener("keydown", (ev) => {
    // don't hijack typing in inputs / pickers
    const ae = document.activeElement;
    const tag = ae && ae.tagName ? String(ae.tagName).toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || (ae && ae.isContentEditable)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const k = String(ev.key || "").toLowerCase();
    if (!k || (k !== "w" && k !== "a" && k !== "s" && k !== "d")) return;

    ev.preventDefault();
    ev.stopPropagation();

    const span = view.max - view.min;
    const accel = ev.shiftKey ? 4.0 : 1.0;
    const center = (view.min + view.max) * 0.5;

    if (k === "a") {
      // pan left
      panByCycles(-span * 0.10 * accel);
    } else if (k === "d") {
      // pan right
      panByCycles(span * 0.10 * accel);
    } else if (k === "w") {
      // zoom in
      zoomAt(center, ev.shiftKey ? 0.75 : 0.85);
    } else if (k === "s") {
      // zoom out
      zoomAt(center, ev.shiftKey ? 1.35 : 1.18);
    }
    requestDraw();
  });

    window.addEventListener("resize", resize);
    resize();

  // Restore scroll positions after initial layout (fallback).
  if (_saved && viewport && Number.isFinite(_saved.viewportScrollTop)) {
    setTimeout(() => {
      try { viewport.scrollTop = _saved.viewportScrollTop; } catch { /* ignore */ }
      try { if (srcBody && Number.isFinite(_saved.srcScrollTop)) srcBody.scrollTop = _saved.srcScrollTop; } catch { /* ignore */ }
      requestDraw();
    }, 0);
  }
})();

