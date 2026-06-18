import { useState, useEffect, useCallback } from 'react'
import type { BadgeUpdate } from '@shared/types'

export function useUnreadBadge(): {
  badge: BadgeUpdate | null
  refreshBadge: () => Promise<void>
} {
  const [badge, setBadge] = useState<BadgeUpdate | null>(null)

  useEffect(() => {
    const mb = (window as any).mailbridge

    // Initial fetch
    const fetchInitial = async () => {
      try {
        if (mb?.unreadGetCount) {
          const perAccount = await mb.unreadGetCount()
          const total = Object.values(perAccount as Record<string, number>).reduce((sum, c) => sum + c, 0)
          setBadge({
            total,
            formatted: total > 99 ? '99+' : String(total),
            perAccount: perAccount as Record<string, number>
          })
        }
      } catch { /* ignore */ }
    }
    fetchInitial()

    // Listen for updates
    const removeListener = mb?.onUnreadBadgeUpdate?.((update: BadgeUpdate) => {
      setBadge(update)
    })

    return () => {
      removeListener?.()
    }
  }, [])

  const refreshBadge = useCallback(async () => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.unreadGetCount) {
        const perAccount = await mb.unreadGetCount()
        const total = Object.values(perAccount as Record<string, number>).reduce((sum, c) => sum + c, 0)
        setBadge({
          total,
          formatted: total > 99 ? '99+' : String(total),
          perAccount: perAccount as Record<string, number>
        })
      }
    } catch { /* ignore */ }
  }, [])

  return { badge, refreshBadge }
}
