import { ipcMain, app } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { storageService } from '../services/storage'
import type { AppSettings } from '@shared/types'
import { logger } from '../services/logger'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannels.SETTINGS_GET, () => {
    return storageService.getSettings()
  })

  ipcMain.handle(IpcChannels.SETTINGS_UPDATE, (_event, settings: Partial<AppSettings>) => {
    const updated = storageService.updateSettings(settings)

    // Apply auto-launch setting immediately
    if ('launchOnStartup' in settings) {
      try {
        app.setLoginItemSettings({
          openAtLogin: settings.launchOnStartup!
        })
        logger.info('Auto-launch setting updated', { openAtLogin: settings.launchOnStartup })
      } catch (err) {
        logger.warn('Failed to update auto-launch setting', err)
      }
    }

    return updated
  })

  ipcMain.handle(IpcChannels.SETTINGS_RESET, () => {
    storageService.resetSettings()
    return storageService.getSettings()
  })
}
