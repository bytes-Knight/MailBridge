import { BrowserWindow, app, ipcMain, screen } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { NotificationAction, NotificationPopupState } from '@shared/types'
import { getWindowIcon } from './icon-loader'
import * as fs from 'fs'
import * as path from 'path'

const TOAST_WIDTH = 458
const TOAST_HEIGHT_DEFAULT = 208
const TOAST_HEIGHT_EXPANDED = 242
const TOAST_MARGIN = 18
const STACK_GAP = 14

export class NotificationWindowManager {
  private windows: BrowserWindow[] = []
  private mainWindow: BrowserWindow | null = null
  private loadedSoundData: string | null = null

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
    const preloadPath = path.join(__dirname, 'notification-preload.js')
    const win = new BrowserWindow({
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
        preload: preloadPath
      }
    })

    win.setVisibleOnAllWorkspaces(true)
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.buildHtml(payload, soundData, autoDismissMs))}`)

    win.once('ready-to-show', () => {
      win.show()
    })

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

    ipcMain.once('notification-overlay-open', handleOpen)
    ipcMain.once('notification-overlay-dismiss', handleDismiss)

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

  private buildHtml(payload: NotificationPopupState, soundData: string | null, autoDismissMs: number): string {
    const sender = parseSender(payload.sender)
    const providerTag = payload.provider === 'proton' ? 'proton' : 'mail'
    const senderLine = sanitizeText(payload.footer || sender.email || sender.label || 'Proton Mail')
    const subject = sanitizeText(payload.subject || '(No subject)')
    const snippet = this.getPreviewText(payload)
    const groupedTag = payload.itemCount > 1 ? `${payload.itemCount} total` : ''
    const popupTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())
    const ringGlyph = getSenderDomainGlyph(sender.email || sender.label, providerTag.charAt(0) || 'm')
    const primaryAction = payload.actions[0] || { id: 'open', title: 'Open Proton Mail', tone: 'primary' as const }
    const secondaryAction = payload.actions[1] || { id: 'dismiss', title: 'Dismiss', tone: 'default' as const }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: #ede9fe;
  user-select: none;
  font-family: 'Segoe UI', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.nt-card {
  position: absolute;
  inset: 0;
  padding: 12px 14px 14px;
  animation: ntSlideIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.nt-card.dismissing {
  animation: ntSlideOut 0.35s cubic-bezier(0.55, 0, 1, 0.45) forwards;
}
@keyframes ntSlideIn {
  from { opacity: 0; transform: translateX(-24px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes ntSlideOut {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(24px); }
}
.nt-shell {
  width: 100%;
  height: 100%;
  background: #0a0a14;
  border: 1px solid rgba(99, 102, 241, 0.25);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42), inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  clip-path: polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
  padding: 14px 16px;
  display: flex;
  gap: 14px;
  align-items: stretch;
  overflow: hidden;
}
.nt-ring-wrap {
  flex-shrink: 0;
  width: 52px;
  height: 52px;
  align-self: flex-start;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nt-ring {
  position: absolute;
  border-radius: 999px;
  pointer-events: none;
}
.nt-ring-outer {
  inset: 0;
  border: 1.5px solid transparent;
  border-top-color: #a78bfa;
  border-right-color: rgba(167, 139, 250, 0.25);
  animation: nt-spin 3s linear infinite;
}
.nt-ring-inner {
  inset: 5px;
  border: 1px solid transparent;
  border-bottom-color: #38bdf8;
  border-left-color: rgba(56, 189, 248, 0.25);
  animation: nt-spin 2s linear infinite reverse;
}
.nt-core {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: #0ea5e9;
  color: #ffffff;
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  position: relative;
  z-index: 1;
  overflow: hidden;
}
.nt-core-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.nt-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.nt-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.nt-app {
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #a78bfa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nt-time {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
}
.nt-surface {
  cursor: pointer;
}
.nt-subject {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: #ede9fe;
}
.nt-preview {
  margin: 6px 0 0;
  padding-left: 10px;
  border-left: 2px solid rgba(167, 139, 250, 0.25);
  font-size: 12px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.72);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.nt-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
  padding-top: 8px;
}
.nt-tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 3px 8px;
  clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
}
.nt-tag-provider {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
}
.nt-tag-group {
  background: rgba(167, 139, 250, 0.15);
  color: #c4b5fd;
}
.nt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}
.nt-btn {
  flex: 1;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid transparent;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.nt-btn-primary {
  background: #7c3aed;
  color: #ffffff;
}
.nt-btn-default {
  border-color: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.82);
}
.nt-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, #8b5cf6, #7c3aed);
  border-radius: 0 0 0 3px;
  transition: width 0.05s linear;
}
.nt-compat-details {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  overflow: hidden;
  white-space: nowrap;
}
@keyframes nt-spin {
  to { transform: rotate(360deg); }
}
</style>
</head>
<body>
<section class="nt-card" id="toast" data-testid="notification-popup" data-provider="${escapeHtml(payload.provider)}">
  <div class="nt-shell">
    <div class="nt-ring-wrap" aria-hidden="true">
      <span class="nt-ring nt-ring-outer"></span>
      <span class="nt-ring nt-ring-inner"></span>
      <span class="nt-core" data-has-image="false" data-image-error="false">
        <span class="nt-core-fallback">${escapeHtml(ringGlyph)}</span>
      </span>
    </div>
    <div class="nt-body">
      <div class="nt-head-row">
        <span class="nt-app">${escapeHtml(senderLine)}</span>
        <span class="nt-time">${escapeHtml(popupTime)}</span>
      </div>
      <div class="nt-surface" data-action="open" id="surfaceBtn">
        <h1 class="nt-subject">${escapeHtml(subject)}</h1>
        ${snippet ? `<p class="nt-preview">${escapeHtml(snippet)}</p>` : ''}
      </div>
      <div class="nt-tags">
        <span class="nt-tag nt-tag-provider">${escapeHtml(providerTag)}</span>
        ${groupedTag ? `<span class="nt-tag nt-tag-group">${escapeHtml(groupedTag)}</span>` : ''}
      </div>
      <div class="nt-actions">
        ${this.renderActionButton(primaryAction)}
        ${this.renderActionButton(secondaryAction)}
      </div>
      <div class="nt-compat-details" aria-hidden="true">
        <p>From: ${escapeHtml(sender.email || sender.full || sender.label || 'Unknown')}</p>
        <p>Subject: ${escapeHtml(subject)}</p>
      </div>
    </div>
  </div>
  <div class="nt-progress" id="progress" style="width:100%"></div>
</section>
<script>
(function() {
  const toast = document.getElementById('toast');
  const progress = document.getElementById('progress');
  const duration = ${Math.max(1000, autoDismissMs)};
  let startedAt = Date.now();
  let pausedAt = 0;
  let pausedTotal = 0;
  let animFrame = null;
  let paused = false;

  function updateProgress() {
    if (paused) {
      animFrame = requestAnimationFrame(updateProgress);
      return;
    }
    const elapsed = Date.now() - startedAt - pausedTotal;
    const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
    progress.style.width = remaining + '%';
    if (remaining <= 0) {
      dismiss();
      return;
    }
    animFrame = requestAnimationFrame(updateProgress);
  }

  function dismiss() {
    if (animFrame) cancelAnimationFrame(animFrame);
    toast.classList.add('dismissing');
    setTimeout(function() {
      try { window.notificationOverlay.onDismiss(); } catch (error) {}
    }, 350);
  }

  function openNotification() {
    try { window.notificationOverlay.onOpen(); } catch (error) {}
  }

  toast.addEventListener('mouseenter', function() {
    if (!paused) {
      paused = true;
      pausedAt = Date.now();
    }
  });

  toast.addEventListener('mouseleave', function() {
    if (paused) {
      paused = false;
      pausedTotal += Date.now() - pausedAt;
      pausedAt = 0;
    }
  });

  document.addEventListener('click', function(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionTarget = target.closest('[data-action]');
    if (!actionTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const action = actionTarget.getAttribute('data-action');
    if (action === 'dismiss') dismiss();
    else openNotification();
  });

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  });

  animFrame = requestAnimationFrame(updateProgress);
  try { window.notificationOverlay.onReady(); } catch (error) {}

  ${!payload.silent && soundData ? `(function playSound() {
    try {
      var audio = new Audio(${JSON.stringify(soundData)});
      audio.preload = 'auto';
      audio.volume = 0.5;
      audio.play().catch(function() {});
    } catch (error) {}
  })();` : ''}
})();
</script>
</body>
</html>`
  }

  private renderActionButton(action: NotificationAction): string {
    const toneClass = action.tone === 'primary' ? 'nt-btn-primary' : 'nt-btn-default'
    return `<button class="nt-btn ${toneClass}" data-action="${escapeHtml(action.id)}">${escapeHtml(action.title)}</button>`
  }

  private getPreviewText(payload: NotificationPopupState): string {
    const subjectKey = normalizeComparableNotificationText(payload.subject)
    const snippetKey = normalizeComparableNotificationText(payload.snippet)

    if (!snippetKey) return ''
    if (snippetKey === subjectKey || snippetKey.includes(subjectKey) || subjectKey.includes(snippetKey)) {
      return ''
    }

    return sanitizeText(payload.snippet)
  }

  private getPopupHeight(payload: NotificationPopupState): number {
    return payload.itemCount > 1 || payload.actions.length > 1 ? TOAST_HEIGHT_EXPANDED : TOAST_HEIGHT_DEFAULT
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

function sanitizeText(value: string): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

function getSenderDomainGlyph(emailOrLabel: string | null, fallback = 'm'): string {
  const value = sanitizeText(emailOrLabel || '')
  const domainMatch = /@([a-z0-9.-]+)/i.exec(value)
  if (domainMatch) {
    const domain = domainMatch[1].replace(/^[^a-z0-9]+/i, '')
    const letter = domain.charAt(0)
    if (letter) return letter.toLowerCase()
  }

  const alnum = value.replace(/[^a-z0-9]/gi, '').charAt(0)
  return alnum ? alnum.toLowerCase() : fallback.toLowerCase()
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export const notificationWindowManager = new NotificationWindowManager()
