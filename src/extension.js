// @ts-check

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function pickResultsDb(attPath) {
  const dir = path.dirname(attPath);
  const base = path.basename(attPath);
  const prefix = base.split("_")[0]; // e.g. 990900_...
  const byPrefix = path.join(dir, `${prefix}_results.db`);
  if (fileExists(byPrefix)) return byPrefix;
  const cands = listFiles(dir).filter((p) => p.endsWith("_results.db"));
  if (cands.length === 1) return cands[0];
  return null;
}

// rocprofv3 copies every source file it can read at capture time into the dispatch's UI output
// directory, as `source_<n>_<basename>`. That copy is the text the code object was compiled from.
// The working tree drifts away from it with the next edit -- on the traces here, a kernel header
// captured at 1112 lines is 1166 in the tree, so every attribution below the first insertion
// points at the wrong statement -- and a `-gline-tables-only` line table carries no file checksum
// to catch it. So the panel reads the capture-time copy and never the working tree.
function nextSourceSnapshotPath(snapshotDir, base) {
  let maxN = -1;
  for (const name of fs.readdirSync(snapshotDir)) {
    const m = name.match(/^source_(\d+)_/);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return path.join(snapshotDir, `source_${maxN + 1}_${base}`);
}

function findSourceSnapshotDir(attPath) {
  const dir = path.dirname(attPath);
  // e.g. zrow_16742_shader_engine_0_338.att -> ui_output_agent_16742_dispatch_338
  const m = path.basename(attPath).match(/_(\d+)_shader_engine_\d+_(\d+)\.att$/);
  if (!m) return null;
  const [, agent, dispatch] = m;
  const exact = path.join(dir, `ui_output_agent_${agent}_dispatch_${dispatch}`);
  if (fileExists(exact)) return exact;
  // The agent number in the trace name and in the UI output directory have agreed on every
  // capture seen so far; fall back to the dispatch alone in case they ever do not.
  const rx = new RegExp(`^ui_output_agent_\\d+_dispatch_${dispatch}$`);
  const cands = listFiles(dir).filter((p) => rx.test(path.basename(p)));
  return cands.length === 1 ? cands[0] : null;
}

function indexSourceSnapshot(dir) {
  const byBase = new Map();
  if (!dir) return byBase;
  for (const p of listFiles(dir)) {
    const m = path.basename(p).match(/^source_\d+_(.+)$/);
    if (!m) continue;
    const arr = byBase.get(m[1]);
    if (arr) arr.push(p);
    else byBase.set(m[1], [p]);
  }
  return byBase;
}

// Where the MCP server keeps its state, mirroring att_mcp.py's own default.
let chatCommands = new Set();

function mcpStateDir() {
  return process.env.ATT_MCP_CACHE || path.join(os.homedir(), ".cache", "att_mcp");
}

// Record which trace the reader is looking at, for the MCP server's `att_current` to answer.
//
// The analysis lives in a chat rather than in this panel now, and a chat has no way to see
// which of the 200-odd captures on disk the question is about. This is that missing link:
// the panel writes what it opened, and the server reads it.
function readCurrentState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(mcpStateDir(), "current.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeCurrentState(state) {
  try {
    const dir = mcpStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify(state), "utf8");
    return true;
  } catch {
    return false; /* the panel still works without the handoff */
  }
}

function recordCurrentTrace(attPath) {
  const prev = readCurrentState();
  const state = {
    att: attPath,
    dir: path.dirname(attPath),
    name: path.basename(attPath),
    updated: Math.floor(Date.now() / 1000),
  };
  // A selection is only meaningful for the trace it was made in, so carry it across a
  // refocus of the same trace but drop it when the reader switches to a different one.
  if (prev && prev.att === attPath && prev.selection) state.selection = prev.selection;
  writeCurrentState(state);
}

// Attach the instructions highlighted in the listing to the trace's chat context.
//
// Selecting a range in the panel is how a reader points at code; this makes that gesture
// legible to the chat, which otherwise only knows the trace as a whole.
function recordSelection(attPath, msg) {
  const lines = Array.isArray(msg.lines) ? msg.lines.slice(0, 400) : [];
  const state = readCurrentState() || {};
  state.att = attPath;
  state.dir = path.dirname(attPath);
  state.name = path.basename(attPath);
  state.updated = Math.floor(Date.now() / 1000);
  state.selection = {
    codeobj: msg.codeobjPath || "",
    marker: msg.markerId == null ? null : msg.markerId,
    begin: msg.begin,
    end: msg.end,
    count: Array.isArray(msg.lines) ? msg.lines.length : 0,
    truncated: Array.isArray(msg.lines) && msg.lines.length > lines.length,
    // present when the reader measured an interval on one slot's row rather than selecting
    // lines in the listing: the cycles are half of what that gesture points at
    window: msg.window || null,
    lines,
    attached: Math.floor(Date.now() / 1000),
  };
  return writeCurrentState(state);
}

// Where the selection files go, beside the rest of the MCP server's state.
//
// Not under the workspace: a chip for a file outside it sends as readily as one inside, and
// the reader's source tree is no place for a file written on every click.
function selectionsDir() {
  return path.join(mcpStateDir(), "selections");
}

// The selected instructions as the text that gets attached.
//
// The header says which trace this came from and what to call for the cycles. Whatever this
// returns arrives with the selection, which is what keeps all of it out of the chat input.
//
// It names the whole tool set, not just the two calls that answer the obvious question. A
// model that has the listing in front of it and knows only `att_disasm` will price these
// instructions and stop there, when what the reader wants next is nearly always whether the
// loop is even where the dispatch spends itself. The list costs a dozen lines once per click
// and is the only place the model is told the other tools exist.
function selectionListing(attPath, msg) {
  const hex = (v) => "0x" + Number(v).toString(16);
  const lines = Array.isArray(msg.lines) ? msg.lines : [];
  const w = Math.max(...lines.map((x) => hex(x.addr).length), 0);
  const win = msg.window;
  const head = [
    ...(win
      ? [
          `; ${lines.length} instructions ${win.slot} ran in the ATT trace ` +
            `${path.basename(attPath)}, ${hex(msg.begin)}\u2013${hex(msg.end)}.`,
          `; Measured on the timeline over cycles [${win.begin}, ${win.end}]: ${win.cycles} ` +
            `cycles of latency on ${win.scope}.`,
        ]
      : [
          `; ${lines.length} instructions selected in the ATT trace ${path.basename(attPath)}, ` +
            `${hex(msg.begin)}\u2013${hex(msg.end)}.`,
        ]),
    ";",
    "; Call att_current for the trace and this selection, then att_disasm with",
    `; begin=${hex(msg.begin)} end=${hex(msg.end)} for the stall cycles measured against`,
    "; each of these instructions.",
    ";",
    "; The rest of the analysis, each taking the run att_current names:",
    ";",
    ";   att_summary  footprint, occupancy and what bounds it, cycle budget, stall by reason",
    ";   att_phases   prologue / mainline / epilogue, cut at the hot loop, cycles for each",
    ";   att_issues   the ranked findings, with what each one costs",
    ";   att_issue    one finding in full: why it fires and every site behind it",
    ";   att_hot      the hottest source lines or instructions, ranked by stall cycles",
    ";   att_source   the source as the capture saved it, whose line numbers still match",
    "",
    "",
  ];
  const body = lines
    .map((x) => `${hex(x.addr).padEnd(w)}  ${x.text}`)
    .join("\n");
  return head.join("\n") + body + "\n";
}

// Write the listing somewhere Cursor can reference as a file range. That is what makes the
// chat show it as one collapsed chip instead of a wall of text: its own "add to chat" attaches
// a range, and a range needs a file behind it.
function writeSelectionFile(attPath, msg) {
  const hex = (v) => "0x" + Number(v).toString(16);
  const dir = selectionsDir();
  fs.mkdirSync(dir, { recursive: true });
  // The cycles are part of what a measured window is: two drags over the same loop body
  // differ by when they were taken, and a file named only by address would overwrite one
  // with the other.
  const win = msg.window ? `_c${msg.window.begin}-${msg.window.end}` : "";
  const file = path.join(
    dir,
    `${path.basename(attPath, ".att")}_${hex(msg.begin)}-${hex(msg.end)}${win}.s`
  );
  fs.writeFileSync(file, selectionListing(attPath, msg), "utf8");
  return file;
}

// What goes into the chat input when the selection is attached: the question, nothing else.
//
// Everything else is in the attached file, which is the point of attaching it.
function attachedQuestion(msg) {
  const n = Array.isArray(msg.lines) ? msg.lines.length : 0;
  if (msg.window) {
    return (
      `What is costing ${msg.window.slot} the ${msg.window.cycles} cycles it spent on these ` +
      `${n} attached instructions?`
    );
  }
  return `What is costing time in these ${n} attached instructions?`;
}

// What Ctrl+L runs, called with nothing: Cursor states the focused editor's selection as a
// mention in the chat input, which is the only reference seen to survive being sent.
//
// The payload cannot be built here instead. `composer.addsymbolstocomposer` takes a
// `codeSelections` payload and draws the chip, and then the chat fails to serialize on send
// — the same for Monaco's IRange as for a `vscode.Range`, for the file inside the workspace
// as outside it, and for the tab left open behind the chip as closed. Nor can the keybinding
// be reached by its own command id: `editor.action.addSymbolToChat` is accepted from an
// extension and does nothing.
//
// The id is not API and the command does not report what it did, so a throw is the only
// failure that can be detected here — a chip that draws is not proof the chat can be sent.
const ATTACH_CMD = "aichat.newchataction";

// Append what "Add to chat" did. None of the commands it drives report success, and the
// panel's only other account of itself is a toast that has faded by the time anyone asks
// why the chat looks wrong, which leaves nothing to read afterwards.
function chatLog(line) {
  try {
    fs.mkdirSync(mcpStateDir(), { recursive: true });
    fs.appendFileSync(
      path.join(mcpStateDir(), "add-to-chat.log"),
      `${new Date().toISOString()}  ${line}\n`,
      "utf8"
    );
  } catch { /* a missing log is not worth failing the attach for */ }
}

// The channel the selection is attached from, rebuilt on every attach.
let selectionChannel = null;

const SELECTION_CHANNEL = "ATT Selection";

// Wait until the output view really holds this listing, rather than pausing and hoping.
//
// `show()` returns before the renderer has the text, and `editor.action.selectAll` acts on the
// document that is there, so selecting too early hands over whatever the view held before. An
// output channel is backed by a document with the `output` scheme, which makes the wait a check
// on the text that is about to be selected. Where the document never shows up — the scheme is
// not contractual — fall back to the fixed pause this used to take.
async function outputHolds(listing, budgetMs = 2000) {
  // The header's first line names the trace and the address range, so it identifies this
  // listing and not the one the view held before.
  const id = listing.split("\n")[0];
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const held = vscode.workspace.textDocuments.some(
      (d) => d.uri.scheme === "output" && d.getText().includes(id)
    );
    if (held) return true;
  }
  await new Promise((r) => setTimeout(r, 250));
  return false;
}

// Attach the selection from an output view, so that nothing opens in the editor area.
//
// An output view is a code editor like any other, only it lives in the panel: a selection can
// be made in it and handed to Ctrl+L's command, and the reader is left looking at the trace
// instead of watching a tab flash past and the panel come back. It is a channel of its own
// because whatever else it held would be attached along with the selection.
//
// The channel is thrown away and rebuilt rather than cleared. `clear()` and `append()` are two
// messages to the renderer and the clear can be applied after the append, which leaves the view
// holding the previous click's listing — so the first attach worked, having been given an empty
// channel to begin with, and every one after it attached the selection before. A channel that
// is created empty cannot race with itself.
//
// This is the only way in. The two it replaced both went through a text editor: one opened the
// selection file to select it, and the other pasted the question wherever the focus had landed
// via `editor.action.clipboardPasteAction`. That paste is a Monaco command and the chat input
// is not a Monaco editor, so on Cursor 1.128 it resolved without throwing and without doing
// anything, and the panel reported success into a void.
async function attachSelection(attPath, msg) {
  if (!chatCommands.has(ATTACH_CMD) || !chatCommands.has("editor.action.selectAll")) {
    return {
      how: "",
      why: `this build has no ${chatCommands.has(ATTACH_CMD) ? "editor.action.selectAll" : ATTACH_CMD}`,
    };
  }
  const listing = selectionListing(attPath, msg);
  if (selectionChannel) selectionChannel.dispose();
  selectionChannel = vscode.window.createOutputChannel(SELECTION_CHANNEL);
  selectionChannel.append(listing);
  // Focus, not just reveal: the command reads the selection of whatever is focused.
  selectionChannel.show(false);
  if (!(await outputHolds(listing))) {
    chatLog("output: the view never reported the listing; selecting anyway");
  }
  try {
    await vscode.commands.executeCommand("editor.action.selectAll");
    await vscode.commands.executeCommand(ATTACH_CMD);
    chatLog(`output: ${ATTACH_CMD} accepted the output view's selection`);
  } catch (e) {
    chatLog(`output: attach failed — ${e && e.message}`);
    return { how: "", why: `${ATTACH_CMD} rejected the selection: ${e && e.message}` };
  }
  // Written as well, so the question can name a file and a chat with no MCP server can read
  // the selection back.
  writeSelectionFile(attPath, msg);
  return askAttachedQuestion(`attached from the ${selectionChannel.name} output view`, msg);
}

// Leave the question on the clipboard for the chat the attach command took the focus into.
//
// Typing it in is not available. `editor.action.clipboardPasteAction` is a Monaco command and
// the chat input is not a Monaco editor, so it resolves without throwing and without pasting —
// it cannot report the difference, which is why the attach used to claim a question it had
// never delivered. The selection is what the click is for and the attach carries it; the
// question is one Ctrl+V away and the toast says so.
async function askAttachedQuestion(via, msg) {
  await vscode.env.clipboard.writeText(attachedQuestion(msg));
  return { how: `${via} — question on the clipboard, paste it to ask` };
}

async function promptForFile(cfg, settingKey, notFoundMsg, openLabel) {
  const choice = await vscode.window.showErrorMessage(notFoundMsg, "Browse…", "Cancel");
  if (choice !== "Browse…") return null;
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel });
  if (!picked || picked.length === 0) return null;
  const newPath = picked[0].fsPath;
  await cfg.update(settingKey, newPath, vscode.ConfigurationTarget.Global);
  return newPath;
}
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function toMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const AUTO_CAP_ATT_BYTES = 64 * 1024 * 1024;
const WEBVIEW_JSON_SOFT_LIMIT_BYTES = 48 * 1024 * 1024;
const AUTO_MAX_EVENTS_DEFAULT = 250000;
const AUTO_MAX_EVENTS_MIN = 50000;
const AUTO_MAX_EVENTS_MAX = 500000;
// A HIP source file the panel will show. Kernel headers run to a few thousand lines; anything
// this size is not source the reader meant to open.
const SOURCE_MAX_BYTES = 8 * 1024 * 1024;

function getWebviewHtml(webview, ctx, jsonUri, traceKey) {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, "media", "viewer.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, "media", "viewer.css")
  );
  const isaRefUri = webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, "media", "isa_lookup.js")
  );
  const nonce = Math.random().toString(36).slice(2);

  // CSP: allow loading our script/style and fetching localResourceRoots URIs
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src ${webview.cspSource} data:;
               style-src ${webview.cspSource} 'unsafe-inline';
               script-src 'nonce-${nonce}';
               connect-src ${webview.cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${styleUri}">
    <title>ATT Viewer</title>
  </head>
  <body>
    <div class="topbar">
      <div class="title">ATT Timeline</div>
      <div class="meta" id="meta"></div>
      <div class="legend" id="legend"></div>
      <button class="btn" id="phasesBtn" title="Mark prologue / mainline / epilogue on the timeline, cut at the hot loop the trace spun in">Phases</button>
      <button class="btn" id="colorsBtn" title="Edit colors">Colors</button>
      <div class="hint">wheel=zoom, drag=pan, ctrl+drag=measure, shift+drag=slot→chat, alt+click=marker</div>
    </div>
    <div class="main">
      <div class="viewport" id="viewport">
          <canvas id="c"></canvas>
          <div class="tooltip" id="tip"></div>
          <div class="loading" id="loading">Loading trace…</div>
          <div class="cfg" id="cfg" style="display:none">
            <div class="cfgHeader">
              <div class="cfgTitle">Colors</div>
              <button class="btn" id="cfgClose">Close</button>
            </div>
            <div class="cfgBody" id="cfgBody"></div>
            <div class="cfgFooter">
              <button class="btn" id="cfgReset">Reset defaults</button>
            </div>
          </div>
      </div>
      <div class="divider" id="divider"></div>
      <div class="sourcePane">
        <div class="sourceHeader">
          <div id="srcMeta">Source</div>
        </div>
        <div class="sourceBody" id="srcBody"></div>
        <div class="disTip" id="disTip"></div>
      </div>
    </div>
    <script nonce="${nonce}">
      window.__ATT_JSON_URI__ = "${jsonUri.toString()}";
      window.__ATT_TRACE_KEY__ = "${String(traceKey || "")}";
    </script>
    <script nonce="${nonce}" src="${isaRefUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // If the shipped default palette changes, old persisted overrides can make the colors look “wrong”
  // on machines that previously used the extension (VS Code vs Cursor have separate storages).
  // We version the built-in palette and clear old overrides on version bump so defaults apply.
  const PALETTE_REV = "legend-2026-01-28";
  const prevRev = context.globalState.get("attViewer.paletteRev", null);
  if (prevRev !== PALETTE_REV) {
    // Clear saved color overrides so the new built-in defaults apply.
    // Users can re-customize after upgrade.
    context.globalState.update("attViewer.colors", undefined);
    context.globalState.update("attViewer.paletteRev", PALETTE_REV);
  }

  vscode.commands.getCommands(true).then(
    (all) => {
      chatCommands = new Set(all);
      // None of the chat commands report whether they did anything, so which ones this
      // build exposes is the only evidence of why "Add to chat" took the path it took.
      try {
        fs.mkdirSync(mcpStateDir(), { recursive: true });
        fs.writeFileSync(
          path.join(mcpStateDir(), "chat-commands.json"),
          JSON.stringify(
            {
              app: vscode.env.appName,
              version: vscode.version,
              attach: [ATTACH_CMD].filter((c) => chatCommands.has(c)),
              related: all.filter((c) => /chat|composer|aichat/i.test(c)).sort(),
              output: all.filter((c) => /output|selectAll/i.test(c)).sort(),
            },
            null,
            1
          ) + "\n",
          "utf8"
        );
      } catch { /* diagnostics are never worth failing activation for */ }
    },
    () => {}
  );

  const openAtt = vscode.commands.registerCommand("attViewer.openAtt", async () => {
    const lastDir = context.globalState.get("attViewer.lastDir", null);
    const pick = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Open ATT",
      filters: { "ATT Trace": ["att"] },
      defaultUri: lastDir ? vscode.Uri.file(String(lastDir)) : undefined,
    });
    if (!pick || pick.length === 0) return;
    await openAttImpl(context, pick[0]);
  });

  const openAttFromUri = vscode.commands.registerCommand(
    "attViewer.openAttFromUri",
    async (uri) => {
      if (!uri) return;
      await openAttImpl(context, uri);
    }
  );

  const customEditorProvider = {
    openCustomDocument(uri) {
      return { uri, dispose() {} };
    },
    async resolveCustomEditor(document, webviewPanel, _token) {
      // Always set webview options first so VS Code has a valid panel regardless of what happens next.
      webviewPanel.webview.options = { enableScripts: true };
      try {
        await openAttImpl(context, document.uri, webviewPanel);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        webviewPanel.webview.html = `<!doctype html><html><body style="color:var(--vscode-foreground);font-family:sans-serif;padding:2em">
          <h3>ATT Viewer: failed to open trace</h3><pre style="white-space:pre-wrap">${msg}</pre></body></html>`;
        vscode.window.showErrorMessage(`ATT Viewer: ${msg}`);
      }
    },
  };

  context.subscriptions.push(
    openAtt,
    openAttFromUri,
    vscode.window.registerCustomEditorProvider(
      "attViewer.attEditor",
      customEditorProvider,
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri} attUri
 * @param {vscode.WebviewPanel} [existingPanel]
 */
async function openAttImpl(context, attUri, existingPanel = null) {
  const cfg = vscode.workspace.getConfiguration("attViewer");
  const pythonPath = cfg.get("pythonPath", "python3");
  const maxEvents = Number(cfg.get("maxEvents", 0)) || 0;
  let rocprofilerSdkPath = cfg.get("rocprofilerSdkPath", "/opt/rocm/lib/librocprofiler-sdk.so");
  if (!fileExists(rocprofilerSdkPath)) {
    const resolved = await promptForFile(
      cfg, "rocprofilerSdkPath",
      `ATT Viewer: librocprofiler-sdk.so not found at "${rocprofilerSdkPath}". Please locate it.`,
      "Select librocprofiler-sdk.so"
    );
    if (!resolved) return;
    rocprofilerSdkPath = resolved;
  }

  let llvmObjdumpPath = cfg.get("llvmObjdumpPath", "/opt/rocm/llvm/bin/llvm-objdump");
  if (!fileExists(llvmObjdumpPath)) {
    const resolved = await promptForFile(
      cfg, "llvmObjdumpPath",
      `ATT Viewer: llvm-objdump not found at "${llvmObjdumpPath}". Please locate it.`,
      "Select llvm-objdump"
    );
    if (!resolved) return;
    llvmObjdumpPath = resolved;
  }

  const attPath = attUri.fsPath;
  const attDir = path.dirname(attPath);
  const attSizeBytes = (() => {
    try { return fs.statSync(attPath).size; } catch { return 0; }
  })();
  // Remember last opened directory for the next Open dialog.
  await context.globalState.update("attViewer.lastDir", attDir);

  const resultsDb = pickResultsDb(attPath);
  if (!resultsDb) {
    vscode.window.showWarningMessage(
      "ATT Viewer: *_results.db not found. Will fall back to scanning code_object_id_*.out; PC stitching may be incomplete."
    );
  }

  const cacheDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(cacheDir, { recursive: true });
  const outJson = path.join(
    cacheDir,
    `att_${sha1(attPath + "|" + (resultsDb || ""))}_${path.basename(attPath)}.json`
  );

  const pyScript = vscode.Uri.joinPath(context.extensionUri, "python", "att2json.py").fsPath;
  const env = { ...process.env };
  // Ensure ROCm libs can be found alongside librocprofiler-sdk.so
  const rocmLibDir = path.dirname(rocprofilerSdkPath);
  env.LD_LIBRARY_PATH = [rocmLibDir, env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");

  let effectiveMaxEvents = maxEvents;
  let autoCapReason = "";
  if (effectiveMaxEvents <= 0 && attSizeBytes >= AUTO_CAP_ATT_BYTES) {
    effectiveMaxEvents = AUTO_MAX_EVENTS_DEFAULT;
    autoCapReason = `large ATT (${toMB(attSizeBytes)} MB)`;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "ATT Viewer: decoding…", cancellable: false },
    async () => {
      await runPython(pythonPath, pyScript, {
        att: attPath,
        resultsDb,
        codeobjDir: attDir,
        out: outJson,
        maxEvents: effectiveMaxEvents,
        rocprofilerSdkPath,
        llvmObjdumpPath,
      }, env);
    }
  );

  if (maxEvents <= 0) {
    const outSizeBytes = (() => {
      try { return fs.statSync(outJson).size; } catch { return 0; }
    })();
    if (outSizeBytes > WEBVIEW_JSON_SOFT_LIMIT_BYTES) {
      const estimate = effectiveMaxEvents > 0
        ? Math.floor((effectiveMaxEvents * WEBVIEW_JSON_SOFT_LIMIT_BYTES) / outSizeBytes)
        : AUTO_MAX_EVENTS_DEFAULT;
      const reducedMaxEvents = Math.max(
        AUTO_MAX_EVENTS_MIN,
        Math.min(AUTO_MAX_EVENTS_MAX, estimate)
      );
      if (effectiveMaxEvents <= 0 || reducedMaxEvents < effectiveMaxEvents) {
        effectiveMaxEvents = reducedMaxEvents;
        autoCapReason = autoCapReason || `large decoded JSON (${toMB(outSizeBytes)} MB)`;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ATT Viewer: reducing events to ${effectiveMaxEvents.toLocaleString()} for webview stability…`,
            cancellable: false,
          },
          async () => {
            await runPython(pythonPath, pyScript, {
              att: attPath,
              resultsDb,
              codeobjDir: attDir,
              out: outJson,
              maxEvents: effectiveMaxEvents,
              rocprofilerSdkPath,
              llvmObjdumpPath,
            }, env);
          }
        );
      }
    }
  }

  if (maxEvents <= 0 && effectiveMaxEvents > 0) {
    vscode.window.showInformationMessage(
      `ATT Viewer: auto-limited to ${effectiveMaxEvents.toLocaleString()} events (${autoCapReason || "very large trace"}). Set attViewer.maxEvents to override.`
    );
  }

  const localResourceRoots = [
    vscode.Uri.file(cacheDir),
    vscode.Uri.file(attDir),
    vscode.Uri.joinPath(context.extensionUri, "media"),
    vscode.Uri.joinPath(context.extensionUri, "python"),
  ];
  let panel;
  if (existingPanel) {
    existingPanel.webview.options = { enableScripts: true, localResourceRoots };
    panel = existingPanel;
  } else {
    panel = vscode.window.createWebviewPanel(
      "attViewer",
      `ATT: ${path.basename(attPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots }
    );
  }

  const jsonUri = panel.webview.asWebviewUri(vscode.Uri.file(outJson));
  const traceKey = sha1(attPath);
  panel.webview.html = getWebviewHtml(panel.webview, context, jsonUri, traceKey);

  // Follow the focused panel, so switching between two traces moves the chat's context with it.
  recordCurrentTrace(attPath);
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) recordCurrentTrace(attPath);
  });

  // In-panel disassembly cache
  const disasmCache = new Map();
  const inlineStackCache = new Map(); // `${codeobj}|${addr}` -> stack[]
  const llvmSymbolizerPath = llvmObjdumpPath.replace(/objdump([^/\\]*)$/, "symbolizer$1");
  // The dispatch's capture-time source copies, keyed by file name. `dir` is reported to the webview
  // so the HIP pane can say why it has nothing to show when a capture saved no sources.
  const snapshotDir = findSourceSnapshotDir(attPath);
  const snapshotByBase = indexSourceSnapshot(snapshotDir);
  const sourceSnapshot = {
    dir: snapshotDir || "",
    files: snapshotByBase.size,
    captured: [...snapshotByBase.keys()].sort(),
  };
  const attCfg = vscode.workspace.getConfiguration("attViewer");
  const hipSourceSnapshotOnly = !!attCfg.get("hipSourceSnapshotOnly", false);
  const hipAutoSnapshotFill = !!attCfg.get("hipAutoSnapshotFill", true);
  const hipSourceFallback = !hipSourceSnapshotOnly;
  // Source paths named by the line tables we have parsed. The webview asks the host to read
  // HIP files by path, so answer only for files a code object actually points at.
  const knownSourceFiles = new Set();
  const rememberSourceFiles = (lines) => {
    for (const ln of lines) if (ln.file) knownSourceFiles.add(ln.file);
  };
  const rememberStackFiles = (stack) => {
    for (const fr of stack) if (fr.file) knownSourceFiles.add(fr.file);
  };

  const isaManifestCache = { value: loadIsaManifest(context.extensionUri) };
  const isaIndexCache = new Map();

  // Persisted color config (global across traces)
  const getSavedColors = () => context.globalState.get("attViewer.colors", null);
  const getSavedMarkers = () => context.globalState.get(`attViewer.markers.${traceKey}`, []);
  // eslint-disable-next-line no-unused-vars
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "requestColors") {
      panel.webview.postMessage({ type: "colors", value: getSavedColors() || null });
    } else if (msg.type === "saveColors") {
      // Treat null as "clear overrides" (delete key) so defaults apply.
      if (msg.value == null) {
        await context.globalState.update("attViewer.colors", undefined);
      } else {
        await context.globalState.update("attViewer.colors", msg.value);
      }
      // Echo the new effective value back so the webview can synchronize UI reliably.
      panel.webview.postMessage({ type: "colors", value: msg.value == null ? null : msg.value });
      panel.webview.postMessage({ type: "colorsSaved" });
    } else if (msg.type === "resetColors") {
      // Explicit reset: remove overrides and inform the webview to revert to built-in defaults.
      await context.globalState.update("attViewer.colors", undefined);
      panel.webview.postMessage({ type: "colors", value: null });
      panel.webview.postMessage({ type: "colorsSaved" });
    } else if (msg.type === "requestMarkers") {
      panel.webview.postMessage({ type: "markers", value: getSavedMarkers() });
    } else if (msg.type === "saveMarkers") {
      const arr = Array.isArray(msg.value) ? msg.value : [];
      await context.globalState.update(`attViewer.markers.${traceKey}`, arr);
      panel.webview.postMessage({ type: "markersSaved" });
    } else if (msg.type === "copyText") {
      // fallback path: the webview could not reach the browser clipboard itself
      await vscode.env.clipboard.writeText(String(msg.text || ""));
      if (msg.toast) vscode.window.showInformationMessage(`ATT Viewer: ${msg.toast}.`);
    } else if (msg.type === "requestPhases") {
      try {
        panel.webview.postMessage({ type: "phases", phases: await loadPhases(context, attPath) });
      } catch (e) {
        panel.webview.postMessage({ type: "phases", error: e.message });
      }
    } else if (msg.type === "attachSelection") {
      const n = Array.isArray(msg.lines) ? msg.lines.length : 0;
      // Recorded whatever the attach does: the state file is what att_current reads, so a
      // failed attach still leaves the model able to reach the selection by that route.
      if (!recordSelection(attPath, msg)) {
        vscode.window.showErrorMessage("ATT Viewer: could not write the chat context file.");
        return;
      }
      chatLog(`--- add to chat: ${n} instructions from ${path.basename(attPath)}`);
      const r = await attachSelection(attPath, msg);
      chatLog(`result: ${r.how || `nothing — ${r.why}`}`);
      const said = r.how
        ? `${n} instruction${n === 1 ? "" : "s"} ${r.how}`
        : `could not attach ${n} instruction${n === 1 ? "" : "s"} (${r.why}) — ask the chat ` +
          `about "the trace I have open" and att_current will reach them`;
      panel.webview.postMessage({ type: "selectionAttached", count: n, toast: said });
      // The effect of this button is in the chat, not in the panel, so a toast in the corner
      // of the panel is in the wrong place to be read: say it where the window says things.
      vscode.window.showInformationMessage(`ATT Viewer: ${said}`);
    } else if (msg.type === "requestDisasm") {
      const codeobjPath = msg.codeobjPath;
      if (!codeobjPath) return;
      if (disasmCache.has(codeobjPath)) {
        const isa = isaPayloadForCodeobj(context.extensionUri, isaManifestCache, isaIndexCache, codeobjPath);
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines: disasmCache.get(codeobjPath),
          sourceSnapshot,
          hipSourceFallback,
          gpuArch: isa.gpuArch,
          isaKey: isa.isaKey,
          isaIndex: isa.isaIndex,
        });
        return;
      }
      try {
        const lines = await runObjdump(llvmObjdumpPath, codeobjPath);
        disasmCache.set(codeobjPath, lines);
        rememberSourceFiles(lines);
        const isa = isaPayloadForCodeobj(context.extensionUri, isaManifestCache, isaIndexCache, codeobjPath);
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines,
          sourceSnapshot,
          hipSourceFallback,
          gpuArch: isa.gpuArch,
          isaKey: isa.isaKey,
          isaIndex: isa.isaIndex,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: "disasmError",
          markerId: msg.markerId,
          codeobjPath,
          error: String(e && e.message ? e.message : e),
        });
      }
    } else if (msg.type === "requestInlineStack") {
      const codeobjPath = msg.codeobjPath;
      const addr = Number(msg.addr);
      const reqId = msg.reqId;
      const markerId = msg.markerId;
      const fail = (error) =>
        panel.webview.postMessage({
          type: "inlineStack",
          reqId,
          markerId,
          addr,
          stack: [],
          error,
        });
      if (!codeobjPath || !Number.isFinite(addr)) {
        fail("missing code object or address");
        return;
      }
      if (!fileExists(llvmSymbolizerPath)) {
        fail(`llvm-symbolizer not found at ${llvmSymbolizerPath}`);
        return;
      }
      const cacheKey = `${codeobjPath}|${addr}`;
      if (inlineStackCache.has(cacheKey)) {
        panel.webview.postMessage({
          type: "inlineStack",
          reqId,
          markerId,
          addr,
          stack: inlineStackCache.get(cacheKey),
        });
        return;
      }
      try {
        const stack = await runSymbolizerInlineStack(llvmSymbolizerPath, codeobjPath, addr);
        inlineStackCache.set(cacheKey, stack);
        rememberStackFiles(stack);
        panel.webview.postMessage({
          type: "inlineStack",
          reqId,
          markerId,
          addr,
          stack,
        });
      } catch (e) {
        fail(String(e && e.message ? e.message : e));
      }
    } else if (msg.type === "requestSource") {
      const srcPath = String(msg.path || "");
      const fail = (error) =>
        panel.webview.postMessage({ type: "sourceError", path: srcPath, error });
      if (!srcPath || !knownSourceFiles.has(srcPath)) {
        fail("not referenced by this code object");
        return;
      }
      const base = path.basename(srcPath);
      if (!snapshotDir) {
        fail("this trace has no captured sources next to it (no ui_output_… directory)");
        return;
      }
      // The copies carry a file name and no directory, so a capture that saved two same-named
      // files from different directories cannot be told apart. Say so rather than guess.
      const cands = snapshotByBase.get(base) || [];
      let readPath = null;
      let fromFallback = false;
      if (cands.length === 1) {
        readPath = cands[0];
      } else if (cands.length === 0) {
        const allowFallback = hipSourceFallback;
        if (allowFallback && fileExists(srcPath)) {
          readPath = srcPath;
          fromFallback = true;
        } else {
          fail(
            allowFallback
              ? `not captured at profile time (no source_*_${base} in ${path.basename(snapshotDir)}); ` +
                  `${srcPath} is not readable on disk`
              : `not captured at profile time (no source_*_${base} in ${path.basename(snapshotDir)}). ` +
                  "rocprof saves only line-table files; call-stack frames from DWARF inlining may " +
                  "name headers with no snapshot. Turn off attViewer.hipSourceSnapshotOnly to read " +
                  "the compile-time path from disk (auto-saved into the capture when enabled)."
          );
          return;
        }
      } else {
        fail(`${cands.length} captured copies are named ${base}, so this path is ambiguous`);
        return;
      }
      try {
        const st = fs.statSync(readPath);
        if (!st.isFile()) {
          fail("the captured copy is not a file");
          return;
        }
        if (st.size > SOURCE_MAX_BYTES) {
          fail(`too large (${(st.size / 1048576).toFixed(1)} MiB)`);
          return;
        }
        let snapshotPath = readPath;
        if (fromFallback && hipAutoSnapshotFill && snapshotDir) {
          try {
            const dest = nextSourceSnapshotPath(snapshotDir, base);
            fs.copyFileSync(readPath, dest);
            snapshotByBase.set(base, [dest]);
            sourceSnapshot.captured = [...snapshotByBase.keys()].sort();
            sourceSnapshot.files = snapshotByBase.size;
            snapshotPath = dest;
            fromFallback = false;
          } catch {
            // ui_output not writable — still serve from compile-time path
          }
        }
        panel.webview.postMessage({
          type: "source",
          path: srcPath,
          snapshotPath: fromFallback ? "" : snapshotPath,
          fromFallback,
          sourceSnapshot: fromFallback ? undefined : { ...sourceSnapshot },
          text: fs.readFileSync(readPath, "utf8"),
        });
      } catch (e) {
        fail(String(e && e.message ? e.message : e));
      }
    }
  });

  // Try pushing immediately as well (webview will ignore if not ready)
  const initial = getSavedColors();
  if (initial) {
    panel.webview.postMessage({ type: "colors", value: initial });
  }
  const initialMarkers = getSavedMarkers();
  if (initialMarkers && initialMarkers.length) {
    panel.webview.postMessage({ type: "markers", value: initialMarkers });
  }
}

function parseSourceLocation(loc) {
  const s = String(loc || "").trim();
  // Non-greedy file match: `kernel.h:525:13` must not capture `:525` in the path.
  const m = s.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (!m || m[1] === "??") return null;
  return { file: m[1], line: parseInt(m[2], 10) };
}

function parseInlineStack(out) {
  const lines = String(out || "").split(/\r?\n/).filter((l) => l.length > 0);
  const stack = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const func = lines[i].trim();
    const pos = parseSourceLocation(lines[i + 1]);
    if (!pos) continue;
    stack.push({ func, file: pos.file, line: pos.line });
  }
  return stack;
}

function runSymbolizerInlineStack(symbolizer, codeobjPath, addr) {
  return new Promise((resolve, reject) => {
    const args = [`--obj=${codeobjPath}`, "--inlining"];
    const p = spawn(symbolizer, args, { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.stdin.write(`0x${Number(addr).toString(16)}\n`);
    p.stdin.end();
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`llvm-symbolizer failed (${code}): ${err}`));
      }
      resolve(parseInlineStack(out));
    });
  });
}

function runObjdump(objdump, codeobjPath) {
  return new Promise((resolve, reject) => {
    // --line-numbers interleaves "; /path/file.h:539" before each run of instructions that
    // came from that source line, and costs nothing when the code object carries no DWARF.
    const args = ["-d", "--line-numbers", codeobjPath];
    const p = spawn(objdump, args, { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`llvm-objdump failed (${code}): ${err}`));
      // Parse lines with trailing address comments: // 000000004450:
      const lines = [];
      const re = /\/\/\s+([0-9A-Fa-f]+):/;
      // "; <mangled>():" marks a function, "; <path>:<line>" a source position. Only the
      // latter carries a colon-separated decimal tail, so match that and let the rest through.
      const posRe = /^;\s+(.+)$/;
      let curFile = "";
      let curLine = 0;
      for (const ln of out.split(/\r?\n/)) {
        if (ln.startsWith(";")) {
          const pm = ln.match(posRe);
          if (pm) {
            const tail = pm[1];
            if (tail.endsWith("():")) {
              // A new function: do not let its first instructions inherit the previous position.
              curFile = "";
              curLine = 0;
            } else {
              const pos = parseSourceLocation(tail);
              if (pos) {
                curFile = pos.file;
                curLine = pos.line;
              }
            }
          }
          continue;
        }
        if (!ln.includes("//")) continue;
        const m = ln.match(re);
        if (!m) continue;
        const addr = parseInt(m[1], 16);
        const text = ln.split("//", 1)[0].trim();
        if (!text || text.endsWith(":")) continue;
        const row = { addr, text };
        if (curFile) {
          row.file = curFile;
          row.line = curLine;
        }
        lines.push(row);
      }
      resolve(lines);
    });
  });
}

// Ask the MCP server's analysis where the hot loop starts and ends, so the timeline can
// show the same prologue/mainline/epilogue split the chat tools describe. Runs the analyzer
// on a cache miss, which is why this is only called when the overlay is switched on.
function loadPhases(context, attPath) {
  const py = vscode.workspace.getConfiguration("attViewer").get("pythonPath", "python3");
  const script = path.join(context.extensionUri.fsPath, "python", "att_mcp.py");
  return new Promise((resolve, reject) => {
    const p = spawn(py, [script, "--phases", path.dirname(attPath)], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim().split("\n").pop() || `exit ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("could not read the analyzer's output"));
      }
    });
  });
}

function runPython(pythonExe, scriptPath, args, env) {
  return new Promise((resolve, reject) => {
    const argv = [
      scriptPath,
      "--att",
      args.att,
      "--codeobj-dir",
      args.codeobjDir,
      "--out",
      args.out,
    ];
    if (args.resultsDb) {
      argv.push("--results-db", args.resultsDb);
    }
    if (args.maxEvents && args.maxEvents > 0) {
      argv.push("--max-events", String(args.maxEvents));
    }
    if (args.rocprofilerSdkPath) {
      argv.push("--rocprofiler-sdk", args.rocprofilerSdkPath);
      argv.push("--decoder-lib-path", path.dirname(args.rocprofilerSdkPath));
    }
    if (args.llvmObjdumpPath) {
      argv.push("--llvm-objdump", args.llvmObjdumpPath);
    }

    const p = spawn(pythonExe, argv, { env });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.stdout.on("data", () => {});
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`python failed (code=${code})\n${stderr}`));
    });
  }).catch((e) => {
    vscode.window.showErrorMessage(`ATT decode failed: ${e.message}`);
    throw e;
  });
}

function loadIsaManifest(extensionUri) {
  const p = path.join(extensionUri.fsPath, "media", "isa", "manifest.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function inferGpuArch(codeobjPath) {
  const base = path.basename(codeobjPath);
  let m = base.match(/(gfx\d+[a-z]?)/i);
  if (m) return m[1].toLowerCase();
  try {
    const out = execSync(`readelf -n ${JSON.stringify(codeobjPath)}`, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    m = out.match(/amdhsa\.target:\s+\S+--(gfx\d+[a-z]?)/i);
    if (m) return m[1].toLowerCase();
  } catch {
    /* code object may not carry notes */
  }
  return "";
}

function isaKeyForGpuArch(gpuArch, manifest) {
  const key = String(gpuArch || "").toLowerCase();
  if (manifest.gfxToIsa[key]) return manifest.gfxToIsa[key];
  if (key.startsWith("gfx95")) return "cdna4";
  if (key.startsWith("gfx94")) return "cdna3";
  if (key === "gfx908") return "cdna1";
  if (key === "gfx90a") return "cdna2";
  if (key.startsWith("gfx12")) return "rdna4";
  if (key.startsWith("gfx115")) return "rdna3_5";
  if (key.startsWith("gfx11")) return "rdna3";
  if (key.startsWith("gfx10")) return "rdna2";
  return "cdna4";
}

function loadIsaIndex(extensionUri, isaKey) {
  const p = path.join(extensionUri.fsPath, "media", "isa", `${isaKey}.json`);
  if (!fileExists(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isaPayloadForCodeobj(extensionUri, manifestCache, indexCache, codeobjPath) {
  const manifest = manifestCache.value;
  const gpuArch = inferGpuArch(codeobjPath);
  const isaKey = isaKeyForGpuArch(gpuArch, manifest);
  let idx = indexCache.get(isaKey);
  if (!idx) {
    idx = loadIsaIndex(extensionUri, isaKey);
    if (idx) indexCache.set(isaKey, idx);
  }
  return {
    gpuArch: gpuArch || "unknown",
    isaKey,
    isaIndex: idx
      ? {
          isaKey: idx.isaKey,
          archName: idx.archName,
          source: idx.source,
          instructions: idx.instructions,
        }
      : null,
  };
}

function deactivate() {}

// runObjdump is exported so the listing parser can be tested against a real code object
// without a VS Code host.
module.exports = {
  activate,
  deactivate,
  runObjdump,
  runSymbolizerInlineStack,
  parseInlineStack,
  parseSourceLocation,
  findSourceSnapshotDir,
  indexSourceSnapshot,
};

