import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { encryptionService } from './encryption'
import { DB_NAME, SETTINGS_KEY } from '@shared/constants'
import type { MailAccount, AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

let SqlJs: any = null

export class StorageService {
  private db: any = null
  private dbPath: string
  private saveTimer: ReturnType<typeof setInterval> | null = null
  private _ready: Promise<void>

  constructor() {
    this.dbPath = path.join(app.getPath('userData'), DB_NAME)
    this._ready = this._init()
  }

  private async _init(): Promise<void> {
    try {
      // Dynamically import sql.js and load WASM
      const initSqlJs = (await import('sql.js')).default

      // Find the WASM file path
      const wasmPath = this.resolveWasmPath()

      // Read WASM binary synchronously to avoid network fetch
      let wasmBinary: ArrayBuffer | undefined
      try {
        const buf = fs.readFileSync(wasmPath)
        wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      } catch (err) {
        logger.warn('Could not read sql.js WASM from file, trying default locateFile', err)
      }

      SqlJs = await initSqlJs({ wasmBinary })

      // Load existing database or create new
      if (fs.existsSync(this.dbPath)) {
        const buffer = fs.readFileSync(this.dbPath)
        this.db = new SqlJs.Database(buffer)
        logger.info('Loaded existing database', { path: this.dbPath, size: buffer.length })
      } else {
        this.db = new SqlJs.Database()
        logger.info('Created new database', { path: this.dbPath })
      }

      this.db.run('PRAGMA foreign_keys = ON')
      this.initTables()
      this.startAutoSave()

      logger.info('Storage service initialized', { path: this.dbPath })
    } catch (err) {
      logger.error('Failed to initialize storage service', err)
      throw err
    }
  }

  private resolveWasmPath(): string {
    // Try multiple possible locations for the WASM file
    const candidates = [
      // Development: from node_modules
      path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      // Development alternative
      path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      // Production: app resources
      path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      // Production with asarUnpack
      path.join(path.dirname(app.getPath('exe')), 'resources', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    // Default - will likely fail but let sql.js handle it
    return candidates[0]
  }

  ready(): Promise<void> {
    return this._ready
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS email_cache (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        data TEXT NOT NULL,
        cached_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS app_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_dedup (
        notification_id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS logo_cache (
        domain TEXT PRIMARY KEY,
        image_data TEXT NOT NULL,
        thumbnail_data TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL,
        content_type TEXT NOT NULL,
        logo_url TEXT,
        last_updated TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        validation_status TEXT NOT NULL DEFAULT 'valid',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT
      );
    `)
  }

  private startAutoSave(): void {
    // Save to disk every 5 seconds to prevent data loss
    this.saveTimer = setInterval(() => {
      try {
        this.saveToDisk()
      } catch (err) {
        logger.error('Auto-save failed', err)
      }
    }, 5000)
  }

  private saveToDisk(): void {
    if (!this.db) return
    const data = this.db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(this.dbPath, buffer)
  }

  // Query helper: run a SELECT query and return all rows as objects
  private queryAll(sql: string, params?: any[]): any[] {
    if (!this.db) throw new Error('Storage not initialized')
    const stmt = this.db.prepare(sql)
    if (params) stmt.bind(params)
    const results: any[] = []
    while (stmt.step()) {
      results.push(stmt.getAsObject())
    }
    stmt.free()
    return results
  }

  // Query helper: run a SELECT query and return the first row
  private queryOne(sql: string, params?: any[]): any | null {
    if (!this.db) throw new Error('Storage not initialized')
    const stmt = this.db.prepare(sql)
    if (params) stmt.bind(params)
    const result = stmt.step() ? stmt.getAsObject() : null
    stmt.free()
    return result
  }

  // Query helper: run an INSERT/UPDATE/DELETE query
  // Auto-save every 5 seconds handles persistence - no need to save on every call
  private execute(sql: string, params?: any[]): void {
    if (!this.db) throw new Error('Storage not initialized')
    const stmt = this.db.prepare(sql)
    if (params) stmt.bind(params)
    stmt.step()
    stmt.free()
  }

  // Account CRUD
  getAccounts(): MailAccount[] {
    const rows = this.queryAll('SELECT * FROM accounts')
    return rows.map(row => {
      try {
        const decrypted = encryptionService.decrypt(row.data)
        return JSON.parse(decrypted)
      } catch (err) {
        logger.error('Failed to decrypt account', { id: row.id, error: err })
        return null
      }
    }).filter(Boolean) as MailAccount[]
  }

  getAccount(id: string): MailAccount | null {
    const row = this.queryOne('SELECT * FROM accounts WHERE id = ?', [id])
    if (!row) return null
    try {
      return JSON.parse(encryptionService.decrypt(row.data))
    } catch {
      return null
    }
  }

  saveAccount(account: MailAccount): void {
    const data = encryptionService.encrypt(JSON.stringify(account))
    this.execute(
      `INSERT OR REPLACE INTO accounts (id, data, created_at, updated_at)
       VALUES (?, ?, COALESCE((SELECT created_at FROM accounts WHERE id = ?), datetime('now')), datetime('now'))`,
      [account.id, data, account.id]
    )
  }

  deleteAccount(id: string): void {
    this.execute('DELETE FROM accounts WHERE id = ?', [id])
  }

  // Settings
  getSettings(): AppSettings {
    const row = this.queryOne('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])
    if (!row) return { ...DEFAULT_SETTINGS }
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  updateSettings(settings: Partial<AppSettings>): AppSettings {
    const current = this.getSettings()
    const merged = { ...current, ...settings }
    this.execute(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [SETTINGS_KEY, JSON.stringify(merged)]
    )
    return merged
  }

  resetSettings(): void {
    this.execute('DELETE FROM settings WHERE key = ?', [SETTINGS_KEY])
  }

  // Email cache
  cacheMessage(accountId: string, messageId: string, threadId: string | undefined, data: unknown): void {
    this.execute(
      `INSERT OR REPLACE INTO email_cache (account_id, message_id, thread_id, data, cached_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [accountId, messageId, threadId || null, JSON.stringify(data)]
    )
  }

  getCachedMessage(accountId: string, messageId: string): unknown | null {
    const row = this.queryOne(
      'SELECT data FROM email_cache WHERE account_id = ? AND message_id = ?',
      [accountId, messageId]
    )
    if (!row) return null
    try { return JSON.parse(row.data) } catch { return null }
  }

  getCachedMessages(accountId: string): unknown[] {
    const rows = this.queryAll('SELECT data FROM email_cache WHERE account_id = ?', [accountId])
    return rows.map(r => { try { return JSON.parse(r.data) } catch { return null } }).filter(Boolean)
  }

  getCacheSize(): number {
    const row = this.queryOne('SELECT SUM(LENGTH(data)) as size FROM email_cache')
    return row?.size ?? 0
  }

  clearCache(): void {
    this.execute('DELETE FROM email_cache')
  }

  // Notification dedup
  isNotificationSeen(id: string): boolean {
    const row = this.queryOne('SELECT 1 FROM notification_dedup WHERE notification_id = ?', [id])
    return !!row
  }

  markNotificationSeen(id: string): void {
    this.execute('INSERT OR IGNORE INTO notification_dedup (notification_id) VALUES (?)', [id])
  }

  evictStaleNotifications(ttlMs = 24 * 60 * 60 * 1000): void {
    const secondsAgo = Math.floor(ttlMs / 1000)
    this.execute(
      `DELETE FROM notification_dedup WHERE datetime(created_at) < datetime('now', ?)`,
      [`-${secondsAgo} seconds`]
    )
  }

  clearAccountNotifications(accountId: string): void {
    this.execute('DELETE FROM notification_dedup WHERE notification_id LIKE ?', [`${accountId}-%`])
  }

  // ── Logo Cache ──────────────────────────────────────────────────────────

  saveLogoEntry(entry: {
    domain: string
    imageData: string
    thumbnailData: string
    sourceType: string
    contentType: string
    logoUrl?: string
    lastUpdated: string
    expiresAt: string
    versionHash: string
    validationStatus: string
    failureCount: number
    lastFailure?: string
  }): void {
    this.execute(
      `INSERT OR REPLACE INTO logo_cache
       (domain, image_data, thumbnail_data, source_type, content_type, logo_url,
        last_updated, expires_at, version_hash, validation_status, failure_count, last_failure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.domain, entry.imageData, entry.thumbnailData,
        entry.sourceType, entry.contentType, entry.logoUrl || null,
        entry.lastUpdated, entry.expiresAt, entry.versionHash,
        entry.validationStatus, entry.failureCount, entry.lastFailure || null
      ]
    )
  }

  getLogoEntry(domain: string): {
    domain: string; imageData: string; thumbnailData: string;
    sourceType: string; contentType: string; logoUrl: string | null;
    lastUpdated: string; expiresAt: string; versionHash: string;
    validationStatus: string; failureCount: number; lastFailure: string | null
  } | null {
    const row = this.queryOne('SELECT * FROM logo_cache WHERE domain = ?', [domain])
    if (!row) return null
    return {
      domain: row.domain,
      imageData: row.image_data,
      thumbnailData: row.thumbnail_data,
      sourceType: row.source_type,
      contentType: row.content_type,
      logoUrl: row.logo_url,
      lastUpdated: row.last_updated,
      expiresAt: row.expires_at,
      versionHash: row.version_hash,
      validationStatus: row.validation_status,
      failureCount: row.failure_count,
      lastFailure: row.last_failure
    }
  }

  getAllLogoEntries(): Array<{
    domain: string; imageData: string; thumbnailData: string;
    sourceType: string; contentType: string; logoUrl: string | null;
    lastUpdated: string; expiresAt: string; versionHash: string;
    validationStatus: string; failureCount: number; lastFailure: string | null
  }> {
    return this.queryAll('SELECT * FROM logo_cache')
  }

  deleteLogoEntry(domain: string): void {
    this.execute('DELETE FROM logo_cache WHERE domain = ?', [domain])
  }

  clearLogoCache(): void {
    this.execute('DELETE FROM logo_cache')
  }

  getExpiredLogoEntries(): Array<{ domain: string; imageData: string; thumbnailData: string; sourceType: string }> {
    return this.queryAll(
      "SELECT * FROM logo_cache WHERE datetime(expires_at) < datetime('now') OR validation_status = 'expired'"
    )
  }

  getLogoCacheSize(): number {
    const row = this.queryOne(
      "SELECT SUM(LENGTH(image_data) + LENGTH(thumbnail_data)) as size FROM logo_cache"
    )
    return row?.size ?? 0
  }

  getLogoCacheCount(): number {
    const row = this.queryOne('SELECT COUNT(*) as count FROM logo_cache')
    return row?.count ?? 0
  }

  getLogoFailureCount(): number {
    const row = this.queryOne(
      "SELECT COUNT(*) as count FROM logo_cache WHERE validation_status = 'failed'"
    )
    return row?.count ?? 0
  }

  // Generic key-value
  getKeyValue(key: string): string | null {
    const row = this.queryOne('SELECT value FROM settings WHERE key = ?', [key])
    return row?.value ?? null
  }

  setKeyValue(key: string, value: string): void {
    this.execute(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [key, value]
    )
  }

  deleteKey(key: string): void {
    this.execute('DELETE FROM settings WHERE key = ?', [key])
  }

  // Logging
  addLog(level: string, message: string, context?: string): void {
    this.execute(
      'INSERT INTO app_logs (level, message, context) VALUES (?, ?, ?)',
      [level, message, context ?? null]
    )
  }

  getLogs(count = 100): { id: number; timestamp: string; level: string; message: string; context?: string }[] {
    return this.queryAll('SELECT * FROM app_logs ORDER BY id DESC LIMIT ?', [count])
  }

  // Export/Import
  exportData(): string {
    const accounts = this.getAccounts()
    const settings = this.getSettings()
    const data = { accounts, settings, version: 1 }
    return encryptionService.encrypt(JSON.stringify(data))
  }

  importData(encryptedBlob: string): boolean {
    try {
      const decrypted = encryptionService.decrypt(encryptedBlob)
      const data = JSON.parse(decrypted)
      if (data.accounts) {
        this.execute('DELETE FROM accounts')
        for (const account of data.accounts) {
          this.saveAccount(account)
        }
      }
      if (data.settings) {
        this.updateSettings(data.settings)
      }
      return true
    } catch (err) {
      logger.error('Failed to import data', err)
      return false
    }
  }

  destroy(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
    if (this.db) {
      this.saveToDisk()
      this.db.close()
      this.db = null
    }
  }
}

export const storageService = new StorageService()
