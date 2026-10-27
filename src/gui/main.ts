// Electron main process for `frostcode gui`. It hosts the same AppController the terminal
// UI uses; the renderer is a sandboxed page that talks to it only through the preload's IPC API.
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasApiKey, prepareProcessEnv, redact, stashApiKey } from '../config/env.js';
import { addAccount, applySavedAccount, checkApiKey, useAccount } from '../config/accounts.js';
import type { PromptAnswer } from '../core/permissions.js';
import { WorkService } from '../work/service.js';
import { GuiBackend, loadGuiPrefs, saveGuiPrefs, type BackendEvent } from './backend.js';
import type { GuiCommand, GuiMode, WorkSnapshot } from './protocol.js';

// Before anything else (and before Chromium launches helper processes): take the key out of
// the environment that child processes inherit. The agent runtime still receives it explicitly.
const accountWarning = applySavedAccount();
if (accountWarning) console.warn(accountWarning);
/** False until a key is found or saved: the window then shows the key setup screen instead of quitting. */
let keyPresent = hasApiKey();
stashApiKey();
prepareProcessEnv();

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, 'renderer');
const isMac = process.platform === 'darwin';
const indexUrl = pathToFileURL(join(rendererDir, 'index.html')).href;

app.setName('FrostCode');
// The Start menu shortcut carries the same id (scripts/install-app.mjs), so the taskbar shows this
// window as FrostCode rather than Electron, and pinning it pins the shortcut.
if (process.platform === 'win32') app.setAppUserModelId('com.frostcode.desktop');
app.enableSandbox();

let win: BrowserWindow | null = null;
let backend: GuiBackend | null = null;
let work: WorkService | null = null;

function send(event: BackendEvent | { type: 'command'; payload: GuiCommand } | { type: 'work'; payload: WorkSnapshot }): void {
  if (win && !win.isDestroyed()) win.webContents.send(`frost:${event.type}`, event.payload);
}

// ---- IPC ----------------------------------------------------------------------

const isString = (v: unknown, max = 100_000): v is string => typeof v === 'string' && v.length <= max;

function assertSender(e: IpcMainInvokeEvent): void {
  if (!win || e.sender !== win.webContents || e.senderFrame?.url !== indexUrl) throw new Error('Rejected IPC from an unexpected sender');
}

function validAnswer(a: unknown): a is PromptAnswer {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  switch (x.kind) {
    case 'allow':
      return x.always === undefined || typeof x.always === 'boolean';
    case 'deny':
    case 'plan-reject':
      return x.feedback === undefined || isString(x.feedback, 10_000);
    case 'plan-approve':
      return x.mode === 'default' || x.mode === 'acceptEdits';
    case 'answers':
      return !!x.answers && typeof x.answers === 'object' && Object.values(x.answers as object).every((v) => isString(v, 10_000));
    case 'cancel':
      return true;
    default:
      return false;
  }
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`frost:${channel}`, async (e, ...args) => {
    assertSender(e);
    try {
      return await fn(...args);
    } catch (err) {
      // Error messages cross into the renderer: never let a key ride along.
      throw new Error(redact((err as Error).message));
    }
  });
}

let started = false;

/** Start the conversation runtime once there is a key: at launch, or when one is saved in the app. */
async function startBackend(): Promise<void> {
  if (started || !backend) return;
  started = true;
  try {
    await backend.start();
  } catch (e) {
    dialog.showErrorBox('FrostCode', redact((e as Error).message));
  }
}

function need(): GuiBackend {
  if (!backend || !started) throw new Error(keyPresent ? 'FrostCode is still starting' : 'Enter your Anthropic API key first.');
  return backend;
}

function needWork(): WorkService {
  if (!work) throw new Error('FrostCode is still starting');
  return work;
}

/** The account name a key entered in the app is saved under (the same store as `frostcode account add`). */
const DESKTOP_ACCOUNT = 'default';

function registerIpc(): void {
  handle('needsKey', () => !keyPresent);
  handle('saveApiKey', async (key) => {
    if (!isString(key, 500)) bad();
    await checkApiKey(key as string);
    addAccount(DESKTOP_ACCOUNT, key as string);
    useAccount(DESKTOP_ACCOUNT);
    keyPresent = true;
    void startBackend();
  });
  handle('init', () => need().initial());
  handle('refreshSessions', () => need().refreshSessions());
  handle('newSession', (cwd) => need().newSession(cwd === undefined ? undefined : isString(cwd, 4096) ? cwd : bad()));
  handle('openSession', (id, cwd) => (isString(id, 200) && isString(cwd, 4096) ? need().openSession(id, cwd) : bad()));
  handle('renameSession', (id, cwd, title) =>
    isString(id, 200) && isString(cwd, 4096) && isString(title, 500) ? need().renameSession(id, cwd, title) : bad(),
  );
  handle('deleteSession', async (id, cwd) => {
    if (!isString(id, 200) || !isString(cwd, 4096)) bad();
    const title = need().sessionGroups.flatMap((g) => g.sessions).find((s) => s.id === id)?.title ?? 'this conversation';
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete this conversation?',
      detail: `"${title.slice(0, 120)}" will be removed from disk. This cannot be undone.`,
    });
    if (response !== 0) return false;
    await need().deleteSession(id as string, cwd as string);
    return true;
  });
  handle('submit', (text) => (isString(text) ? need().submit(text) : bad()));
  handle('interrupt', () => need().interrupt());
  handle('answer', (a) => (validAnswer(a) ? need().answer(a) : bad()));
  handle('setModel', (m) => (m === null || isString(m, 200) ? need().setModel(m) : bad()));
  handle('setMode', (m) => (m === 'default' || m === 'acceptEdits' || m === 'plan' || m === 'auto' ? need().setMode(m as GuiMode) : bad()));
  handle('setAutoMode', (on) => (typeof on === 'boolean' ? need().setAutoMode(on) : bad()));
  handle('recentProjects', () => need().recentProjects());
  handle('chooseProject', () => chooseProject());
  handle('openProject', (p) => (isString(p, 4096) ? need().openProject(p) : bad()));
  handle('mcpList', (refresh) => need().mcpList(refresh === true));
  handle('mcpAction', (id, action) =>
    isString(id, 4096) && (action === 'approve' || action === 'reject' || action === 'enable' || action === 'disable' || action === 'reconnect' || action === 'refresh')
      ? need().mcpAction(id, action)
      : bad(),
  );
  handle('mcpTrust', (server, tool, trusted) => (isString(server, 200) && isString(tool, 200) && typeof trusted === 'boolean' ? need().mcpTrust(server, tool, trusted) : bad()));
  handle('workLoad', (refresh) => needWork().load(refresh === true));
  handle('workConnectJira', (site, email, token) =>
    isString(site, 500) && isString(email, 320) && isString(token, 4096) ? needWork().connectJira(site, email, token) : bad(),
  );
  handle('workConnectMicrosoft', () => needWork().connectMicrosoft());
  handle('workCancelMicrosoft', () => needWork().cancelMicrosoft());
  handle('workDisconnect', (source) => (source === 'jira' || source === 'microsoft' ? needWork().disconnect(source) : bad()));
  handle('openExternal', async (url) => {
    if (!isString(url, 4096)) bad();
    const u = new URL(url as string);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened');
    await shell.openExternal(u.href);
  });
}

function bad(): never {
  throw new Error('Invalid arguments');
}

async function chooseProject(): Promise<void> {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: backend?.snapshot().cwd,
  });
  if (!res.canceled && res.filePaths[0]) await need().openProject(res.filePaths[0]);
}

// ---- window -------------------------------------------------------------------

function boundsFromPrefs() {
  const saved = loadGuiPrefs().window;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(saved?.width ?? 1180, area.width);
  const height = Math.min(saved?.height ?? 800, area.height);
  return { width, height, x: saved?.x, y: saved?.y };
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...boundsFromPrefs(),
    minWidth: 720,
    minHeight: 480,
    title: 'FrostCode',
    backgroundColor: '#0d0f13',
    // The top bar is the title bar. macOS draws its traffic lights over the sidebar's top; on Windows and
    // Linux a hidden title bar has no window buttons at all unless the overlay draws them at the top bar's
    // right end (45px: the top bar less its bottom border, which stays visible under the buttons).
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0d0f13', symbolColor: '#b4bac4', height: 45 },
          // Taskbar / Alt+Tab icon (macOS takes the app bundle's). dist/gui -> the repo's assets/.
          icon: join(here, '..', '..', 'assets', process.platform === 'win32' ? 'FrostCode.ico' : 'FrostCode-1024.png'),
        }),
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  w.once('ready-to-show', () => w.show());
  // The page is a fixed local file: no navigation, no popups (links open in the browser via IPC).
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('will-redirect', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.on('close', () => {
    const b = w.getBounds();
    saveGuiPrefs({ window: { x: b.x, y: b.y, width: b.width, height: b.height } });
  });
  void w.loadURL(indexUrl);
  return w;
}

function buildMenu(): void {
  const cmd = (c: GuiCommand) => () => send({ type: 'command', payload: c });
  const run = (fn: () => Promise<unknown>) => () => {
    fn().catch((e) => dialog.showErrorBox('FrostCode', redact((e as Error).message)));
  };
  // The bar itself only shows on macOS (a hidden title bar has no menu bar elsewhere), but every
  // platform gets the accelerators. Hide / Hide Others are macOS roles; Quit moves to File elsewhere.
  const appMenu: Electron.MenuItemConstructorOptions[] = isMac
    ? [{ label: 'FrostCode', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }]
    : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: run(() => need().newSession()) },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: run(() => chooseProject()) },
        { type: 'separator' },
        { label: 'Rename Conversation', accelerator: 'CmdOrCtrl+R', click: cmd('rename-session') },
        { label: 'Search Conversations', accelerator: 'CmdOrCtrl+K', click: cmd('focus-search') },
        { type: 'separator' },
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Conversation',
      submenu: [
        { label: 'Focus Message Box', accelerator: 'CmdOrCtrl+L', click: cmd('focus-composer') },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: run(() => need().interrupt()) },
        { type: 'separator' },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: cmd('show-shortcuts') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSessions(): void {
  // Deny every browser permission except writing copied code to the clipboard.
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

// ---- lifecycle ----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    hardenSessions();
    // Saved Jira / Microsoft sign-ins are encrypted with the OS (DPAPI on Windows, the Keychain on macOS).
    work = new WorkService({
      secrets: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (data) => safeStorage.decryptString(data),
      },
      emit: (snapshot) => send({ type: 'work', payload: snapshot }),
    });
    registerIpc();
    buildMenu();
    backend = new GuiBackend({
      defaultCwd: process.env.FROSTCODE_GUI_DEFAULT_CWD || app.getPath('home'),
      cwd: process.env.FROSTCODE_GUI_CWD || undefined,
      emit: send,
    });
    win = createWindow();
    win.on('closed', () => (win = null));
    if (keyPresent) await startBackend();
  });

  app.on('window-all-closed', () => app.quit());

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !backend || !started) return;
    e.preventDefault();
    const n = backend.runningCount;
    if (n > 0) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: n === 1 ? 'A conversation is still running.' : `${n} conversations are still running.`,
        detail: 'Quitting stops them. Their replies so far are saved.',
      });
      if (choice !== 0) {
        // Closing the window quits too; on Cancel bring it back onto the still-running conversations.
        if (!win) {
          win = createWindow();
          win.on('closed', () => (win = null));
        }
        return;
      }
    }
    quitting = true;
    work?.shutdown();
    const b = backend;
    void b.shutdown().finally(() => app.quit());
  });
}
