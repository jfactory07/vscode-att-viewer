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

  const ROW_H = 14;
  const ROW_PAD = 2;
  // leave room for the cycle axis labels so wave0 doesn't overlap
  const TOP_PAD = 24;
  const LEFT_PAD = 80;
  const GRID_STEP_PX = 120;
  // Built-in defaults (shipped with the extension). User config can override these.
  const DEFAULT_STALL_COLOR = "#ff9aa2";
  const BUILTIN_DEFAULT_COLORS = {
    SMEM: "#6aa84f",
    SALU: "#ffd966",
    VMEM: "#e69138",
    FLAT: "#f6b26b",
    LDS: "#3c78d8",
    MFMA: "#ff0000",
    VALU: "#4b0082",
    JUMP: "#8e7cc3",
    NEXT: "#b4a7d6",
    IMMED: "#999999",
    CONTEXT: "#76a5af",
    MESSAGE: "#c27ba0",
    BVH: "#93c47d",
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

  showLoading("Loading trace…");
  const res = await fetch(jsonUri);
  const DATA = await res.json();
  hideLoading();

  // Mutable colors map (category -> color hex).
  // Start from built-in defaults, then merge any trace-provided colors.
  let COLORS = { ...BUILTIN_DEFAULT_COLORS, ...(DATA.colors || {}) };
  const CAT_NAMES = DATA.cat_names;

  const lanes = DATA.lanes;
  const eventsByLane = [];
  for (let i = 0; i < lanes; i++) eventsByLane.push([]);
  for (const e of DATA.events) eventsByLane[e.lane].push(e);
  for (const lane of eventsByLane) lane.sort((a, b) => a.issue - b.issue);

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

  metaEl.textContent = `lanes=${lanes}  events=${DATA.events.length}  cycles=[${DATA.min_cycle}, ${DATA.max_cycle}]`;

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
    saveColors();
  }

  if (cfgReset) cfgReset.addEventListener("click", resetColors);
  buildCfgUI();

  // load persisted config (if any)
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "colors" && msg.value) {
      const v = msg.value;
      if (v.colors && typeof v.colors === "object") COLORS = { ...COLORS, ...v.colors };
      if (typeof v.stallColor === "string") stallColor = v.stallColor;
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
  let disasmLines = []; // [{addr,text}]
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
  let waitSel = null; // { fromLine:number, targets:Array<{type:"lgkm"|"vm", n:number, line:number, pc:number}> }
  let waitSelVersion = 0;
  const WAIT_SCAN_BACK_LIMIT = 4096;

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
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
  function renderAsmHtmlWithRegs(text, enableHighlightForLine) {
    const s = String(text || "");
    let out = "";
    let last = 0;
    let m;
    while ((m = REG_RE.exec(s)) !== null) {
      const a = m.index;
      const b = a + m[0].length;
      if (a > last) out += escapeHtml(s.slice(last, a));
      const tok = m[0];
      // boundary check: avoid matching inside identifiers
      const pre = a > 0 ? s[a - 1] : "";
      const post = b < s.length ? s[b] : "";
      const isWord = (ch) => /[A-Za-z0-9_]/.test(ch);
      if ((pre && isWord(pre)) || (post && isWord(post))) {
        out += escapeHtml(tok);
        last = b;
        continue;
      }
      const info = atomsFromRegToken(tok);
      const isSel = !!(enableHighlightForLine && regSel && intersectsAtoms(info.atoms, regSel.atoms));
      out += `<span class="regTok${isSel ? " sel" : ""}" data-regtok="${escapeHtml(tok)}">${escapeHtml(tok)}</span>`;
      last = b;
    }
    if (last < s.length) out += escapeHtml(s.slice(last));
    return out || escapeHtml(s);
  }

  function parseWaitcnt(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const mnem = s.split(/\s+/)[0] || "";
    if (mnem !== "s_waitcnt") return null;
    const lgkmM = s.match(/lgkmcnt\((\d+)\)/);
    const vmM = s.match(/vmcnt\((\d+)\)/);
    const lgkm = lgkmM ? Number(lgkmM[1]) : null;
    const vm = vmM ? Number(vmM[1]) : null;
    if (lgkm == null && vm == null) return null;
    return {
      lgkm: Number.isFinite(lgkm) ? lgkm : null,
      vm: Number.isFinite(vm) ? vm : null
    };
  }

  function mnemOfLineText(text) {
    const s = String(text || "").trim();
    if (!s) return "";
    return (s.split(/\s+/)[0] || "").trim();
  }

  function isDsReadWrite(text) {
    const m = mnemOfLineText(text);
    return /^ds_(read|write)/.test(m);
  }

  function isBufferLoad(text) {
    const m = mnemOfLineText(text);
    return /^buffer_load/.test(m);
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
    if (!info) {
      if (waitSel) { waitSel = null; waitSelVersion++; }
      return;
    }
    const targets = [];
    if (info.lgkm != null) {
      const tLine = findNthPrevLine(Number(fromLine), isDsReadWrite, Number(info.lgkm) + 1);
      if (tLine != null && disasmLines[tLine]) {
        targets.push({ type: "lgkm", n: Number(info.lgkm), line: Number(tLine), pc: Number(disasmLines[tLine].addr) });
      }
    }
    if (info.vm != null) {
      const tLine = findNthPrevLine(Number(fromLine), isBufferLoad, Number(info.vm) + 1);
      if (tLine != null && disasmLines[tLine]) {
        targets.push({ type: "vm", n: Number(info.vm), line: Number(tLine), pc: Number(disasmLines[tLine].addr) });
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
  let tabDisasmBtn = null;
  let tabOccBtn = null;
  if (sourceHeader) {
    const tabs = document.createElement("div");
    tabs.className = "srcTabs";
    tabDisasmBtn = document.createElement("button");
    tabDisasmBtn.className = "tabBtn active";
    tabDisasmBtn.textContent = "Disasm";
    tabOccBtn = document.createElement("button");
    tabOccBtn.className = "tabBtn";
    tabOccBtn.textContent = "Occurrences";
    tabs.appendChild(tabDisasmBtn);
    tabs.appendChild(tabOccBtn);
    sourceHeader.appendChild(tabs);
  }

  function setSourceMode(mode) {
    sourceMode = mode;
    if (tabDisasmBtn) tabDisasmBtn.classList.toggle("active", mode === "disasm");
    if (tabOccBtn) tabOccBtn.classList.toggle("active", mode === "occ");
    if (srcBody) srcBody.classList.toggle("noPad", mode === "disasm");
    if (mode === "disasm") {
      renderDisasm(disasmLines);
      if (selected && selected.marker_id === currentMarkerId) highlightDisasm(selected.pc);
    } else {
      if (selected) renderOccurrences(selected.marker_id, selected.pc);
    }
  }
  if (tabDisasmBtn) tabDisasmBtn.addEventListener("click", () => setSourceMode("disasm"));
  if (tabOccBtn) tabOccBtn.addEventListener("click", () => setSourceMode("occ"));

  function requestDisasm(markerId) {
    const p = codeobjFiles[String(markerId)];
    if (!p) {
      if (srcMeta) srcMeta.textContent = `Source: marker=${markerId} (no code object path)`;
      return;
    }
    currentMarkerId = markerId;
    if (srcMeta) srcMeta.textContent = `Source: marker=${markerId}  ${p}`;
    vscode.postMessage({ type: "requestDisasm", markerId, codeobjPath: p, gpuArch: (DATA.meta && DATA.meta.gpu_arch) || "gfx950" });
  }

  function renderDisasm(lines) {
    disasmLines = lines || [];
    disasmAddrToEl = new Map();
    if (!srcBody) return;
    // virtualized grid: only render visible rows to avoid huge DOM
    srcBody.innerHTML = "";

    const disContainer = document.createElement("div");
    disContainer.className = "disContainer";

    // grid columns: addr | text | total | wave columns
    const cols = ["74px", "1fr", "52px"];
    for (let w = 0; w < lanes; w++) cols.push("38px");
    const gridTemplateColumns = cols.join(" ");
    const ADDR_W = 74;

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
      hw.textContent = `w${w}`;
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
      // Match the screenshot: elbow in the left gutter, arrow points into the target row.
      const xEdge = Math.max(10, Math.min(ADDR_W - 8, 66)); // near end of addr column
      const xGutter = 10; // left gutter fold

      for (const t of waitSel.targets) {
        const yTo = (t.line * ROW_H) + ROW_H * 0.5;
        const isLgkm = t.type === "lgkm";
        const color = "#ff3b30";
        const markerId = isLgkm ? "mkLgkm" : "mkVm";

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
      // Wait links are attached to disBody and scroll naturally with rows.
      if (first === lastFirst && count === lastCount && lastRegVer === regSelVersion && lastWaitVer === waitSelVersion) return;
      lastFirst = first; lastCount = count;
      lastRegVer = regSelVersion;
      lastWaitVer = waitSelVersion;
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
        const isWaitFrom = !!(waitSel && Number(idx) === Number(waitSel.fromLine));
        const isWaitTlgkm = !!(waitSel && waitSel.targets && waitSel.targets.some((t) => t.type === "lgkm" && Number(t.line) === Number(idx)));
        const isWaitTvm = !!(waitSel && waitSel.targets && waitSel.targets.some((t) => t.type === "vm" && Number(t.line) === Number(idx)));
        row.classList.toggle("waitFrom", isWaitFrom);
        row.classList.toggle("waitTargetLgkm", isWaitTlgkm);
        row.classList.toggle("waitTargetVmcnt", isWaitTvm);

        // fill cells
        const cells = row.children;
        cells[0].className = "disCell disAddrCell";
        {
          const addr = "0x" + pc.toString(16).padStart(4, "0");
          let badges = "";
          if (isWaitTlgkm) badges += ` <span class="waitBadge lgkm">LGKM</span>`;
          if (isWaitTvm) badges += ` <span class="waitBadge vm">VM</span>`;
          cells[0].innerHTML = escapeHtml(addr) + badges;
        }
        cells[1].className = "disCell disTextCell";
        // Highlight selected register occurrences in the selected line, as well as:
        // - all prior lines
        // - following lines up to REG_HL_FORWARD_LINES (bounded for performance)
        let txtHtml = renderAsmHtmlWithRegs(
          ln.text,
          !!(regSel && Number(idx) <= (Number(regSel.focusLine) + REG_HL_FORWARD_LINES))
        );
        if (isWaitFrom && waitSel && waitSel.targets && waitSel.targets.length) {
          const parts = waitSel.targets.map((t) => {
            const p = "0x" + Number(t.pc).toString(16);
            if (t.type === "lgkm") return `LGKM(${t.n}) ↖ ${p}`;
            return `VM(${t.n}) ↖ ${p}`;
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
            if (ev && ev.target && ev.target.classList && ev.target.classList.contains("regTok")) {
              const tok = ev.target.getAttribute("data-regtok") || "";
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
            const pcNow = Number(row.dataset.addr);
            const hitNow = pcIndex.get(`${currentMarkerId}|${pcNow}`);
            if (!hitNow) return;
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

    // recompute wait arrows when disasm changes
    updateWaitSelFromSelected();
    requestWaitLinks();
    updateVisible();
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
    lab.textContent = "Lane:";
    const sel = document.createElement("select");
    sel.className = "occLaneSel";
    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "all";
    sel.appendChild(optAll);
    for (let l = 0; l < lanes; l++) {
      const o = document.createElement("option");
      o.value = String(l);
      o.textContent = `w${l}`;
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

    const asm = events[0].asm || "";
    const hint = document.createElement("div");
    hint.className = "occHint";
    const laneSuffix = occLaneFilter == null ? "" : `   lane=w${occLaneFilter}`;
    hint.textContent = `${asm || "(unknown)"}   marker=${markerId} pc=0x${Number(pc).toString(16)}   count=${events.length}${laneSuffix}`;
    srcBody.appendChild(hint);

    const table = document.createElement("table");
    table.className = "occTable";
    table.innerHTML = `
      <thead><tr>
        <th>#</th><th>lane</th><th>t0</th><th>Δt0</th><th>stall</th><th>exec</th><th>dur</th><th>cat</th>
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
          <td>${e.lane}</td>
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
      renderDisasm(msg.lines);
      updateWaitSelFromSelected();
      if (selected && selected.marker_id === msg.markerId) highlightDisasm(selected.pc);
    } else if (msg.type === "disasmError") {
      if (srcMeta) srcMeta.textContent = `Source: failed (${msg.error || "error"})`;
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
  if (best != null) requestDisasm(best);
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
    const height = Math.max(viewport.clientHeight, TOP_PAD + lanes * ROW_H + 30);
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
      const y = TOP_PAD + i * ROW_H;
      ctx.fillText(`wave ${i}`, 8, y + 1);
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

  function drawEvents() {
    for (let lane = 0; lane < lanes; lane++) {
      const y = TOP_PAD + lane * ROW_H;
      const rowY = y + ROW_PAD;
      const rowH = ROW_H - ROW_PAD * 2;
      const evs = eventsByLane[lane];

      const pad = (view.max - view.min) * 0.05;
      let lo = 0,
        hi = evs.length;
      const target = view.min - pad;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (evs[mid].issue < target) lo = mid + 1;
        else hi = mid;
      }

      for (let i = lo; i < evs.length; i++) {
        const e = evs[i];
        if (e.issue > view.max + pad) break;
        const t0 = e.issue; // first attempted
        const stall = Math.max(0, e.stall || 0);
        const dur = Math.max(1, e.duration || 1);
        const t_issue = t0 + stall;      // successful issue time (if any)
        const exec = Math.max(0, dur - stall); // execution/issue cycles; can be 0 for wait-like insts

        const isImmed = e.cat === "IMMED";
        // issue/exec bar:
        // - normal: [t_issue, t_issue + exec]
        // - immed with exec==0: render as a bar covering [t0, t0+dur] (no separate stall line)
        if (exec > 0 || (isImmed && exec === 0)) {
          const barStart = (isImmed && exec === 0) ? t0 : t_issue;
          const barLen = (isImmed && exec === 0) ? dur : exec;
          const x1 = xScale(barStart);
          const x2 = xScale(barStart + Math.max(1, barLen));
          const ww = Math.max(1, x2 - x1);
          ctx.fillStyle = COLORS[e.cat] || "#999";
          // rounded bars to make separation clearer
          fillRoundRect(x1, rowY, ww, rowH, 3);
        }

        // stall line (aligned to bottom edge): [t0, t_issue]
        if (stall > 0 && !(isImmed && exec === 0)) {
          const sx1 = xScale(t0);
          const sx2 = xScale(t_issue);
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
    if (_drawPending) return;
    _drawPending = true;
    requestAnimationFrame(() => {
      _drawPending = false;
      draw();
    });
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
      const y = TOP_PAD + lane * ROW_H;
      const rowY = y + ROW_PAD;
      const rowH = ROW_H - ROW_PAD * 2;
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
        const t0 = e.issue;
        const stall = Math.max(0, e.stall || 0);
        const dur = Math.max(1, e.duration || 1);
        const t_issue = t0 + stall;
        const exec = Math.max(0, dur - stall);
        const isImmed = e.cat === "IMMED";
        ctx.save();
        if (exec > 0 || (isImmed && exec === 0)) {
          // Selection highlight should include stall-line span when present.
          const barStart = (isImmed && exec === 0) ? t0 : t_issue;
          const barLen = (isImmed && exec === 0) ? dur : exec;
          const hasStallLine = stall > 0 && !(isImmed && exec === 0);
          const hlStart = hasStallLine ? t0 : barStart;
          const hlEnd = barStart + Math.max(1, barLen);
          const x1 = xScale(hlStart);
          const x2 = xScale(hlEnd);
          // stronger highlight: translucent fill + thicker stroke
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          ctx.fillRect(x1 - 2, rowY - 2, Math.max(4, x2 - x1 + 4), rowH + 4);
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 - 2, rowY - 2, Math.max(4, x2 - x1 + 4), rowH + 4);
        } else {
          // wait-like instruction: highlight the stall line span
          const sx1 = xScale(t0);
          const sx2 = xScale(t_issue);
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
  }

  function findEvent(lane, cycle) {
    const evs = eventsByLane[lane];
    if (!evs || evs.length === 0) return null;
    let lo = 0,
      hi = evs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = evs[mid];
      if (cycle < e.issue) hi = mid - 1;
      else if (cycle > e.issue) lo = mid + 1;
      else return e;
    }
    const idx = Math.max(0, Math.min(evs.length - 1, hi));
    const e = evs[idx];
    const end = e.issue + Math.max(1, e.duration);
    if (cycle >= e.issue && cycle <= end) return e;
    for (const j of [idx - 1, idx + 1]) {
      if (j < 0 || j >= evs.length) continue;
      const ee = evs[j];
      const eeEnd = ee.issue + Math.max(1, ee.duration);
      if (cycle >= ee.issue && cycle <= eeEnd) return ee;
    }
    return null;
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
    tip.textContent =
      `${name}\n` +
      `${pc}\n` +
      `category=${e.cat}  raw=${CAT_NAMES[String(e.category)] || ""}\n` +
      `t0=${t0}  t_issue=${tIssue}  t_end=${tEnd}\n` +
      `duration=${dur}  stall=${stall}  exec(duration-stall)=${exec}\n` +
      `cu=${e.cu} simd=${e.simd} slot=${e.slot} lane=${e.lane}`;
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
    const lane = Math.floor((y - TOP_PAD) / ROW_H);
    if (lane < 0 || lane >= lanes) {
      hideTip();
      return;
    }
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle);
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
    const lane = Math.floor((y - TOP_PAD) / ROW_H);
    if (lane < 0 || lane >= lanes) return;
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle);
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
    const lane = Math.floor((y - TOP_PAD) / ROW_H);
    if (lane < 0 || lane >= lanes) return;
    const cycle = cycleAtX(x);
    const e = findEvent(lane, cycle);
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
})();

