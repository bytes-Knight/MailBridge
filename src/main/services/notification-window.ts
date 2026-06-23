import { BrowserWindow, app, ipcMain, screen } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { AccentColor, NotificationAction, NotificationPopupState, NotificationPreview } from '@shared/types'
import { getWindowIcon } from './icon-loader'
import { logger } from './logger'
import * as fs from 'fs'
import * as path from 'path'

const TOAST_WIDTH = 420
const TOAST_HEIGHT_DEFAULT = 120
const TOAST_HEIGHT_EXPANDED = 140
const TOAST_MARGIN = 18
const STACK_GAP = 10

export class NotificationWindowManager {
  private windows: BrowserWindow[] = []
  private mainWindow: BrowserWindow | null = null
  private loadedSoundData: string | null = null
  private generatedPreloadPath: string | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  loadSoundFile(): void {
    try {
      const candidates = [
        path.join(__dirname, '..', '..', '..', 'notification-sound.mp3'),
        path.join(process.resourcesPath!, 'notification-sound.mp3'),
        path.join(__dirname, '..', '..', '..', 'resources', 'notification-sound.mp3'),
        path.join(app.getAppPath(), 'notification-sound.mp3'),
        path.join(path.dirname(app.getPath('exe')), 'resources', 'notification-sound.mp3'),
        path.join(process.cwd(), 'notification-sound.mp3')
      ]

      for (const filePath of candidates) {
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath)
          this.loadedSoundData = `data:audio/mpeg;base64,${buffer.toString('base64')}`
          return
        }
      }
    } catch {
      // Notification sound stays optional.
    }
  }

  show(payload: NotificationPopupState, soundData: string | null, autoDismissMs: number): void {
    while (this.windows.length > 0) {
      const existing = this.windows.shift()
      if (existing && !existing.isDestroyed()) {
        try { existing.close() } catch { /* ignore */ }
      }
    }

    this.windows = this.windows.filter(win => !win.isDestroyed())

    const windowHeight = this.getPopupHeight(payload)
    const { x, y } = this.getNotificationBounds(this.windows.length, windowHeight)
    const preloadPath = this.getNotificationPreloadPath()

    let win: BrowserWindow
    try {
      win = new BrowserWindow({
        width: TOAST_WIDTH,
        height: windowHeight,
        x,
        y,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        hasShadow: false,
        focusable: false,
        icon: getWindowIcon(),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: preloadPath,
          // Disable features that may cause crashes on lightweight notification windows
          backgroundThrottling: false,
          spellcheck: false
        }
      })
    } catch (err) {
      logger.error('Failed to create notification window, falling back to in-app notification', {
        id: payload.id,
        error: String(err)
      })
      // Fallback: send the notification as an in-app toast through the main window instead
      this.sendFallbackNotification(payload)
      return
    }

    win.setVisibleOnAllWorkspaces(true)
    let shown = false
    const showWindow = (reason: string) => {
      if (shown || win.isDestroyed()) return
      shown = true
      try {
        win.showInactive()
        win.moveTop()
        logger.info('Notification popup shown', {
          id: payload.id,
          reason,
          bounds: win.getBounds()
        })
      } catch (err) {
        logger.error('Failed to show notification popup', err)
      }
    }

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      logger.error('Notification popup failed to load', { id: payload.id, errorCode, errorDescription })
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      logger.error('Notification popup renderer exited', { id: payload.id, details })
    })

    win.webContents.on('did-finish-load', () => {
      showWindow('did-finish-load')
    })

    win.once('ready-to-show', () => {
      showWindow('ready-to-show')
    })

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.buildHtml(payload, soundData, autoDismissMs))}`)
      .catch(err => {
        logger.error('Notification popup loadURL failed', { id: payload.id, error: String(err) })
      })

    setTimeout(() => showWindow('fallback-timeout'), 800)

    const handleOpen = () => {
      this.close(win)
      if (!this.mainWindow) return

      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.show()
      this.mainWindow.focus()

      this.mainWindow.webContents.send(IpcChannels.NOTIFICATION_OPEN_CONVERSATION, {
        accountId: payload.accountId,
        threadId: payload.threadId,
        messageId: payload.messageId
      })
    }

    const handleDismiss = () => {
      this.close(win)
    }

    const openHandler = (event: Electron.IpcMainEvent) => {
      cleanupHandlers(event)
      handleOpen()
    }
    const dismissHandler = (event: Electron.IpcMainEvent) => {
      cleanupHandlers(event)
      handleDismiss()
    }

    const cleanupHandlers = (_event?: Electron.IpcMainEvent) => {
      try { ipcMain.removeListener('notification-overlay-open', openHandler) } catch {}
      try { ipcMain.removeListener('notification-overlay-dismiss', dismissHandler) } catch {}
    }

    ipcMain.on('notification-overlay-open', openHandler)
    ipcMain.on('notification-overlay-dismiss', dismissHandler)

    // Clean up handlers when the window is destroyed (e.g. auto-dismiss)
    win.on('closed', () => {
      cleanupHandlers()
    })

    this.windows.push(win)
    this.syncPositions()
  }

  close(targetWindow?: BrowserWindow): void {
    if (targetWindow) {
      const index = this.windows.indexOf(targetWindow)
      if (index !== -1) this.windows.splice(index, 1)
      try { targetWindow.close() } catch { /* ignore */ }
    } else {
      const win = this.windows.shift()
      if (win) {
        try { win.close() } catch { /* ignore */ }
      }
    }

    this.syncPositions()
  }

  destroy(): void {
    for (const win of this.windows) {
      if (!win.isDestroyed()) {
        try { win.close() } catch { /* ignore */ }
      }
    }
    this.windows = []
    this.mainWindow = null
  }

  /**
   * Fallback: send notification data through the main window as an in-app toast.
   * Used when the popup window fails to create (e.g., system resource limits).
   */
  private sendFallbackNotification(payload: NotificationPopupState): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    try {
      this.mainWindow.webContents.send(IpcChannels.NOTIFICATION_NEW_EMAIL, {
        id: payload.id,
        accountId: payload.accountId,
        provider: payload.provider,
        from: { name: payload.sender, address: '' },
        subject: payload.subject,
        snippet: payload.snippet,
        timestamp: Date.now(),
        threadId: payload.threadId,
        messageId: payload.messageId,
        appIconUrl: payload.appIconUrl || ''
      })
      logger.info('Fallback in-app notification sent', { id: payload.id })
    } catch (err) {
      logger.error('Failed to send fallback in-app notification', { id: payload.id, error: String(err) })
    }
  }

  private getNotificationPreloadPath(): string {
    if (this.generatedPreloadPath && fs.existsSync(this.generatedPreloadPath)) {
      return this.generatedPreloadPath
    }

    const preloadDir = path.join(app.getPath('userData'), 'generated')
    const preloadPath = path.join(preloadDir, 'notification-preload.js')
    const preloadSource = `
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationOverlay', {
  onOpen: () => ipcRenderer.send('notification-overlay-open'),
  onDismiss: () => ipcRenderer.send('notification-overlay-dismiss'),
  onReady: () => {}
});
`.trim()

    fs.mkdirSync(preloadDir, { recursive: true })
    fs.writeFileSync(preloadPath, preloadSource, 'utf8')
    this.generatedPreloadPath = preloadPath
    return preloadPath
  }

  private buildHtml(payload: NotificationPopupState, soundData: string | null, autoDismissMs: number): string {
    const sender = parseSender(payload.sender)
    const providerTag = payload.provider === 'proton' ? 'proton' : 'mail'
    const senderLine = sanitizeText(payload.footer || sender.email || sender.label || 'Proton Mail')
    const subject = sanitizeText(payload.subject || '(No subject)')
    const snippet = this.getPreviewText(payload)
    const popupTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())
    const primaryAction = payload.actions[0] || { id: 'open', title: 'Open Proton Mail', tone: 'primary' as const }
    const secondaryAction = payload.actions[1] || { id: 'dismiss', title: 'Dismiss', tone: 'default' as const }

    // Override action labels
    const openLabel = payload.provider === 'proton' ? 'Open Proton Mail' : 'Open Email'
    primaryAction.title = openLabel

    const accent = getAccentColors(payload.accentColor)

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --cbg: #0f0f13;
  --cbd: rgba(255, 255, 255, 0.08);
  --ct1: #e4e4e7;
  --ct2: #a1a1aa;
  --ct3: #71717a;
  --cbg2: #1a1a23;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: var(--ct1);
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.nt-card {
  position: absolute;
  inset: 0;
  background: var(--cbg);
  border: 0.5px solid var(--cbd);
  border-radius: 14px;
  animation: ntSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 0 0.5px rgba(255, 255, 255, 0.03) inset;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.nt-card.dismissing {
  animation: ntSlideOut 0.3s cubic-bezier(0.55, 0, 1, 0.45) forwards;
}
@keyframes ntSlideIn {
  0% { opacity: 0; transform: translateX(48px) scale(0.95); }
  100% { opacity: 1; transform: translateX(0) scale(1); }
}
@keyframes ntSlideOut {
  0% { opacity: 1; transform: translateX(0) scale(1); }
  100% { opacity: 0; transform: translateX(32px) scale(0.96); }
}

/* ── Header Row (Icon + Content) ── */    .nt-top-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

/* ── Icon ── */
.nt-icon-wrap {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}
.nt-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, ${accent.primary}, ${accent.secondary || '#8b5cf6'});
  display: flex;
  align-items: center;
  justify-content: center;
}
.nt-icon-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #00c896;
  border: 2px solid var(--cbg);
}
.nt-icon-box svg {
  display: block;
}

/* ── Content area ── */
.nt-content-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Head row ── */
.nt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.nt-head-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ct1);
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nt-head-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ct3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ── Sender ── */
.nt-sender {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ct1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
}

/* ── Subject + Snippet inline ── */
.nt-message-preview {
  font-size: 12.5px;
  color: var(--ct2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
.nt-message-preview .nt-sep {
  color: var(--ct3);
  margin: 0 4px;
}

/* ── Footer ── */
.nt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.nt-badge {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${accent.primary};
  background: ${accent.soft};
  border: 0.5px solid ${accent.border};
  border-radius: 5px;
  padding: 2px 7px;
  line-height: 1;
}
.nt-actions {
  display: flex;
  gap: 6px;
}
.nt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  border-radius: 7px;
  padding: 4px 12px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1;
  border: 0.5px solid transparent;
  transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
.nt-btn:active { transform: scale(0.96); }
.nt-btn-primary {
  color: #fff;
  background: ${accent.primary};
  border-color: transparent;
}
.nt-btn-primary:hover {
  filter: brightness(1.1);
}
.nt-btn-secondary {
  color: var(--ct2);
  background: var(--cbg2);
  border-color: var(--cbd);
}
.nt-btn-secondary:hover {
  color: var(--ct1);
  border-color: rgba(255, 255, 255, 0.15);
}

/* ── Screen-reader only ── */
.nt-sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  border: 0; clip: rect(0 0 0 0);
  overflow: hidden; white-space: nowrap;
}
</style>
</head>
<body>
<section class="nt-card" id="toast" data-testid="notification-popup" data-provider="${escapeHtml(payload.provider)}">
  <div class="nt-top-row">
    <div class="nt-icon-wrap" aria-hidden="true">
      <div class="nt-icon-box">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="4" width="20" height="16" rx="3" fill="white" fill-opacity="0.15" stroke="white" stroke-width="1.5"/>
          <path d="M2 8l10 7 10-7" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="nt-icon-dot"></div>
    </div>

    <div class="nt-content-area">
      <div class="nt-head">
        <span class="nt-head-label">${escapeHtml(senderLine)}</span>
        <span class="nt-head-time">${escapeHtml(popupTime)}</span>
      </div>

      <div class="nt-sender" data-action="open">
        ${escapeHtml(sender.full || sender.label || 'Unknown Sender')}
      </div>

      <div class="nt-message-preview" data-action="open">
        ${escapeHtml(subject || 'New email received')}
        ${snippet ? `<span class="nt-sep">·</span>${escapeHtml(snippet).replace(nlRe, ' ')}` : ''}
      </div>
    </div>
  </div>

  <div class="nt-footer">
    <span class="nt-badge">${escapeHtml(providerTag)}</span>

    <div class="nt-actions">
      ${this.renderActionButton(secondaryAction)}
      ${this.renderActionButton(primaryAction)}
    </div>
  </div>

  <div class="nt-sr-only" aria-hidden="true">
    To: ${escapeHtml(senderLine)}. From: ${escapeHtml(sender.email || sender.full || sender.label || 'Unknown')}. Subject: ${escapeHtml(subject)}.
  </div>
</section>
<script>
(function() {
  const toast = document.getElementById('toast');
  const autoDismiss = ${Math.max(1000, autoDismissMs)};
  let timer = null;

  function dismiss() {
    if (timer) clearTimeout(timer);
    toast.classList.add('dismissing');
    setTimeout(function() {
      try { window.notificationOverlay.onDismiss(); } catch (e) {}
    }, 300);
  }

  function openNotification() {
    try { window.notificationOverlay.onOpen(); } catch (e) {}
  }

  // Auto-dismiss
  timer = setTimeout(dismiss, autoDismiss);

  // Pause on hover
  toast.addEventListener('mouseenter', function() {
    if (timer) { clearTimeout(timer); timer = null; }
  });
  toast.addEventListener('mouseleave', function() {
    if (!timer) {
      timer = setTimeout(dismiss, autoDismiss);
    }
  });

  // Click handling
  document.addEventListener('click', function(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var actionTarget = target.closest('[data-action]');
    if (!actionTarget) return;
    event.preventDefault();
    event.stopPropagation();
    var action = actionTarget.getAttribute('data-action');
    if (action === 'dismiss') dismiss();
    else openNotification();
  });

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  });

  try { window.notificationOverlay.onReady(); } catch (e) {}

  ${!payload.silent && soundData ? `(function() {
    try {
      var audio = new Audio(${JSON.stringify(soundData)});
      audio.volume = 0.4;
      audio.play().catch(function() {});
    } catch (e) {}
  })();` : ''}
})();
</script>
</body>
</html>`
  }

  private renderActionButton(action: NotificationAction): string {
    const toneClass = action.tone === 'primary' ? 'nt-btn-primary' : 'nt-btn-secondary'
    return `<button class="nt-btn ${toneClass}" data-action="${escapeHtml(action.id)}">${escapeHtml(action.title)}</button>`
  }

  private getPreviewText(payload: NotificationPopupState): string {
    const subjectKey = normalizeComparableNotificationText(payload.subject)
    const snippetKey = normalizeComparableNotificationText(payload.snippet)

    if (!snippetKey) return ''
    if (snippetKey === subjectKey || snippetKey.includes(subjectKey) || subjectKey.includes(snippetKey)) {
      return ''
    }

    return sanitizePreviewText(payload.snippet)
  }

  private getPopupHeight(payload: NotificationPopupState): number {
    const hasSnippet = this.getPreviewText(payload).length > 0
    const baseHeight = payload.itemCount > 1 || hasSnippet ? TOAST_HEIGHT_EXPANDED : TOAST_HEIGHT_DEFAULT
    return baseHeight
  }

  private syncPositions(): void {
    this.windows = this.windows.filter(win => !win.isDestroyed())

    for (let index = 0; index < this.windows.length; index += 1) {
      const win = this.windows[index]
      if (win.isDestroyed()) continue

      const bounds = win.getBounds()
      const pos = this.getNotificationBounds(index, bounds.height)
      win.setBounds({ x: pos.x, y: pos.y, width: TOAST_WIDTH, height: bounds.height }, true)
    }
  }

  private getNotificationBounds(index: number, height: number): { x: number; y: number } {
    const workArea = screen.getPrimaryDisplay().workArea
    return {
      x: Math.round(workArea.x + workArea.width - TOAST_WIDTH - TOAST_MARGIN),
      y: Math.round(workArea.y + workArea.height - height - TOAST_MARGIN - index * (height + STACK_GAP))
    }
  }
}

const nlRe = /\n/g

function sanitizeText(value: string): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizePreviewText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n')
}

function normalizeComparableNotificationText(value: string): string {
  return sanitizeText(value)
    .replace(/^re:\s*/i, '')
    .replace(/^fwd:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function parseSender(value: string): { label: string; email: string | null; full: string } {
  const trimmed = sanitizeText(value)
  const mailboxMatch = /^(?:"?([^"<]+?)"?\s*)?<([^>]+)>$/.exec(trimmed)
  if (mailboxMatch) {
    const name = mailboxMatch[1]?.trim() || ''
    const email = mailboxMatch[2].trim()
    return {
      label: name || email || 'Mail',
      email: email || null,
      full: name ? `${name} <${email}>` : email
    }
  }

  const emailMatch = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(trimmed)
  if (emailMatch) {
    const email = emailMatch[1].trim()
    return {
      label: email,
      email,
      full: trimmed || email
    }
  }

  return {
    label: trimmed || 'Mail',
    email: null,
    full: trimmed || 'Mail'
  }
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

interface AccentColors {
  primary: string
  secondary: string
  soft: string
  altSoft: string
  border: string
  core: string
  tagBg: string
  tagText: string
  text: string
}

const ACCENT_MAP: Record<AccentColor, AccentColors> = {
  indigo: { primary: '#a78bfa', secondary: '#7c3aed', soft: 'rgba(167, 139, 250, 0.2)', altSoft: 'rgba(56, 189, 248, 0.2)', border: 'rgba(167, 139, 250, 0.2)', core: '#0ea5e9', tagBg: 'rgba(167, 139, 250, 0.12)', tagText: '#a78bfa', text: '#ede9fe' },
  blue: { primary: '#93c5fd', secondary: '#3b82f6', soft: 'rgba(147, 197, 253, 0.2)', altSoft: 'rgba(56, 189, 248, 0.2)', border: 'rgba(147, 197, 253, 0.2)', core: '#3b82f6', tagBg: 'rgba(147, 197, 253, 0.12)', tagText: '#93c5fd', text: '#ede9fe' },
  cyan: { primary: '#67e8f9', secondary: '#06b6d4', soft: 'rgba(103, 232, 249, 0.2)', altSoft: 'rgba(167, 139, 250, 0.2)', border: 'rgba(103, 232, 249, 0.2)', core: '#06b6d4', tagBg: 'rgba(103, 232, 249, 0.12)', tagText: '#67e8f9', text: '#ede9fe' },
  emerald: { primary: '#6ee7b7', secondary: '#10b981', soft: 'rgba(110, 231, 183, 0.2)', altSoft: 'rgba(56, 189, 248, 0.2)', border: 'rgba(110, 231, 183, 0.2)', core: '#10b981', tagBg: 'rgba(110, 231, 183, 0.12)', tagText: '#6ee7b7', text: '#ede9fe' },
  amber: { primary: '#fcd34d', secondary: '#f59e0b', soft: 'rgba(252, 211, 77, 0.2)', altSoft: 'rgba(249, 115, 22, 0.2)', border: 'rgba(252, 211, 77, 0.2)', core: '#f59e0b', tagBg: 'rgba(252, 211, 77, 0.12)', tagText: '#fcd34d', text: '#fef3c7' },
  red: { primary: '#fca5a5', secondary: '#ef4444', soft: 'rgba(252, 165, 165, 0.2)', altSoft: 'rgba(251, 146, 60, 0.2)', border: 'rgba(252, 165, 165, 0.2)', core: '#ef4444', tagBg: 'rgba(252, 165, 165, 0.12)', tagText: '#fca5a5', text: '#fee2e2' },
  pink: { primary: '#f9a8d4', secondary: '#ec4899', soft: 'rgba(249, 168, 212, 0.2)', altSoft: 'rgba(167, 139, 250, 0.2)', border: 'rgba(249, 168, 212, 0.2)', core: '#ec4899', tagBg: 'rgba(249, 168, 212, 0.12)', tagText: '#f9a8d4', text: '#fce7f3' },
  violet: { primary: '#c4b5fd', secondary: '#8b5cf6', soft: 'rgba(196, 181, 253, 0.2)', altSoft: 'rgba(56, 189, 248, 0.2)', border: 'rgba(196, 181, 253, 0.2)', core: '#8b5cf6', tagBg: 'rgba(196, 181, 253, 0.12)', tagText: '#c4b5fd', text: '#ede9fe' }
}

function getAccentColors(color?: AccentColor): AccentColors {
  return ACCENT_MAP[color || 'indigo']
}

export const notificationWindowManager = new NotificationWindowManager()
