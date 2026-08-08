import { ipcMain, app } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { storageService } from '../services/storage'
import { syncService } from '../services/sync-service'
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

    // Re-apply the sync cadence immediately when sync settings change
    if ('syncInterval' in settings || 'autoSync' in settings || 'syncOnStartup' in settings) {
      try {
        syncService.applySyncInterval()
        if ('syncOnStartup' in settings && settings.syncOnStartup) {
          syncService.syncAll()
        }
      } catch (err) {
        logger.warn('Failed to re-apply sync settings', err)
      }
    }

    return updated
  })

  ipcMain.handle(IpcChannels.SETTINGS_RESET, () => {
    storageService.resetSettings()
    return storageService.getSettings()
  })
}
