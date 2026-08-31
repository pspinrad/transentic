const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron sandboxes preload scripts by default, which blocks plain
      // Node builtins like require('path') / require('fs') that preload.js
      // needs to read config/settings.json. contextIsolation stays on as
      // the real security boundary between preload and the page; disabling
      // just the sandbox is the standard fix for preload scripts that need
      // filesystem access.
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();

  // Electron shows no context menu at all by default (unlike a regular
  // browser tab) — this adds a minimal one so right-click actually does
  // something, notably Inspect Element for debugging the transcript's
  // per-word styling.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [
      {
        label: 'Inspect Element',
        click: () => mainWindow.webContents.inspectElement(params.x, params.y)
      }
    ];
    if (params.selectionText && params.selectionText.trim().length > 0) {
      template.unshift({ role: 'copy' }, { type: 'separator' });
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Media File…',
          accelerator: 'CmdOrCtrl+O',
          click: handleOpenMedia
        },
        { type: 'separator' },
        {
          label: 'Save Transcript',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu:save', { saveAs: false })
        },
        {
          label: 'Save Transcript As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu:save', { saveAs: true })
        },
        {
          label: 'Open Saved Transcript…',
          click: handleOpenSavedTranscript
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// NOTE ON FUTURE REMOTE/STREAMING SOURCES:
// handleOpenMedia currently only resolves local file:// paths, but it returns
// a normalized { sourceUri, sourceKind: 'local' } shape. When remote sources
// are added, sourceKind can become 'remote'/'stream' and the same downstream
// pipeline (analyze.py invocation, player, transcript render) does not need
// to change — only the resolution step here does.
async function handleOpenMedia() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Audio or Video File',
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'flac'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return;

  const filePath = result.filePaths[0];
  mainWindow.webContents.send('media:opened', { filePath });
}

async function handleOpenSavedTranscript() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Saved Senticscript',
    properties: ['openFile'],
    // Electron's dialog filters match a simple final extension, not a
    // compound suffix like "senticscript.md" — so this will also list
    // plain unrelated .md files. extractSenticscriptJson() below throws a
    // clear, specific error if someone picks one that isn't actually a
    // senticscript, which is an acceptable trade for cross-platform
    // filter reliability.
    filters: [{ name: 'Senticscript', extensions: ['md'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const filePath = result.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const sidecar = extractSenticscriptJson(raw);
    mainWindow.webContents.send('transcript:loaded', { sidecarPath: filePath, sidecar });
  } catch (e) {
    dialog.showErrorBox('Could not open senticscript', e.message);
  }
}

// Pulls the fenced ```json ... ``` block back out of a senticscript file.
// Written to appear at the bottom, but matched generically here in case of
// manual edits/reordering — this just finds the first such block.
function extractSenticscriptJson(raw) {
  const match = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('No JSON sentiment-data block found in this file — is it actually a .senticscript.md file?');
  }
  return JSON.parse(match[1]);
}

// Tracks the currently-running backend analysis process (only ever one at
// a time in this app) so it can be killed cleanly — both by the app-quit
// handler below, and later by an actual Cancel button.
let currentAnalysisProcess = null;

// --- IPC: kick off backend analysis of a media file ---
ipcMain.handle('backend:analyze', async (_evt, { filePath }) => {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.ETX_PYTHON || 'python3';
    const scriptPath = path.join(__dirname, 'backend', 'analyze.py');
    const outputPath = path.join(
      os.tmpdir(),
      `transentic-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    // Force the arm64 slice explicitly. Universal (fat) Python binaries pick
    // their executing architecture based on inherited process/shell state at
    // spawn time, which has proven inconsistent across terminal sessions in
    // practice (e.g. after switching from an x86_64/Rosetta shell to a
    // native one) — wrapping with `arch -arm64` removes that ambiguity
    // entirely rather than relying on whatever slice gets inherited.
    // On Intel Macs `arch -arm64` would fail, so only apply it on arm64 hosts.
    const useArchWrapper = process.arch === 'arm64';
    const command = useArchWrapper ? 'arch' : pythonBin;
    const args = useArchWrapper
      ? ['-arm64', pythonBin, scriptPath, filePath, outputPath]
      : [scriptPath, filePath, outputPath];
    // detached: true makes this child the leader of its own new process
    // group (POSIX) rather than sharing Electron's. That matters because
    // analyze.py itself spawns ffmpeg as a genuine child subprocess — if we
    // only ever signal this top-level process, ffmpeg would be orphaned
    // and keep running pointlessly rather than dying with it. Killing by
    // negative PID (see killCurrentAnalysisProcess() below) signals the
    // whole group — this process and any children it spawned — in one shot.
    const proc = spawn(command, args, { cwd: __dirname, detached: true });
    currentAnalysisProcess = proc;

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // stdout is intentionally not parsed for the result anymore — several
    // ML libraries in analyze.py's pipeline (Keras/TensorFlow in particular)
    // print their own progress output to stdout, which would corrupt a JSON
    // payload sent that way. analyze.py instead writes the result to
    // outputPath, which is read directly below once the process exits.
    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
      if (currentAnalysisProcess === proc) currentAnalysisProcess = null;
      if (code !== 0) {
        reject(new Error(stderr || `analyze.py exited with code ${code}`));
        return;
      }
      let raw;
      try {
        raw = fs.readFileSync(outputPath, 'utf-8');
      } catch (e) {
        reject(new Error(`analyze.py exited successfully but did not write an output file: ${e.message}`));
        return;
      }
      fs.unlink(outputPath, () => {}); // best-effort cleanup, non-blocking
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`Could not parse backend output file as JSON: ${e.message}`));
      }
    });
  });
});

// --- IPC: save a senticscript (transcript + sentiment data, one file) ---
ipcMain.handle('file:saveTranscript', async (_evt, { fileContent, suggestedName, forceDialog, currentSavedPath }) => {
  let filePath;
  if (forceDialog || !currentSavedPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Senticscript',
      defaultPath: suggestedName || 'transcript.senticscript.md',
      // See the matching comment in handleOpenSavedTranscript() — Electron
      // filters match a simple final extension, so this just offers .md;
      // the .senticscript part comes from defaultPath's suggested name and
      // is preserved below if the OS's save panel leaves it intact.
      filters: [{ name: 'Senticscript', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    filePath = ensureSenticscriptExtension(result.filePath);
  } else {
    filePath = currentSavedPath;
  }

  fs.writeFileSync(filePath, fileContent, 'utf-8');
  return { canceled: false, filePath };
});

// Some save panels normalize/strip a suggested compound extension like
// ".senticscript.md" down to just ".md" — this restores it if that happens,
// so files stay consistently and recognizably named.
function ensureSenticscriptExtension(filePath) {
  if (filePath.toLowerCase().endsWith('.senticscript.md')) return filePath;
  if (filePath.toLowerCase().endsWith('.md')) return filePath.slice(0, -3) + '.senticscript.md';
  return `${filePath}.senticscript.md`;
}

// Kills the whole process group of any in-flight backend analysis — the
// Python process and anything it spawned (ffmpeg) — rather than just the
// top-level PID. Safe to call when nothing is running.
function killCurrentAnalysisProcess(signal = 'SIGTERM') {
  if (!currentAnalysisProcess || currentAnalysisProcess.killed) return;
  try {
    if (process.platform === 'win32') {
      // Windows has no equivalent process-group-by-negative-PID concept;
      // taskkill's /T flag kills the whole subtree instead.
      spawn('taskkill', ['/pid', String(currentAnalysisProcess.pid), '/T', '/F']);
    } else {
      process.kill(-currentAnalysisProcess.pid, signal);
    }
  } catch (e) {
    // ESRCH here just means it already exited on its own between the
    // liveness check above and this call — not a real error.
    if (e.code !== 'ESRCH') console.error('Failed to kill analysis process:', e);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Without this, quitting mid-analysis would leave the Python process (and
// any ffmpeg child it spawned) running as an orphan with no way to ever
// deliver its result — this ensures it's actually terminated first.
app.on('before-quit', () => {
  killCurrentAnalysisProcess('SIGTERM');
});
