import React, { useState, useCallback, useEffect, useRef } from 'react'
import { NotificationToast } from './NotificationToast'
import type { NewEmailNotification } from '@shared/types'

interface NotificationStackProps {
  onNavigateToConversation: (accountId: string, threadId: string) => void
}

const MAX_STACK = 5

export function NotificationStack({ onNavigateToConversation }: NotificationStackProps): React.ReactElement {
  const [notifications, setNotifications] = useState<NewEmailNotification[]>([])
  const [autoDismissDuration, setAutoDismissDuration] = useState(5000)
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Load auto-dismiss duration from user settings
  useEffect(() => {
    const mb = (window as any).mailbridge
    mb?.settingsGet?.().then((settings: any) => {
      if (settings?.autoDismissDuration !== undefined) {
        setAutoDismissDuration(Number(settings.autoDismissDuration))
      }
    }).catch(() => {})
  }, [])

  // Listen for new notifications — stack multiple at a time
  useEffect(() => {
    const mb = (window as any).mailbridge
    const removeListener = mb?.onNewEmailNotification?.((newNotif: NewEmailNotification) => {
      setNotifications(prev => {
        const next = [newNotif, ...prev].slice(0, MAX_STACK)
        return next
      })

      // Auto-dismiss timer for this notification
      const timer = setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== newNotif.id))
        dismissTimersRef.current.delete(newNotif.id)
      }, autoDismissDuration || 5000)
      dismissTimersRef.current.set(newNotif.id, timer)
    })
    return () => {
      removeListener?.()
      dismissTimersRef.current.forEach(t => clearTimeout(t))
    }
  }, [autoDismissDuration])

  const handleDismiss = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
    const timer = dismissTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      dismissTimersRef.current.delete(id)
    }
  }, [])

  const handleNavigate = useCallback((accountId: string, threadId: string) => {
    onNavigateToConversation(accountId, threadId)
  }, [onNavigateToConversation])

  if (notifications.length === 0) return <></>

  return (
    <div className="notification-stack" role="region" aria-label="Notifications">
      {notifications.map((notif, index) => (
        <div key={notif.id} className="nt-stack-item" style={{ zIndex: notifications.length - index }}>
          <NotificationToast
            notification={notif}
            onDismiss={handleDismiss}
            onNavigate={handleNavigate}
            autoDismissDuration={autoDismissDuration}
          />
        </div>
      ))}
    </div>
  )
}
