import { BrowserWindow, app, ipcMain, screen } from 'electron'
import { IpcChannels } from '@shared/ipc'
import type { AccentColor, NotificationAction, NotificationPopupState, NotificationPreview } from '@shared/types'
import { getWindowIcon } from './icon-loader'
import { logger } from './logger'
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

    // Override action labels: make the primary button say 'Open Email' or 'Open Proton Mail'
    const openLabel = payload.provider === 'proton' ? 'Open Proton Mail' : 'Open Email'
    primaryAction.title = openLabel

    const accent = getAccentColors(payload.accentColor)

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
  color: var(--nt-text);
  user-select: none;
  font-family: 'Segoe UI', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
:root {
  --nt-glass: linear-gradient(135deg, rgba(8, 8, 20, 0.92), rgba(12, 12, 30, 0.95));
  --nt-border: ${accent.border};
  --nt-text: #ede9fe;
  --nt-muted: rgba(255, 255, 255, 0.3);
  --nt-accent: ${accent.primary};
  --nt-accent-soft: ${accent.soft};
  --nt-accent-alt: ${accent.secondary};
  --nt-primary-bg: ${accent.primary};
  --nt-primary-text: #ffffff;
  --nt-progress-start: ${accent.primary};
  --nt-progress-end: ${accent.secondary};
  --nt-btn-glow: ${accent.soft};
}
.nt-card {
  position: absolute;
  inset: 0;
  padding: 12px 14px 14px;
  overflow: hidden;
  border-radius: 18px;
  animation: ntSlideIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.nt-card.dismissing {
  animation: ntSlideOut 0.4s cubic-bezier(0.55, 0, 1, 0.45) forwards;
}
@keyframes ntSlideIn {
  0% { opacity: 0; transform: translateX(60px) scale(0.92); filter: blur(4px); }
  100% { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
}
@keyframes ntSlideOut {
  0% { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
  100% { opacity: 0; transform: translateX(40px) scale(0.95); filter: blur(4px); }
}
.nt-glow-border {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: conic-gradient(
    from 0deg,
    transparent,
    ${accent.soft},
    rgba(56, 189, 248, 0.06),
    ${accent.soft},
    transparent
  );
  animation: ntGlowSpin 8s linear infinite;
  pointer-events: none;
  z-index: 0;
}
@keyframes ntGlowSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.nt-scanlines {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    0deg, transparent, transparent 2px,
    rgba(255, 255, 255, 0.015) 2px, rgba(255, 255, 255, 0.015) 4px
  );
  mask-image: radial-gradient(ellipse at 50% 50%, black 30%, transparent 70%);
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, black 30%, transparent 70%);
}
.nt-shell {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  background: var(--nt-glass);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid var(--nt-border);
  border-radius: 18px;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.03) inset,
    0 0 40px ${accent.soft};
  padding: 14px 16px;
  display: flex;
  gap: 14px;
  align-items: flex-start;
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
  border-top-color: var(--nt-accent);
  border-right-color: var(--nt-accent-soft);
  border-bottom-color: rgba(56, 189, 248, 0.3);
  border-left-color: var(--nt-accent-soft);
  animation: nt-spin 4s linear infinite;
  box-shadow: 0 0 8px ${accent.soft};
}
.nt-ring-inner {
  inset: 6px;
  border: 1px solid transparent;
  border-bottom-color: var(--nt-accent-alt);
  border-left-color: ${accent.altSoft};
  border-top-color: var(--nt-accent-soft);
  animation: nt-spin 2.5s linear infinite reverse;
  box-shadow: 0 0 6px ${accent.altSoft};
}
/* Orbiting particles */
.nt-particle {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  pointer-events: none;
}
.nt-particle.p1 {
  background: ${accent.primary};
  top: -2px;
  left: 50%;
  margin-left: -2px;
  animation: ntParticleOrbit 3s ease-in-out infinite;
  box-shadow: 0 0 6px ${accent.primary}66;
}
.nt-particle.p2 {
  background: ${accent.secondary || '#38bdf8'};
  bottom: 2px;
  right: 2px;
  animation: ntParticleOrbit 3s ease-in-out infinite 1s;
  box-shadow: 0 0 6px ${accent.secondary || 'rgba(56, 189, 248, 0.6)'};
}
.nt-particle.p3 {
  background: #c084fc;
  bottom: 2px;
  left: 2px;
  animation: ntParticleOrbit 3s ease-in-out infinite 2s;
  box-shadow: 0 0 6px rgba(192, 132, 252, 0.6);
}
@keyframes ntParticleOrbit {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(0.5); }
}
.nt-core {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: linear-gradient(135deg, ${accent.soft}, rgba(56, 189, 248, 0.15));
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
  overflow: hidden;
  box-shadow: 0 0 12px ${accent.soft};
}
.nt-core-image {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: contain;
  padding: 4px;
  background: transparent;
  display: block;
}
.nt-core-fallback {
  display: none;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #c4b5fd;
}
.nt-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nt-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.nt-recipient {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: linear-gradient(135deg, ${accent.primary}, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nt-recipient-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: ${accent.primary};
  box-shadow: 0 0 6px ${accent.primary}99;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
  animation: ntDotPulse 2s ease-in-out infinite;
}
@keyframes ntDotPulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px ${accent.primary}99; }
  50% { opacity: 0.5; box-shadow: 0 0 10px ${accent.primary}4D; }
}
.nt-time {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.nt-content {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
  transition: background 150ms ease;
  border-radius: 8px;
  margin: 0 -4px;
  padding: 2px 4px;
}
.nt-content:hover {
  background: ${accent.soft};
}
.nt-sender-name {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: #ede9fe;
  letter-spacing: -0.01em;
}
.nt-sender-email {
  font-size: 10px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.3);
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.nt-subject {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.75);
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nt-preview-line {
  font-size: 11px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nt-bottom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.nt-meta-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-shrink: 0;
}
.nt-tag {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1;
  white-space: nowrap;
}
.nt-tag-pulse {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  animation: ntDotPulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
.nt-tag-provider {
  background: ${accent.tagBg};
  color: ${accent.tagText};
  box-shadow: 0 0 8px ${accent.tagBg};
}
.nt-tag-provider .nt-tag-pulse {
  background: ${accent.tagText};
  box-shadow: 0 0 6px ${accent.tagText}80;
}
.nt-tag-meta {
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.35);
  padding: 3px 6px;
}
.nt-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.nt-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid transparent;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1), filter 150ms ease, background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.nt-btn:hover { transform: translateY(-1px) scale(1.02); filter: brightness(1.08); }
.nt-btn:active { transform: translateY(0) scale(0.97); }
.nt-btn-primary {
  background: linear-gradient(135deg, ${accent.primary}, ${accent.secondary || 'rgba(109, 40, 217, 1)'});
  color: var(--nt-primary-text);
  border-color: transparent;
  box-shadow: 0 2px 12px ${accent.soft};
}
.nt-btn-primary:hover {
  box-shadow: 0 4px 20px ${accent.soft};
}
.nt-btn-default {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.55);
}
.nt-btn-default:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.8);
}
.nt-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, ${accent.primary}, ${accent.secondary || 'rgba(124, 58, 237, 1)'}, ${accent.altSoft ? '#38bdf8' : '#38bdf8'});
  border-radius: 0 0 18px 18px;
  transition: width 0.05s linear;
  z-index: 2;
  overflow: hidden;
}
.nt-progress-glow {
  position: absolute;
  right: 0;
  top: -6px;
  width: 20px;
  height: 15px;
  background: radial-gradient(ellipse, ${accent.soft}, transparent);
  pointer-events: none;
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
  <div class="nt-glow-border" aria-hidden="true"></div>
  <div class="nt-scanlines" aria-hidden="true"></div>
  <div class="nt-shell" style="position:relative;z-index:1;">
    <div class="nt-ring-wrap" aria-hidden="true">
      <span class="nt-ring nt-ring-outer"></span>
      <span class="nt-ring nt-ring-inner"></span>
      <span class="nt-particle p1"></span>
      <span class="nt-particle p2"></span>
      <span class="nt-particle p3"></span>
      <span class="nt-core nt-core-icon-only">
        <img class="nt-core-image" src="${escapeHtml(payload.appIconUrl || '')}" alt="MailBridge" />
        <span class="nt-core-fallback">${escapeHtml(sender.label?.charAt(0)?.toUpperCase() || 'M')}</span>
      </span>
    </div>
    <div class="nt-body">
      <div class="nt-head-row">
        <span class="nt-recipient">
          <span class="nt-recipient-dot"></span>
          ${escapeHtml(senderLine)}
        </span>
        <span class="nt-time">${escapeHtml(popupTime)}</span>
      </div>
      <div class="nt-content" data-action="open" id="surfaceBtn">
        <div class="nt-sender-name">${escapeHtml(sender.full || sender.label || 'Unknown Sender')}</div>
        ${sender.email && sender.label ? `<div class="nt-sender-email">${escapeHtml(sender.email)}</div>` : ''}
        <h1 class="nt-subject">${escapeHtml(subject || 'New email received')}</h1>
        ${snippet ? `<p class="nt-preview-line">${escapeHtml(snippet)}</p>` : ''}
      </div>
      <div class="nt-bottom-row">
        <div class="nt-meta-left">
          <span class="nt-tag nt-tag-provider">
            <span class="nt-tag-pulse"></span>
            ${escapeHtml(providerTag)}
          </span>
        </div>
        <div class="nt-actions">
          ${this.renderActionButton(secondaryAction)}
          ${this.renderActionButton(primaryAction)}
        </div>
      </div>
      <div class="nt-compat-details" aria-hidden="true">
        <p>To: ${escapeHtml(senderLine)}</p>
        <p>From: ${escapeHtml(sender.email || sender.full || sender.label || 'Unknown')}</p>
        <p>Subject: ${escapeHtml(subject)}</p>
      </div>
    </div>
  </div>
  <div class="nt-progress" id="progress" style="width:100%">
    <div class="nt-progress-glow"></div>
  </div>
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

  // Handle logo image load errors — show fallback glyph
  var core = document.querySelector('.nt-core');
  var coreImage = document.querySelector('.nt-core-image');
  if (core && coreImage) {
    coreImage.addEventListener('load', function() {
      core.setAttribute('data-image-error', 'false');
    });
    coreImage.addEventListener('error', function() {
      core.setAttribute('data-image-error', 'true');
    });
    if (coreImage.complete) {
      core.setAttribute('data-image-error', coreImage.naturalWidth === 0 ? 'true' : 'false');
    }
  }

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
}

const ACCENT_MAP: Record<AccentColor, AccentColors> = {
  indigo: { primary: '#a78bfa', secondary: '#38bdf8', soft: 'rgba(167, 139, 250, 0.25)', altSoft: 'rgba(56, 189, 248, 0.25)', border: 'rgba(99, 102, 241, 0.25)', core: '#0ea5e9', tagBg: 'rgba(56, 189, 248, 0.15)', tagText: '#38bdf8' },
  blue: { primary: '#93c5fd', secondary: '#38bdf8', soft: 'rgba(147, 197, 253, 0.25)', altSoft: 'rgba(56, 189, 248, 0.25)', border: 'rgba(59, 130, 246, 0.25)', core: '#3b82f6', tagBg: 'rgba(56, 189, 248, 0.15)', tagText: '#38bdf8' },
  cyan: { primary: '#67e8f9', secondary: '#a78bfa', soft: 'rgba(103, 232, 249, 0.25)', altSoft: 'rgba(167, 139, 250, 0.25)', border: 'rgba(6, 182, 212, 0.25)', core: '#06b6d4', tagBg: 'rgba(103, 232, 249, 0.15)', tagText: '#67e8f9' },
  emerald: { primary: '#6ee7b7', secondary: '#38bdf8', soft: 'rgba(110, 231, 183, 0.25)', altSoft: 'rgba(56, 189, 248, 0.25)', border: 'rgba(16, 185, 129, 0.25)', core: '#10b981', tagBg: 'rgba(110, 231, 183, 0.15)', tagText: '#6ee7b7' },
  amber: { primary: '#fcd34d', secondary: '#f97316', soft: 'rgba(252, 211, 77, 0.25)', altSoft: 'rgba(249, 115, 22, 0.25)', border: 'rgba(245, 158, 11, 0.25)', core: '#f59e0b', tagBg: 'rgba(252, 211, 77, 0.15)', tagText: '#fcd34d' },
  red: { primary: '#fca5a5', secondary: '#fb923c', soft: 'rgba(252, 165, 165, 0.25)', altSoft: 'rgba(251, 146, 60, 0.25)', border: 'rgba(239, 68, 68, 0.25)', core: '#ef4444', tagBg: 'rgba(252, 165, 165, 0.15)', tagText: '#fca5a5' },
  pink: { primary: '#f9a8d4', secondary: '#a78bfa', soft: 'rgba(249, 168, 212, 0.25)', altSoft: 'rgba(167, 139, 250, 0.25)', border: 'rgba(236, 72, 153, 0.25)', core: '#ec4899', tagBg: 'rgba(249, 168, 212, 0.15)', tagText: '#f9a8d4' },
  violet: { primary: '#c4b5fd', secondary: '#38bdf8', soft: 'rgba(196, 181, 253, 0.25)', altSoft: 'rgba(56, 189, 248, 0.25)', border: 'rgba(139, 92, 246, 0.25)', core: '#8b5cf6', tagBg: 'rgba(196, 181, 253, 0.15)', tagText: '#c4b5fd' }
}

function getAccentColors(color?: AccentColor): AccentColors {
  return ACCENT_MAP[color || 'indigo']
}

export const notificationWindowManager = new NotificationWindowManager()
