import { ipcMain } from 'electron'
import { registerAccountsHandlers } from './accounts-handler'
import { registerAppHandlers } from './app-handler'
import { registerProtonHandlers } from './proton-handler'
import { registerSettingsHandlers } from './settings-handler'
import { registerStorageHandlers } from './storage-handler'
import { registerUnreadHandlers } from './unread-handler'
import { registerWindowHandlers } from './window-handler'
import { registerLogoHandlers } from './logo-handler'
import { IpcChannels } from '@shared/ipc'
import { syncService } from '../services/sync-service'
import { unreadCounter } from '../services/unread-counter'
import { notificationService } from '../services/notification-service'
import { logoCache } from '../services/logo-cache'
import { logoPreloader } from '../services/logo-preloader'
import { logger } from '../services/logger'
import type { BrowserWindow } from 'electron'

export async function registerAllHandlers(mainWindow: BrowserWindow): Promise<void> {
  // Register all IPC handlers
  registerAccountsHandlers()
  registerAppHandlers()
  registerProtonHandlers()
  registerSettingsHandlers()
  registerStorageHandlers()
  registerUnreadHandlers()
  registerWindowHandlers()
  registerLogoHandlers()

  // Notification-specific handlers
  ipcMain.handle(IpcChannels.NOTIFICATION_SEND_TEST, async () => {
    await notificationService.sendTestNotification()
  })

  // Initialize services
  unreadCounter.setMainWindow(mainWindow)
  notificationService.setMainWindow(mainWindow)
  notificationService.initialize()

  // Warm logo cache from disk on startup
  logoCache.warmFromDisk().catch(err =>
    logger.warn('Failed to warm logo cache', err)
  )

  // Register sync callback for logo prefetch
  syncService.onStatus((status) => {
    if (status.status === 'completed') {
      logoPreloader.notifySyncCompleted()
    }
  })

  // Initialize sync
  unreadCounter.refreshAll()
  syncService.start()
}
