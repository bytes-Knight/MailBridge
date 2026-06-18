import React, { useState, useEffect, useRef } from 'react'
import type { NewEmailNotification } from '@shared/types'
import { formatRelativeTime } from '@shared/helpers'

interface NotificationToastProps {
  notification: NewEmailNotification
  onDismiss: (id: string) => void
  onNavigate: (accountId: string, threadId: string) => void
  autoDismissDuration?: number // ms; default 16000 (matching proton project)
}

export function NotificationToast({ notification, onDismiss, onNavigate, autoDismissDuration = 16000 }: NotificationToastProps): React.ReactElement {
  const [dismissed, setDismissed] = useState(false)
  const [progress, setProgress] = useState(100)
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  const onDismissRef = useRef(onDismiss)
  const durationRef = useRef(autoDismissDuration)
  onDismissRef.current = onDismiss
  durationRef.current = autoDismissDuration

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
    }, 50)

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

  const avatarLetter = (notification.from.name || notification.from.address || '?')[0].toUpperCase()
  const senderName = notification.from.name || notification.from.address || 'Unknown'
  const senderAddress = notification.from.address || ''

  return (
    <section className={`nt-card ${dismissed ? 'dismissing' : ''}`} data-testid="notification-popup" data-provider={notification.provider} role="alert" aria-live="polite">
      <div className="nt-shell">
        {/* Avatar with decorative spinning rings */}
        <div className="nt-ring-wrap" aria-hidden="true">
          <span className="nt-ring nt-ring-outer" />
          <span className="nt-ring nt-ring-inner" />
          <span className="nt-core" data-has-image="false" data-image-error="false">
            <span className="nt-core-fallback">{avatarLetter}</span>
          </span>
        </div>

        {/* Body */}
        <div className="nt-body">
          {/* Head row: sender + email + time */}
          <div className="nt-head-row">
            <span className="nt-app">{senderName}</span>
            {senderAddress && <span className="nt-app-sub">{senderAddress}</span>}
            <span className="nt-time">{formatRelativeTime(notification.timestamp)}</span>
          </div>

          {/* Clickable surface: subject + preview */}
          <div className="nt-surface" data-action="open" data-role="surface" onClick={handleOpen}>
            <h1 className="nt-subject">{notification.subject || '(No Subject)'}</h1>
            {notification.snippet && (
              <p className="nt-preview">{notification.snippet}</p>
            )}
          </div>

          {/* Tags */}
          <div className="nt-tags">
            <span className="nt-tag nt-tag-provider">proton</span>
          </div>

          {/* Actions */}
          <div className="nt-actions">
            <button className="nt-btn nt-btn-default" data-action="dismiss" onClick={handleDismiss}>Dismiss</button>
            <button className="nt-btn nt-btn-primary" data-action="open" onClick={handleOpen}>Open</button>
          </div>

          {/* Hidden compat details (screen-reader accessible) */}
          <div className="nt-compat-details" aria-hidden="true">
            <p className="nt-content-detail nt-content-detail-primary">From: {notification.from.address || senderName || 'Unknown'}</p>
            <p className="nt-content-detail">Subject: {notification.subject || '(No Subject)'}</p>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="nt-progress" style={{ width: `${progress}%` }} />
    </section>
  )
}
