import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import type { ErrorReport } from '@shared/types'

export class ErrorReporter {
  private errorDir: string
  private logPath: string

  constructor() {
    this.errorDir = path.join(app.getPath('userData'), 'errors')
    this.logPath = path.join(this.errorDir, 'error-log.jsonl')
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.errorDir)) {
      fs.mkdirSync(this.errorDir, { recursive: true })
    }
  }

  report(report: ErrorReport): void {
    try {
      const filePath = path.join(this.errorDir, `${report.id}.json`)
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2))

      // Append to consolidated log
      fs.appendFileSync(this.logPath, JSON.stringify(report) + '\n')

      // Cleanup old files
      this.cleanup()

      logger.info('Error report saved', { id: report.id, source: report.source, level: report.level })
    } catch (err) {
      logger.error('Failed to save error report', err)
    }
  }

  private cleanup(): void {
    try {
      // Rotate log if > 5MB
      const stats = fs.statSync(this.logPath)
      if (stats.size > 5 * 1024 * 1024) {
        const rotated = this.logPath + '.1'
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
        fs.renameSync(this.logPath, rotated)
      }

      // Clean old files (max 500, 30 days)
      const files = fs.readdirSync(this.errorDir)
        .filter(f => f.endsWith('.json') && f !== 'error-log.jsonl')
        .sort()

      const now = Date.now()
      const thirtyDays = 30 * 24 * 60 * 60 * 1000

      for (const file of files) {
        const filePath = path.join(this.errorDir, file)
        const mtime = fs.statSync(filePath).mtimeMs
        if (files.length > 500 || (now - mtime) > thirtyDays) {
          fs.unlinkSync(filePath)
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  getReports(): ErrorReport[] {
    try {
      const files = fs.readdirSync(this.errorDir)
        .filter(f => f.endsWith('.json') && f !== 'error-log.jsonl')
        .sort()
        .reverse()
        .slice(0, 100)

      return files.map(f => {
        try {
          const content = fs.readFileSync(path.join(this.errorDir, f), 'utf-8')
          return JSON.parse(content)
        } catch {
          return null
        }
      }).filter(Boolean)
    } catch {
      return []
    }
  }

  getReport(id: string): ErrorReport | null {
    try {
      const content = fs.readFileSync(path.join(this.errorDir, `${id}.json`), 'utf-8')
      return JSON.parse(content)
    } catch {
      return null
    }
  }

  clearAll(): void {
    try {
      const files = fs.readdirSync(this.errorDir)
      for (const file of files) {
        fs.unlinkSync(path.join(this.errorDir, file))
      }
    } catch {
      // Ignore
    }
  }

  getSummary(): { total: number; bySource: Record<string, number>; byLevel: Record<string, number> } {
    const reports = this.getReports()
    const bySource: Record<string, number> = {}
    const byLevel: Record<string, number> = {}

    for (const report of reports) {
      bySource[report.source] = (bySource[report.source] || 0) + 1
      byLevel[report.level] = (byLevel[report.level] || 0) + 1
    }

    return { total: reports.length, bySource, byLevel }
  }
}

export const errorReporter = new ErrorReporter()
