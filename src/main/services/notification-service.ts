import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { storageService } from './storage'
import { notificationWindowManager } from './notification-window'
import { NotificationCenter } from './notification-center'
import { evictStaleNotifications } from './notification-dedup'
import { logoResolver } from './logo-resolver'
import { getIconDataUrl } from './icon-loader'
import { IpcChannels } from '@shared/ipc'
import type { MailAccount, NewEmailNotification, NotificationPopupState } from '@shared/types'

export class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private soundData: string | null = null
  private appIconDataUrl: string = ''
  private readonly notificationCenter = new NotificationCenter({
    flushDebounceMs: 1000,
    dedupeWindowMs: 30000,
    onFlush: items => this.flushNotifications(items)
  })

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    notificationWindowManager.setMainWindow(window)
  }

  initialize(): void {
    evictStaleNotifications()

    // Load the app icon and notification sound
    this.appIconDataUrl = getIconDataUrl()
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
    logger.info('Notification queued', {
      id: notification.id,
      accountId: notification.accountId,
      subject: notification.subject,
      hasSnippet: Boolean(notification.snippet)
    })
    this.notificationCenter.enqueue(notification)
  }

  private async flushNotificationsAsync(items: NewEmailNotification[], options: { force?: boolean } = {}): Promise<void> {
    const settings = storageService.getSettings()
    if (items.length === 0) {
      return
    }

    if (!options.force && (!settings.notificationsEnabled || settings.doNotDisturb || !settings.notifyForProton)) {
      logger.info('Notification suppressed by settings', {
        notificationsEnabled: settings.notificationsEnabled,
        doNotDisturb: settings.doNotDisturb,
        notifyForProton: settings.notifyForProton,
        itemCount: items.length
      })
      return
    }

    const popup = this.buildPopupState(items, settings.showPreviews !== false, settings.notificationSound !== false)

    // Set app icon URL and account email on each notification for the in-app toast
    const appIconUrl = this.appIconDataUrl || ''
    const account = storageService.getAccount(items[items.length - 1].accountId)
    const accountEmail = account?.email || ''
    for (const item of items) {
      item.appIconUrl = appIconUrl
      item.accountEmail = accountEmail
    }

    // Send the latest notification to the renderer for the in-app toast
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const primary = items[items.length - 1]
      this.mainWindow.webContents.send(IpcChannels.NOTIFICATION_NEW_EMAIL, primary)
    }

    // Show notification immediately, then try to resolve logo asynchronously
    notificationWindowManager.show(popup, this.soundData, settings.autoDismissDuration || 16000)

    // Best-effort logo resolution (non-blocking, 500ms timeout)
    const senderAddress = items[items.length - 1].from.address || ''
    if (senderAddress) {
      withTimeout(logoResolver.resolve(senderAddress), 500, null).then(logoResult => {
        if (logoResult && logoResult.type !== 'initials' && logoResult.data) {
          // Update the popup icon — this works because the window is already showing
          popup.iconUrl = logoResult.data
        }
      }).catch(() => { /* logo resolution is optional */ })
    }

    logger.info('Notification delivered', {
      id: popup.id,
      itemCount: popup.itemCount,
      subject: popup.subject
    })
  }

  private flushNotifications(items: NewEmailNotification[], options: { force?: boolean } = {}): void {
    void this.flushNotificationsAsync(items, options)
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
      notificationKey: `test-notification-${Date.now()}`,
      from: { name: 'MailBridge Test', address: 'test@mailbridge.app' },
      subject: 'Test Notification',
      snippet: 'This is a test notification from MailBridge',
      timestamp: Date.now()
    }
    this.flushNotifications([notification], { force: true })
  }

  destroy(): void {
    this.notificationCenter.flushAll()
    notificationWindowManager.destroy()
  }

  private buildPopupState(items: NewEmailNotification[], showPreviews: boolean, soundEnabled: boolean): NotificationPopupState {
    const primary = items[items.length - 1]
    const account = storageService.getAccount(primary.accountId)
    const settings = storageService.getSettings()
    const footer = this.buildFooter(account)
    const previewItems = items.slice(-3).reverse()
    const displaySubject = this.buildDisplaySubject(primary)

    return {
      id: randomUUID(),
      provider: primary.provider,
      accountId: primary.accountId,
      threadId: primary.threadId,
      messageId: primary.messageId,
      sender: this.formatSender(primary),
      subject: displaySubject,
      snippet: showPreviews ? this.buildDisplaySnippet(primary, displaySubject) : '',
      footer,
      iconUrl: undefined,
      appIconUrl: this.appIconDataUrl || undefined,
      silent: !soundEnabled,
      itemCount: items.length,
      moreCount: Math.max(0, items.length - 1),
      accentColor: settings.accentColor,
      date: primary.date,
      hasAttachments: primary.hasAttachments,
      isStarred: primary.isStarred,
      previews: showPreviews ? previewItems.map(item => ({
        sender: this.formatSender(item),
        subject: this.buildDisplaySubject(item),
        snippet: this.buildDisplaySnippet(item, this.buildDisplaySubject(item))
      })) : [],
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

  private buildDisplaySubject(notification: NewEmailNotification): string {
    const subject = this.normalizeNotificationText(notification.subject)
    if (!subject) return 'New email received'
    if (this.isGenericProtonSubject(subject) && this.looksLikeNavigationJunk(subject)) {
      return 'New email received'
    }
    // Show the subject even if it's generic — real email subjects are more informative
    if (this.isGenericProtonSubject(subject)) {
      return subject.length > 0 ? subject : 'New email received'
    }
    if (this.looksLikeNavigationJunk(subject)) {
      return 'New email received'
    }
    return subject
  }

  private buildDisplaySnippet(notification: NewEmailNotification, displaySubject: string): string {
    const rawSnippet = this.normalizeNotificationText(notification.snippet)
    const rawSubject = this.normalizeNotificationText(notification.subject)

    // Show snippet if it exists and is meaningful — be lenient to maximize detail
    if (
      rawSnippet &&
      rawSnippet !== rawSubject &&
      rawSnippet !== displaySubject &&
      !this.looksLikeNavigationJunk(rawSnippet) &&
      rawSnippet.length > 3
    ) {
      // Show up to 200 chars of snippet
      return rawSnippet.length > 200 ? rawSnippet.substring(0, 200) + '...' : rawSnippet
    }

    return ''
  }

  private normalizeNotificationText(value?: string): string {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private isGenericProtonSubject(value: string): boolean {
    const normalized = value.trim().toLowerCase()
    return (
      normalized === 'proton mail' ||
      normalized === 'new message in proton mail' ||
      normalized === 'new email received' ||
      normalized === 'new message received' ||
      normalized === '(no subject)' ||
      normalized === 'you have 1 new message(s)' ||
      normalized === 'you have new message(s)' ||
      /^you have \d+ new message/i.test(normalized) ||
      /^\d+ new message/i.test(normalized)
    )
  }

  private looksLikeNavigationJunk(value: string): boolean {
    const normalized = this.normalizeNotificationText(value).toLowerCase()
    if (!normalized) return false
    if (normalized.length > 260) return true
    return /\b(open navigation|all mail|drafts|sent|starred|archive|spam|trash|folders|labels|manage your folders|create a new folder|inbox drafts sent)\b/i.test(normalized)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, timeoutMs)
    promise.then(value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }).catch(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

export const notificationService = new NotificationService()
