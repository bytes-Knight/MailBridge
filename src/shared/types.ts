

export type Provider = 'proton'


export type ThemeMode = 'light' | 'dark' | 'system'

export type AccentColor = 'indigo' | 'blue' | 'cyan' | 'emerald' | 'amber' | 'red' | 'pink' | 'violet'

export interface EmailAddress {
  name?: string
  address: string
}

export interface EmailAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  attachmentId?: string
  headers?: Record<string, string>
  body?: string
}

export interface EmailMessagePart {
  partId: string
  mimeType: string
  filename?: string
  headers?: Record<string, string>
  body?: {
    size: number
    data?: string
    attachmentId?: string
  }
  parts?: EmailMessagePart[]
}


export interface EmailAccount {
  id: string
  provider: Provider
  email: string
  name?: string
  avatarInitial?: string
  color: string
  isDefault?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface ProtonAccount extends EmailAccount {
  provider: 'proton'
  sessionPath?: string
  isLoggedIn?: boolean
}

export type MailAccount = ProtonAccount

export interface AppSettings {
  // General
  launchOnStartup: boolean
  minimizeToTray: boolean
  openToDashboard: boolean
  defaultAccount: string | null

  // Appearance
  theme: ThemeMode
  accentColor: AccentColor

  // Notifications
  notificationsEnabled: boolean
  notificationSound: boolean
  showPreviews: boolean
  notifyForProton: boolean
  autoDismissDuration: number
  doNotDisturb: boolean
  clickBehavior: 'open-message' | 'open-inbox'

  // Sync
  autoSync: boolean
  syncOnStartup: boolean
  syncInterval: number

  // Browser (Proton)
  clearSessionOnExit: boolean
  blockThirdPartyCookies: boolean

  // Cache
  autoClean: boolean
  cacheCleanInterval: number
}

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'completed' | 'failed'
  accountId?: string
  timestamp: number
  error?: string
}

export interface NewEmailNotification {
  id: string
  accountId: string
  provider: Provider
  notificationKey?: string
  from: EmailAddress
  subject: string
  snippet?: string
  threadId?: string
  messageId?: string
  timestamp: number
  isRead?: boolean
}

export interface NotificationPreview {
  sender: string
  subject: string
  snippet: string
}

export interface NotificationAction {
  id: string
  title: string
  tone: 'primary' | 'default' | 'danger'
}

export interface NotificationPopupState {
  id: string
  provider: Provider
  accountId: string
  threadId?: string
  messageId?: string
  sender: string
  subject: string
  snippet: string
  footer: string
  iconUrl?: string
  silent: boolean
  itemCount: number
  moreCount: number
  previews: NotificationPreview[]
  actions: NotificationAction[]
}

export interface BadgeUpdate {
  total: number
  formatted: string
  perAccount: Record<string, number>
}

export interface ErrorReport {
  id: string
  timestamp: number
  source: 'renderer' | 'main'
  level: 'error' | 'warning' | 'info'
  message: string
  stack?: string
  context?: Record<string, unknown>
  componentStack?: string
}

// ── Brand Identity / Logo Types ──────────────────────────────────────────

export type LogoSourceType = 'bimi' | 'brand' | 'favicon' | 'initials'

/** Result sent from main process to renderer for display. */
export interface LogoResult {
  /** 'svg' for BIMI SVGs to render inline, 'img' for raster, 'initials' for fallback */
  type: 'svg' | 'img' | 'initials'
  /** Data URL, SVG URL, or initials text */
  data: string
  /** Background color for initials fallback */
  backgroundColor?: string
  /** Where the logo was sourced from */
  source: LogoSourceType | 'cache' | 'generated'
  /** Whether the result came from a cache hit */
  fromCache: boolean
}

/** Full cache entry stored on disk. */
export interface LogoCacheEntry {
  domain: string
  /** Base64-encoded optimized image data (PNG for raster, or SVG text) */
  imageData: string
  /** Base64-encoded 32×32 thumbnail */
  thumbnailData: string
  /** Source type */
  sourceType: LogoSourceType | 'initials'
  /** MIME type of the image data */
  contentType: string
  /** Original logo URL (for BIMI SVG URLs) */
  logoUrl?: string
  /** ISO timestamp of last update */
  lastUpdated: string
  /** ISO timestamp when this entry expires */
  expiresAt: string
  /** Hash of imageData for change detection */
  versionHash: string
  /** Validation status */
  validationStatus: 'valid' | 'pending' | 'failed' | 'expired'
  /** Number of consecutive failures */
  failureCount: number
  /** ISO timestamp of last failure */
  lastFailure?: string
}

/** Diagnostics data for developer tools. */
export interface LogoDiagnostics {
  memoryCacheSize: number
  diskCacheSize: number
  failedDomains: number
  activeLookups: number
  totalHits: number
  totalMisses: number
  lastRefreshTime: string | null
  storageBytes: number
}

export interface EmailContextMenuAction {
  id: string
  label: string
  icon?: any
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchOnStartup: false,
  minimizeToTray: true,
  openToDashboard: false,
  defaultAccount: null,
  theme: 'dark',
  accentColor: 'indigo',
  notificationsEnabled: true,
  notificationSound: true,
  showPreviews: true,
  notifyForProton: true,
  autoDismissDuration: 5000,
  doNotDisturb: false,
  clickBehavior: 'open-message',
  autoSync: true,
  syncOnStartup: true,
  syncInterval: 20,
  clearSessionOnExit: false,
  blockThirdPartyCookies: true,
  autoClean: false,
  cacheCleanInterval: 24
}
