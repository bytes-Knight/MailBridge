import { app, BrowserWindow } from 'electron'
import { logger } from './logger'
import { storageService } from './storage'
import type { BadgeUpdate } from '@shared/types'
import { IpcChannels } from '@shared/ipc'

class UnreadCounter {
  private mainWindow: BrowserWindow | null = null
  private counts = new Map<string, number>()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  async refreshAll(): Promise<void> {
    const accounts = storageService.getAccounts()
    // Unread counts for Proton accounts are managed through session state
    // This is a placeholder for future unread tracking implementation
    this.updateBadge()
  }

  setInboxCount(accountId: string, count: number): void {
    this.counts.set(accountId, count)
    this.updateBadge()
  }

  getTotalUnread(): number {
    let total = 0
    for (const count of this.counts.values()) {
      total += count
    }
    return total
  }

  getPerAccount(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [id, count] of this.counts) {
      result[id] = count
    }
    return result
  }

  private updateBadge(): void {
    const total = this.getTotalUnread()
    app.setBadgeCount(total)

    const badge: BadgeUpdate = {
      total,
      formatted: total > 99 ? '99+' : String(total),
      perAccount: this.getPerAccount()
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IpcChannels.UNREAD_BADGE_UPDATED, badge)
    }
  }
}

export const unreadCounter = new UnreadCounter()
