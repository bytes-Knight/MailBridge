import React, { useState, useEffect, useCallback, useRef } from 'react'

interface ProtonViewProps {
  accountId: string
}

type SessionState = 'idle' | 'loading' | 'active' | 'error' | 'crashed' | 'unresponsive'
type SyncStatus = 'idle' | 'syncing'

export function ProtonView({ accountId }: ProtonViewProps): React.ReactElement {
  const [sessionState, setSessionState] = useState<SessionState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null)
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncCheckRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll the injected observer's sync status from the Proton webview
  const pollSyncStatus = useCallback(async () => {
    try {
      const mb = (window as any).mailbridge
      const result = await mb?.protonIsLoggedIn?.(accountId)
      if (!result) return

      // Read sync status from the injected observer
      // We use a small IPC via the existing protonKeepAlive mechanism
      // to check if the injection is alive
      await mb?.protonKeepAlive?.(accountId)

      // Update last sync time from our local timer
      setLastSyncTime(Date.now())
      setSyncStatus('idle')
    } catch {
      // Webview might not be ready
    }
  }, [accountId])

  const initSession = useCallback(async () => {
    setSessionState('loading')
    setErrorMessage(null)
    try {
      const mb = (window as any).mailbridge
      // Try to restore an existing hidden session first
      const result = await mb?.protonCreateSession?.(accountId)
      // If session was restored (not created fresh), resize to current layout
      if (result?.restored) {
        const sidebar = document.querySelector('.sidebar')
        const titlebar = document.querySelector('.titlebar')
        const sidebarWidth = sidebar?.getBoundingClientRect().width || 0
        const titlebarHeight = titlebar?.getBoundingClientRect().height || 0
        await mb?.protonResizeSession?.(accountId, {
          x: sidebarWidth,
          y: titlebarHeight,
          width: window.innerWidth - sidebarWidth,
          height: window.innerHeight - titlebarHeight
        })
      }
      setSessionState('active')
    } catch (err) {
      setSessionState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start Proton session')
    }
  }, [accountId])

  useEffect(() => {
    initSession()

    const mb = (window as any).mailbridge

    // Start periodic keep-alive pings (every 2 minutes) to prevent proton timeout.
    // We *do* keep this alive even when the window is hidden because Proton's
    // login state requires periodic browser activity.
    keepAliveRef.current = setInterval(() => {
      // Skip while the whole app is backgrounded — the main process runs its own
      // per-account keep-alive (startKeepAlive in proton-handler.ts) at 4min, so
      // we don't need to also ping here while the user can't see the result.
      if (typeof document !== 'undefined' && document.hidden) return
      mb?.protonKeepAlive?.(accountId)
    }, 2 * 60 * 1000)

    // Poll sync status every 15 seconds (matching the mailbox observer periodic sync).
    // Pauses automatically while the window is hidden — the IPC round-trip per
    // tick is cheap but pointless and a few hundred K can be reclaimed over time.
    syncCheckRef.current = setInterval(pollSyncStatus, 15 * 1000)

    const removeLoginListener = mb?.onProtonStatus?.((data: any) => {
      if (data.status === 'logged-in') setSessionState('active')
    })

    // If the main window is hidden while this view is mounted, immediately pause
    // the React-side polling timers. mailbridge:visibility is emitted from
    // main-window.ts; the renderer subscribes via document visibilitychange which
    // is the browser-native equivalent.
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (syncCheckRef.current) {
          clearInterval(syncCheckRef.current)
          syncCheckRef.current = null
        }
      } else if (!syncCheckRef.current) {
        syncCheckRef.current = setInterval(pollSyncStatus, 15 * 1000)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      // Hide instead of destroy — keeps the session alive in the background
      mb?.protonHideSession?.(accountId)
      if (keepAliveRef.current) clearInterval(keepAliveRef.current)
      if (syncCheckRef.current) clearInterval(syncCheckRef.current)
      keepAliveRef.current = null
      syncCheckRef.current = null
      removeLoginListener?.()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [accountId, initSession, pollSyncStatus])

  const handleRefresh = useCallback(async () => {
    try {
      setSyncStatus('syncing')
      const mb = (window as any).mailbridge
      // Trigger gentle mailbox sync (calls __mailbridgeMailboxSyncNow in Proton webview)
      await mb?.protonRefreshSession?.(accountId)
      setLastSyncTime(Date.now())
      // Show syncing state for 2 seconds minimum for feedback
      setTimeout(() => setSyncStatus('idle'), 2000)
    } catch { /* ignore */ }
  }, [accountId])

  const handleReload = useCallback(async () => {
    try {
      const mb = (window as any).mailbridge
      await mb?.protonDestroySession?.(accountId)
      await initSession()
    } catch { /* ignore */ }
  }, [accountId, initSession])

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      const mb = (window as any).mailbridge
      const sidebar = document.querySelector('.sidebar')
      const titlebar = document.querySelector('.titlebar')
      const sidebarWidth = sidebar?.getBoundingClientRect().width || 0
      const titlebarHeight = titlebar?.getBoundingClientRect().height || 0

      mb?.protonResizeSession?.(accountId, {
        x: sidebarWidth,
        y: titlebarHeight,
        width: window.innerWidth - sidebarWidth,
        height: window.innerHeight - titlebarHeight
      })
    }

    window.addEventListener('resize', handleResize)
    handleResize()
    const interval = setInterval(handleResize, 1000)

    return () => {
      window.removeEventListener('resize', handleResize)
      clearInterval(interval)
    }
  }, [accountId, sessionState])

  if (sessionState === 'idle' || sessionState === 'loading') {
    return (
      <div className="proton-loading">
        <div className="proton-loading-spinner" />
        <p>Loading Proton Mail...</p>
      </div>
    )
  }

  if (sessionState === 'error') {
    return (
      <div className="proton-error">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <h3>Proton Mail Error</h3>
        <p>{errorMessage || 'An error occurred loading Proton Mail'}</p>
        <button className="btn primary" onClick={handleReload}>Retry</button>
      </div>
    )
  }

  if (sessionState === 'crashed') {
    return (
      <div className="proton-error">
        <h3>Proton Mail Crashed</h3>
        <p>The Proton Mail view has crashed</p>
        <button className="btn primary" onClick={handleReload}>Reload</button>
      </div>
    )
  }

  const formatLastSync = () => {
    if (!lastSyncTime) return 'Auto-refresh active'
    const seconds = Math.floor((Date.now() - lastSyncTime) / 1000)
    if (seconds < 60) return `Synced ${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    return `Synced ${minutes}m ago`
  }

  return (
    <div className="proton-view">
      <div className="proton-floating-refresh">
        <button
          className={`proton-refresh-btn ${syncStatus === 'syncing' ? 'is-syncing' : ''}`}
          onClick={handleRefresh}
          title="Refresh Proton Mail"
          disabled={syncStatus === 'syncing'}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={syncStatus === 'syncing' ? 'spin' : ''}
          >
            <path d="M21 2v6h-6M3 12a9 9 0 0115.364-6.364L21 8M3 22v-6h6M21 12a9 9 0 01-15.364 6.364L3 16" />
          </svg>
        </button>
        <span className="proton-sync-status">{syncStatus === 'syncing' ? 'Syncing...' : formatLastSync()}</span>
      </div>
      <div className="proton-active-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <p>Proton Mail browser view active</p>
        <span className="proton-sync-indicator">
          <span className={`proton-sync-dot ${syncStatus === 'syncing' ? 'syncing' : 'idle'}`} />
          Auto-refresh every minute
        </span>
      </div>
    </div>
  )
}
