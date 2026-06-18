import { useState, useEffect, useCallback, useRef } from 'react'

type SyncDisplayState = 'idle' | 'syncing' | 'updated' | 'dimmed'

interface SyncStatusState {
  displayState: SyncDisplayState
  lastUpdated: number | null
  lastErrorMessage: string | null
  trackSync: <T>(promise: Promise<T>) => Promise<T>
}

export function useSyncStatus(): SyncStatusState {
  const [displayState, setDisplayState] = useState<SyncDisplayState>('idle')
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [lastErrorMessage, setLastErrorMessage] = useState<string | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearAllTimers = useCallback(() => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current = []
  }, [])

  const setTimer = useCallback((fn: () => void, delay: number): void => {
    const timer = setTimeout(() => {
      timersRef.current = timersRef.current.filter(t => t !== timer)
      fn()
    }, delay)
    timersRef.current.push(timer)
  }, [])

  useEffect(() => {
    const mb = (window as any).mailbridge

    const onStarted = () => {
      clearAllTimers()
      // Debounce: wait 300ms before showing syncing state
      setTimer(() => {
        setDisplayState('syncing')
      }, 300)
    }

    const onCompleted = () => {
      clearAllTimers()
      setLastUpdated(Date.now())
      setLastErrorMessage(null)
      setDisplayState('updated')

      // After 3s: dimmed state
      setTimer(() => {
        setDisplayState('dimmed')
      }, 3000)

      // After 33s: idle state
      setTimer(() => {
        setDisplayState('idle')
      }, 33000)
    }

    const onFailed = (data?: { error?: string }) => {
      clearAllTimers()
      setLastUpdated(Date.now())
      setLastErrorMessage(data?.error || 'Sync failed')
      setDisplayState('updated')

      // After 3s: dimmed state
      setTimer(() => {
        setDisplayState('dimmed')
      }, 3000)
    }

    const removeStarted = mb?.onSyncStatusStarted?.(onStarted)
    const removeCompleted = mb?.onSyncStatusCompleted?.(onCompleted)
    const removeFailed = mb?.onSyncStatusFailed?.(onFailed)

    return () => {
      removeStarted?.()
      removeCompleted?.()
      removeFailed?.()
      clearAllTimers()
    }
  }, [clearAllTimers, setTimer])

  const trackSync = useCallback(async <T,>(promise: Promise<T>): Promise<T> => {
    setDisplayState('syncing')
    try {
      const result = await promise
      setLastUpdated(Date.now())
      setLastErrorMessage(null)
      setDisplayState('updated')
      setTimeout(() => setDisplayState('dimmed'), 3000)
      return result
    } catch (err) {
      setLastUpdated(Date.now())
      setLastErrorMessage(err instanceof Error ? err.message : String(err))
      setDisplayState('updated')
      setTimeout(() => setDisplayState('dimmed'), 3000)
      throw err
    }
  }, [])

  return { displayState, lastUpdated, lastErrorMessage, trackSync }
}
