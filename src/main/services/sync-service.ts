import { logger } from './logger'
import { storageService } from './storage'
import type { SyncStatus } from '@shared/types'

type SyncStatusCallback = (status: SyncStatus) => void

class SyncService {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private callbacks: SyncStatusCallback[] = []
  private isSyncing = false

  onStatus(callback: SyncStatusCallback): void {
    this.callbacks.push(callback)
  }

  offStatus(callback: SyncStatusCallback): void {
    this.callbacks = this.callbacks.filter(c => c !== callback)
  }

  start(): void {
    this.syncAll()
    const interval = storageService.getSettings().syncInterval || 20
    this.intervalId = setInterval(() => this.syncAll(), Math.max(interval, 20) * 1000)
    logger.info('Sync service started')
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    logger.info('Sync service stopped')
  }

  async syncAll(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping')
      return
    }

    this.isSyncing = true
    this.broadcast({ status: 'syncing', timestamp: Date.now() })

    try {
      const accounts = storageService.getAccounts()

      for (const account of accounts) {
        await this.syncAccount(account)
      }

      this.broadcast({ status: 'completed', timestamp: Date.now() })
    } catch (err) {
      logger.error('Sync failed', err)
      this.broadcast({ status: 'failed', timestamp: Date.now(), error: String(err) })
    } finally {
      this.isSyncing = false
    }
  }

  async triggerManualSync(): Promise<void> {
    return this.syncAll()
  }

  private async syncAccount(account: any): Promise<void> {
    try {
      // Proton accounts are synced via session management
      logger.debug('Sync account placeholder', { accountId: account.id })
    } catch (err) {
      logger.warn('Failed to sync account', { accountId: account.id, error: err })
    }
  }

  private broadcast(status: SyncStatus): void {
    for (const cb of this.callbacks) {
      try { cb(status) } catch { /* ignore */ }
    }
  }
}

export const syncService = new SyncService()
