import { useState, useEffect, useCallback, useRef } from 'react'
import type { NewEmailNotification } from '@shared/types'

interface NotificationState {
  queue: NewEmailNotification[]
  history: NewEmailNotification[]
  soundEnabled: boolean
}

export function useNotifications(): NotificationState {
  const [queue, setQueue] = useState<NewEmailNotification[]>([])
  const [history, setHistory] = useState<NewEmailNotification[]>([])
  const [soundEnabled, setSoundEnabled] = useState(true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const maxVisible = 5
  const maxHistory = 100

  useEffect(() => {
    const mb = (window as any).mailbridge

    // Load preferences
    const loadPrefs = async () => {
      try {
        if (mb?.settingsGet) {
          const settings = await mb.settingsGet()
          setSoundEnabled(settings.notificationSound !== false)
        }
      } catch { /* ignore */ }
    }
    loadPrefs()

    // Listen for new notifications
    const removeListener = mb?.onNewEmailNotification?.((notification: NewEmailNotification) => {
      setQueue(prev => {
        const next = [...prev, notification].slice(-maxVisible)
        return next
      })
      setHistory(prev => {
        return [notification, ...prev].slice(0, maxHistory)
      })

      // Auto-dismiss
      const timer = setTimeout(() => {
        setQueue(prev => prev.filter(n => n.id !== notification.id))
        timersRef.current.delete(notification.id)
      }, 5000)
      timersRef.current.set(notification.id, timer)
    })

    // Listen for sound play
    const removeSoundListener = mb?.onNotificationSoundPlay?.((data: { soundData?: string }) => {
      playNotificationSound(data?.soundData || null)
    })

    // Listen for conversation navigation
    const removeNavListener = mb?.onNotificationOpenConversation?.((data: any) => {
      // Navigation is handled by App component
    })

    return () => {
      removeListener?.()
      removeSoundListener?.()
      removeNavListener?.()
      timersRef.current.forEach(t => clearTimeout(t))
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  const playNotificationSound = useCallback(async (soundData: string | null) => {
    try {
      if (soundData) {
        // Play the notification sound file (MP3 sent from main process as data URL)
        const audio = new Audio(soundData)
        audio.volume = 0.5
        await audio.play()
      } else {
        // Fallback: generate a simple beep using Web Audio API
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext()
        }
        const ctx = audioContextRef.current
        const oscillator = ctx.createOscillator()
        const gainNode = ctx.createGain()

        oscillator.type = 'sine'
        oscillator.frequency.value = 880 // A5
        gainNode.gain.value = 0.3

        oscillator.connect(gainNode)
        gainNode.connect(ctx.destination)

        oscillator.start()
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25)
        oscillator.stop(ctx.currentTime + 0.25)
      }
    } catch {
      // Audio playback failed silently
    }
  }, [])

  const dismissNotification = useCallback((notificationId: string) => {
    setQueue(prev => prev.filter(n => n.id !== notificationId))
    const timer = timersRef.current.get(notificationId)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(notificationId)
    }
  }, [])

  return { queue, history, soundEnabled }
}
