import { app, BrowserWindow, Tray, Menu, crashReporter, powerMonitor } from 'electron'
import { createMainWindow, setQuitting } from './windows/main-window'
import { registerAllHandlers } from './ipc/register'
import { storageService } from './services/storage'
import { syncService } from './services/sync-service'
import { destroyAllProtonSessions } from './ipc/proton-handler'
import { logger } from './services/logger'
import { getTrayIcon, getIconDiagnostics } from './services/icon-loader'
import { windowStateManager } from './services/window-state'

// ── Windows-Specific Resilience Flags ───────────────────────────────────────
// These flags dramatically improve stability on Windows by avoiding GPU-related
// crashes, sandbox conflicts, and rendering pipeline issues.

// Disable GPU acceleration to avoid renderer crashes on Windows
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Windows-specific GPU workarounds for common crash scenarios
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-accelerated-2d-canvas')
app.commandLine.appendSwitch('disable-accelerated-video-decode')
app.commandLine.appendSwitch('use-gl', 'swiftshader') // Software fallback for WebGL
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor') // Avoid DComp crashes

// Memory management for long-running sessions
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024 --expose-gc')
app.commandLine.appendSwitch('memory-pressure-off')

// ── Windows Taskbar Pinning Fix ─────────────────────────────────────────────
// On Windows, app.setAppUserModelId() must be called early so the pinned
// taskbar shortcut's AppUserModelID matches the running process. Without this,
// Windows treats the running instance as a separate app and shows the default
// Electron icon instead of the custom one when the app is pinned.
// The ID must match the appId in electron-builder.yml.
try {
  app.setAppUserModelId('com.mailbridge.app')
  logger.info('AppUserModelID set to com.mailbridge.app')
} catch (err) {
  // Non-Windows platforms don't support this API
}

// Prevent multiple instances — when the window is hidden to tray and the user
// relaunches, this ensures only one process manages all Proton sessions.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Another instance was launched — focus the existing window
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      const win = windows[0]
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createTray(): void {
  // Log icon diagnostics at startup
  try {
  const diag = getIconDiagnostics()
  logger.info('Tray icon resolved', { source: diag.source, path: diag.filePath })

  const trayImage = getTrayIcon()

  tray = new Tray(trayImage)
  tray.setToolTip('MailBridge')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open MailBridge',
      click: () => {
        if (mainWindow) {
          try {
            mainWindow.show()
            mainWindow.focus()
          } catch (err) {
            logger.error('Failed to show window from tray', err)
            // If the window is destroyed, recreate it
            if (!mainWindow || mainWindow.isDestroyed()) {
              mainWindow = createMainWindow()
              registerAllHandlers(mainWindow)
            }
          }
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      try {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      } catch (err) {
        logger.error('Tray click handler error', err)
      }
    }
  })
  } catch (err) {
    logger.error('Failed to create tray', err)
    // Continue without tray — app should still function
  }
}

app.whenReady().then(async () => {
  try {
    // Initialize storage first (async - loads sql.js WASM)
    await storageService.ready()

    // Log whether DB was recovered from backup (indicates prior crash)
    if (storageService.wasRecovered()) {
      logger.warn('Database was recovered from backup — app may have crashed previously')
    }

    mainWindow = createMainWindow()
    await registerAllHandlers(mainWindow)
    createTray()

    // Apply auto-launch setting on startup
    try {
      const settings = storageService.getSettings()
      app.setLoginItemSettings({
        openAtLogin: settings.launchOnStartup
      })
      logger.info('Auto-launch setting applied', { openAtLogin: settings.launchOnStartup })
    } catch (err) {
      logger.warn('Failed to apply auto-launch setting', err)
    }

    // Set up power monitor events for Windows sleep/wake resilience
    setupPowerMonitor()

    // Periodic memory cleanup to prevent memory leaks on long-running sessions
    startMemoryCleanup()

    app.on('activate', () => {
      try {
        const windows = BrowserWindow.getAllWindows()
        if (windows.length === 0) {
          mainWindow = createMainWindow()
          registerAllHandlers(mainWindow)
        } else if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      } catch (err) {
        logger.error('Failed to handle activate event', err)
      }
    })
  } catch (err) {
    logger.error('Failed to initialize application', err)
  }
})

// ── Power Monitor (Windows Sleep/Wake Resilience) ───────────────────────────

function setupPowerMonitor(): void {
  try {
    // When the system wakes from sleep, refresh syncing and window state
    powerMonitor.on('resume', () => {
      logger.info('System resumed from sleep — refreshing services')

      // Force a sync cycle to catch up after sleep
      try {
        syncService.syncAll()
      } catch (err) {
        logger.error('Sync after resume failed', err)
      }

      // Re-create Proton sessions if they were lost during sleep
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('window:resumed-from-sleep')
        } catch { /* renderer may not be ready */ }
      }
    })

    // When the system is about to suspend, flush state
    powerMonitor.on('suspend', () => {
      logger.info('System suspending — flushing state')
      windowStateManager.flush()
      storageService.forceBackup()
    })

    // Handle AC power changes (notifications for battery/power)
    powerMonitor.on('on-ac', () => {
      logger.debug('Power source changed to AC')
    })

    powerMonitor.on('on-battery', () => {
      logger.debug('Power source changed to battery')
    })

    // Shutdown/lock session handling on Windows
    powerMonitor.on('shutdown', (_event: Electron.Event) => {
      logger.info('System shutting down — saving state')
      windowStateManager.flush()
      _event.preventDefault()
    })

    logger.info('Power monitor handlers registered')
  } catch (err) {
    logger.warn('Failed to set up power monitor', err)
  }
}

// ── Memory Cleanup ──────────────────────────────────────────────────────────

let memoryCleanupTimer: ReturnType<typeof setInterval> | null = null

function startMemoryCleanup(): void {
  // Run periodic garbage collection every 5 minutes on Windows
  // to prevent memory bloat in long-running sessions
  memoryCleanupTimer = setInterval(() => {
    try {
      // Suggest V8 garbage collection (requires --expose-gc flag)
      if (global.gc && typeof global.gc === 'function') {
        global.gc()
      }

      // Log memory usage for diagnostics
      const usage = process.memoryUsage()
      logger.debug('Memory usage', {
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(usage.rss / 1024 / 1024) + 'MB'
      })

      // If heap usage exceeds 800MB, log a warning
      if (usage.heapUsed > 800 * 1024 * 1024) {
        logger.warn('High memory usage detected', {
          heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB'
        })
      }
    } catch (err) {
      // Memory monitoring is best-effort
    }
  }, 5 * 60 * 1000)
}

// Override the window close to minimize to tray instead of quitting
app.on('before-quit', () => {
  isQuitting = true
  setQuitting(true)
})

app.on('will-quit', () => {
  // Flush window state to disk before quitting
  try { windowStateManager.flush() } catch { /* ignore */ }

  syncService.stop()
  destroyAllProtonSessions()
  if (storageService) {
    try {
      storageService.forceBackup()
      storageService.destroy()
    } catch (err) {
      logger.error('Error during storage shutdown', err)
    }
  }
  logger.info('Application shutting down')
})

// Handle window close - minimize to tray instead of closing
app.on('window-all-closed', () => {
  // Don't quit on window close - keep running in tray for notifications
  // Only quit if explicitly requested
  if (isQuitting) {
    app.quit()
  }
  // Otherwise, the window just hides and app keeps running
})

// Prevent app from quitting when all windows are closed
app.on('will-finish-launching', () => {
  // Keep the app running
})

// ── Global Error Handlers ───────────────────────────────────────────────────

// Catch uncaught exceptions in the main process
process.on('uncaughtException', (error) => {
  try {
    logger.error('Uncaught main process exception', {
      message: error.message,
      stack: error.stack?.substring(0, 500),
      name: error.name
    })

    // Flush critical state before potentially crashing
    try { windowStateManager.flush() } catch { /* ignore */ }
    try { if (storageService) storageService.forceBackup() } catch { /* ignore */ }
  } catch {
    // Last resort — write critical error info to console
    console.error('FATAL: Uncaught exception', error.message)
    console.error(error.stack?.substring(0, 500))
  }
})

// Catch unhandled promise rejections in the main process
process.on('unhandledRejection', (reason) => {
  try {
    logger.warn('Unhandled promise rejection', {
      reason: String(reason),
      stack: (reason as Error)?.stack?.substring(0, 300)
    })
  } catch {
    console.warn('Unhandled rejection:', String(reason))
  }
})

// Handle 'error' events on the process that aren't otherwise caught
process.on('warning', (warning) => {
  // Only log warnings that matter — ignore Electron internal noise
  if (warning.name === 'DeprecationWarning') return
  if (warning.message?.includes('electron')) return
  try {
    logger.debug('Process warning', {
      name: warning.name,
      message: warning.message?.substring(0, 200),
      stack: warning.stack?.substring(0, 200)
    })
  } catch { /* ignore */ }
})
