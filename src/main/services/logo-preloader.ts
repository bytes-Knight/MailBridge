import { logger } from './logger'

/**
 * Background logo prefetcher.
 *
 * v2.28.0: queue was disabled to keep total Electron RAM under the
 * user's 500MB hard cap. The previous eager prefetch fan-out loaded up
 * to ~500 logos into the main process's in-memory logo cache on startup,
 * contributing 30-100MB of resident memory that we cannot afford.
 *
 * Logos are now resolved lazily on demand via the same `logoResolver`
 * pipeline used by the renderer / notification paths. The class shell
 * stays exported so dependent callers — `syncService`,
 * `notificationService` — keep their existing import paths. All methods
 * are hard no-ops: do not reintroduce state here without first
 * re-budgeting the 500MB cap.
 */
class LogoPreloader {
  notifySyncCompleted(): void {
    // No-op. Logos resolve lazily on demand via the resolver pipeline.
  }

  queueNewDomains(_domains: string[]): void {
    // Intentionally no-op — see class-level doc comment.
  }

  getStats(): { queueSize: number; processing: boolean; totalPrefetched: number } {
    // Reserved-shape stub so callers like the diagnostic dashboard that
    // read this stat keep typechecking. Always reports zero.
    return { queueSize: 0, processing: false, totalPrefetched: 0 }
  }
}

export const logoPreloader = new LogoPreloader()

logger.debug('Logo preloader is in no-op mode for the 500MB RAM cap (v2.28.0)')
