// @ts-check

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

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
      <button class="btn" id="colorsBtn" title="Edit colors">Colors</button>
      <div class="hint">wheel=zoom, drag=pan, alt+click=marker</div>
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
      </div>
    </div>
    <script nonce="${nonce}">
      window.__ATT_JSON_URI__ = "${jsonUri.toString()}";
      window.__ATT_TRACE_KEY__ = "${String(traceKey || "")}";
    </script>
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

  // In-panel disassembly cache
  const disasmCache = new Map();
  // The dispatch's capture-time source copies, keyed by file name. `dir` is reported to the webview
  // so the HIP pane can say why it has nothing to show when a capture saved no sources.
  const snapshotDir = findSourceSnapshotDir(attPath);
  const snapshotByBase = indexSourceSnapshot(snapshotDir);
  const sourceSnapshot = { dir: snapshotDir || "", files: snapshotByBase.size };
  // Source paths named by the line tables we have parsed. The webview asks the host to read
  // HIP files by path, so answer only for files a code object actually points at.
  const knownSourceFiles = new Set();
  const rememberSourceFiles = (lines) => {
    for (const ln of lines) if (ln.file) knownSourceFiles.add(ln.file);
  };

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
    } else if (msg.type === "requestDisasm") {
      const codeobjPath = msg.codeobjPath;
      if (!codeobjPath) return;
      if (disasmCache.has(codeobjPath)) {
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines: disasmCache.get(codeobjPath),
          sourceSnapshot,
        });
        return;
      }
      try {
        const lines = await runObjdump(llvmObjdumpPath, codeobjPath);
        disasmCache.set(codeobjPath, lines);
        rememberSourceFiles(lines);
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines,
          sourceSnapshot,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: "disasmError",
          markerId: msg.markerId,
          codeobjPath,
          error: String(e && e.message ? e.message : e),
        });
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
      if (cands.length !== 1) {
        fail(
          cands.length === 0
            ? `not captured at profile time (no source_*_${base} in ${path.basename(snapshotDir)})`
            : `${cands.length} captured copies are named ${base}, so this path is ambiguous`
        );
        return;
      }
      const snapPath = cands[0];
      try {
        const st = fs.statSync(snapPath);
        if (!st.isFile()) {
          fail("the captured copy is not a file");
          return;
        }
        if (st.size > SOURCE_MAX_BYTES) {
          fail(`too large (${(st.size / 1048576).toFixed(1)} MiB)`);
          return;
        }
        panel.webview.postMessage({
          type: "source",
          path: srcPath,
          snapshotPath: snapPath,
          text: fs.readFileSync(snapPath, "utf8"),
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
      const posRe = /^;\s+(\S.*):(\d+)$/;
      let curFile = "";
      let curLine = 0;
      for (const ln of out.split(/\r?\n/)) {
        if (ln.startsWith(";")) {
          const pm = ln.match(posRe);
          if (pm) {
            curFile = pm[1];
            curLine = parseInt(pm[2], 10);
          } else if (ln.endsWith("():")) {
            // A new function: do not let its first instructions inherit the previous position.
            curFile = "";
            curLine = 0;
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

function deactivate() {}

// runObjdump is exported so the listing parser can be tested against a real code object
// without a VS Code host.
module.exports = { activate, deactivate, runObjdump, findSourceSnapshotDir, indexSourceSnapshot };

