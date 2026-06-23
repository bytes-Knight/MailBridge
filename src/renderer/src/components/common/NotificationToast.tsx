import React, { useState, useEffect, useRef } from 'react'
import type { NewEmailNotification } from '@shared/types'
import { formatRelativeTime } from '@shared/helpers'

interface NotificationToastProps {
  notification: NewEmailNotification
  onDismiss: (id: string) => void
  onNavigate: (accountId: string, threadId: string) => void
  autoDismissDuration?: number
}

export function NotificationToast({ notification, onDismiss, onNavigate, autoDismissDuration = 16000 }: NotificationToastProps): React.ReactElement {
  const [dismissed, setDismissed] = useState(false)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  const absoluteTime = new Date(notification.timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  useEffect(() => {
    const nid = notification.id
    const timer = setTimeout(() => {
      setDismissed(true)
      setTimeout(() => dismissRef.current(nid), 300)
    }, autoDismissDuration)

    return () => clearTimeout(timer)
  }, [notification.id, autoDismissDuration])

  const handleDismiss = () => {
    setDismissed(true)
    setTimeout(() => onDismiss(notification.id), 300)
  }

  const handleOpen = () => {
    if (notification.threadId) {
      onNavigate(notification.accountId, notification.threadId)
    }
    handleDismiss()
  }

  const recipientEmail = notification.accountEmail || ''
  const senderName = notification.from.name || ''
  const senderAddress = notification.from.address || ''
  const senderDisplay = senderName && senderAddress
    ? senderName
    : (senderAddress || senderName || 'Proton Mail')
  // Only show snippet if it's different from the subject and non-empty,
  // to avoid duplicating the subject line
  const rawSnippet = notification.snippet || ''
  const hasMeaningfulSnippet = rawSnippet &&
    rawSnippet !== notification.subject &&
    !notification.subject?.includes(rawSnippet) &&
    rawSnippet.length > 3
  const isStacked = false // feature flag for future stacked variant
  const providerTag = notification.provider === 'proton' ? 'Proton' : 'Mail'

  return (
    <section
      className={`nt-toast ${dismissed ? 'nt-toast--out' : ''} ${isStacked ? 'nt-toast--stacked' : ''}`}
      data-testid="notification-popup"
      data-provider={notification.provider}
      role="alert"
      aria-live="polite"
    >
      <div className="nt-toast-row">
        <div className="nt-toast-icon-wrap" aria-hidden="true">
          <div className="nt-toast-icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="4" width="20" height="16" rx="3" fill="white" fillOpacity="0.15" stroke="white" strokeWidth="1.5" />
              <path d="M2 8l10 7 10-7" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="nt-toast-icon-dot" />
        </div>

        <div className="nt-toast-body">
          <div className="nt-toast-head">
            <span className="nt-toast-label" title={recipientEmail}>
              {recipientEmail || 'MailBridge'}
            </span>
            <span className="nt-toast-time" title={`Received ${absoluteTime}`}>
              {formatRelativeTime(notification.timestamp)}
            </span>
          </div>

          <div className="nt-toast-sender">
            {senderDisplay || 'Unknown Sender'}
          </div>

          <div className="nt-toast-preview" onClick={handleOpen}>
            <span>{notification.subject || 'New email received'}</span>
            {hasMeaningfulSnippet && (
              <>
                <span className="nt-toast-sep">·</span>
                <span>{rawSnippet.split('\n')[0]}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="nt-toast-footer">
        <span className="nt-toast-badge">{providerTag}</span>

        <div className="nt-toast-actions">
            <button className="nt-toast-btn nt-toast-btn--secondary" onClick={handleDismiss}>
            Dismiss
          </button>
          <button className="nt-toast-btn nt-toast-btn--primary" onClick={handleOpen}>
            {notification.provider === 'proton' ? 'Open Proton Mail' : 'Open Email'}
          </button>
        </div>
      </div>
    </section>
  )
}
