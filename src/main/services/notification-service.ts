import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { storageService } from './storage'
import { notificationWindowManager } from './notification-window'
import { NotificationCenter } from './notification-center'
import { isNotificationSeen, markNotificationSeen, evictStaleNotifications } from './notification-dedup'
import { IpcChannels } from '@shared/ipc'
import type { MailAccount, NewEmailNotification, NotificationPopupState } from '@shared/types'

export class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private soundData: string | null = null
  private readonly notificationCenter = new NotificationCenter({
    onFlush: items => this.flushNotifications(items)
  })

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    notificationWindowManager.setMainWindow(window)
  }

  initialize(): void {
    evictStaleNotifications()

    // Load the notification sound file for both the service and the popup window
    this.loadSoundFile()
    notificationWindowManager.loadSoundFile()

    // Periodic cleanup of stale dedup entries
    setInterval(() => evictStaleNotifications(), 30 * 60 * 1000)

    logger.info('Notification service initialized')
  }

  private loadSoundFile(): void {
    try {
      // Try multiple possible locations for the notification sound file
      const candidates = [
        // Development: project root (relative to out/main/services/)
        path.join(__dirname, '..', '..', '..', 'notification-sound.mp3'),
        // Production: bundled via extraResources in electron-builder.yml
        path.join(process.resourcesPath!, 'notification-sound.mp3'),
        // Development alternative: resources/ directory
        path.join(__dirname, '..', '..', '..', 'resources', 'notification-sound.mp3'),
        // Production: app.getAppPath()
        path.join(app.getAppPath(), 'notification-sound.mp3'),
        // Production: resources dir from exe path
        path.join(path.dirname(app.getPath('exe')), 'resources', 'notification-sound.mp3'),
        // Fallback: process.cwd()
        path.join(process.cwd(), 'notification-sound.mp3')
      ]

      for (const filePath of candidates) {
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath)
          const base64 = buffer.toString('base64')
          this.soundData = `data:audio/mpeg;base64,${base64}`
          logger.info('Loaded notification sound', { path: filePath, size: buffer.length })
          return
        }
      }

      logger.warn('Notification sound file not found at any expected location')
    } catch (err) {
      logger.warn('Failed to load notification sound', err)
    }
  }

  enqueueNotification(notification: NewEmailNotification): void {
    const dedupId = this.getDedupId(notification)
    if (isNotificationSeen(dedupId)) return

    markNotificationSeen(dedupId)
    this.notificationCenter.enqueue(notification)
  }

  private flushNotifications(items: NewEmailNotification[]): void {
    const settings = storageService.getSettings()
    if (!settings.notificationsEnabled || settings.doNotDisturb || items.length === 0) {
      return
    }

    const popup = this.buildPopupState(items, settings.showPreviews !== false, settings.notificationSound !== false)
    notificationWindowManager.show(popup, this.soundData, settings.autoDismissDuration || 16000)

    logger.info('Notification delivered', {
      id: popup.id,
      itemCount: popup.itemCount,
      subject: popup.subject
    })
  }

  async playSound(): Promise<void> {
    if (!this.mainWindow) return

    // If we couldn't load the sound file, send null — the renderer will fall back to a beep
    this.mainWindow.webContents.send(IpcChannels.NOTIFICATION_SOUND_PLAY, {
      soundData: this.soundData
    })
  }

  async sendTestNotification(): Promise<void> {
    const notification: NewEmailNotification = {
      id: `test-${Date.now()}`,
      accountId: 'test',
      provider: 'proton',
      notificationKey: 'test-notification',
      from: { name: 'MailBridge Test', address: 'test@mailbridge.app' },
      subject: 'Test Notification',
      snippet: 'This is a test notification from MailBridge',
      timestamp: Date.now()
    }
    this.enqueueNotification(notification)
  }

  destroy(): void {
    this.notificationCenter.flushAll()
    notificationWindowManager.destroy()
  }

  private buildPopupState(items: NewEmailNotification[], showPreviews: boolean, soundEnabled: boolean): NotificationPopupState {
    const primary = items[items.length - 1]
    const account = storageService.getAccount(primary.accountId)
    const footer = this.buildFooter(account)
    const previewItems = items.slice(-2).reverse()

    return {
      id: randomUUID(),
      provider: primary.provider,
      accountId: primary.accountId,
      threadId: primary.threadId,
      messageId: primary.messageId,
      sender: this.formatSender(primary),
      subject: primary.subject || '(No subject)',
      snippet: showPreviews ? (primary.snippet || '') : '',
      footer,
      iconUrl: undefined,
      silent: !soundEnabled,
      itemCount: items.length,
      moreCount: Math.max(0, items.length - 1),
      previews: previewItems.map(item => ({
        sender: this.formatSender(item),
        subject: item.subject || '(No subject)',
        snippet: showPreviews ? (item.snippet || '') : ''
      })),
      actions: [
        {
          id: 'open',
          title: 'Open Proton Mail',
          tone: 'primary'
        },
        {
          id: 'dismiss',
          title: items.length > 1 ? 'Dismiss All' : 'Dismiss',
          tone: 'default'
        }
      ]
    }
  }

  private buildFooter(account: MailAccount | null): string {
    return account?.email || account?.name || 'Proton Mail'
  }

  private formatSender(notification: NewEmailNotification): string {
    const name = notification.from.name?.trim()
    const address = notification.from.address?.trim()

    if (name && address) return `${name} <${address}>`
    if (address) return address
    if (name) return name
    return 'Proton Mail'
  }

  private getDedupId(notification: NewEmailNotification): string {
    return `${notification.accountId}-${notification.notificationKey || notification.id}`
  }
}

export const notificationService = new NotificationService()
