import React, { useState, useEffect, useRef } from 'react'
import { useSyncStatus } from '../../hooks/useSyncStatus'
import { formatRelativeTime } from '@shared/helpers'

export function SyncStatusIndicator(): React.ReactElement {
  const { displayState, lastUpdated, lastErrorMessage } = useSyncStatus()
  const [visible, setVisible] = useState(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    requestAnimationFrame(() => {
      if (mountedRef.current) setVisible(true)
    })
    return () => { mountedRef.current = false }
  }, [])

  const isIdle = displayState === 'idle'
  const isDimmed = displayState === 'dimmed'
  const isFaded = isDimmed && lastUpdated && Date.now() - lastUpdated > 30000

  const getIcon = () => {
    switch (displayState) {
      case 'syncing':
        return (
          <svg className="sync-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 2v6h-6M3 12a9 9 0 0115.364-6.364L21 8M3 22v-6h6M21 12a9 9 0 01-15.364 6.364L3 16" />
          </svg>
        )
      case 'updated':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )
      default:
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
    }
  }

  const getStatusClass = () => {
    const classes = ['sync-status']
    if (visible) classes.push('visible')
    if (displayState === 'syncing') classes.push('syncing')
    if (displayState === 'updated') classes.push('updated')
    if (isFaded) classes.push('faded')
    return classes.join(' ')
  }

  const getRelativeTime = () => {
    if (!lastUpdated) return ''
    const diff = Date.now() - lastUpdated
    if (diff < 5000) return 'now'
    return formatRelativeTime(lastUpdated)
  }

  return (
    <div className={getStatusClass()} role="status" aria-live="polite" title={lastErrorMessage || undefined}>
      {getIcon()}
      <span className="sync-status-text">
        {displayState === 'syncing' ? 'Syncing...' : displayState === 'updated' ? 'Updated' : ''}
      </span>
      {lastUpdated && (
        <span className="sync-status-time">{getRelativeTime()}</span>
      )}
    </div>
  )
}
