import React, { useState, useEffect } from 'react'

interface TitleBarProps {
  viewLabel: string
  onDashboard: () => void
  onSettings: () => void
}

export function TitleBar({ viewLabel, onDashboard, onSettings }: TitleBarProps): React.ReactElement {
  const [isMaximized, setIsMaximized] = useState(false)
  const [unreadText, setUnreadText] = useState('')

  useEffect(() => {
    const mb = (window as any).mailbridge

    const removeMaxListener = mb?.onMaximizedChanged?.((maximized: boolean) => {
      setIsMaximized(maximized)
    })

    const removeBadgeListener = mb?.onUnreadBadgeUpdate?.((badge: any) => {
      setUnreadText(badge.formatted || '')
    })

    // Initial max state
    mb?.windowIsMaximized?.().then(setIsMaximized)

    return () => {
      removeMaxListener?.()
      removeBadgeListener?.()
    }
  }, [])

  const handleMinimize = () => {
    const mb = (window as any).mailbridge
    mb?.windowMinimize?.()
  }

  const handleMaximize = () => {
    const mb = (window as any).mailbridge
    mb?.windowMaximize?.()
  }

  const handleClose = () => {
    const mb = (window as any).mailbridge
    mb?.windowClose?.()
  }

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <div className="titlebar-left">
          <div className="titlebar-brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 7L2 7" />
            </svg>
            <span className="titlebar-name">MailBridge</span>
            {unreadText && unreadText !== '0' && (
              <span className="titlebar-badge">{unreadText}</span>
            )}
          </div>
          <span className="titlebar-view">{viewLabel}</span>
        </div>
        <div className="titlebar-center">
          <button className="titlebar-btn" onClick={onDashboard} title="Dashboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
          <button className="titlebar-btn" onClick={onSettings} title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-control" onClick={handleMinimize} title="Minimize">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button className="titlebar-control" onClick={handleMaximize} title={isMaximized ? 'Restore' : 'Maximize'}>
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="0.5" y="2.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
        <button className="titlebar-control titlebar-close" onClick={handleClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
