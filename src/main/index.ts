import { app, BrowserWindow, Tray, Menu } from 'electron'
import { createMainWindow } from './windows/main-window'
import { registerAllHandlers } from './ipc/register'
import { storageService } from './services/storage'
import { syncService } from './services/sync-service'
import { destroyAllProtonSessions } from './ipc/proton-handler'
import { logger } from './services/logger'
import { getTrayIcon, getIconDiagnostics } from './services/icon-loader'

// Disable GPU acceleration to avoid renderer crashes on Windows
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createTray(): void {
  // Log icon diagnostics at startup
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
          mainWindow.show()
          mainWindow.focus()
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
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

app.whenReady().then(async () => {
  try {
    // Initialize storage first (async - loads sql.js WASM)
    await storageService.ready()

    mainWindow = createMainWindow()
    await registerAllHandlers(mainWindow)
    createTray()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
        registerAllHandlers(mainWindow)
      } else if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (err) {
    logger.error('Failed to initialize application', err)
  }
})

// Override the window close to minimize to tray instead of quitting
app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  syncService.stop()
  destroyAllProtonSessions()
  storageService.destroy()
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
