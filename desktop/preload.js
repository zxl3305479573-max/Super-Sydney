const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sydney', {
  getState: () => ipcRenderer.invoke('app:state'),
  listEvents: filter => ipcRenderer.invoke('events:list', filter),
  createEvent: event => ipcRenderer.invoke('events:create', event),
  updateEvent: (id, patch) => ipcRenderer.invoke('events:update', { id, patch }),
  draftEvent: id => ipcRenderer.invoke('events:draft', id),
  deleteEvent: id => ipcRenderer.invoke('events:delete', id),
  setCapture: enabled => ipcRenderer.invoke('capture:set', enabled),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  generateSummary: kind => ipcRenderer.invoke('summary:generate', kind),
  generateWorkflow: () => ipcRenderer.invoke('workflow:generate'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  openFile: target => ipcRenderer.invoke('files:open', target),
  saveScreenshot: dataUrl => ipcRenderer.invoke('screenshot:save', dataUrl),
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  syncApproved: () => ipcRenderer.invoke('sync:push'),
  onEventsChanged: callback => ipcRenderer.on('events:changed', callback),
  onCaptureChanged: callback => ipcRenderer.on('capture:changed', (_event, value) => callback(value))
});
