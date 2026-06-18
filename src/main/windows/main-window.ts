import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { logger } from '../services/logger'
import { IpcChannels } from '@shared/ipc'

let crashCount = 0
const MAX_CRASH_RELOADS = 2

export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Crash handling
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process crashed', { reason: details.reason })
    if (crashCount < MAX_CRASH_RELOADS) {
      crashCount++
      mainWindow.reload()
    }
  })

  // Window state broadcasts
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized-changed', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized-changed', false)
  })

  // External links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Load content
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('Main window created')
  return mainWindow
}
