import { ipcMain, app, shell, dialog, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { APP_VERSION } from '@shared/constants'
import { errorReporter } from '../services/error-reporter'

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannels.APP_GET_VERSION, () => {
    return APP_VERSION
  })

  ipcMain.handle(IpcChannels.APP_GET_PLATFORM, () => {
    return process.platform
  })

  ipcMain.handle(IpcChannels.APP_OPEN_EXTERNAL, async (_event, url: string) => {
    return await shell.openExternal(url)
  })

  ipcMain.handle(IpcChannels.DIALOG_CONFIRM, async (_event, options: any) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return { response: -1 }

    const result = await dialog.showMessageBox(window, {
      type: options.type || 'question',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons || ['OK', 'Cancel'],
      defaultId: options.defaultId || 0,
      cancelId: options.cancelId || 1
    })

    return { response: result.response, checkboxChecked: result.checkboxChecked }
  })

  ipcMain.handle(IpcChannels.ERROR_REPORT, (_event, report: any) => {
    errorReporter.report(report)
  })
}
