import type { NewEmailNotification } from '@shared/types'

type NotificationCenterOptions = {
  flushDebounceMs?: number
  dedupeWindowMs?: number
  onFlush: (items: NewEmailNotification[]) => void
}

export class NotificationCenter {
  private readonly flushDebounceMs: number
  private readonly dedupeWindowMs: number
  private readonly onFlush: NotificationCenterOptions['onFlush']
  private readonly queues = new Map<string, { items: NewEmailNotification[]; timer: NodeJS.Timeout | null }>()
  private readonly seen = new Map<string, number>()

  constructor(options: NotificationCenterOptions) {
    this.flushDebounceMs = options.flushDebounceMs ?? 1800
    this.dedupeWindowMs = options.dedupeWindowMs ?? 90000
    this.onFlush = options.onFlush
  }

  enqueue(item: NewEmailNotification): void {
    const dedupeKey = `${item.provider}:${item.accountId}:${item.notificationKey || item.id}`
    const now = Date.now()
    const lastSeen = this.seen.get(dedupeKey) ?? 0

    if (now - lastSeen < this.dedupeWindowMs) {
      return
    }

    this.seen.set(dedupeKey, now)
    this.pruneSeen(now)

    const queueKey = `${item.provider}:${item.accountId}`
    const queue = this.queues.get(queueKey) ?? { items: [], timer: null }
    queue.items.push(item)

    if (!queue.timer) {
      queue.timer = setTimeout(() => this.flush(queueKey), this.flushDebounceMs)
    }

    this.queues.set(queueKey, queue)
  }

  flushAll(): void {
    for (const key of Array.from(this.queues.keys())) {
      this.flush(key)
    }
  }

  private flush(queueKey: string): void {
    const queue = this.queues.get(queueKey)
    if (!queue) return

    if (queue.timer) {
      clearTimeout(queue.timer)
    }

    this.queues.delete(queueKey)

    if (queue.items.length > 0) {
      this.onFlush(queue.items)
    }
  }

  private pruneSeen(now: number): void {
    for (const [key, value] of this.seen.entries()) {
      if (now - value >= this.dedupeWindowMs) {
        this.seen.delete(key)
      }
    }
  }
}
