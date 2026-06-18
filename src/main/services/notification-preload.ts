import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('notificationOverlay', {
  onOpen: () => ipcRenderer.send('notification-overlay-open'),
  onDismiss: () => ipcRenderer.send('notification-overlay-dismiss')
})
