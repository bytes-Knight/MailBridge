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

class Logger {
  private logDir: string
  private logFile: string
  private stream: fs.WriteStream | null = null
  private maxSize = 5 * 1024 * 1024 // 5MB
  private logLevel: LogLevel = 'DEBUG'

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs')
    this.logFile = path.join(this.logDir, 'mailbridge.log')
    this.ensureDir()
    this.openStream()
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }
  }

  private openStream(): void {
    if (this.stream) {
      this.stream.end()
    }
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })
  }

  private rotate(): void {
    try {
      const stats = fs.statSync(this.logFile)
      if (stats.size >= this.maxSize) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const rotatedPath = path.join(this.logDir, `mailbridge-${timestamp}.log`)
        if (this.stream) {
          this.stream.end()
        }
        fs.renameSync(this.logFile, rotatedPath)
        this.openStream()
      }
    } catch {
      // Ignore rotation errors
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

    console.log(logLine)

    this.rotate()
    if (this.stream) {
      this.stream.write(logLine + '\n')
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

  getRecentLogs(count = 100): string[] {
    try {
      if (!fs.existsSync(this.logFile)) return []
      const content = fs.readFileSync(this.logFile, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      return lines.slice(-count)
    } catch {
      return []
    }
  }

  clearLogs(): void {
    try {
      if (this.stream) {
        this.stream.end()
      }
      fs.writeFileSync(this.logFile, '')
      this.openStream()
    } catch {
      // Ignore
    }
  }

  destroy(): void {
    if (this.stream) {
      this.stream.end()
    }
  }
}

export const logger = new Logger()
