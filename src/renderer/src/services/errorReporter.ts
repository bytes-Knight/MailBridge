export function initErrorReporter(): void {
  const mb = (window as any).mailbridge

  window.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason?.message || String(event.reason)

    // Suppress harmless ResizeObserver diagnostic
    if (msg.includes('ResizeObserver loop completed')) {
      event.preventDefault()
      return
    }

    const report = {
      id: generateErrorId(),
      timestamp: Date.now(),
      source: 'renderer' as const,
      level: 'error' as const,
      message: msg,
      stack: event.reason?.stack,
      context: { type: 'unhandledrejection' }
    }
    if (mb?.errorReport) {
      mb.errorReport(report)
    }
    event.preventDefault()
  })

  window.onerror = (message, source, lineno, colno, error) => {
    const msg = typeof message === 'string' ? message : String(message)

    // Suppress harmless ResizeObserver diagnostic that Chromium fires during rendering
    if (msg.includes('ResizeObserver loop completed')) {
      return
    }

    const report = {
      id: generateErrorId(),
      timestamp: Date.now(),
      source: 'renderer' as const,
      level: 'error' as const,
      message: msg,
      stack: error?.stack,
      context: { source, lineno, colno }
    }
    if (mb?.errorReport) {
      mb.errorReport(report)
    }
  }

  // Intercept console.error
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(a => safeStringify(a)).join(' ')

    // Suppress harmless ResizeObserver diagnostic from console.error too
    if (msg.includes('ResizeObserver loop completed')) {
      originalConsoleError.apply(console, args)
      return
    }

    const report = {
      id: generateErrorId(),
      timestamp: Date.now(),
      source: 'renderer' as const,
      level: 'error' as const,
      message: msg,
      context: { type: 'console.error' }
    }
    if (mb?.errorReport) {
      mb.errorReport(report)
    }
    originalConsoleError.apply(console, args)
  }
}

function generateErrorId(): string {
  return `err-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
}

function safeStringify(obj: unknown): string {
  if (typeof obj === 'string') return obj
  if (obj instanceof Error) return `${obj.message}\n${obj.stack || ''}`
  try {
    return JSON.stringify(obj)
  } catch {
    return String(obj)
  }
}
