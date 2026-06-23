import { app, screen } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
  displayBounds?: { x: number; y: number; width: number; height: number }
}

const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 900
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

class WindowStateManager {
  private statePath: string
  private state: WindowState
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly SAVE_DELAY_MS = 500

  constructor() {
    this.statePath = path.join(app.getPath('userData'), 'window-state.json')
    this.state = this.load()
  }

  private load(): WindowState {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = fs.readFileSync(this.statePath, 'utf-8')
        const parsed = JSON.parse(data) as WindowState

        // Validate basic shape
        if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          // Clamp to minimum sizes
          parsed.width = Math.max(parsed.width, MIN_WIDTH)
          parsed.height = Math.max(parsed.height, MIN_HEIGHT)

          // Check if the saved position is still valid on the current display setup
          if (parsed.x !== undefined && parsed.y !== undefined) {
            const displays = screen.getAllDisplays()
            const onScreen = displays.some(display => {
              const { x, y, width, height } = display.workArea
              // Check if at least part of the window would be visible
              return (
                parsed.x! < x + width &&
                parsed.x! + parsed.width > x &&
                parsed.y! < y + height &&
                parsed.y! + parsed.height > y
              )
            })

            if (!onScreen) {
              // Saved position is off-screen (display was disconnected) — reset position
              delete parsed.x
              delete parsed.y
              logger.warn('Saved window position off-screen, resetting to default', {
                savedPosition: { x: parsed.x, y: parsed.y },
                displayCount: displays.length
              })
            }
          }

          logger.info('Window state loaded', {
            width: parsed.width,
            height: parsed.height,
            isMaximized: parsed.isMaximized
          })
          return parsed
        }
      }
    } catch (err) {
      logger.warn('Failed to load window state, using defaults', err)
      // Remove corrupted state file
      try { fs.unlinkSync(this.statePath) } catch { /* ignore */ }
    }

    return {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      isMaximized: false
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.statePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      // Write atomically: write to temp file, then rename
      const tmpPath = this.statePath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8')
      fs.renameSync(tmpPath, this.statePath)
    } catch (err) {
      logger.warn('Failed to save window state', err)
    }
  }

  /** Debounced save — persists after a short delay to batch rapid updates */
  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.save()
      this.saveTimer = null
    }, this.SAVE_DELAY_MS)
  }

  /** Get the saved window state */
  get(): WindowState {
    return { ...this.state }
  }

  /** Update window dimensions */
  setBounds(width: number, height: number): void {
    this.state.width = Math.max(width, MIN_WIDTH)
    this.state.height = Math.max(height, MIN_HEIGHT)
  }

  /** Update window position */
  setPosition(x: number, y: number): void {
    this.state.x = x
    this.state.y = y
    // Save display context for position validation on next launch
    this.state.displayBounds = undefined
    try {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      this.state.displayBounds = { ...display.workArea }
    } catch { /* ignore */ }
  }

  /** Update maximized state */
  setMaximized(maximized: boolean): void {
    this.state.isMaximized = maximized
  }

  /** Force immediate save (e.g., before quit) */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
  }

  /** Get window options for BrowserWindow creation */
  getWindowOptions(): Electron.BrowserWindowConstructorOptions {
    return {
      width: this.state.width || DEFAULT_WIDTH,
      height: this.state.height || DEFAULT_HEIGHT,
      x: this.state.x,
      y: this.state.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT
    }
  }
}

export const windowStateManager = new WindowStateManager()
