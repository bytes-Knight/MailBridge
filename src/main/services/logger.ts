import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
}

/**
 * Maximum retry attempts for file operations.
 * On Windows, files can be temporarily locked by antivirus scans.
 */
const MAX_FILE_RETRIES = 3
const FILE_RETRY_DELAY_MS = 50

/**
 * Helper to retry a file operation with exponential backoff.
 * This handles transient Windows file-locking issues (antivirus, search indexing).
 */
function retryFileOp<T>(fn: () => T, maxRetries = MAX_FILE_RETRIES): T | null {
  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries - 1) {
        // Brief backoff: 50ms, 100ms, 150ms
        const delay = FILE_RETRY_DELAY_MS * (attempt + 1)
        const end = Date.now() + delay
        while (Date.now() < end) { /* busy-wait micro delay */ }
      }
    }
  }
  // Log only the last error to avoid noise
  console.warn('File operation failed after retries', lastError)
  return null
}

class Logger {
  private logDir: string
  private logFile: string
  private stream: fs.WriteStream | null = null
  private maxSize = 5 * 1024 * 1024 // 5MB
  private logLevel: LogLevel = 'DEBUG'
  /** Circular buffer for in-memory logs — survives file-system issues. */
  private memoryBuffer: string[] = []
  private readonly MAX_MEMORY_LOGS = 500

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs')
    this.logFile = path.join(this.logDir, 'mailbridge.log')
    this.ensureDir()
    this.openStream()
  }

  private ensureDir(): void {
    retryFileOp(() => {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true })
      }
    })
  }

  private openStream(): void {
    retryFileOp(() => {
      if (this.stream) {
        try { this.stream.end() } catch { /* ignore */ }
      }
      this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })
    })
  }

  private rotate(): void {
    const result = retryFileOp(() => {
      const stats = fs.statSync(this.logFile)
      if (stats.size >= this.maxSize) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const rotatedPath = path.join(this.logDir, `mailbridge-${timestamp}.log`)
        if (this.stream) {
          try { this.stream.end() } catch { /* ignore */ }
          this.stream = null
        }
        // Try rename; if it fails (e.g., locked), skip rotation and continue writing
        try {
          fs.renameSync(this.logFile, rotatedPath)
        } catch {
          // File is likely locked by another process — reopen the stream to the same file
          this.openStream()
          return false
        }
        this.openStream()
        return true
      }
      return false
    })
    // If rotation failed and stream is null, reopen it
    if (result === null && !this.stream) {
      this.openStream()
    }
  }

  private write(level: LogLevel, message: string, context?: unknown): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.logLevel]) return

    const timestamp = new Date().toISOString()
    let logLine = `[${timestamp}] [${level}] ${message}`
    if (context !== undefined) {
      try {
        const ctx = typeof context === 'string' ? context : JSON.stringify(context)
        logLine += ` ${ctx}`
      } catch {
        logLine += ' [Circular context]'
      }
    }

    // Always emit to console
    console.log(logLine)

    // Always keep a copy in the in-memory ring buffer
    this.memoryBuffer.push(logLine)
    if (this.memoryBuffer.length > this.MAX_MEMORY_LOGS) {
      this.memoryBuffer.shift()
    }

    // File write with retry for Windows lock resilience
    this.rotate()
    if (this.stream) {
      retryFileOp(() => {
        this.stream!.write(logLine + '\n')
      })
    }
  }

  debug(message: string, context?: unknown): void {
    this.write('DEBUG', message, context)
  }

  info(message: string, context?: unknown): void {
    this.write('INFO', message, context)
  }

  warn(message: string, context?: unknown): void {
    this.write('WARN', message, context)
  }

  error(message: string, context?: unknown): void {
    this.write('ERROR', message, context)
  }

  /**
   * Get recent logs from the in-memory buffer.
   * Falls back to reading from disk if the buffer is empty.
   */
  getRecentLogs(count = 100): string[] {
    const fromMemory = this.memoryBuffer.slice(-count)
    if (fromMemory.length > 0) return fromMemory

    // Fallback: read from disk
    return retryFileOp(() => {
      if (!fs.existsSync(this.logFile)) return []
      const content = fs.readFileSync(this.logFile, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      return lines.slice(-count)
    }) ?? []
  }

  clearLogs(): void {
    try {
      this.memoryBuffer = []
      if (this.stream) {
        try { this.stream.end() } catch { /* ignore */ }
        this.stream = null
      }
      retryFileOp(() => {
        fs.writeFileSync(this.logFile, '')
      })
      this.openStream()
    } catch {
      // Ignore
    }
  }

  destroy(): void {
    try {
      // Flush any pending writes
      if (this.stream) {
        this.stream.end()
        this.stream = null
      }
    } catch { /* ignore */ }
  }
}

export const logger = new Logger()
