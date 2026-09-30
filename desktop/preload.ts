import { contextBridge, ipcRenderer } from 'electron';
import type { SydneyApi } from './shared';

const api: SydneyApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  createEvent: event => ipcRenderer.invoke('event:create', event),
  updateEvent: (id, patch) => ipcRenderer.invoke('event:update', id, patch),
  deleteEvent: id => ipcRenderer.invoke('event:delete', id),
  setCapture: enabled => ipcRenderer.invoke('capture:set', enabled),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  generateDailySummary: () => ipcRenderer.invoke('summary:daily'),
  onChanged: callback => { ipcRenderer.on('state:changed', callback); return () => ipcRenderer.removeListener('state:changed', callback); }
};

contextBridge.exposeInMainWorld('sydney', api);
