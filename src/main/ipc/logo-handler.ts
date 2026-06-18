import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { logoCache } from '../services/logo-cache'
import { logoResolver } from '../services/logo-resolver'
import { logger } from '../services/logger'

/**
 * Register IPC handlers for the Brand Identity Service.
 */
export function registerLogoHandlers(): void {
  // Resolve a single email → logo
  ipcMain.handle(IpcChannels.LOGO_RESOLVE, async (_event, params: { email: string; name?: string }) => {
    try {
      const result = await logoResolver.resolve(params.email, params.name)
      return result
    } catch (err) {
      logger.error('Logo resolve handler failed', { email: params.email, error: err })
      return {
        type: 'initials' as const,
        data: (params.name || params.email).substring(0, 2).toUpperCase(),
        source: 'generated' as const,
        fromCache: false
      }
    }
  })

  // Resolve multiple emails in batch
  ipcMain.handle(IpcChannels.LOGO_RESOLVE_BATCH, async (_event, params: { entries: Array<{ email: string; name?: string }> }) => {
    try {
      const results = await logoResolver.resolveBatch(params.entries)
      return results
    } catch (err) {
      logger.error('Logo resolve batch handler failed', { error: err })
      return {}
    }
  })

  // Clear all cached logos
  ipcMain.handle(IpcChannels.LOGO_CLEAR_CACHE, async () => {
    try {
      await logoCache.clearAll()
      return { success: true }
    } catch (err) {
      logger.error('Logo clear cache handler failed', { error: err })
      return { success: false, error: String(err) }
    }
  })

  // Get diagnostics
  ipcMain.handle(IpcChannels.LOGO_GET_DIAGNOSTICS, async () => {
    try {
      return logoCache.getDiagnostics()
    } catch (err) {
      logger.error('Logo diagnostics handler failed', { error: err })
      return null
    }
  })
}
