import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { storageService } from '../services/storage'
import type { AppSettings } from '@shared/types'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannels.SETTINGS_GET, () => {
    return storageService.getSettings()
  })

  ipcMain.handle(IpcChannels.SETTINGS_UPDATE, (_event, settings: Partial<AppSettings>) => {
    return storageService.updateSettings(settings)
  })

  ipcMain.handle(IpcChannels.SETTINGS_RESET, () => {
    storageService.resetSettings()
    return storageService.getSettings()
  })
}
