import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { logger } from '../services/logger'
import { windowStateManager } from '../services/window-state'
import { storageService } from '../services/storage'
import { getWindowIcon, getIconPath } from '../services/icon-loader'
import { refreshAttachedSession } from '../ipc/proton-handler'

let crashCount = 0
const MAX_CRASH_RELOADS = 10
const CRASH_RESET_INTERVAL = 60 * 1000 // Reset crash count after 1 minute of stability
let isQuitting = false
let crashResetTimer: ReturnType<typeof setTimeout> | null = null

export function setQuitting(value: boolean): void {
  isQuitting = value
}

export function createMainWindow(): BrowserWindow {
  const savedState = windowStateManager.get()

  // On Windows, passing a direct .ico file PATH string works better for the
  // taskbar icon than a NativeImage. The NativeImage fallback via setIcon()
  // is added below for extra reliability.
  const iconPath = getIconPath()

  const mainWindow = new BrowserWindow({
    ...windowStateManager.getWindowOptions(),
    icon: iconPath || getWindowIcon(),
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable these for better crash resilience on Windows
      backgroundThrottling: true,
      spellcheck: false
    }
  })

  // Mark this window as the main MailBridge window so the Proton handler
  // can locate it reliably (even when other BrowserWindows — one per Proton
  // account — are focused). Each account's Proton window is created with
  // `parent: mainWindow`, keeping it visually embedded but giving it its own
  // webContents, partition and process isolation.
  ;(mainWindow as any).__isMainWindow = true

  // F5 / Ctrl+R while focus is on the app shell should refresh the active
  // Proton session, not reload the app UI.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isRefreshKey =
      input.key === 'F5' ||
      (input.key.toLowerCase() === 'r' && (input.control || input.meta))
    if (!isRefreshKey) return
    // Only take over the key when a Proton view is attached to this window;
    // otherwise keep the default behavior (e.g. dev reload of the app shell).
    if (!mainWindow.getBrowserView()) return
    event.preventDefault()
    refreshAttachedSession()
  })

  // Restore maximized state if it was saved
  if (savedState.isMaximized) {
    mainWindow.maximize()
  }

  // Intercept close to minimize to tray (hide) instead of destroy
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      // Honor the "Minimize to tray" setting: when disabled, closing the
      // window quits the app instead of hiding to the tray.
      let minimizeToTray = true
      try {
        minimizeToTray = storageService.getSettings().minimizeToTray !== false
      } catch {
        // Default to tray behavior if settings can't be read
      }
      if (minimizeToTray) {
        event.preventDefault()
        mainWindow.hide()
        logger.info('Window hidden to tray')
        return
      }
      logger.info('Minimize to tray disabled — quitting on window close')
      app.quit()
    }
  })

  // Broadcast a process-wide "background" event whenever the main window leaves the
  // foreground so service modules (Proton handlers, sync services) can throttle
  // background polling (MutationObservers, mailbox syncs, React render loops)
  // without losing any feature — Proton page-title-updated events still fire for
  // notifications because the BrowserViews themselves remain alive.
  mainWindow.on('hide', () => {
    app.emit('mailbridge:visibility', 'hidden')
  })
  mainWindow.on('minimize', () => {
    app.emit('mailbridge:visibility', 'hidden')
  })
  mainWindow.on('blur', () => {
    // `blur` fires for any focus loss, but we also fire on `restore`/`show`, so
    // receiving a `shown` event after `blur` is idempotent.
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      app.emit('mailbridge:visibility', 'hidden')
    }
  })
  mainWindow.on('show', () => {
    app.emit('mailbridge:visibility', 'visible')
  })
  mainWindow.on('restore', () => {
    app.emit('mailbridge:visibility', 'visible')
  })

  // Track window state changes for persistence
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      const [width, height] = mainWindow.getSize()
      windowStateManager.setBounds(width, height)
      windowStateManager.scheduleSave()
    }
  })

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      const [x, y] = mainWindow.getPosition()
      windowStateManager.setPosition(x, y)
      windowStateManager.scheduleSave()
    }
  })

  mainWindow.on('maximize', () => {
    windowStateManager.setMaximized(true)
    windowStateManager.scheduleSave()
    try {
      mainWindow.webContents.send('window:maximized-changed', true)
    } catch { /* renderer may not be ready */ }
  })

  mainWindow.on('unmaximize', () => {
    windowStateManager.setMaximized(false)
    windowStateManager.scheduleSave()
    try {
      mainWindow.webContents.send('window:maximized-changed', false)
    } catch { /* renderer may not be ready */ }
  })

  // Save state on blur as extra safety
  mainWindow.on('blur', () => {
    windowStateManager.scheduleSave()
  })

  // Crash handling with exponential backoff
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process crashed', { reason: details.reason, crashCount })

    if (crashCount >= MAX_CRASH_RELOADS) {
      logger.warn('Max crash reloads reached, showing error page')
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
        '<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0f0f13;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center;padding:2rem;">' +
        '<div><h1 style="color:#6366f1;font-size:1.5rem;margin-bottom:0.5rem;">MailBridge</h1>' +
        '<p style="color:#a1a1aa;margin-bottom:1rem;">The application has crashed too many times.</p>' +
        '<p style="color:#71717a;font-size:0.875rem;">Please restart the application.</p>' +
        '<button onclick="window.close()" style="margin-top:1rem;padding:8px 20px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;">Close</button></div></body></html>'
      )}`)
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s...
    const backoffMs = Math.min(1000 * Math.pow(2, crashCount), 30000)
    crashCount++

    logger.info('Attempting renderer reload', { backoffMs, attempt: crashCount })

    setTimeout(() => {
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.reload()
        }
      } catch (err) {
        logger.error('Failed to reload after crash', err)
      }
    }, backoffMs)

    // Reset crash count after a period of stability
    if (crashResetTimer) clearTimeout(crashResetTimer)
    crashResetTimer = setTimeout(() => {
      crashCount = 0
      logger.debug('Crash count reset after stable period')
    }, CRASH_RESET_INTERVAL)
  })

  // Handle unresponsive renderer (freeze detection)
  let unresponsiveCount = 0
  mainWindow.webContents.on('unresponsive', () => {
    unresponsiveCount++
    logger.warn('Renderer unresponsive', { count: unresponsiveCount })
    if (unresponsiveCount >= 3) {
      logger.warn('Force-killing unresponsive renderer')
      try {
        mainWindow.webContents.forcefullyCrashRenderer()
      } catch (err) {
        logger.error('Failed to forcefully crash renderer', err)
      }
      unresponsiveCount = 0
    }
  })

  mainWindow.webContents.on('responsive', () => {
    if (unresponsiveCount > 0) {
      logger.info('Renderer responsive again')
      unresponsiveCount = 0
    }
  })

  // External links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('ready-to-show', () => {
    // Set icon RIGHT before showing — ensures Windows taskbar picks up the icon
    // on the first paint. This is critical for the taskbar icon to be correct
    // from the moment the window appears.
    try { mainWindow.setIcon(getWindowIcon()) } catch { /* non-critical */ }
    mainWindow.show()
  })

  // Log loading failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logger.warn('Main window load failed', { errorCode, errorDescription })
  })

  // Set icon immediately after creation (belt-and-suspenders with constructor option)
  try { mainWindow.setIcon(getWindowIcon()) } catch { /* non-critical */ }

  // Set icon again after the window is shown — some Windows configurations
  // need a post-show setIcon call for the taskbar to update properly
  mainWindow.on('show', () => {
    try { mainWindow.setIcon(getWindowIcon()) } catch { /* non-critical */ }
  })

  // Load content
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('Main window created', {
    width: savedState.width,
    height: savedState.height,
    isMaximized: savedState.isMaximized
  })
  return mainWindow
}
