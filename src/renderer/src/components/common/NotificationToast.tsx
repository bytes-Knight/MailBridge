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
  const [progress, setProgress] = useState(100)
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  const onDismissRef = useRef(onDismiss)
  const durationRef = useRef(autoDismissDuration)
  onDismissRef.current = onDismiss
  durationRef.current = autoDismissDuration

  const absoluteTime = new Date(notification.timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  useEffect(() => {
    const start = Date.now()
    const notificationId = notification.id
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - start
      const remaining = Math.max(0, 100 - (elapsed / durationRef.current) * 100)
      setProgress(remaining)
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current)
        setDismissed(true)
        setTimeout(() => onDismissRef.current(notificationId), 350)
      }
    }, 150)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [notification.id])

  const handleDismiss = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    setDismissed(true)
    setTimeout(() => onDismiss(notification.id), 350)
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
  const senderFull = senderName && senderAddress
    ? `${senderName}`
    : (senderAddress || senderName || 'Proton Mail')
  const senderEmailOnly = senderAddress || ''
  const previewText = notification.snippet || notification.subject || ''
  const providerAccentClass = `nt-accent-${notification.provider}`
  const hasAttachments = notification.hasAttachments
  const isStarred = notification.isStarred

  return (
    <section className={`nt-card ${dismissed ? 'dismissing' : ''} ${providerAccentClass}`} data-testid="notification-popup" data-provider={notification.provider} role="alert" aria-live="polite">
      {/* Animated gradient glow border */}
      <div className="nt-glow-border" aria-hidden="true" />

      {/* Scan line overlay */}
      <div className="nt-scanlines" aria-hidden="true" />

      <div className="nt-shell">
        {/* Holographic avatar with orbiting particles */}
        <div className="nt-ring-wrap" aria-hidden="true">
          <span className="nt-ring nt-ring-outer" />
          <span className="nt-ring nt-ring-inner" />
          <span className="nt-ring nt-ring-particle p1" />
          <span className="nt-ring nt-ring-particle p2" />
          <span className="nt-ring nt-ring-particle p3" />
          <span className="nt-core nt-core-icon-only">
            <img className="nt-core-image" src={notification.appIconUrl || ''} alt="MailBridge" />
            <span className="nt-core-fallback">
              {senderName.charAt(0).toUpperCase() || notification.provider.charAt(0).toUpperCase()}
            </span>
          </span>
        </div>

        {/* Body */}
        <div className="nt-body">
          {/* Head row: recipient account + time */}
          <div className="nt-head-row">
            <span className="nt-recipient" title={recipientEmail}>
              <span className="nt-recipient-dot" />
              {recipientEmail || 'MailBridge'}
            </span>
            <span className="nt-time" title={`Received ${absoluteTime}`}>
              {formatRelativeTime(notification.timestamp)}
            </span>
          </div>

          {/* Clickable content area */}
          <div className="nt-content" onClick={handleOpen}>
            <div className="nt-sender-badge-row">
              <span className="nt-sender-name">{senderFull || 'Unknown Sender'}</span>
              {senderEmailOnly && senderName && (
                <span className="nt-sender-email">{senderEmailOnly}</span>
              )}
            </div>
            <h1 className="nt-subject">{notification.subject || 'New email received'}</h1>
            {previewText && (
              <p className="nt-preview-line" title={previewText}>
                {previewText}
              </p>
            )}
          </div>

          {/* Bottom row: provider badge + meta + actions */}
          <div className="nt-bottom-row">
            <div className="nt-meta-left">
              <span className="nt-tag nt-tag-provider">
                <span className="nt-tag-pulse" />
                PROTON
              </span>
              {hasAttachments && (
                <span className="nt-tag nt-tag-meta" title="Has attachments">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path d="M14 8.5A5.5 5.5 0 0 1 3.5 8.5V4a3 3 0 0 1 6 0v5a1.5 1.5 0 0 1-3 0V5h1v4a.5.5 0 0 0 1 0V4a2 2 0 1 0-4 0v4.5a4.5 4.5 0 1 0 9 0V5h1v3.5Z" fill="currentColor"/>
                  </svg>
                </span>
              )}
              {isStarred && (
                <span className="nt-tag nt-tag-meta nt-tag-starred" title="Starred">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2.943 6.525 5.573a.567.567 0 0 1-.393.278l-2.973.541 2.06 2.119c.117.12.173.286.15.45l-.39 2.924 2.777-1.282a.582.582 0 0 1 .486 0l2.777 1.282-.39-2.925a.542.542 0 0 1 .15-.45l2.06-2.118-2.973-.541a.567.567 0 0 1-.394-.278L8.498 1.788Z"/>
                  </svg>
                </span>
              )}
            </div>
            <div className="nt-actions">
              <button className="nt-btn nt-btn-default" onClick={handleDismiss}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Dismiss
              </button>
              <button className="nt-btn nt-btn-primary" onClick={handleOpen}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                  <path d="M2 4l6 4 6-4" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                </svg>
                Open
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Animated progress bar */}
      <div className="nt-progress" style={{ width: `${progress}%` }}>
        <div className="nt-progress-glow" />
      </div>
    </section>
  )
}
