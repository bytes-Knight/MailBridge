import { IpcChannels } from '@shared/ipc'
import type { LogoResult } from '@shared/types'
import { getDeterministicGradient, getInitials, extractDomain } from './bimi'

const ipc = (window as any).mailbridge

/**
 * Renderer-side brand logo service.
 *
 * Thin IPC wrapper — all heavy lifting (network requests, caching,
 * image processing) happens in the main process. The renderer only
 * makes IPC calls and renders the results.
 */
class BrandLogoService {
  private pendingRequests = new Map<string, Promise<LogoResult>>()

  /**
   * Resolve a logo for the given email address.
   *
   * Uses IPC to communicate with the main-process logo resolver.
   * Falls back to deterministic initials if IPC is unavailable
   * (e.g. during initial load or in tests).
   */
  async resolveLogo(email: string, name?: string): Promise<LogoResult> {
    const cacheKey = email.toLowerCase()

    // Deduplicate concurrent requests for the same email
    if (this.pendingRequests.has(cacheKey)) {
      return this.pendingRequests.get(cacheKey)!
    }

    const promise = this.resolveViaIpc(email, name)
    this.pendingRequests.set(cacheKey, promise)

    try {
      return await promise
    } finally {
      this.pendingRequests.delete(cacheKey)
    }
  }

  /**
   * Resolve logos for multiple emails in a single IPC call.
   */
  async resolveBatch(entries: Array<{ email: string; name?: string }>): Promise<Record<string, LogoResult>> {
    if (!ipc?.logoResolveBatch) {
      // Fallback: resolve sequentially
      const results: Record<string, LogoResult> = {}
      for (const entry of entries) {
        results[entry.email] = await this.resolveLogo(entry.email, entry.name)
      }
      return results
    }

    try {
      return await ipc.logoResolveBatch({ entries })
    } catch {
      // Fallback to sequential
      const results: Record<string, LogoResult> = {}
      for (const entry of entries) {
        results[entry.email] = await this.resolveLogo(entry.email, entry.name)
      }
      return results
    }
  }

  /**
   * Clear all cached logos.
   */
  async clearCache(): Promise<void> {
    try {
      await ipc?.logoClearCache?.()
    } catch {
      // Ignore
    }
  }

  /**
   * Resolve a single logo via IPC, with fallback to local initials.
   */
  private async resolveViaIpc(email: string, name?: string): Promise<LogoResult> {
    // If IPC bridge is not available, use local fallback immediately
    if (!ipc?.logoResolve) {
      return this.fallbackResult(email, name)
    }

    try {
      const result = await ipc.logoResolve({ email, name })
      if (result && result.type) {
        return result
      }
    } catch {
      // IPC failed — use fallback
    }

    return this.fallbackResult(email, name)
  }

  /**
   * Generate a deterministic initials fallback without any network requests.
   */
  private fallbackResult(email: string, name?: string): LogoResult {
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

export const brandLogoService = new BrandLogoService()
