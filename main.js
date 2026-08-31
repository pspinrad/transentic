const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
    filters: [{ name: 'Transcript sidecar', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const sidecarPath = result.filePaths[0];
  try {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    mainWindow.webContents.send('transcript:loaded', { sidecarPath, sidecar });
  } catch (e) {
    dialog.showErrorBox('Could not open transcript', e.message);
  }
}

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
    const proc = spawn(command, args, { cwd: __dirname });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // stdout is intentionally not parsed for the result anymore — several
    // ML libraries in analyze.py's pipeline (Keras/TensorFlow in particular)
    // print their own progress output to stdout, which would corrupt a JSON
    // payload sent that way. analyze.py instead writes the result to
    // outputPath, which is read directly below once the process exits.
    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
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

// --- IPC: save transcript + sidecar to disk ---
ipcMain.handle('file:saveTranscript', async (_evt, { markdown, sidecar, suggestedName, forceDialog }) => {
  let basePath;
  if (forceDialog || !sidecar.savedPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Senticscript',
      defaultPath: suggestedName || 'transcript.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    basePath = result.filePath.replace(/\.md$/i, '');
  } else {
    basePath = sidecar.savedPath.replace(/\.sentiment\.json$/i, '');
  }

  const mdPath = `${basePath}.md`;
  const jsonPath = `${basePath}.sentiment.json`;

  if (!sidecar.guid) sidecar.guid = crypto.randomUUID();
  sidecar.savedPath = jsonPath;
  sidecar.transcriptPath = mdPath;

  fs.writeFileSync(mdPath, markdown, 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2), 'utf-8');

  return { canceled: false, mdPath, jsonPath, guid: sidecar.guid };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
