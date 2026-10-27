// Sandboxed preload: exposes a fixed set of IPC calls as window.frost. It cannot load local
// modules (sandbox), so channel names are listed here rather than imported.
import { contextBridge, ipcRenderer } from 'electron';
import type { FrostApi, GuiEvents } from './protocol.js';

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`frost:${channel}`, ...args);

const EVENTS: (keyof GuiEvents)[] = ['state', 'transcript', 'sessions', 'command'];

const api: FrostApi = {
  init: invoke('init') as FrostApi['init'],
  refreshSessions: invoke('refreshSessions') as FrostApi['refreshSessions'],
  newSession: invoke('newSession') as FrostApi['newSession'],
  openSession: invoke('openSession') as FrostApi['openSession'],
  renameSession: invoke('renameSession') as FrostApi['renameSession'],
  deleteSession: invoke('deleteSession') as FrostApi['deleteSession'],
  submit: invoke('submit') as FrostApi['submit'],
  interrupt: invoke('interrupt') as FrostApi['interrupt'],
  answer: invoke('answer') as FrostApi['answer'],
  setModel: invoke('setModel') as FrostApi['setModel'],
  setMode: invoke('setMode') as FrostApi['setMode'],
  setAutoMode: invoke('setAutoMode') as FrostApi['setAutoMode'],
  recentProjects: invoke('recentProjects') as FrostApi['recentProjects'],
  chooseProject: invoke('chooseProject') as FrostApi['chooseProject'],
  openProject: invoke('openProject') as FrostApi['openProject'],
  openExternal: invoke('openExternal') as FrostApi['openExternal'],
  mcpList: invoke('mcpList') as FrostApi['mcpList'],
  mcpAction: invoke('mcpAction') as FrostApi['mcpAction'],
  mcpTrust: invoke('mcpTrust') as FrostApi['mcpTrust'],
  on(event, fn) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event ${String(event)}`);
    // Never hand the raw IpcRendererEvent (it carries `sender`) to the page.
    const listener = (_e: unknown, payload: unknown) => fn(payload as never);
    ipcRenderer.on(`frost:${event}`, listener);
    return () => {
      ipcRenderer.removeListener(`frost:${event}`, listener);
    };
  },
};

contextBridge.exposeInMainWorld('frost', api);
