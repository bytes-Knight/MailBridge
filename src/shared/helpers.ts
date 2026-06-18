export function decodeBase64(data: string): string {
  // Convert base64url to standard base64 with proper padding
  let normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  // Restore padding: Gmail API strips padding from base64url data
  const remainder = normalized.length % 4
  if (remainder === 1) {
    normalized += '==='
  } else if (remainder === 2) {
    normalized += '=='
  } else if (remainder === 3) {
    normalized += '='
  }
  try {
    const binary = atob(normalized)
    // Convert to Uint8Array so TextDecoder can handle multi-byte UTF-8
    // (emojis, CJK, accented chars, etc.) that atob() would garble.
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export function generateId(provider: string): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength).trimEnd() + '...'
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function formatDate(timestamp: string | number): string {
  const date = new Date(Number(timestamp))
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function extractEmailAddress(email: string): string {
  const match = email.match(/<([^>]+)>/)
  return match ? match[1] : email
}

export function extractName(email: string): string | undefined {
  const match = email.match(/^([^<]+)</)
  return match ? match[1].trim() : undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

export function throttle<T extends (...args: unknown[]) => void>(fn: T, limit: number): (...args: Parameters<T>) => void {
  let inThrottle = false
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args)
      inThrottle = true
      setTimeout(() => { inThrottle = false }, limit)
    }
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
