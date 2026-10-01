import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount } from './context/AccountContext'
import { TitleBar } from './components/common/TitleBar'
import { Sidebar } from './components/common/Sidebar'
import { SyncStatusIndicator } from './components/common/SyncStatusIndicator'
import { NotificationStack } from './components/common/NotificationStack'
import { ExternalLinkModal } from './components/common/ExternalLinkModal'
import { AddAccountModal } from './components/common/AddAccountModal'
import { Dashboard } from './components/dashboard/Dashboard'
import { ProtonView } from './components/proton/ProtonView'
import { SettingsView } from './components/settings/SettingsView'
import { useNotifications } from './hooks/useNotifications'

export type ViewMode = 'dashboard' | 'workspace' | 'settings'

export function App(): React.ReactElement {
  const { accounts, defaultAccount, loading } = useAccount()
  const [view, setView] = useState<ViewMode>('dashboard')
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [notificationNav, setNotificationNav] = useState<{ accountId: string; threadId: string } | null>(null)
  const [viewKey, setViewKey] = useState(0)
  const previouslyActiveRef = useRef<string | null>(null)
  const [externalLinkUrl, setExternalLinkUrl] = useState<string | null>(null)
  const pendingLinkRef = useRef<string | null>(null)

  // Initialize notification sound handler (sound playback managed by the hook)
  useNotifications()

  // Load every Proton account in the background at startup so they come up
  // logged-in and active without having to open each one manually. The main
  // process creates the sessions detached and keeps them alive via the
  // per-session keep-alive + mailbox-sync timers. The MemoryWatchdog /
  // single-active-session eviction still applies as the RAM safety net.
  useEffect(() => {
    if (accounts.length === 0) return
    const protonAccounts = accounts.filter(a => a.provider === 'proton')
    if (protonAccounts.length === 0) return
    const mb = (window as any).mailbridge
    if (!mb?.protonInitSession) return
    let cancelled = false
    const initAll = async () => {
      for (const account of protonAccounts) {
        if (cancelled) return
        try {
          await mb.protonInitSession(account.id)
        } catch {
          // Session init might fail (e.g. not logged in yet) — retried on next refresh
        }
      }
    }
    initAll()
    return () => { cancelled = true }
  }, [accounts])

  // Auto-open the default account's workspace on startup so the user doesn't
  // have to manually open/activate an account (unless "Open to dashboard" is on).
  const didAutoOpenRef = useRef(false)
  useEffect(() => {
    if (didAutoOpenRef.current) return
    if (loading || accounts.length === 0) return
    const run = async () => {
      let openToDashboard = true
      let preferredId: string | null = null
      try {
        const mb = (window as any).mailbridge
        const s = await mb?.settingsGet?.()
        if (s) {
          openToDashboard = !!s.openToDashboard
          preferredId = s.defaultAccount || null
        }
      } catch {
        // Default to opening the workspace if settings can't be read
      }
      const target =
        (preferredId && accounts.some(a => a.id === preferredId) ? preferredId : null) ||
        defaultAccount?.id ||
        null
      if (!openToDashboard && target) {
        setActiveAccountId(target)
        setView('workspace')
        setViewKey(k => k + 1)
      }
      didAutoOpenRef.current = true
    }
    run()
  }, [accounts, loading, defaultAccount])

  // Handle notification navigation
  useEffect(() => {
    if (notificationNav) {
      setView('workspace')
      setActiveAccountId(notificationNav.accountId)
      setViewKey(k => k + 1)
      setNotificationNav(null)
    }
  }, [notificationNav])

  useEffect(() => {
    const mb = (window as any).mailbridge
    const removeListener = mb?.onNotificationOpenConversation?.((data: { accountId?: string; threadId?: string }) => {
      if (!data?.accountId) return
      setNotificationNav({
        accountId: data.accountId,
        threadId: data.threadId || ''
      })
    })

    return () => removeListener?.()
  }, [])

  // Handle external link confirmation via IPC from main process
  useEffect(() => {
    const mb = (window as any).mailbridge
    const removeListener = mb?.onExternalLinkConfirm?.((url: string) => {
      pendingLinkRef.current = url
      setExternalLinkUrl(url)
    })
    return () => removeListener?.()
  }, [])

  const handleLinkConfirm = useCallback(() => {
    const url = pendingLinkRef.current
    if (url) {
      const mb = (window as any).mailbridge
      // Send confirmation to main process — it handles shell.openExternal
      mb?.externalLinkResult?.(true)
    }
    setExternalLinkUrl(null)
    pendingLinkRef.current = null
  }, [])

  const handleLinkCancel = useCallback(() => {
    const mb = (window as any).mailbridge
    mb?.externalLinkResult?.(false)
    setExternalLinkUrl(null)
    pendingLinkRef.current = null
  }, [])

  // When a modal opens (AddAccount or ExternalLink), hide the active Proton
  // BrowserView so it doesn't overlap the modal. Restore when all modals close.
  useEffect(() => {
    const mb = (window as any).mailbridge
    const isModalOpen = showAddModal || !!externalLinkUrl

    if (isModalOpen) {
      // Save the currently active account before hiding
      if (activeAccountId && view === 'workspace') {
        previouslyActiveRef.current = activeAccountId
        mb?.protonHideSession?.(activeAccountId)
      }
    } else {
      // Restore the previously active session when all modals are closed
      const prevId = previouslyActiveRef.current
      if (prevId) {
        previouslyActiveRef.current = null
        // Re-show the session with current bounds
        const sidebar = document.querySelector('.sidebar')
        const titlebar = document.querySelector('.titlebar')
        const sidebarWidth = sidebar?.getBoundingClientRect().width || 0
        const titlebarHeight = titlebar?.getBoundingClientRect().height || 0
        mb?.protonShowSession?.(prevId, {
          x: sidebarWidth,
          y: titlebarHeight,
          width: window.innerWidth - sidebarWidth,
          height: window.innerHeight - titlebarHeight
        })
      }
    }
  }, [showAddModal, externalLinkUrl])

  const handleNavigateToConversation = (accountId: string, threadId: string) => {
    setNotificationNav({ accountId, threadId })
  }

  // Get the active view label
  const getViewLabel = (): string => {
    if (view === 'dashboard') return 'Dashboard'
    if (view === 'settings') return 'Settings'
    if (activeAccountId) {
      const account = accounts.find(a => a.id === activeAccountId)
      return account?.name || account?.email || 'Mail'
    }
    return 'Mail'
  }

  const handleSelectAccount = (accountId: string) => {
    setActiveAccountId(accountId)
    setView('workspace')
    setViewKey(k => k + 1)
  }

  const handleBackToDashboard = () => {
    setView('dashboard')
    setActiveAccountId(null)
    setViewKey(k => k + 1)
  }

  const handleGoToSettings = () => {
    setView('settings')
    setViewKey(k => k + 1)
  }

  return (
    <div className="app-layout">
      <div className="app-bg" aria-hidden="true">
        <div className="app-bg-orb app-bg-orb--a" />
        <div className="app-bg-orb app-bg-orb--b" />
        <div className="app-bg-orb app-bg-orb--c" />
        <div className="app-bg-grid" />
        <div className="app-bg-vignette" />
      </div>
      <TitleBar
        viewLabel={getViewLabel()}
        onDashboard={handleBackToDashboard}
        onSettings={handleGoToSettings}
      />
      <div className="app-body">
        <Sidebar
          activeAccountId={activeAccountId}
          onSelectAccount={handleSelectAccount}
          onAddAccount={() => setShowAddModal(true)}
          onDashboard={handleBackToDashboard}
        />
        <main className="app-content">
          {view === 'dashboard' && (
            <div key={`view-${viewKey}`} className="view-enter">
              <Dashboard
                onSelectAccount={handleSelectAccount}
                onAddAccount={() => setShowAddModal(true)}
              />
            </div>
          )}
          {view === 'workspace' && activeAccountId && (
            <div key={`view-${viewKey}`} className="view-enter">
              {(() => {
                const account = accounts.find(a => a.id === activeAccountId)
                if (!account) return <div className="empty-state">Account not found</div>
                if (account.provider === 'proton') {
                  return <ProtonView accountId={activeAccountId} />
                }
                return null
              })()}
            </div>
          )}
          {view === 'settings' && (
            <div key={`view-${viewKey}`} className="view-enter">
              <SettingsView />
            </div>
          )}
        </main>
      </div>
      <SyncStatusIndicator />
      {showAddModal && <AddAccountModal onClose={() => setShowAddModal(false)} />}
      {externalLinkUrl && (
        <ExternalLinkModal
          url={externalLinkUrl}
          onCancel={handleLinkCancel}
          onConfirm={handleLinkConfirm}
        />
      )}
      <NotificationStack onNavigateToConversation={handleNavigateToConversation} />
    </div>
  )
}
