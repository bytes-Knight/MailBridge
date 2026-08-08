import { app, BrowserWindow, Tray, Menu, crashReporter, powerMonitor } from 'electron'
import { createMainWindow, setQuitting } from './windows/main-window'
import { registerAllHandlers } from './ipc/register'
import { storageService } from './services/storage'
import { syncService } from './services/sync-service'
import { destroyAllProtonSessions, evictIdleProtonSession } from './ipc/proton-handler'
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

// Windows-specific GPU workarounds for common crash scenarios.
// We keep the renderer on the CPU (no GPU process spawn) and explicitly disable WebGL
// so Chromium doesn't fall back to the memory-hungry SwiftShader software renderer
// (which can add 200-400 MB to every Proton BrowserView's renderer process).
// NOTE: only `VizDisplayCompositor` is disabled — keep Chromium's window-occlusion
// detection so it can throttle hidden BrowserViews and reduce idle RAM.
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-accelerated-2d-canvas')
app.commandLine.appendSwitch('disable-accelerated-video-decode')
// Disable Chromium's site-isolation trials + per-frame site isolation as well —
// these features spawn extra processes per origin and routinely account for
// 50-100MB of idle overhead per renderer. Expensive side-channel protection
// that we don't need inside a desktop single-purpose wrapper.
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor,IsolateOrigins,site-per-process')

// Hard V8 memory budget. Combined with the per-process MemoryWatchdog below
// (which destroys idle Proton BrowserViews when total Electron RAM exceeds
// the 500MB target), this keeps the worst-case footprint bounded.
// --expose-gc            : manual `global.gc()` from main process on idle ticks
// --max-old-space-size=N : hard V8 old-space cap. 384MB keeps notification
//                          batching + sql.js serving hot, while capping the
//                          main process's heap contribution to ~25% of the
//                          total 500MB budget. The remaining ~120MB is for
//                          the renderer + 1 active Proton BrowserView.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --expose-gc')
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

    // Log icon diagnostics at startup so user can see which icon was resolved
    const iconDiag = getIconDiagnostics()
    console.log('=== MAILBRIDGE ICON DIAGNOSTICS ===')
    console.log('  Source:', iconDiag.source)
    console.log('  Path:', iconDiag.filePath)
    console.log('  Window image empty:', iconDiag.windowImageEmpty)
    console.log('  Window image size:', iconDiag.windowImageSize)
    console.log('  __dirname:', iconDiag.__dirname)
    console.log('  appPath:', iconDiag.appPath)
    console.log('  cwd:', iconDiag.cwd)
    console.log('====================================')

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
    // v2.28.0: total-Electron-RAM watchdog that evicts idle Proton sessions
    // when the aggregate resident-set exceeds the 500MB target.
    startMemoryWatchdog()
    startAutoCleanTimer()

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

let autoCleanTimer: ReturnType<typeof setInterval> | null = null
let lastAutoCleanAt = 0

function startAutoCleanTimer(): void {
  // Check periodically; only actually clears the cache when the "Auto-clean"
  // setting is enabled and the configured interval has elapsed.
  autoCleanTimer = setInterval(() => {
    try {
      const settings = storageService.getSettings()
      if (!settings.autoClean) return
      const intervalH = Math.max(settings.cacheCleanInterval || 24, 1)
      const elapsedH = (Date.now() - lastAutoCleanAt) / (60 * 60 * 1000)
      if (elapsedH >= intervalH) {
        lastAutoCleanAt = Date.now()
        storageService.clearCache()
        logger.debug('Auto-clean: cleared email cache', { intervalHours: intervalH })
      }
    } catch {
      // Auto-clean is best-effort
    }
  }, 5 * 60 * 1000)
}

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
  // Run periodic garbage collection every 2 minutes on Windows to keep the
  // idle-process footprint low. The V8 flag `--expose-gc` is set above, so
  // `global.gc()` is available. 2 minutes is the sweet spot:
  //   - frequent enough that the heap doesn't plateau between user actions
  //   - sparse enough that a major GC pass (stop-the-world) doesn't visibly
  //     stall WASM loads, notification flushes, or sync cycles.
  memoryCleanupTimer = setInterval(() => {
    try {
      // Force a major GC pass so unused heap pages can be returned to the OS
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

      if (usage.heapUsed > 384 * 1024 * 1024) {
        logger.warn('Main process heap approaching the 384MB cap', {
          heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB'
        })
      }
    } catch (err) {
      // Memory monitoring is best-effort
    }
  }, 60 * 1000) // 1 minute — tighter cadence so we react quickly if a ramp develops
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

// ── Memory Watchdog ─────────────────────────────────────────────────────────
// v2.28.0: Total-Electron RAM watchdog. Polls `app.getAppMetrics()` every
// 30 seconds. If the aggregate resident-set across every Electron process
// (main + renderer + each Proton BrowserView + GPU + utility) exceeds the
// 500MB target, we trigger a V8 major GC and proactively destroy idle
// Proton sessions (those whose BrowserView is currently detached from the
// main window) until we are back under budget.
//
// This is the *enforcement* layer behind the per-process V8 cap, the
// single-active-BrowserView rule in PROTON_SHOW_SESSION, and the disabled
// logo preloader. Each measure trims tens of MB; the watchdog catches the
// case where the user opens multiple accounts in quick succession or where
// syncs/notification bursts temporarily spike RSS above the cap.

let memoryWatchdogTimer: ReturnType<typeof setInterval> | null = null

// Total-RAM target. Exposed at module scope so unit-test stubs can override it.
const RAM_BUDGET_MB = 500
const RAM_WATCHDOG_INTERVAL_MS = 30 * 1000
const RAM_RECOVERY_HEADROOM_MB = 50 // Aim to land ~50MB under the cap after a cleanup pass.

function startMemoryWatchdog(): void {
  if (memoryWatchdogTimer) return
  memoryWatchdogTimer = setInterval(() => {
    try {
      // Aggregate resident set across every process Electron tracks.
      const metrics = (app as unknown as { getAppMetrics?: () => Array<{ memory: { residentSetSize: number } }> }).getAppMetrics?.()
      if (!metrics || metrics.length === 0) return
      // Declared `let` so the eviction loop below can re-sample after each
      // destroyed-session cycle and feed a fresh value into the loop condition.
      let totalRssMb = metrics.reduce((sum, m) => sum + (m.memory?.residentSetSize ?? 0), 0) / 1024

      if (totalRssMb <= RAM_BUDGET_MB) return // happy path

      logger.warn('Total Electron RAM above budget — triggering recovery', {
        totalRssMb: Math.round(totalRssMb),
        capMb: RAM_BUDGET_MB,
        processCount: metrics.length
      })

      // Block A: full V8 major GC across the main process. Other V8 instances
      // (renderer, BrowserViews) react to their own memory-pressure events.
      try { global.gc?.() } catch { /* ignore */ }

      // Block B: destroy idle Proton sessions until we land safely below the cap
      // OR there are no idle sessions left to evict. We bound the loop so a
      // pathological spike can't stall the timer callback.
      let destroyed = 0
      for (let pass = 0; pass < 3 && totalRssMb > RAM_BUDGET_MB - RAM_RECOVERY_HEADROOM_MB; pass++) {
        try {
          const proton = require('./ipc/proton-handler') as typeof import('./ipc/proton-handler')
          const evicted = proton.evictIdleProtonSession?.()
          if (!evicted) break // nothing idle to evict
          destroyed++
          // Re-sample after eviction so the loop condition sees the fresh RSS.
          const refreshed = (app as unknown as { getAppMetrics?: () => Array<{ memory: { residentSetSize: number } }> }).getAppMetrics?.()
          if (!refreshed) break
          const freshRssMb = refreshed.reduce((sum, m) => sum + (m.memory?.residentSetSize ?? 0), 0) / 1024
          totalRssMb = freshRssMb
        } catch (err) {
          logger.warn('Memory watchdog eviction pass failed', { error: String(err) })
          break
        }
      }

      try { global.gc?.() } catch { /* ignore */ }

      if (destroyed > 0) {
        logger.info('Memory watchdog evicted idle Proton sessions', {
          destroyed,
          totalRssMb: Math.round(totalRssMb)
        })
      } else if (totalRssMb > RAM_BUDGET_MB) {
        // Cap cannot be enforced because the *active* Proton BrowserView
        // alone exceeds the budget. Surface this explicitly so the limit
        // breach is visible in diagnostics instead of silently passing.
        logger.warn('Memory watchdog cannot enforce 500MB cap — active session alone exceeds the budget', {
          totalRssMb: Math.round(totalRssMb),
          capMb: RAM_BUDGET_MB
        })
      }
    } catch (err) {
      // Watchdog is best-effort — never propagate.
    }
  }, RAM_WATCHDOG_INTERVAL_MS)
}



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
