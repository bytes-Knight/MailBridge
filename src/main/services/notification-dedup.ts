import { storageService } from './storage'

export function isNotificationSeen(id: string): boolean {
  return storageService.isNotificationSeen(id)
}

export function markNotificationSeen(id: string): void {
  storageService.markNotificationSeen(id)
}

export function evictStaleNotifications(): void {
  storageService.evictStaleNotifications()
}

export function clearAccountNotifications(accountId: string): void {
  storageService.clearAccountNotifications(accountId)
}

export function clearAllNotifications(): void {
  // Re-create the dedup store
}
