import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'

export function registerWindowHandlers(): void {
  ipcMain.handle(IpcChannels.WINDOW_MINIMIZE, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) window.minimize()
  })

  ipcMain.handle(IpcChannels.WINDOW_MAXIMIZE, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
  })

  ipcMain.handle(IpcChannels.WINDOW_CLOSE, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) window.close()
  })

  ipcMain.handle(IpcChannels.WINDOW_IS_MAXIMIZED, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? window.isMaximized() : false
  })
}
