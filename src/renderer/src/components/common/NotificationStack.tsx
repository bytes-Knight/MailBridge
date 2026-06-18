import React, { useState, useCallback, useEffect } from 'react'
import { NotificationToast } from './NotificationToast'
import type { NewEmailNotification } from '@shared/types'

interface NotificationStackProps {
  onNavigateToConversation: (accountId: string, threadId: string) => void
}

export function NotificationStack({ onNavigateToConversation }: NotificationStackProps): React.ReactElement {
  const [notification, setNotification] = useState<NewEmailNotification | null>(null)
  const [autoDismissDuration, setAutoDismissDuration] = useState(5000)

  // Load auto-dismiss duration from user settings
  useEffect(() => {
    const mb = (window as any).mailbridge
    mb?.settingsGet?.().then((settings: any) => {
      if (settings?.autoDismissDuration !== undefined) {
        setAutoDismissDuration(Number(settings.autoDismissDuration))
      }
    }).catch(() => {})
  }, [])

  // Listen for new notifications — show only the latest one at a time
  useEffect(() => {
    const mb = (window as any).mailbridge
    const removeListener = mb?.onNewEmailNotification?.((newNotif: NewEmailNotification) => {
      setNotification(newNotif)
    })
    return () => removeListener?.()
  }, [])

  const handleDismiss = useCallback(() => {
    setNotification(null)
  }, [])

  const handleNavigate = useCallback((accountId: string, threadId: string) => {
    onNavigateToConversation(accountId, threadId)
    setNotification(null)
  }, [onNavigateToConversation])

  if (!notification) return <></>

  return (
    <div className="notification-stack" role="region" aria-label="Notifications">
      <NotificationToast
        key={notification.id}
        notification={notification}
        onDismiss={handleDismiss}
        onNavigate={handleNavigate}
        autoDismissDuration={autoDismissDuration}
      />
    </div>
  )
}
