import { useState, useEffect, useCallback, useRef } from 'react'

export function useNotifications(): { soundEnabled: boolean } {
  const [soundEnabled, setSoundEnabled] = useState(true)
  const audioContextRef = useRef<AudioContext | null>(null)

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

    // Listen for sound play (sent from main process)
    const removeSoundListener = mb?.onNotificationSoundPlay?.((data: { soundData?: string }) => {
      playNotificationSound(data?.soundData || null)
    })

    return () => {
      removeSoundListener?.()
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
        // Resume AudioContext if suspended (autoplay policy)
        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume()
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

  return { soundEnabled }
}
