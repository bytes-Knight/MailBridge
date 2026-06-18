import { logger } from './logger'
import { logoCache } from './logo-cache'
import { logoResolver } from './logo-resolver'
import { LOGO_PREFETCH_BATCH_SIZE, LOGO_PREFETCH_RATE_LIMIT_MS } from '@shared/constants'

/**
 * Background logo prefetcher.
 *
 * Hooks into sync completion events and proactively resolves logos
 * for newly discovered sender domains. Rate-limited to avoid
 * flooding network requests.
 *
 * Uses the same `logoResolver.resolve()` pipeline as the on-demand
 * renderer path — no duplication of resolution logic.
 */
class LogoPreloader {
  private queue: string[] = []
  private processing = false
  private prefetchCount = 0

  /**
   * Called when sync completes — triggers queue processing.
   */
  notifySyncCompleted(): void {
    if (this.queue.length > 0 && !this.processing) {
      this.processQueue()
    }
  }

  /**
   * Queue new domains for background resolution.
   * These will be resolved via the standard logoResolver pipeline.
   */
  queueNewDomains(domains: string[]): void {
    const unique = domains.filter(d => {
      if (this.queue.includes(d)) return false
      return true
    })

    if (unique.length === 0) return

    this.queue.push(...unique)
    logger.debug('Queued domains for logo prefetch', { count: unique.length, total: this.queue.length })

    if (!this.processing) {
      this.processQueue()
    }
  }

  /**
   * Process the prefetch queue with rate limiting.
   * Each domain is resolved through logoResolver.resolve(),
   * which handles caching, BIMI → brand → favicon pipeline,
   * and image processing.
   */
  private async processQueue(): Promise<void> {
    this.processing = true

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, LOGO_PREFETCH_BATCH_SIZE)

      for (const domain of batch) {
        // Skip if already cached or in cooldown
        const cached = await logoCache.get(domain)
        if (cached) continue
        if (logoCache.isInCooldown(domain)) continue

        try {
          // Resolve using a dummy email — logoResolver extracts the domain
          // and uses the standard multi-source pipeline.
          await logoResolver.resolve(`noreply@${domain}`)
          this.prefetchCount++
        } catch {
          // Individual failures are already handled by logoResolver
        }

        // Rate limit between requests
        await sleep(LOGO_PREFETCH_RATE_LIMIT_MS)
      }
    }

    this.processing = false
    logger.info('Logo prefetch completed', { totalPrefetched: this.prefetchCount })
  }

  /**
   * Get prefetch statistics.
   */
  getStats(): { queueSize: number; processing: boolean; totalPrefetched: number } {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      totalPrefetched: this.prefetchCount
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const logoPreloader = new LogoPreloader()
