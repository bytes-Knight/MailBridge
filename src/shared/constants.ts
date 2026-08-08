export const APP_NAME = 'MailBridge'
export const APP_VERSION = '1.0.0'

// Proton Mail
export const PROTON_MAIL_URL = 'https://mail.proton.me'
export const PROTON_ACCOUNT_URL = 'https://account.proton.me'

/**
 * Realistic Chrome user-agent used for Proton Mail sessions.
 *
 * We use Chrome 138 (stable since May 2025) instead of the version Electron
 * injects by default because:
 *  - Proton's bot detection flags very new / unknown Chromium versions.
 *  - Chrome 138 is older than what Electron reports (150.x) and is widely
 *    deployed, so it looks like a normal Windows desktop browser.
 *  - Keeping `Win64; x64` and the Windows NT 10.0 platform string matches the
 *    real fingerprint that Proton sees from legitimate users.
 *
 * We also override the User-Agent on the underlying Electron Session
 * (`session.fromPartition(...).setUserAgent(...)`) AND attach matching
 * `Sec-CH-UA*` Client Hints headers via `webRequest.onBeforeSendHeaders`,
 * because Proton also reads these to verify browser identity.
 */
export const PROTON_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

/** Client Hints — matches the Chrome version advertised in PROTON_USER_AGENT. */
export const PROTON_SEC_CH_UA =
  '"Not_A Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"'
export const PROTON_SEC_CH_UA_PLATFORM = '"Windows"'
export const PROTON_SEC_CH_UA_MOBILE = '?0'

// Account colors
export const ACCOUNT_COLORS = [
  '#6366f1', // indigo
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#8b5cf6'  // violet
]

// Limits
export const DEFAULT_SYNC_INTERVAL = 15 // seconds
export const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000 // 5 minutes
export const MIN_SYNC_INTERVAL = 30 // seconds

// DB
// Logo cache
/** Max in-memory cached logos */
export const LOGO_CACHE_MAX_MEMORY = 500
/** Default TTL for cached logos (7 days in ms) */
export const LOGO_CACHE_DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000
/** Cooldown before retrying a failed domain (7 days in ms) */
export const LOGO_FAILURE_COOLDOWN = 7 * 24 * 60 * 60 * 1000
/** Max consecutive failures before blacklisting a domain */
export const LOGO_FAILURE_MAX_RETRIES = 3
/** Batch size for background prefetch */
export const LOGO_PREFETCH_BATCH_SIZE = 5
/** Rate limit delay between prefetch requests (ms) */
export const LOGO_PREFETCH_RATE_LIMIT_MS = 200
/** Thumbnail size for small avatars */
export const LOGO_THUMBNAIL_SIZE = 32
/** Standard display size for full logos */
export const LOGO_DISPLAY_SIZE = 64

export const DB_NAME = 'mailbridge.db'
export const SETTINGS_KEY = 'app_settings'
