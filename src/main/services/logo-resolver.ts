import { nativeImage } from 'electron'
import { logger } from './logger'
import { logoCache } from './logo-cache'
import {
  LOGO_CACHE_DEFAULT_TTL,
  LOGO_THUMBNAIL_SIZE,
  LOGO_DISPLAY_SIZE
} from '@shared/constants'
import type { LogoResult, LogoCacheEntry, LogoSourceType } from '@shared/types'

/**
 * Resolution priority:
 *  1. Cache (memory → disk) handled by logoCache
 *  2. BIMI DNS record → SVG logo
 *  3. Brand API (Clearbit) → PNG logo
 *  4. Website favicon
 *  5. Generated initials with deterministic gradient
 *
 * Image processing pipeline:
 *  - Fetch → nativeImage → resize → base64 encode
 *  - Generate thumbnail version
 *  - Compute version hash for change detection
 */

const GRADIENTS = [
  ['#6366f1', '#4f46e5'],
  ['#3b82f6', '#2563eb'],
  ['#06b6d4', '#0891b2'],
  ['#10b981', '#059669'],
  ['#f59e0b', '#d97706'],
  ['#ef4444', '#dc2626'],
  ['#ec4899', '#db2777'],
  ['#8b5cf6', '#7c3aed']
]

class LogoResolver {
  private online = true

  setOnline(online: boolean): void {
    this.online = online
  }

  /**
   * Resolve a logo for an email address.
   * Returns instantly from cache if available, otherwise queues network fetch.
   */
  async resolve(email: string, name?: string): Promise<LogoResult> {
    const domain = extractDomain(email)

    // 1) Try cache first
    const cached = await logoCache.get(domain)
    if (cached) {
      return this.cachedToResult(cached)
    }

    // 2) Check cooldown
    if (logoCache.isInCooldown(domain)) {
      return this.generateInitialsResult(email, name)
    }

    // 3) Resolve via network
    if (!this.online) {
      return this.generateInitialsResult(email, name)
    }

    logoCache.incrementLookups()
    try {
      const netResult = await this.resolveFromNetwork(domain)
      if (netResult) {
        await this.cacheResult(domain, netResult.result, netResult.imageBuffer)
        return netResult.result
      }
    } catch (err) {
      logger.warn('Logo resolution failed', { domain, error: err })
    } finally {
      logoCache.decrementLookups()
    }

    // Track failure
    logoCache.recordFailure(domain)

    return this.generateInitialsResult(email, name)
  }

  /**
   * Resolve logos for multiple domains in a batch.
   * Returns a map of domain → LogoResult.
   */
  async resolveBatch(entries: Array<{ email: string; name?: string }>): Promise<Record<string, LogoResult>> {
    const results: Record<string, LogoResult> = {}

    for (const entry of entries) {
      results[entry.email] = await this.resolve(entry.email, entry.name)
    }

    return results
  }

  // ── Network Resolution ────────────────────────────────────────────────────

  /** Internal network result bundling the LogoResult with image buffer for thumbnails. */
  private async resolveFromNetwork(
    domain: string
  ): Promise<{ result: LogoResult; imageBuffer: Buffer } | null> {
    // Priority 1: BIMI DNS record
    try {
      const bimiUrl = await queryBimiRecord(domain)
      if (bimiUrl) {
        const svgData = await fetchSvgData(bimiUrl)
        if (svgData) {
          logger.debug('Logo resolved via BIMI', { domain })
          return {
            result: { type: 'svg', data: svgData, source: 'bimi', fromCache: false },
            imageBuffer: Buffer.from(svgData.split(',')[1] || '', 'base64')
          }
        }
      }
    } catch { /* continue */ }

    // Priority 2: Brand logo API (Clearbit)
    try {
      const brandUrl = `https://logo.clearbit.com/${domain}`
      const pngBuffer = await fetchImageBuffer(brandUrl)
      if (pngBuffer && pngBuffer.length > 100) {
        const processed = this.processRasterImage(pngBuffer)
        logger.debug('Logo resolved via Clearbit', { domain })
        return {
          result: { type: 'img', data: processed.dataUrl, source: 'brand', fromCache: false },
          imageBuffer: pngBuffer
        }
      }
    } catch { /* continue */ }

    // Priority 3: Favicon
    try {
      const faviconUrl = await queryFaviconUrl(domain)
      if (faviconUrl) {
        const icoBuffer = await fetchImageBuffer(faviconUrl)
        if (icoBuffer && icoBuffer.length > 100) {
          const processed = this.processRasterImage(icoBuffer)
          logger.debug('Logo resolved via favicon', { domain })
          return {
            result: { type: 'img', data: processed.dataUrl, source: 'favicon', fromCache: false },
            imageBuffer: icoBuffer
          }
        }
      }
    } catch { /* continue */ }

    return null
  }

  // ── Image Processing ──────────────────────────────────────────────────────

  private processRasterImage(buffer: Buffer): { dataUrl: string; thumbnailDataUrl: string } {
    const img = nativeImage.createFromBuffer(buffer)

    if (img.isEmpty()) {
      // Try creating from path if it's an ico file
      // Some .ico files aren't parseable by nativeImage from Buffer
      return {
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        thumbnailDataUrl: ''
      }
    }

    // Resize to standard display size
    const displaySize = img.getSize()
    let resized = img
    if (displaySize.width > LOGO_DISPLAY_SIZE || displaySize.height > LOGO_DISPLAY_SIZE) {
      resized = img.resize({ width: LOGO_DISPLAY_SIZE, height: LOGO_DISPLAY_SIZE, quality: 'good' })
    }

    // Generate thumbnail
    const thumbnail = img.resize({ width: LOGO_THUMBNAIL_SIZE, height: LOGO_THUMBNAIL_SIZE, quality: 'good' })

    const dataUrl = resized.toDataURL()
    const thumbnailDataUrl = thumbnail.toDataURL()

    return { dataUrl, thumbnailDataUrl }
  }

  private processSvg(svgText: string): { dataUrl: string; thumbnailDataUrl: string } {
    const base64 = Buffer.from(svgText, 'utf-8').toString('base64')
    const dataUrl = `data:image/svg+xml;base64,${base64}`

    // For SVGs, try to render via nativeImage for the thumbnail
    let thumbnailDataUrl = ''
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(svgText), { width: 64, height: 64 })
      if (!img.isEmpty()) {
        const thumb = img.resize({ width: LOGO_THUMBNAIL_SIZE, height: LOGO_THUMBNAIL_SIZE, quality: 'good' })
        thumbnailDataUrl = thumb.toDataURL()
      }
    } catch {
      thumbnailDataUrl = dataUrl // Fallback: use the same SVG
    }

    return { dataUrl, thumbnailDataUrl }
  }

  private computeHash(data: string): string {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36)
  }

  // ── Cache Integration ─────────────────────────────────────────────────────

  private async cacheResult(domain: string, result: LogoResult, thumbnailBuffer?: Buffer): Promise<void> {
    const now = new Date()
    const expires = new Date(Date.now() + LOGO_CACHE_DEFAULT_TTL)

    let imageData = result.data
    let thumbnailData = ''
    let contentType = result.type === 'svg' ? 'image/svg+xml' : 'image/png'
    let sourceType: LogoSourceType = result.source as LogoSourceType || 'favicon'

    if (result.type === 'svg') {
      // Process SVG for thumbnail
      const svgText = Buffer.from(result.data.split(',')[1] || '', 'base64').toString('utf-8')
      const processed = this.processSvg(svgText)
      thumbnailData = processed.thumbnailDataUrl || result.data
    } else if (thumbnailBuffer) {
      // Use the pre-generated thumbnail buffer
      const thumbImg = nativeImage.createFromBuffer(thumbnailBuffer)
      if (!thumbImg.isEmpty()) {
        const resized = thumbImg.resize({ width: LOGO_THUMBNAIL_SIZE, height: LOGO_THUMBNAIL_SIZE, quality: 'good' })
        thumbnailData = resized.toDataURL()
      } else {
        thumbnailData = result.data
      }
    } else {
      thumbnailData = result.data
    }

    const entry: LogoCacheEntry = {
      domain,
      imageData,
      thumbnailData,
      sourceType,
      contentType,
      logoUrl: undefined,
      lastUpdated: now.toISOString(),
      expiresAt: expires.toISOString(),
      versionHash: this.computeHash(imageData),
      validationStatus: 'valid',
      failureCount: 0
    }

    await logoCache.set(domain, entry)
  }

  private cachedToResult(entry: LogoCacheEntry): LogoResult {
    const isSvg = entry.contentType === 'image/svg+xml'
    const hasThumbnail = !!entry.thumbnailData && entry.thumbnailData.length > 0

    const isCacheSource = entry.validationStatus === 'valid' || entry.validationStatus === 'failed'
    return {
      type: isSvg ? 'svg' : 'img',
      data: hasThumbnail ? entry.thumbnailData : entry.imageData,
      source: isCacheSource ? 'cache' : entry.sourceType,
      fromCache: true
    }
  }

  // ── Fallback ──────────────────────────────────────────────────────────────

  private generateInitialsResult(email: string, name?: string): LogoResult {
    const gradient = getDeterministicGradient(email)
    const initials = getInitials(name || '', email)
    return {
      type: 'initials',
      data: initials,
      backgroundColor: gradient[0],
      source: 'generated',
      fromCache: false
    }
  }
}

// ── Network Helpers ─────────────────────────────────────────────────────────

async function queryBimiRecord(domain: string): Promise<string | null> {
  const response = await fetch(
    `https://dns.google/resolve?name=default._bimi.${domain}&type=TXT`
  )
  if (!response.ok) return null

  const data: any = await response.json()
  const answers = data.Answer as Array<{ data: string }> | undefined
  if (!answers) return null

  for (const answer of answers) {
    const text = answer.data.replace(/"/g, '')
    const urlMatch = text.match(/https?:\/\/[^\s;"]+\.svg[^\s;"]*/i)
    if (urlMatch) return urlMatch[0]
  }
  return null
}

async function queryFaviconUrl(domain: string): Promise<string | null> {
  // Google Favicons service — use GET (HEAD often returns 403/405)
  const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
  try {
    const resp = await fetch(googleUrl, { method: 'GET' })
    if (resp.ok) return googleUrl
  } catch { /* continue */ }

  // Fallback: direct favicon.ico
  const directUrl = `https://${domain}/favicon.ico`
  try {
    const resp = await fetch(directUrl, { method: 'GET' })
    if (resp.ok) return directUrl
  } catch { /* continue */ }

  return null
}

async function fetchSvgData(url: string): Promise<string | null> {
  const response = await fetch(url)
  if (!response.ok) return null

  const text = await response.text()

  // Validate that it looks like an SVG
  if (!text.includes('<svg') && !text.includes('<SVG')) return null

  return `data:image/svg+xml;base64,${Buffer.from(text, 'utf-8').toString('base64')}`
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  const response = await fetch(url)
  if (!response.ok) return null

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ── Deterministic Helpers ───────────────────────────────────────────────────

function getDeterministicGradient(email: string): string[] {
  const hash = email.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return GRADIENTS[hash % GRADIENTS.length]
}

function getInitials(name: string, email: string): string {
  if (name) {
    const parts = name.split(' ').filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  }
  return email.substring(0, 2).toUpperCase()
}

function extractDomain(email: string): string {
  const match = email.match(/@([\w.-]+)/)
  return match ? match[1].toLowerCase() : ''
}

export const logoResolver = new LogoResolver()
