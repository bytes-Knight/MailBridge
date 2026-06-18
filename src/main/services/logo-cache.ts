import { logger } from './logger'
import { storageService } from './storage'
import {
  LOGO_CACHE_MAX_MEMORY,
  LOGO_CACHE_DEFAULT_TTL,
  LOGO_FAILURE_COOLDOWN,
  LOGO_FAILURE_MAX_RETRIES,
  LOGO_THUMBNAIL_SIZE
} from '@shared/constants'
import type { LogoCacheEntry, LogoSourceType, LogoDiagnostics } from '@shared/types'

/**
 * Multi-layer logo cache:
 *  1. In-memory LRU Map (fastest, session-scoped)
 *  2. Persistent disk via sql.js (survives restarts)
 *  3. Failure tracking (cooldown before retry)
 */
export class LogoCache {
  private memoryCache = new Map<string, { entry: LogoCacheEntry; timestamp: number }>()
  private lruKeys: string[] = []
  private failures = new Map<string, { count: number; lastAttempt: number }>()

  // Stats
  private hits = 0
  private misses = 0
  private activeLookups = 0

  // ── Getters ────────────────────────────────────────────────────────────────

  /** Total hit count since process start. */
  get totalHits(): number { return this.hits }
  /** Total miss count since process start. */
  get totalMisses(): number { return this.misses }

  // ── Memory Cache ──────────────────────────────────────────────────────────

  private touchLru(key: string): void {
    this.lruKeys = this.lruKeys.filter(k => k !== key)
    this.lruKeys.push(key)
  }

  private evictLru(): void {
    while (this.lruKeys.length > LOGO_CACHE_MAX_MEMORY) {
      const oldest = this.lruKeys.shift()
      if (oldest) this.memoryCache.delete(oldest)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Resolve a logo: check memory → disk → return null if not cached. */
  async get(domain: string): Promise<LogoCacheEntry | null> {
    // 1) Memory cache
    const mem = this.memoryCache.get(domain)
    if (mem) {
      const expired = Date.now() > new Date(mem.entry.expiresAt).getTime()
      if (!expired) {
        this.hits++
        this.touchLru(domain)
        return mem.entry
      }
      // Expired — remove from memory, will check disk
      this.memoryCache.delete(domain)
      this.lruKeys = this.lruKeys.filter(k => k !== domain)
    }

    // 2) Disk cache
    const disk = storageService.getLogoEntry(domain)
    if (disk) {
      const expired = Date.now() > new Date(disk.expiresAt).getTime()
      if (!expired && disk.validationStatus !== 'failed') {
        const entry = this.diskRowToEntry(disk)
        this.setMemory(domain, entry)
        this.hits++
        return entry
      }
    }

    this.misses++
    return null
  }

  /** Store a resolved logo in both memory and disk. */
  async set(domain: string, entry: LogoCacheEntry): Promise<void> {
    this.setMemory(domain, entry)
    this.persistToDisk(domain, entry)
    // Clear any previous failure record
    this.failures.delete(domain)
  }

  /** Record a failure for a domain. Only enters cooldown after max retries reached. */
  recordFailure(domain: string): boolean {
    const f = this.failures.get(domain)
    const count = (f?.count ?? 0) + 1
    this.failures.set(domain, { count, lastAttempt: Date.now() })

    // Only persist failures to disk and enter cooldown after max retries
    if (count >= LOGO_FAILURE_MAX_RETRIES) {
      // Persist a failed entry to disk so we don't retry on next session
      const now = new Date()
      const cooldownEnd = new Date(Date.now() + LOGO_FAILURE_COOLDOWN)
      const failedEntry: LogoCacheEntry = {
        domain,
        imageData: '',
        thumbnailData: '',
        sourceType: 'favicon',
        contentType: '',
        lastUpdated: now.toISOString(),
        expiresAt: cooldownEnd.toISOString(),
        versionHash: '',
        validationStatus: 'failed',
        failureCount: count,
        lastFailure: now.toISOString()
      }
      storageService.saveLogoEntry({
        domain: failedEntry.domain,
        imageData: failedEntry.imageData,
        thumbnailData: failedEntry.thumbnailData,
        sourceType: failedEntry.sourceType,
        contentType: failedEntry.contentType,
        lastUpdated: failedEntry.lastUpdated,
        expiresAt: failedEntry.expiresAt,
        versionHash: failedEntry.versionHash,
        validationStatus: 'failed',
        failureCount: count,
        lastFailure: now.toISOString()
      })
      return false
    }
    return true // Can retry
  }

  /** Check if a domain is in cooldown after max retries reached. */
  isInCooldown(domain: string): boolean {
    // Only block retries if we've hit max retries (not after a single failure)
    const f = this.failures.get(domain)
    if (f && f.count >= LOGO_FAILURE_MAX_RETRIES) {
      if (Date.now() - f.lastAttempt < LOGO_FAILURE_COOLDOWN) {
        return true
      }
    }
    // Check disk failures (these are already past max retries)
    const disk = storageService.getLogoEntry(domain)
    if (disk && disk.validationStatus === 'failed' && disk.failureCount >= LOGO_FAILURE_MAX_RETRIES) {
      const failedAt = disk.lastFailure ? new Date(disk.lastFailure).getTime() : 0
      if (Date.now() - failedAt < LOGO_FAILURE_COOLDOWN) {
        return true
      }
    }
    return false
  }

  /** Delete a specific domain from cache. */
  async delete(domain: string): Promise<void> {
    this.memoryCache.delete(domain)
    this.lruKeys = this.lruKeys.filter(k => k !== domain)
    this.failures.delete(domain)
    storageService.deleteLogoEntry(domain)
  }

  /** Clear all cached logos. */
  async clearAll(): Promise<void> {
    this.memoryCache.clear()
    this.lruKeys = []
    this.failures.clear()
    storageService.clearLogoCache()
    this.hits = 0
    this.misses = 0
    logger.info('Logo cache cleared')
  }

  /** Prune expired entries from disk. */
  async pruneExpired(): Promise<void> {
    const expired = storageService.getExpiredLogoEntries()
    for (const row of expired) {
      storageService.deleteLogoEntry(row.domain)
      this.memoryCache.delete(row.domain)
      this.lruKeys = this.lruKeys.filter(k => k !== row.domain)
    }
    if (expired.length > 0) {
      logger.info('Pruned expired logo entries', { count: expired.length })
    }
  }

  /** Increment active lookup counter. */
  incrementLookups(): void { this.activeLookups++ }

  /** Decrement active lookup counter. */
  decrementLookups(): void { this.activeLookups = Math.max(0, this.activeLookups - 1) }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  getDiagnostics(): LogoDiagnostics {
    return {
      memoryCacheSize: this.memoryCache.size,
      diskCacheSize: storageService.getLogoCacheCount(),
      failedDomains: storageService.getLogoFailureCount(),
      activeLookups: this.activeLookups,
      totalHits: this.hits,
      totalMisses: this.misses,
      lastRefreshTime: null, // Could track this separately
      storageBytes: storageService.getLogoCacheSize()
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  private setMemory(domain: string, entry: LogoCacheEntry): void {
    this.memoryCache.set(domain, { entry, timestamp: Date.now() })
    this.touchLru(domain)
    this.evictLru()
  }

  private persistToDisk(domain: string, entry: LogoCacheEntry): void {
    storageService.saveLogoEntry({
      domain,
      imageData: entry.imageData,
      thumbnailData: entry.thumbnailData,
      sourceType: entry.sourceType,
      contentType: entry.contentType,
      logoUrl: entry.logoUrl,
      lastUpdated: entry.lastUpdated,
      expiresAt: entry.expiresAt,
      versionHash: entry.versionHash,
      validationStatus: entry.validationStatus,
      failureCount: entry.failureCount,
      lastFailure: entry.lastFailure
    })
  }

  private diskRowToEntry(row: any): LogoCacheEntry {
    return {
      domain: row.domain,
      imageData: row.image_data,
      thumbnailData: row.thumbnail_data,
      sourceType: row.source_type as LogoSourceType,
      contentType: row.content_type,
      logoUrl: row.logo_url ?? undefined,
      lastUpdated: row.last_updated,
      expiresAt: row.expires_at,
      versionHash: row.version_hash,
      validationStatus: row.validation_status,
      failureCount: row.failure_count,
      lastFailure: row.last_failure ?? undefined
    }
  }

  /** Pre-warm memory cache from disk on startup. */
  async warmFromDisk(): Promise<void> {
    const all = storageService.getAllLogoEntries()
    let loaded = 0
    for (const row of all) {
      if (row.validationStatus === 'failed') continue
      const expired = Date.now() > new Date(row.expiresAt).getTime()
      if (expired) continue
      const entry = this.diskRowToEntry(row)
      this.setMemory(row.domain, entry)
      loaded++
    }
    logger.info('Logo cache warmed from disk', { loaded, totalOnDisk: all.length })
  }
}

export const logoCache = new LogoCache()
