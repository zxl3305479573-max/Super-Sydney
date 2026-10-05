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
  draftEvent: id => ipcRenderer.invoke('event:draft', id),
  applyDraft: id => ipcRenderer.invoke('event:draft:apply', id),
  clearDraft: id => ipcRenderer.invoke('event:draft:clear', id),
  getLlmKeyStatus: () => ipcRenderer.invoke('llm-key:status'),
  saveLlmKey: value => ipcRenderer.invoke('llm-key:save', value),
  deleteLlmKey: () => ipcRenderer.invoke('llm-key:delete'),
  onChanged: callback => { ipcRenderer.on('state:changed', callback); return () => ipcRenderer.removeListener('state:changed', callback); }
};

contextBridge.exposeInMainWorld('sydney', api);
