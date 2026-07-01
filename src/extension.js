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

async function promptForFile(cfg, settingKey, notFoundMsg, openLabel) {
  const choice = await vscode.window.showErrorMessage(notFoundMsg, "Browse…", "Cancel");
  if (choice !== "Browse…") return null;
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel });
  if (!picked || picked.length === 0) return null;
  const newPath = picked[0].fsPath;
  await cfg.update(settingKey, newPath, vscode.ConfigurationTarget.Global);
  return newPath;
}

function inferGpuArchFromDir(dir) {
  const cands = listFiles(dir).filter((p) => p.includes("_code_object_id_") && p.endsWith(".out"));
  for (const p of cands) {
    const m = p.match(/_gfx(\d+)_code_object_id_/);
    if (m) return `gfx${m[1]}`;
  }
  return null;
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

  const inferredArch = inferGpuArchFromDir(attDir);
  const gpuArch = cfg.get("gpuArch", inferredArch || "gfx950") || inferredArch || "gfx950";

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
        gpuArch,
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
              gpuArch,
              out: outJson,
              maxEvents: effectiveMaxEvents,
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
  const disasmCache = new Map(); // key: gpuArch|path -> lines

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
    } else if (msg.type === "requestDisasm") {
      const gpuArch = msg.gpuArch;
      const codeobjPath = msg.codeobjPath;
      if (!gpuArch || !codeobjPath) return;
      const key = `${gpuArch}|${codeobjPath}`;
      if (disasmCache.has(key)) {
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines: disasmCache.get(key),
        });
        return;
      }
      try {
        const lines = await runObjdump(gpuArch, codeobjPath, llvmObjdumpPath);
        disasmCache.set(key, lines);
        panel.webview.postMessage({
          type: "disasm",
          markerId: msg.markerId,
          codeobjPath,
          lines,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: "disasmError",
          markerId: msg.markerId,
          codeobjPath,
          error: String(e && e.message ? e.message : e),
        });
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

function runObjdump(gpuArch, codeobjPath, objdump = "/opt/rocm/llvm/bin/llvm-objdump") {
  return new Promise((resolve, reject) => {
    const args = ["-d", `--mcpu=${gpuArch}`, codeobjPath];
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
      for (const ln of out.split(/\r?\n/)) {
        if (!ln.includes("//")) continue;
        const m = ln.match(re);
        if (!m) continue;
        const addr = parseInt(m[1], 16);
        const text = ln.split("//", 1)[0].trim();
        if (!text || text.endsWith(":")) continue;
        lines.push({ addr, text });
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
      "--gpu-arch",
      args.gpuArch,
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

module.exports = { activate, deactivate };

