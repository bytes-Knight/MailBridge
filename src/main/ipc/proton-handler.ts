import { app, ipcMain, session, BrowserView, BrowserWindow, shell } from 'electron'
import { IpcChannels } from '@shared/ipc'
import {
  PROTON_MAIL_URL,
  PROTON_USER_AGENT,
  PROTON_SEC_CH_UA,
  PROTON_SEC_CH_UA_PLATFORM,
  PROTON_SEC_CH_UA_MOBILE,
} from '@shared/constants'
import { withTimeout } from '@shared/helpers'
import { logger } from '../services/logger'
import { notificationService } from '../services/notification-service'
import { storageService } from '../services/storage'
import type { NewEmailNotification } from '@shared/types'

/**
 * Each Proton account runs inside its own Electron BrowserView that is
 * attached to the MailBridge main window. This gives every account:
 *   - A dedicated `webContents` (true per-account browser instance)
 *   - A dedicated OS-level session / partition: `persist:proton-${accountId}`
 *   - Independent title updates, page-title-updated events and notification
 *   detection — so two accounts in different states can't leak into each other.
 *
 * BrowserView (rather than BrowserWindow) keeps the Proton content visually
 * embedded inside the MailBridge window — exactly like before — while still
 * passing the realistic Chrome 138 user-agent + Client Hints on every request
 * so Proton can't tell apart MailBridge from a real Chrome browser.
 *
 * The user-agent override is the actual protection against Proton's
 * multi-account heuristics: each session gets its own `setUserAgent` +
 * `webRequest.onBeforeSendHeaders` setup below in `applyChromeFingerprint`,
 * so Proton sees a coherent Windows-Chrome-138 fingerprint from each account
 * even though they all live inside the same OS process.
 */
interface ProtonSession {
  view: BrowserView
  partition: string
}
const sessions = new Map<string, ProtonSession>()

/** Periodic keep-alive timers for each Proton session to prevent logout. */
const keepAliveTimers = new Map<string, ReturnType<typeof setInterval>>()

/** Periodic mailbox sync timers (refreshing Proton's own mailbox view). */
const mailboxSyncTimers = new Map<string, ReturnType<typeof setInterval>>()
const backgroundSyncTimers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Tracks whether the main window is currently visible to the user. While the
 * window is hidden (minimised or in the system tray) we disconnect the heavy
 * DOM MutationObserver inside each Proton BrowserView — the worst single
 * source of idle RAM in each renderer process. The 10-second mailbox-sync /
 * refresh-button-click timer that lives in the main process keeps running
 * uninterrupted on purpose, so the user-visible Proton refresh cadence is the
 * same whether the window is in the tray or visible. Proton's own
 * `page-title-updated` events continue to fire for notifications regardless.
 */
let isAppVisible = true
let visibilityListenersAttached = false

/** 10-second heartbeat — matches Proton project's PROTON_MAILBOX_REFRESH_HEARTBEAT_MS */
const MAILBOX_SYNC_INTERVAL_MS = 10_000

/** 15-minute background sync — matches Proton project's PROTON_BACKGROUND_SYNC_INTERVAL_MS */
const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000

/**
 * Connect / disconnect lifecycle for the foreground↔background throttling system.
 * Registered at app-level so `main-window.ts` can broadcast visibility changes
 * through `app.emit('mailbridge:visibility', ...)` without taking a direct
 * dependency on the Proton handler module.
 */
function registerVisibilityHandlers(): void {
  // Idempotent guard — only attach the listener once even if this module is
  // re-evaluated. We deliberately avoid `app.removeAllListeners(...)` so any
  // future subscribers (telemetry, another service module) aren't wiped.
  if (visibilityListenersAttached) return
  visibilityListenersAttached = true
  // NB: emitters in main-window.ts call `app.emit('mailbridge:visibility', 'visible'|'hidden')`
  // with the state as the ONLY payload (matching Electron's EventEmitter convention so the
  // single-arg signature here works as expected). Do NOT switch to a (_event, state)
  // signature without also passing an event object from the emitters.
  // Serial chain: queue visibility changes so back-to-back show/hide transitions
  // don't race the async reconnect/disconnect observers inside each BrowserView.
  // Without this, e.g. hide can disconnect a freshly-created observer that show
  // was in the middle of installing. Awaiting the chain ensures each batch fully
  // finishes before the next begins.
  let visibilityChain: Promise<void> = Promise.resolve()
  // Electron's App type only declares built-in events on its `on` overload.
  // Cast through `unknown` to the wider `EventEmitter` shape so the custom
  // 'mailbridge:visibility' event name compiles.
  ;(app as unknown as NodeJS.EventEmitter).on('mailbridge:visibility', (state: 'visible' | 'hidden') => {
    visibilityChain = visibilityChain
      .then(() => applyVisibilityChange(state))
      .catch(err => {
        logger.warn('Visibility transition error', { error: String(err) })
      })
  })
}

async function applyVisibilityChange(state: 'visible' | 'hidden'): Promise<void> {
  const next = state === 'visible'
  if (next === isAppVisible) return
  isAppVisible = next
  logger.info('MailBridge visibility changed', { state })
  if (next) {
    // Coming back to foreground: reattach only the injected DOM MutationObserver
    // inside each Proton BrowserView. We deliberately do NOT call
    // `startMailboxSync(...)` here — the 10-second mailbox-sync timer (which
    // drives the user-visible Proton refresh button click via runSyncTick ->
    // clickRefreshButton) has been running the entire time the window was
    // hidden and must continue without interruption when the window returns.
    for (const [accountId, session_] of Array.from(sessions.entries())) {
      try {
        await reconnectProtonObserver(session_.view).catch(() => { /* ignore */ })
      } catch (err) {
        logger.warn('Failed to resume Proton observer on show', { accountId, error: String(err) })
      }
    }
  } else {
    // Going to background: disconnect only the injected DOM MutationObserver
    // (the heaviest single source of idle RAM in each Proton BrowserView).
    // We deliberately do NOT call `stopMailboxSync(...)` here — the 10-second
    // mailbox-sync timer (which drives runSyncTick -> clickRefreshButton) must
    // keep firing while the window is hidden so the user-visible Proton
    // refresh cadence doesn't change just because they minimised the window
    // to the tray. Proton's own `page-title-updated` events keep notifications
    // flowing regardless.
    for (const [accountId, session_] of Array.from(sessions.entries())) {
      try {
        await disconnectProtonObserver(session_.view).catch(() => { /* ignore */ })
      } catch (err) {
        logger.warn('Failed to pause Proton observer on hide', { accountId, error: String(err) })
      }
    }
    // Hint V8 to release anything we won't need soon (main-heap only; renderer
    // heaps are managed by their own processes).
    if (global.gc && typeof global.gc === 'function') {
      try { global.gc() } catch { /* ignore */ }
    }
  }
}

/**
 * Disconnect the injected DOM MutationObserver inside a Proton BrowserView without
 * tearing down the view itself. Proton page-title-updated events still fire
 * for notifications because the web contents remain alive.
 */
async function disconnectProtonObserver(view: BrowserView): Promise<void> {
  if (!view.webContents || view.webContents.isDestroyed()) return
  await view.webContents.executeJavaScript(
    `(() => {
       try {
         if (window.__mailbridgeObserver) {
           window.__mailbridgeObserver.disconnect();
         }
         // NOTE: we deliberately do NOT touch the in-page periodic setInterval
         // (10s cadence) inside Proton — it keeps running so the
         // row-extraction cadence matches the main-process mailbox sync, and
         // the user-visible Proton refresh click keeps firing at 10s whether
         // the main window is hidden or not.
       } catch (e) { /* page context might be torn down */ }
     })()`
  ).catch(() => { /* page might not be ready */ })
}

/**
 * Reconnect the observer (or create a fresh one) inside a Proton BrowserView.
 * Called whenever the foreground status flips back to visible.
 */
async function reconnectProtonObserver(view: BrowserView): Promise<void> {
  if (!view.webContents || view.webContents.isDestroyed()) return
  // First try the lightweight in-place restart exposed by the injected script.
  const restarted = await view.webContents.executeJavaScript(
    `(() => {
       try {
         if (window.__mailbridgeRestartObserver) {
           window.__mailbridgeRestartObserver();
           return true;
         }
         return false;
       } catch (e) { return false; }
     })()`
  ).catch(() => false)
  // If the script hasn't been injected yet (e.g. user just added an account while
  // the window was hidden), fall back to a full re-injection.
  if (restarted !== true) {
    injectMailboxObserver(view)
  }
  // NOTE: we deliberately do NOT call window.__mailbridgeRestartPeriodic — the
  // injected-script's periodic timer was never stopped by disconnectProtonObserver
  // (so the 10-second row-extraction cadence matches the user-visible refresh
  // cadence regardless of window visibility).
}

/** Track last known unread count per account for notification detection. */
const lastUnreadCounts = new Map<string, number>()

/** Cooldown map to prevent duplicate notifications within a short window. */
const lastNotifTimestamps = new Map<string, number>()
const NOTIF_COOLDOWN_MS = 5000 // 5 seconds
const EMAIL_DETAIL_TIMEOUT_MS = 3000

type ProtonEmailInfo = {
  sender: string
  senderEmail: string
  subject: string
  snippet: string
  /** Relative date string from Proton Mail list view (e.g. "2h", "Jan 15") */
  date?: string
  /** Whether the email has attachment indicators in the list */
  hasAttachments?: boolean
  /** Whether the email is starred */
  isStarred?: boolean
}

/**
 * Trusted Proton domains — navigation to these is allowed without confirmation.
 */
const TRUSTED_PROTON_DOMAINS = [
  'proton.me',
  'mail.proton.me',
  'account.proton.me',
  'protonvpn.com',
  'protonmail.com',
  'protonstatus.com'
]

/**
 * Dangerous URL protocols to always block.
 */
const DANGEROUS_PROTOCOLS = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:'
]

/**
 * Check if a URL belongs to a trusted Proton domain.
 */
function isTrustedProtonUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return TRUSTED_PROTON_DOMAINS.some(domain =>
      parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    )
  } catch {
    return false
  }
}

/**
 * Check if a URL uses a dangerous protocol.
 */
function hasDangerousProtocol(url: string): boolean {
  return DANGEROUS_PROTOCOLS.some(protocol => url.toLowerCase().startsWith(protocol))
}

/**
 * Find the MailBridge main window, which is marked with the
 * `__isMainWindow` flag in `main-window.ts`. This is the window every
 * per-account Proton BrowserView will be attached to and detached from,
 * so the user always sees Proton content inside the MailBridge UI but
 * with each account in its own isolated session.
 *
 * Falls back to `BrowserWindow.getFocusedWindow()` and any focused window
 * with no parent of its own.
 */
function findMainWindow(): BrowserWindow | null {
  const all = BrowserWindow.getAllWindows()
  for (const w of all) {
    if ((w as any).__isMainWindow === true) return w
  }
  // First fallback: any window with no parent of its own is the root window.
  for (const w of all) {
    try {
      if (!w.getParentWindow()) return w
    } catch {
      // ignore — destroyed window
    }
  }
  // Last fallback: whatever is focused right now.
  return BrowserWindow.getFocusedWindow() ?? null
}

/**
 * Apply realistic Client Hints headers to every request leaving a Proton
 * session. Proton (and many other modern sites) now verify these against
 * the User-Agent to fingerprint browsers; without matching hints, the
 * request looks suspicious even if the UA looks fine.
 *
 * Calling `setUserAgent` on the Electron Session is what makes the
 * User-Agent header look real. We do both — session-level UA override +
 * request-level Client Hints — so anyone checking either signal sees a
 * consistent Windows-Chrome-138 fingerprint.
 */
function isProtonHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'proton.me' || host.endsWith('.proton.me') ||
      host === 'protonmail.com' || host.endsWith('.protonmail.com') ||
      host === 'protonvpn.com' || host.endsWith('.protonvpn.com')
    )
  } catch {
    return false
  }
}

function applyChromeFingerprint(s: Electron.Session): void {
  try {
    s.setUserAgent(PROTON_USER_AGENT)
  } catch {
    // session may already be torn down — ignore
  }
  try {
    s.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders ?? {}
      headers['Sec-CH-UA'] = PROTON_SEC_CH_UA
      headers['Sec-CH-UA-Mobile'] = PROTON_SEC_CH_UA_MOBILE
      headers['Sec-CH-UA-Platform'] = PROTON_SEC_CH_UA_PLATFORM
      // Drop the language/ECMascript hints Chromium normally sends, since
      // some sites flag them when they disagree with the rest of the fingerprint.
      // When "Block third-party cookies" is enabled, also strip cookies from
      // requests to non-Proton (third-party) hosts. The setting is read live
      // per request, so toggling it takes effect immediately.
      if (storageService.getSettings().blockThirdPartyCookies && !isProtonHost(details.url)) {
        delete headers['Cookie']
      }
      callback({ requestHeaders: headers })
    })
  } catch {
    // webRequest may already be hooked — ignore
  }
  try {
    // Block third-party cookies: don't accept Set-Cookie from non-Proton hosts.
    s.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = details.responseHeaders ?? {}
      if (storageService.getSettings().blockThirdPartyCookies && !isProtonHost(details.url)) {
        delete responseHeaders['set-cookie']
      }
      callback({ responseHeaders })
    })
  } catch {
    // webRequest may already be hooked — ignore
  }
}

/**
 * Send an external link confirmation request to the renderer.
 * Returns true if the user confirmed, false otherwise.
 * Automatically confirms for domains the user has marked as trusted.
 */
async function confirmExternalLink(url: string): Promise<boolean> {
  const mainWindow = findMainWindow()
  if (!mainWindow) return false

  // Check if the URL's hostname is in the trusted domains list
  try {
    const parsed = new URL(url)
    const settings = storageService.getSettings()
    if (settings.trustedDomains?.includes(parsed.hostname)) {
      return true // Auto-confirm trusted domains without showing modal
    }
  } catch {
    // Malformed URL — proceed to show modal
  }

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, 30000)

    const cleanup = () => {
      clearTimeout(timeout)
      try { ipcMain.removeListener(IpcChannels.EXTERNAL_LINK_RESULT, handler) } catch {}
    }

    const handler = (_event: any, confirmed: boolean) => {
      cleanup()
      resolve(confirmed)
    }

    ipcMain.once(IpcChannels.EXTERNAL_LINK_RESULT, handler)

    try {
      mainWindow.webContents.send(IpcChannels.EXTERNAL_LINK_CONFIRM, url)
    } catch {
      cleanup()
      resolve(false)
    }
  })
}

/**
 * Set up external link handling on a Proton BrowserWindow's webContents:
 * - Intercept will-navigate for link clicks within the page
 * - Intercept new-window for target=_blank links
 * - Show confirmation dialog for external URLs
 * - Open confirmed URLs in the system's default browser
 */
function setupExternalLinkHandler(view: BrowserView): void {
  const web = view.webContents
  if (!web || web.isDestroyed()) return

  // Handler for in-page navigation (normal link clicks, redirects)
  web.on('will-navigate', (event, url) => {
    // Allow trusted Proton URLs to navigate normally
    if (isTrustedProtonUrl(url)) return

    // Block dangerous protocols outright
    if (hasDangerousProtocol(url)) {
      logger.warn('Blocked dangerous URL in Proton webview', { url })
      event.preventDefault()
      return
    }

    // For external URLs, show confirmation and open in system browser
    event.preventDefault()

    confirmExternalLink(url).then(confirmed => {
      if (confirmed) {
        shell.openExternal(url).catch(err => {
          logger.error('Failed to open external link', { url, error: err })
        })
      }
    })
  })

  // Handler for new window requests (target="_blank", window.open)
  web.setWindowOpenHandler(({ url }) => {
    // Block dangerous protocols outright
    if (hasDangerousProtocol(url)) {
      logger.warn('Blocked dangerous URL from new-window', { url })
      return { action: 'deny' }
    }

    // For trusted Proton URLs, allow opening
    if (isTrustedProtonUrl(url)) {
      return { action: 'allow' }
    }

    // For external URLs, show confirmation and open in system browser
    confirmExternalLink(url).then(confirmed => {
      if (confirmed) {
        shell.openExternal(url).catch(err => {
          logger.error('Failed to open external link', { url, error: err })
        })
      }
    })

    // Always deny the actual new window — we handle it via shell.openExternal
    return { action: 'deny' }
  })
}

/**
 * Parse unread count from Proton Mail page title.
 * Examples: "(3) Inbox", "(12) Inbox - Proton Mail", "Inbox"
 */
function parseUnreadCount(title: string): number {
  const match = title.match(/^\((\d+)\)/)
  return match ? parseInt(match[1], 10) : 0
}

function buildNotificationKey(
  accountId: string,
  currentCount: number,
  emailInfo: { sender?: string; senderEmail?: string; subject?: string; snippet?: string; date?: string; hasAttachments?: boolean; isStarred?: boolean } | null
): string {
  const sender = String(emailInfo?.senderEmail || emailInfo?.sender || '').trim().toLowerCase()
  const subject = String(emailInfo?.subject || '').trim().toLowerCase()
  const snippet = String(emailInfo?.snippet || '').trim().toLowerCase()
  return [accountId, currentCount, sender, subject, snippet, Date.now()].filter(Boolean).join('|')
}

function buildProtonNotification(
  accountId: string,
  currentCount: number,
  increasedBy: number,
  emailInfo: ProtonEmailInfo | null
): NewEmailNotification {
  const id = `proton-${accountId}-${currentCount}-${Date.now()}`
  const account = storageService.getAccount(accountId)
  return {
    id,
    accountId,
    provider: 'proton',
    notificationKey: buildNotificationKey(accountId, currentCount, emailInfo),
    from: {
      name: emailInfo?.sender || 'Proton Mail',
      address: emailInfo?.senderEmail || ''
    },
    subject: emailInfo?.subject || (emailInfo?.sender ? `New email from ${emailInfo.sender}` : 'New email received'),
    snippet: emailInfo?.snippet || '',
    timestamp: Date.now(),
    date: emailInfo?.date,
    hasAttachments: emailInfo?.hasAttachments,
    isStarred: emailInfo?.isStarred
  }
}

function notifyForProtonMail(
  view: BrowserView,
  accountId: string,
  currentCount: number,
  increasedBy: number
): void {
  logger.info('Proton notify triggered', { accountId, currentCount, increasedBy })
  withTimeout(fetchLatestUnreadEmail(view, accountId), EMAIL_DETAIL_TIMEOUT_MS, null).then(emailInfo => {
    if (emailInfo) {
      logger.info('fetchLatestUnreadEmail succeeded', {
        sender: emailInfo.sender,
        subject: emailInfo.subject,
        hasDate: !!emailInfo.date,
        hasAttachments: emailInfo.hasAttachments
      })
    } else {
      logger.info('fetchLatestUnreadEmail returned null — using fallback text')
    }
    notificationService.enqueueNotification(buildProtonNotification(accountId, currentCount, increasedBy, emailInfo))
  })
}

/**
 * Pull the most recent unread row out of the Proton Mail inbox DOM, plus any
 * captured browser-notification payload from the patched Notification API.
 */
async function fetchLatestUnreadEmail(view: BrowserView, accountId: string): Promise<ProtonEmailInfo | null> {
  try {
    // Step 0: Poll for captured notification data first (Proton may fire the browser notification
    // slightly AFTER the page title update, so we need to wait a bit for __lastProtonNotification)
    const capturedData = await view.webContents.executeJavaScript(`
      (function() {
        var start = Date.now();
        var maxWait = 2500;
        var interval = 80;

        // Clear any stale notification data from UI actions (e.g. "Star conversation" toasts)
        // so we only capture fresh email notifications that fire after this point.
        window.__lastProtonNotification = null;

        function tryGet() {
          var n = window.__lastProtonNotification;
          if (n && (n.sender || n.subject || n.body)) {
            window.__lastProtonNotification = null;
            return n;
          }
          return null;
        }

        // Try immediately first (fast path)
        var immediate = tryGet();
        if (immediate) return JSON.stringify(immediate);

        // Poll with async delay if nothing yet
        return new Promise(function(resolve) {
          function poll() {
            var found = tryGet();
            if (found) {
              resolve(JSON.stringify(found));
            } else if (Date.now() - start >= maxWait) {
              resolve(null);
            } else {
              setTimeout(poll, interval);
            }
          }
          setTimeout(poll, interval);
        });
      })()
    `)

    // Parse captured notification data if found
    if (capturedData) {
      try {
        const parsed = JSON.parse(capturedData)
        if (parsed && (parsed.sender || parsed.subject || parsed.body)) {
          const sender = cleanCapturedText(parsed.sender) || ''
          const body = cleanCapturedText(parsed.body) || ''
          const subject = cleanCapturedText(parsed.subject) || ''

          // Try to extract sender email from text
          let senderEmail = ''
          const emailMatch = (parsed.senderEmail || sender || body).match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/i)
          if (emailMatch) senderEmail = emailMatch[0]

          // Get metadata from DOM
          const metaResult = await view.webContents.executeJavaScript(`
            (function() {
              try {
                var rows = document.querySelectorAll('[data-testid*="message-row" i], [class*="item-container--row"]');
                for (var ri = 0; ri < rows.length; ri++) {
                  var row = rows[ri];
                  var isRead = /\\bread\\b/i.test(row.className?.toString() || '');
                  if (isRead) continue;
                  var hasAttachments = false;
                  var isStarred = false;
                  var svgs = row.querySelectorAll('svg use');
                  for (var si = 0; si < svgs.length; si++) {
                    var href = svgs[si].getAttribute('href') || svgs[si].getAttribute('xlink:href') || '';
                    if (/attachment|paperclip|ic-paperclip|ic-attachment/i.test(href)) hasAttachments = true;
                    if (/star|ic-star/i.test(href)) isStarred = true;
                  }
                  if (!isStarred) isStarred = !!row.querySelector('[aria-label*="star" i]');
                  return JSON.stringify({ hasAttachments: hasAttachments, isStarred: isStarred });
                }
                return JSON.stringify({ hasAttachments: false, isStarred: false });
              } catch(e) {
                return JSON.stringify({ hasAttachments: false, isStarred: false });
              }
            })()
          `)
          const metadata = metaResult ? JSON.parse(metaResult) : { hasAttachments: false, isStarred: false }

          // Determine if we have meaningful data
          const hasMeaningfulSender = sender.length > 0 && !/^(proton mail|new email received|new message received|new message in proton mail|\(no subject\))$/i.test(sender)
          const hasMeaningfulSubject = subject.length > 0 && !/^(proton mail|new email received|new message received|new message in proton mail|\(no subject\))$/i.test(subject)

          if (hasMeaningfulSubject || hasMeaningfulSender) {

            return {
              sender: hasMeaningfulSender ? sender : (sender || 'New Email'),
              senderEmail: senderEmail,
              subject: hasMeaningfulSubject ? subject : (subject || 'New email received'),
              snippet: parsed.snippet || '',
              date: '',
              hasAttachments: metadata.hasAttachments,
              isStarred: metadata.isStarred
            }
          }
        }
      } catch {
        // JSON parse error — fall through to DOM strategies
      }
    }

        // --- Strategy 0.5: Targeted sender extraction from DOM ---
        // Look for the specific data-testid elements that Proton uses for sender info.
        // This is far more reliable than generic text extraction.
        const targetedResult = await view.webContents.executeJavaScript(`
          (function() {
            try {
              var unreadRows = document.querySelectorAll(
                '[data-testid*="message-item" i]:not(.read), ' +
                '[data-testid*="conversation-row" i]:not(.read), ' +
                '[data-testid*="message-row" i]:not(.read), ' +
                '[class*="item-container--row"]:not(.read)'
              );
              var allRows = unreadRows.length > 0
                ? Array.from(unreadRows)
                : Array.from(document.querySelectorAll(
                    '[data-testid*="message-item" i], ' +
                    '[data-testid*="conversation-row" i], ' +
                    '[data-testid*="message-row" i], ' +
                    '[class*="item-container--row"]'
                  ));
              for (var ri = 0; ri < allRows.length; ri++) {
                try {
                  var row = allRows[ri];
                  var rect = row.getBoundingClientRect();
                  if (rect.width < 50 || rect.height < 20) continue;
                  var senderCol = row.querySelector('[data-testid="message-column:sender-address"]');
                  if (!senderCol) senderCol = row.querySelector('[data-testid*="sender-address" i]');
                  if (senderCol) {
                    var senderEmail = senderCol.getAttribute('title') || '';
                    var senderNameSpan = senderCol.querySelector('span');
                    var senderName = senderNameSpan ? (senderNameSpan.textContent || '').trim() : '';
                    var subjectEl = row.querySelector('[data-testid="message-row:subject"]');
                    if (!subjectEl) subjectEl = row.querySelector('[id^="message-subject-"]');
                    if (!subjectEl) subjectEl = row.querySelector('[data-testid*="subject" i]');
                    var subject = subjectEl ? (subjectEl.textContent || '').trim() : '';
                    subject = subject.replace(/^\\[\\d+\\]\\s*/, '').trim();
                    var snippet = '';
                    var snippetEl = row.querySelector('[data-testid*="snippet" i]');
                    if (snippetEl) snippet = (snippetEl.textContent || '').trim();
                    var dateEl = row.querySelector('time[datetime]');
                    var date = dateEl ? (dateEl.textContent || '').trim() : '';
                    var hasAttachments = false;
                    var isStarred = false;
                    var svgs = row.querySelectorAll('svg use');
                    for (var si = 0; si < svgs.length; si++) {
                      var href = svgs[si].getAttribute('href') || svgs[si].getAttribute('xlink:href') || '';
                      if (/attachment|paperclip|ic-paperclip|ic-attachment/i.test(href)) hasAttachments = true;
                      if (/star|ic-star/i.test(href)) isStarred = true;
                    }
                    var finalName = senderName || senderEmail || 'New Email';
                    var finalEmail = senderEmail || '';
                    var emailInName = finalName.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/i);
                    if (emailInName && !finalEmail) {
                      finalEmail = emailInName[0];
                    }
                    var hasMeaningfulSender = finalName.length > 0 && !/^(proton mail|new email received|new message received|\\*\\*|__)$/i.test(finalName);
                    var hasMeaningfulSubject = subject.length > 0 && !/^(proton mail|new email received|new message received|\\(no subject\\))$/i.test(subject);
                    if (hasMeaningfulSender || hasMeaningfulSubject) {
                      return JSON.stringify({
                        sender: hasMeaningfulSender ? finalName : (finalName || 'New Email'),
                        senderEmail: finalEmail,
                        subject: hasMeaningfulSubject ? subject : (subject || 'New email received'),
                        snippet: snippet,
                        date: date,
                        hasAttachments: hasAttachments,
                        isStarred: isStarred
                      });
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}
            return null;
          })()
        `)

        if (targetedResult) {
          try {
            const parsed = JSON.parse(targetedResult)
            logger.info('Proton sender extracted via targeted DOM query', {
              sender: parsed.sender,
              senderEmail: parsed.senderEmail,
              subject: parsed.subject
            })
            return parsed
          } catch {}
        }

        // Step 1: Run DOM strategies (mailbox observer + direct scan)
        const account = storageService.getAccount(accountId)
        const accountEmail = account?.email || ''
        const accountLabel = account?.name || ''
    const result = await view.webContents.executeJavaScript(`
      (function() {
        var accountEmail = ${JSON.stringify(accountEmail)};
        var accountLabel = ${JSON.stringify(accountLabel)};

        function clean(text) {
          return String(text || '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim();
        }

        function extractEmailFromText(text) {
          var match = text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
          return match ? match[0] : '';
        }

        function isGenericText(text) {
          var normalized = clean(text).toLowerCase();
          return !normalized ||
            normalized === 'proton mail' ||
            normalized === 'new email received' ||
            normalized === 'new message received' ||
            normalized === 'new message in proton mail' ||
            normalized === '(no subject)';
        }

        function isAccountIdentity(text) {
          var normalized = clean(text).toLowerCase();
          var email = clean(accountEmail).toLowerCase();
          var label = clean(accountLabel).toLowerCase();
          if (!normalized) return false;
          if (email && (normalized === email || normalized.indexOf(email + ' |') === 0)) return true;
          if (label && (normalized === label || normalized.indexOf(label + ' |') === 0)) return true;
          return normalized.indexOf('mail.proton.me') >= 0;
        }

        function looksLikeNavigationJunk(text) {
          var normalized = clean(text).toLowerCase();
          if (!normalized) return false;
          if (normalized.length > 260) return true;
          return /\\b(open navigation|all mail|drafts|sent|starred|archive|spam|trash|folders|labels|manage your folders|create a new folder|inbox drafts sent)\\b/i.test(normalized);
        }

        function isInvalidMailboxItem(item) {
          if (!item) return true;
          var sender = clean(item.sender);
          var subject = clean(item.subject);
          var snippet = clean(item.snippet);
          if (looksLikeNavigationJunk(sender) || looksLikeNavigationJunk(subject) || looksLikeNavigationJunk(snippet)) return true;
          if (!snippet && isAccountIdentity(sender) && isAccountIdentity(subject)) return true;
          if (!snippet && sender && sender.toLowerCase() === subject.toLowerCase() && (isAccountIdentity(sender) || isAccountIdentity(subject))) return true;
          return false;
        }

        function isSeparatorOnlyLine(text) {
          var normalized = (text || '').replace(/\\s+/g, '');
          return normalized.length > 0 && /^[+*_=#~^|<>\-]{5,}$/.test(normalized);
        }

        var metadata = getRowMetadata();

        // --- Strategy 1: Read from the mailbox observer ---
        if (window.__mailbridgeLastMailboxItems && window.__mailbridgeLastMailboxItems.length > 0) {
          var candidates = window.__mailbridgeLastMailboxItems.filter(function(item) {
            return item && !isInvalidMailboxItem(item);
          });
          var unreadCandidates = candidates.filter(function(item) { return item.unread; });
          if (unreadCandidates.length > 0) candidates = unreadCandidates;
          var firstItem = candidates[0];
          if (firstItem && firstItem.sender) {
            return {
              sender: clean(firstItem.sender) || 'New Email',
              senderEmail: firstItem.senderEmail || '',
              subject: clean(firstItem.subject) || 'New email received',
              snippet: clean(firstItem.snippet) || '',
              date: firstItem.date || '',
              hasAttachments: metadata.hasAttachments,
              isStarred: metadata.isStarred
            };
          }
        }

        // --- Strategy 2: Direct DOM scan ---
        var rowSelector = [
          'main [data-testid*="message-row" i]',
          'main [data-proton-thread]',
          '[class*="item-container--row"]'
        ].join(',');
        var allRows = document.querySelectorAll(rowSelector);
        var targetRow = null;

        for (var ri = 0; ri < allRows.length; ri++) {
          try {
            var rect = allRows[ri].getBoundingClientRect();
            if (rect.width > 50 && rect.height > 20) {
              targetRow = allRows[ri];
              break;
            }
          } catch(e) {}
        }

        if (targetRow) {
          var rowTexts = [];
          var walker = document.createTreeWalker(targetRow, NodeFilter.SHOW_TEXT, null, false);
          var node;
          while (node = walker.nextNode()) {
            var t = clean(node.textContent || '');
            if (t && t.length > 1) {
              // Skip text inside SVG elements (star button tooltips, etc.)
              var p = node.parentElement;
              var inSvg = false;
              while (p) {
                if (p.tagName && p.tagName.toLowerCase() === 'svg') { inSvg = true; break; }
                p = p.parentElement;
              }
              if (inSvg) continue;
              if (/^\\d+$/.test(t)) continue;
              if (looksLikeNavigationJunk(t)) continue;
              rowTexts.push(t);
            }
          }

          var unique = [];
          for (var ui = 0; ui < rowTexts.length; ui++) {
            if (unique.indexOf(rowTexts[ui]) === -1) {
              unique.push(rowTexts[ui]);
            }
          }

          var datePattern = /^(\\d+\\s*(m|min|h|hr|d|day)\\s*ago|\\d{1,2}:\\d{2}\\s*(AM|PM)?|[A-Z][a-z]+\\s+\\d{1,2}(,\\s*\\d{4})?)$/i;
          var extractedDate = '';
          var meaningful = [];
          for (var bi = 0; bi < unique.length; bi++) {
            var block = unique[bi];
            if (datePattern.test(block)) {
              if (!extractedDate) extractedDate = block;
            } else {
              meaningful.push(block);
            }
          }

          if (meaningful.length > 0) {
            var sender2 = meaningful[0] || '';
            var subject2 = meaningful.length > 1 ? meaningful[1] : '';
            var snippet2 = meaningful.slice(2).join(' ').substring(0, 200);
            var fullText = targetRow.textContent || '';

            return {
              sender: sender2 || 'New Email',
              senderEmail: extractEmailFromText(fullText),
              subject: subject2 || 'New email received',
              snippet: snippet2 || '',
              date: extractedDate || '',
              hasAttachments: metadata.hasAttachments,
              isStarred: metadata.isStarred
            };
          }
        }

        function getRowMetadata() {
          try {
            var rows = document.querySelectorAll('[data-testid*="message-row" i], [class*="item-container--row"]');
            for (var ri = 0; ri < rows.length; ri++) {
              var row = rows[ri];
              var isRead = /\\bread\\b/i.test(row.className?.toString() || '');
              if (isRead) continue;
              var hasAttachments = false;
              var isStarred = false;
              var svgs = row.querySelectorAll('svg use');
              for (var si = 0; si < svgs.length; si++) {
                var href = svgs[si].getAttribute('href') || svgs[si].getAttribute('xlink:href') || '';
                if (/attachment|paperclip|ic-paperclip|ic-attachment/i.test(href)) hasAttachments = true;
                if (/star|ic-star/i.test(href)) isStarred = true;
              }
              if (!isStarred) isStarred = !!row.querySelector('[aria-label*="star" i]');
              return { hasAttachments: hasAttachments, isStarred: isStarred };
            }
            if (rows.length > 0) {
              var firstRow = rows[0];
              return { hasAttachments: !!firstRow.querySelector('use[href*="attachment" i], use[href*="paperclip" i]'), isStarred: !!firstRow.querySelector('[aria-label*="star" i]') };
            }
            return { hasAttachments: false, isStarred: false };
          } catch(e) {
            return { hasAttachments: false, isStarred: false };
          }
        }

        return null;
      })()
    `)
    return result
  } catch {
    return null
  }
}

function cleanCapturedText(value: string): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Inject a script into the Proton window that monkey-patches the
 * Notification constructor. This runs once after the page loads,
 * capturing Proton Mail's own notification data (sender name, subject).
 */
function injectNotificationInterceptor(view: BrowserView): void {
  if (!view.webContents || view.webContents.isDestroyed()) return
  view.webContents.executeJavaScript(`
    (function() {
      // Skip if already injected
      if (window.__protonNotifInjected) return;
      window.__protonNotifInjected = true;

      // Monkey-patch the Notification API so we capture Proton's notification data
      var OrigNotification = window.Notification;
      function PatchedNotification(title, options) {
        // Extract sender name from notification title
        var sender = (title || '').trim();

        // Skip capturing non-email notifications (UI action toasts like "Star conversation",
        // "Conversation starred", "Message deleted", etc.) so we don't pick up stale data.
        if (/\\b(star|unstar|moved|deleted|removed|archived|trashed)\\b/i.test(sender)) {
          return new OrigNotification(title, options);
        }

        // Extract subject + snippet from notification body
        var body = (options && options.body || '').trim();
        var subject = body;
        var snippet = '';
        var senderEmail = '';

        // Try to split body into subject and preview
        // Proton uses actual newline characters (\\n) to separate subject from snippet
        if (body.indexOf('\\\\n') >= 0) {
          var parts = body.split('\\\\n');
          subject = (parts[0] || '').trim();
          snippet = parts.slice(1).join(' ').trim().substring(0, 200);
        }

        // Try to extract email address from the body or notification data
        // Proton sometimes includes email in the notification body or tag data
        var bodyEmailMatch = body.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
        if (bodyEmailMatch) {
          senderEmail = bodyEmailMatch[0];
        }
        // Also check if sender itself looks like an email
        if (!senderEmail) {
          var senderEmailMatch = sender.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
          if (senderEmailMatch) {
            senderEmail = senderEmailMatch[0];
            // If sender was just an email, try to extract name from options
            if (sender === senderEmail && options && options.body) {
              sender = options.body.split('\\\\n')[0] || sender;
            }
          }
        }
        // Check the notification options for additional data (tag, data attributes)
        if (!senderEmail && options) {
          // Some notification implementations pass data via options.data or options.tag
          if (options.data && options.data.email) senderEmail = options.data.email;
          if (options.tag) {
            var tagEmailMatch = String(options.tag).match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
            if (tagEmailMatch) senderEmail = tagEmailMatch[0];
          }
        }

        window.__lastProtonNotification = {
          sender: sender || 'New Email',
          senderEmail: senderEmail,
          subject: subject || '(No Subject)',
          snippet: snippet || '',
          body: body || ''
        };

        // Still create the original notification (don't suppress Proton's UI)
        return new OrigNotification(title, options);
      }
      PatchedNotification.prototype = OrigNotification.prototype;
      PatchedNotification.requestPermission = OrigNotification.requestPermission.bind(OrigNotification);
      PatchedNotification.permission = OrigNotification.permission;

      window.Notification = PatchedNotification;
    })();
  `).catch(function() { /* page might not be ready yet, ignore */ });
}

/**
 * Inject a MutationObserver-based mailbox observer into the Proton window.
 * Mirrors `protonMailboxObserver.ts` from the Proton Mail Companion project
 * — extracts sender/subject/snippet rows, dedupes by bounding rect, and
 * exposes `__mailbridgeMailboxSyncNow()` for gentle manual refresh.
 */
function injectMailboxObserver(view: BrowserView): void {
  if (!view.webContents || view.webContents.isDestroyed()) return
  view.webContents.executeJavaScript(`
    (function() {
      // ── Guard ─────────────────────────────────────────────────────
      if (window.__mailbridgeObserverInjected) return;
      window.__mailbridgeObserverInjected = true;

      var PERIODIC_SYNC_INTERVAL_MS = 10000; // 10 seconds
      var MUTATION_SYNC_DELAY_MS = 120;     // 120ms debounce (matching Proton project)
      var MAX_ITEMS = 40;
      var syncTimer = null;
      var periodicTimer = null;

      // ── Helpers ───────────────────────────────────────────────────
      function extractText(el) {
        if (!el) return '';
        return (el.textContent || '').replace(/\\s+/g, ' ').trim();
      }

      function extractHref(el) {
        if (!el) return '';
        if (el.tagName === 'A') return el.getAttribute('href') || '';
        var a = el.querySelector('a');
        return a ? (a.getAttribute('href') || '') : '';
      }

      function normalizeBlockText(text) {
        return text
          .replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]+/g, ' ')
          .replace(/^\\s+|\\s+$/g, '')
          .replace(/\\s{2,}/g, ' ');
      }

      // ── Heuristics ────────────────────────────────────────────────
      function isExcludedMailboxRegion(el) {
        if (!el) return true;
        var tag = el.tagName.toLowerCase();
        if (tag === 'aside' || tag === 'nav' || tag === 'header' || tag === 'footer') return true;
        if (tag === 'dialog') return true;
        var role = el.getAttribute('role');
        if (role === 'toolbar' || role === 'navigation' || role === 'banner') return true;
        // Check parent elements
        var p = el.parentElement;
        while (p) {
          var pt = p.tagName.toLowerCase();
          if (pt === 'aside' || pt === 'nav' || pt === 'header' || pt === 'footer') return true;
          p = p.parentElement;
        }
        return false;
      }

      function hasDateSignal(el) {
        if (!el) return false;
        // Check for datetime attributes
        if (el.hasAttribute('datetime') || el.hasAttribute('data-timestamp') || el.hasAttribute('title')) return true;
        // Check text content for date patterns
        var text = extractText(el);
        if (!text) return false;
        // Common relative date patterns
        if (/^(\\d+)\\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\\s*(ago)?$/i.test(text)) return true;
        // Date patterns like "Jan 15", "Jan 15, 2024", "01/15", "15 Jan"
        if (/\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(,?\\s+\\d{4})?\\b/i.test(text)) return true;
        // Time patterns like "10:30 AM", "14:30"
        if (/\\b\\d{1,2}:\\d{2}\\s*(AM|PM)?\\b/i.test(text)) return true;
        return false;
      }

      function isLikelyMailboxIdentityText(text) {
        if (!text) return false;
        // Email addresses
        if (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(text)) return true;
        // Name patterns (not pure numbers, not dates, not very short)
        if (/^\\d+$/.test(text)) return false;
        if (/^\\d{1,2}:\\d{2}/.test(text)) return false;
        if (text.length < 2) return false;
        if (/\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/i.test(text) && /\\d/.test(text)) return false;
        return true;
      }

      function isLikelyDateText(text) {
        if (!text) return false;
        if (/^(\\d+)\\s*(m|min|h|hr|d|day)\\s*ago$/i.test(text.trim())) return true;
        if (/^\\d{1,2}:\\d{2}\\s*(AM|PM)?$/i.test(text.trim())) return true;
        if (/^\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?$/.test(text.trim())) return true;
        return false;
      }

      function isLikelyMailboxMetadataBlock(text) {
        var normalized = normalizeBlockText(text);
        if (!normalized || normalized === 'Unread' || isLikelyDateText(normalized)) return true;
        var lower = normalized.toLowerCase();
        return (
          lower === 'official' || lower === 'important' || lower === 'pinned' ||
          lower === 'starred' || lower === 'primary' || lower === 'social' ||
          lower === 'updates' || lower === 'forums' || lower === 'promotions' ||
          lower === 'label' || lower === 'proton' || lower === 'sent' ||
          lower === 'draft' || lower === 'drafts' ||
          /^\\d+\\s*-\\s*\\d+\\s+of\\s+\\d+$/i.test(normalized) ||
          (normalized === normalized.toUpperCase() && normalized.length > 1 && normalized.length < 15)
        );
      }

      function getMeaningfulTextBlocks(el) {
        if (!el) return [];
        var texts = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while (node = walker.nextNode()) {
          // Skip text inside SVG elements (star button tooltips, etc.)
          var p = node.parentElement;
          var inSvg = false;
          while (p) {
            if (p.tagName && p.tagName.toLowerCase() === 'svg') { inSvg = true; break; }
            p = p.parentElement;
          }
          if (inSvg) continue;
          var t = (node.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t.length > 1 && !/^[\\s\\d\\s]*$/.test(t)) {
            // Skip separator-only lines and metadata blocks
            if (isSeparatorOnlyLine(t)) continue;
            var blockText = normalizeBlockText(t);
            if (isLikelyMailboxMetadataBlock(blockText)) continue;
            texts.push(t);
          }
        }
        return texts.filter(function(t, i, self) { return self.indexOf(t) === i; }); // unique
      }

      function inferUnread(el) {
        if (!el) return false;
        // Proton's current mailbox UI renders an .item-unread-dot element only
        // on unread rows — the most reliable unread signal in the 2026 layout.
        if (el.querySelector('.item-unread-dot')) return true;
        var label = el.getAttribute('aria-label') || '';
        if (/\\bunread\\b/i.test(label)) return true;
        // Check font-weight on child elements
        var spans = el.querySelectorAll('span, b, strong');
        for (var i = 0; i < spans.length; i++) {
          var fw = window.getComputedStyle(spans[i]).fontWeight;
          if (fw === '700' || fw === 'bold') return true;
        }
        return false;
      }          // ── Row extraction ────────────────────────────────────────────
      function toSummary(row) {
        try {
          var id = row.getAttribute('data-proton-thread') ||
                   row.getAttribute('data-message-id') ||
                   row.getAttribute('data-element-id') || '';
          var textBlocks = getMeaningfulTextBlocks(row);
          var dateEl = row.querySelector('[datetime], [data-timestamp]');
          var dateText = dateEl ? extractText(dateEl) : '';
          var href = extractHref(row);

          // Extract sender, subject, snippet from text blocks
          var sender = '';
          var subject = '';
          var snippet = '';
          var senderEmail = '';

          // ── Structured extraction (Proton's current 2026 mailbox UI) ──
          // The new layout exposes sender/subject/date as explicit columns
          // with stable data-testid attributes; prefer those over heuristics.
          var senderCol = row.querySelector('[data-testid="message-row:sender-address"]');
          if (senderCol) {
            sender = extractText(senderCol);
          }
          var senderEmailCol = row.querySelector('[data-testid="message-column:sender-address"]');
          if (senderEmailCol) {
            var emailFromTitle = senderEmailCol.getAttribute('title') || '';
            if (/[\\w.+-]+@[\\w-]+\\.[\\w.]+/.test(emailFromTitle)) {
              senderEmail = emailFromTitle;
            }
          }
          var subjectCol = row.querySelector('[data-testid="message-row:subject"]');
          if (subjectCol) {
            var rawSubject = subjectCol.getAttribute('title') || extractText(subjectCol);
            // Strip conversation-count prefixes like "[3]" / "3 messages in conversation"
            subject = String(rawSubject)
              .replace(/^\\s*\\[\\d+\\]\\s*/, '')
              .replace(/^\\d+\\s+messages in conversation\\s*/i, '')
              .trim();
          }
          var dateCol = row.querySelector('[data-testid="item-date-simple"]');
          if (dateCol) {
            dateText = extractText(dateCol) || dateText;
          }

          // Strategy: find identity texts, skip dates and metadata
          var identityTexts = textBlocks.filter(function(t) {
            return isLikelyMailboxIdentityText(t) && !isLikelyDateText(t);
          });

          // Check for email addresses in identity texts
          for (var k = 0; k < identityTexts.length; k++) {
            var emailMatch = identityTexts[k].match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
            if (emailMatch) {
              senderEmail = emailMatch[0];
              // If the text is just an email, use it as both sender and email
              if (emailMatch[0] === identityTexts[k].trim()) {
                identityTexts[k] = identityTexts[k].replace(emailMatch[0], '').replace(/[<>()\\[\\]]/g, '').trim();
              }
              break;
            }
          }

          // If no email found in identity texts, try to find it elsewhere in the row
          if (!senderEmail) {
            var mailtoLinks = row.querySelectorAll('a[href^="mailto:"]');
            for (var m = 0; m < mailtoLinks.length; m++) {
              var mailHref = mailtoLinks[m].getAttribute('href') || '';
              var parsedEmail = mailHref.replace('mailto:', '').split('?')[0].trim();
              if (parsedEmail) {
                senderEmail = parsedEmail;
                break;
              }
            }
          }

          // If still no email, try using a generic email pattern on the entire row text
          if (!senderEmail) {
            var rowText = extractText(row);
            var genericMatch = rowText.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
            if (genericMatch) senderEmail = genericMatch[0];
          }

          if (!sender && identityTexts.length >= 1) {
            sender = identityTexts[0];
          }
          if (!subject && identityTexts.length >= 2) {
            subject = identityTexts[1];
          }
          if (identityTexts.length >= 3) {
            snippet = identityTexts.slice(2).join(' ');
          } else {
            // Fallback: use remaining text blocks after subject
            var remaining = textBlocks.slice(identityTexts.length);
            remaining = remaining.filter(function(t) {
              return !isLikelyDateText(t) && t !== sender && t !== subject;
            });
            if (remaining.length > 0) {
              snippet = remaining.join(' ');
            }
          }

          return {
            id: id,
            sender: normalizeBlockText(sender) || 'New Email',
            senderEmail: senderEmail,
            subject: normalizeBlockText(subject) || '(No Subject)',
            snippet: normalizeBlockText(snippet).substring(0, 200),
            unread: inferUnread(row),
            date: dateText || '',
            href: href
          };
        } catch(e) {
          return null;
        }
      }

      // ── Row validation ────────────────────────────────────────────
      function isLikelyMailboxRow(el) {
        try {
          if (!(el instanceof HTMLElement) || el.offsetParent === null) return false;

          var rect = el.getBoundingClientRect();
          // Must have meaningful dimensions — too narrow or too short is not a row
          if (rect.width < 220 || rect.height < 28 || rect.height > 240) return false;

          // Must not be in excluded regions (aside, nav, header, footer, dialog, toolbar, composer)
          if (isExcludedMailboxRegion(el)) return false;

          // Must not be a text input or contenteditable
          if (el.querySelector('textarea, [contenteditable="true"]')) return false;

          // Explicit match on known Proton row attributes
          if (el.matches('[data-proton-companion-thread], [data-proton-thread]')) return true;

          // Check text/attributes for known row patterns
          var text = [
            el.getAttribute('data-testid') || '',
            el.className?.toString() || '',
            el.getAttribute('aria-label') || ''
          ].join(' ').toLowerCase();

          var meaningfulBlocks = getMeaningfulTextBlocks(el);
          if (meaningfulBlocks.length < 2) return false;

          // Known Proton row class/testid patterns
          if (/message-row|conversation-row|thread-row|mailbox-row|message-item|conversation/.test(text)) {
            return hasDateSignal(el) || meaningfulBlocks.length >= 3;
          }

          // Fallback: must have a link to a mail/inbox/message URL and a date signal
          var href = extractHref(el);
          if (!href) return false;

          return hasDateSignal(el) && /\\/mail|\\/inbox|message/i.test(href);
        } catch(e) {
          return false;
        }
      }

      // ── Separator-only line detection ────────────────────────────
      function isSeparatorOnlyLine(text) {
        var normalized = (text || '').replace(/\\s+/g, '');
        return normalized.length > 0 && /^[+*_=#~^|<>\-]{5,}$/.test(normalized);
      }

      // ── Row collection ────────────────────────────────────────────
      function dedupeRows(rows) {
        // Sort by top then left, then filter out rows contained within other rows
        var sorted = rows.slice().sort(function(a, b) {
          try {
            var ra = a.getBoundingClientRect();
            var rb = b.getBoundingClientRect();
            return (ra.top - rb.top) || (ra.left - rb.left);
          } catch(e) { return 0; }
        });
        return sorted.filter(function(row, index) {
          try {
            var rect = row.getBoundingClientRect();
            return !sorted.some(function(other, otherIndex) {
              if (otherIndex >= index) return false;
              try {
                var otherRect = other.getBoundingClientRect();
                // Other fully contains this row
                return otherRect.left <= rect.left &&
                       otherRect.right >= rect.right &&
                       otherRect.top <= rect.top &&
                       otherRect.bottom >= rect.bottom &&
                       (otherRect.width > rect.width || otherRect.height > rect.height);
              } catch(e2) { return false; }
            });
          } catch(e) { return false; }
        });
      }

      function collectRows() {
        var rows = [];

        // Pass 1: Explicit selectors (Proton's data attributes and test IDs)
        var explicitSelectors = [
          '[data-proton-companion-thread]',
          '[data-proton-thread]',
          // Proton's current mailbox UI marks each row with
          // data-testid="message-item:<subject>"
          '[data-testid^="message-item"]',
          '[data-testid*="message-row" i]',
          '[data-testid*="conversation-row" i]',
          '[data-testid*="thread-row" i]',
          '[class*="conversation-row" i]',
          '[class*="message-row" i]',
          '[class*="thread-row" i]',
          '[role="row"]'
        ];
        var explicit = document.querySelectorAll(explicitSelectors.join(','));
        for (var i = 0; i < explicit.length; i++) {
          if (isLikelyMailboxRow(explicit[i])) {
            rows.push(explicit[i]);
          }
        }

        // Pass 2: Generic fallback - look for structured list items
        if (rows.length === 0) {
          var generic = document.querySelectorAll(
            'main [role="row"], ' +
            'main [role="listitem"], ' +
            '[role="main"] [role="row"], ' +
            '[role="main"] [role="listitem"], ' +
            'main a[href*="/mail"], main a[href*="/inbox"], main a[href*="/message"], ' +
            '[role="main"] a[href*="/mail"], [role="main"] a[href*="/inbox"], [role="main"] a[href*="/message"], ' +
            'div[class*="items"] > div, ' +
            'div[class*="list"] > div, ' +
            '[role="listbox"] > [role="option"], ' +
            '[role="list"] > [role="listitem"]'
          );
          for (var j = 0; j < generic.length; j++) {
            if (isLikelyMailboxRow(generic[j])) {
              rows.push(generic[j]);
            }
          }
        }

        return dedupeRows(rows).slice(0, MAX_ITEMS);
      }

      // ── URL helpers ──────────────────────────────────────────────
      function isInboxView() {
        try {
          var pathname = window.location.pathname;
          // Normalize: remove trailing slash
          var normalized = pathname.replace(/\\/+$/, '');
          // Only auto-refresh when on the exact inbox root, not sub-views like /inbox/conversation/...
          return normalized.endsWith('/inbox');
        } catch(e) { return false; }
      }

      // ── Main sync function ────────────────────────────────────────
      function syncMailbox() {
        try {
          // Skip if not on the inbox view — don't auto-refresh when reading emails or browsing other folders
          if (!isInboxView()) {
            window.__mailbridgeSyncStatus = 'idle';
            return;
          }

          window.__mailbridgeSyncStatus = 'syncing';

          // Collect rows and extract summaries
          var rows = collectRows();
          var items = [];
          for (var i = 0; i < rows.length; i++) {
            var summary = toSummary(rows[i]);
            if (summary) items.push(summary);
          }

          // Store extracted items on window for main process to read
          window.__mailbridgeLastMailboxItems = items;
          window.__mailbridgeLastMailboxSenders = items.map(function(it) { return it.sender; });
          window.__mailbridgeLastMailboxSubjects = items.map(function(it) { return it.subject; });
          window.__mailbridgeLastMailboxUnread = items.filter(function(it) { return it.unread; }).length;
          window.__mailbridgeLastSync = Date.now();

          // NOTE: do NOT click Proton's refresh button from in here.
          //
          // Earlier versions of this observer dispatched a synthetic click on
          // the refresh icon inside syncMailbox(). Clicking the icon caused a
          // DOM mutation (spinner, status row update, etc.) which immediately
          // re-triggered this same MutationObserver -- and because the click
          // path doesn't pass through the 120ms debounce cleanly between
          // back-to-back frames, the observer ended up firing the click in an
          // effective tight loop: click -> DOM change -> observer -> click ->
          // DOM change -> ... The user reported it as the "refresh button
          // pressing continuously, every 10 second delay is gone".
          //
          // The 10-second-cadence click on the Proton refresh button is now
          // handled exclusively from the main process via runSyncTick ->
          // clickRefreshButton(view). This observer is only responsible for
          // reading the mailbox DOM (extracting sender/subject/snippet rows)
          // and reporting it back to main.

          // Keep syncing status visible for at least 2 seconds (async refresh)
          if (window.__mailbridgeSyncTimer) clearTimeout(window.__mailbridgeSyncTimer);
          window.__mailbridgeSyncTimer = setTimeout(function() {
            window.__mailbridgeSyncStatus = 'idle';
          }, 2000);
        } catch(e) {
          window.__mailbridgeSyncStatus = 'idle';
        }
      }

      // ── MutationObserver ─────────────────────────────────────────
      var observer = new MutationObserver(function() {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(syncMailbox, MUTATION_SYNC_DELAY_MS);
      });

      try {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: false
        });
      } catch(e) {
        // Observer start failed, use periodic only
      }

      // ── Expose observer + restart hooks so the main process can disconnect
      //    everything when the MailBridge window is hidden, then reopen the
      //    observer when it's shown again. This avoids a 10-second DOM
      //    scan across the entire Proton Mail document tree while the user
      //    isn't even looking at MailBridge.
      try {
        window.__mailbridgeObserver = observer;
        // Expose only the in-place restart hook the main process needs to
        // re-attach the DOM MutationObserver on visibility-show. The 10-second
        // periodic sync timer ('periodicTimer' below) is deliberately never
        // stopped/restarted by the main process, so no helper for that is
        // needed here.
        window.__mailbridgeRestartObserver = function() {
          try {
            if (observer) observer.disconnect();
          } catch (e) { /* ignore */ }
          observer = new MutationObserver(function() {
            if (syncTimer) clearTimeout(syncTimer);
            syncTimer = setTimeout(syncMailbox, MUTATION_SYNC_DELAY_MS);
          });
          try {
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: false
            });
          } catch (e) { /* ignore */ }
          window.__mailbridgeObserver = observer;
        };
      } catch (e) {
        // Page context might restrict assignment to window — ignore
      }

      // ── Periodic sync ────────────────────────────────────────────
      // The 10-second periodic timer below is INTENTIONALLY never stopped or
      // restarted by the main process. It runs whether the MailBridge window
      // is hidden or visible so the row-extraction cadence inside Proton
      // matches the user-visible 10-second refresh click cadence.
      periodicTimer = setInterval(syncMailbox, PERIODIC_SYNC_INTERVAL_MS);

      // ── Manual sync trigger ───────────────────────────────────────
      window.__mailbridgeMailboxSyncNow = function() {
        window.__mailbridgeSyncStatus = 'syncing';
        syncMailbox();
        return true;
      };

      // ── Sync on focus ────────────────────────────────────────────
      window.addEventListener('focus', function() {
        syncMailbox();
      });

      // ── Sync on load ──────────────────────────────────────────────
      if (document.readyState === 'complete') {
        syncMailbox();
      } else {
        window.addEventListener('load', function() {
          setTimeout(syncMailbox, 1000);
        });
      }

      // ── Cleanup ──────────────────────────────────────────────────
      window.addEventListener('beforeunload', function() {
        if (observer) observer.disconnect();
        if (syncTimer) clearTimeout(syncTimer);
        if (periodicTimer) clearInterval(periodicTimer);
        if (window.__mailbridgeSyncTimer) clearTimeout(window.__mailbridgeSyncTimer);
        window.__mailbridgeObserverInjected = false;
        window.__mailbridgeObserver = null;
        window.__mailbridgeRestartObserver = null;
        window.__mailbridgeMailboxSyncNow = null;
        window.__mailbridgeLastMailboxItems = null;
        window.__mailbridgeLastMailboxSenders = null;
        window.__mailbridgeLastMailboxSubjects = null;
      });
    })();
  `).catch(function() { /* page might not be ready yet, ignore */ });
}

/** Tracks whether each Proton session was observed on a logged-in mailbox page. */
const wasLoggedInSessions = new Map<string, boolean>()

function isLoggedInUrl(url: string): boolean {
  return url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
}

/**
 * Start a periodic keep-alive ping for a Proton session.
 * Pings every 4 minutes to keep the session from being marked as inactive.
 *
 * A transient failure (page navigating, renderer busy) must NOT kill the
 * keep-alive — otherwise the session silently goes inactive until the user
 * manually reopens the account. Only stop when the view is truly gone.
 */
function startKeepAlive(accountId: string, view: BrowserView): void {
  // Clear any existing timer first
  stopKeepAlive(accountId)

  const timer = setInterval(() => {
    try {
      if (view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.executeJavaScript('void(0)', false).catch(() => {
          if (view.webContents.isDestroyed()) {
            stopKeepAlive(accountId)
          }
        })
      } else {
        stopKeepAlive(accountId)
      }
    } catch {
      if (!view.webContents || view.webContents.isDestroyed()) {
        stopKeepAlive(accountId)
      }
    }

    // If Proton dropped the session to a login/landing page (inactivity
    // timeout, expired session), reload the mailbox URL so the persisted
    // cookies re-establish the session instead of sitting logged out.
    try {
      const url = view.webContents.getURL()
      if (isLoggedInUrl(url)) {
        wasLoggedInSessions.set(accountId, true)
      } else if (
        wasLoggedInSessions.get(accountId) &&
        url &&
        !view.webContents.isLoading() &&
        !url.includes('account.proton.me')
      ) {
        logger.info('Proton session dropped to non-mailbox page — reloading to keep active', { accountId, url })
        view.webContents.loadURL(PROTON_MAIL_URL)
      }
    } catch {
      // View may be mid-destruction; ignore
    }
  }, 4 * 60 * 1000)

  keepAliveTimers.set(accountId, timer)
}

function stopKeepAlive(accountId: string): void {
  const timer = keepAliveTimers.get(accountId)
  if (timer) {
    clearInterval(timer)
    keepAliveTimers.delete(accountId)
  }
}

/**
 * Click the Proton refresh button using trusted input events.
 * Uses sendInputEvent() to simulate real mouse clicks that Proton accepts.
 */
async function clickRefreshButton(view: BrowserView): Promise<void> {
  try {
    if (!view.webContents || view.webContents.isDestroyed()) return

    // Get the refresh button coordinates from the page
    const coords = await view.webContents.executeJavaScript(`
      (function() {
        var refreshTarget = document.querySelector(
          'svg[data-testid="navigation-link:refresh-folder"], [data-testid="navigation-link:refresh-folder"]'
        );
        var refreshBtn = refreshTarget
          ? (refreshTarget.closest('button, a, [role="button"]') || refreshTarget)
          : null;
        if (!refreshBtn) {
          // Fallback: look for button containing refresh SVG
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].querySelector('svg[data-testid="navigation-link:refresh-folder"]') ||
                buttons[i].querySelector('[data-testid*="refresh"]') ||
                buttons[i].querySelector('[class*="reload-spinner"]') ||
                buttons[i].querySelector('[class*="reload"]') ||
                buttons[i].querySelector('[aria-label*="Refresh"]')) {
              refreshBtn = buttons[i];
              break;
            }
          }
        }
        if (refreshBtn) {
          var rect = refreshBtn.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            return null;
          }
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }
        return null;
      })()
    `)

    if (coords) {
      // Simulate real mouse press and release using trusted input events
      await view.webContents.sendInputEvent({
        type: 'mouseDown',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1
      })
      // Small delay between mousedown and mouseup to mimic real user behavior
      await new Promise(resolve => setTimeout(resolve, 50))
      await view.webContents.sendInputEvent({
        type: 'mouseUp',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1
      })
    }
  } catch {
    // Ignore errors - page might not be ready
  }
}

/**
 * Check if the Proton window is currently on the inbox root view.
 * Only auto-refresh when on the exact inbox — skip sub-views like /inbox/conversation/..., /inbox/message/..., etc.
 */
async function isOnInboxView(view: BrowserView): Promise<boolean> {
  try {
    if (!view.webContents || view.webContents.isDestroyed()) return false
    const url = view.webContents.getURL()
    try {
      const parsed = new URL(url)
      const pathname = parsed.pathname
      // Normalize: remove trailing slash
      const normalized = pathname.replace(/\/+$/, '')
      // Only match the exact inbox root, not sub-paths like /inbox/conversation/...
      return normalized.endsWith('/inbox')
    } catch {
      // Fallback for malformed URLs
      return false
    }
  } catch {
    return false
  }
}

/**
 * Start a periodic 10-second mailbox sync (heartbeat) that calls
 * __mailbridgeMailboxSyncNow to gently refresh Proton's mailbox view.
 * Auto-refresh only runs when the user is on the inbox view.
 */
function startMailboxSync(accountId: string, view: BrowserView): void {
  stopMailboxSync(accountId)

  const runSyncTick = () => {
    try {
      if (!view.webContents || view.webContents.isDestroyed()) {
        stopMailboxSync(accountId)
        return
      }
      // First, sync the mailbox data via injected observer
      view.webContents.executeJavaScript(`
        (function() {
          if (typeof window.__mailbridgeMailboxSyncNow === 'function') {
            window.__mailbridgeMailboxSyncNow();
          }
        })();
      `).catch(() => {
        // Transient failures (navigation, busy renderer) must not kill the
        // heartbeat — retry on the next tick instead.
        logger.debug('Mailbox sync tick failed — will retry next tick', { accountId })
      })

      // Only click the refresh button if on the inbox view
      // Skip when viewing conversations, settings, or any other folder
      isOnInboxView(view).then((onInbox) => {
        if (onInbox) {
          clickRefreshButton(view).catch(() => {})
        }
      })
    } catch {
      stopMailboxSync(accountId)
    }
  }

  // Kick once immediately so newly connected Proton sessions start refreshing right away.
  runSyncTick()

  const timer = setInterval(runSyncTick, MAILBOX_SYNC_INTERVAL_MS)

  mailboxSyncTimers.set(accountId, timer)
}

function stopMailboxSync(accountId: string): void {
  const timer = mailboxSyncTimers.get(accountId)
  if (timer) {
    clearInterval(timer)
    mailboxSyncTimers.delete(accountId)
  }
}

/**
 * Start a 15-minute background sync timer — performs a more thorough refresh
 * to keep data fresh.
 */
function startBackgroundSync(accountId: string, view: BrowserView): void {
  stopBackgroundSync(accountId)

  const timer = setInterval(() => {
    try {
      if (!view.webContents || view.webContents.isDestroyed()) {
        stopBackgroundSync(accountId)
        return
      }
      view.webContents.executeJavaScript(`
        (function() {
          // Full background sync: collect rows, sync, and also reload
          // the URL to ensure we're on the latest Proton Mail page
          if (typeof window.__mailbridgeMailboxSyncNow === 'function') {
            window.__mailbridgeMailboxSyncNow();
          }
        })();
      `).catch(() => {
        // Transient failures must not kill the background sync — retry next tick.
        logger.debug('Background sync tick failed — will retry next tick', { accountId })
      })
    } catch {
      stopBackgroundSync(accountId)
    }
  }, BACKGROUND_SYNC_INTERVAL_MS)

  backgroundSyncTimers.set(accountId, timer)
}

function stopBackgroundSync(accountId: string): void {
  const timer = backgroundSyncTimers.get(accountId)
  if (timer) {
    clearInterval(timer)
    backgroundSyncTimers.delete(accountId)
  }
}

/**
 * Try to do a gentle mailbox sync via the injected __mailbridgeMailboxSyncNow.
 * Returns true if the function was found and called, false otherwise.
 */
async function triggerMailboxRefresh(view: BrowserView): Promise<boolean> {
  try {
    if (!view.webContents || view.webContents.isDestroyed()) return false
    const result = await view.webContents.executeJavaScript(`
      (function() {
        if (typeof window.__mailbridgeMailboxSyncNow === 'function') {
          window.__mailbridgeMailboxSyncNow();
          return true;
        }
        return false;
      })()
    `)
    return result === true
  } catch {
    return false
  }
}

/**
 * Build (or return existing) BrowserView for a Proton account.
 *
 * - Each account is a separate BrowserView attached to the main MailBridge
 *   window — visually embedded inside the app, like the original UX.
 * - Each view has its own session partition: `persist:proton-${accountId}`
 *   with a realistic Chrome 138 User-Agent + Client Hints attached via
 *   `applyChromeFingerprint`, so Proton sees multiple legitimate browser
 *   sessions instead of one fingerprint with many accounts.
 * - If `showNow` is true, the view is attached immediately; otherwise it
 *   is created detached and stays unloaded-and-idle in the background.
 *   Background init keeps the partition alive and Proton's session running,
 *   so when the user clicks an account the inbox is already loaded.
 */
/**
 * Shared refresh logic: prefer a gentle mailbox sync (via the injected
 * observer), falling back to a full page reload.
 */
async function refreshSession(accountId: string, view: BrowserView): Promise<void> {
  try {
    const synced = await triggerMailboxRefresh(view)
    if (!synced) {
      view.webContents.reload()
    }
  } catch {
    try { view.webContents.reload() } catch { /* ignore */ }
  }
}

/**
 * Intercept F5 / Ctrl+R inside a Proton BrowserView and refresh the mailbox
 * instead of letting Chromium ignore (or reload) the key.
 */
function setupRefreshKeyHandler(accountId: string, view: BrowserView): void {
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isRefreshKey =
      input.key === 'F5' ||
      (input.key.toLowerCase() === 'r' && (input.control || input.meta))
    if (!isRefreshKey) return
    event.preventDefault()
    refreshSession(accountId, view)
  })
}

/**
 * Refresh the Proton session whose BrowserView is currently attached to the
 * main window. Used when F5 / Ctrl+R is pressed while focus is on the app
 * shell (sidebar, title bar, etc.) so the mail refreshes instead of the app UI.
 */
export function refreshAttachedSession(): void {
  try {
    const mainWindow = findMainWindow()
    const view = mainWindow?.getBrowserView?.()
    if (!view) return
    for (const [accountId, entry] of sessions) {
      if (entry.view === view) {
        refreshSession(accountId, view)
        return
      }
    }
  } catch { /* ignore */ }
}

function ensureProtonView(
  accountId: string,
  showNow: boolean,
  bounds?: { x: number; y: number; width: number; height: number }
): ProtonSession {
  const existing = sessions.get(accountId)
  if (existing) {
    const viewLive = existing.view.webContents && !existing.view.webContents.isDestroyed()
    if (!viewLive) {
      // Drop the stale entry — its webContents is gone. Clean up timers
      // too so they don't fire against a dead acccount.
      sessions.delete(accountId)
      stopKeepAlive(accountId)
      stopMailboxSync(accountId)
      stopBackgroundSync(accountId)
      lastUnreadCounts.delete(accountId)
    } else {
      if (showNow) attachProtonView(existing, bounds)
      else if (bounds) try { existing.view.setBounds(bounds) } catch { /* ignored */ }
      return existing
    }
  }

  const partition = `persist:proton-${accountId}`

  // Configure the per-account session BEFORE creating the BrowserView so the
  // very first request that Proton receives already carries our UA + Client Hints.
  const ses = session.fromPartition(partition, { cache: true })
  applyChromeFingerprint(ses)

  const view = new BrowserView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false
    }
  })

  // Belt-and-suspenders: also override UA at the webContents level so the
  // very first navigation's User-Agent header is already right.
  view.webContents.setUserAgent(PROTON_USER_AGENT)

  const session_: ProtonSession = { view, partition }
  sessions.set(accountId, session_)

  setupExternalLinkHandler(view)
  startKeepAlive(accountId, view)
  startMailboxSync(accountId, view)
  startBackgroundSync(accountId, view)

  // Wire up listeners BEFORE loadURL so we never miss a `did-finish-load`
  // for the very first navigation.
  attachProtonListeners(view, accountId)

  view.webContents.loadURL(PROTON_MAIL_URL)

  if (showNow) {
    attachProtonView(session_, bounds)
  }

  logger.info('Proton session created', { accountId, partition })
  return session_
}

/**
 * Attach (or re-attach) a per-account BrowserView to the main window,
 * positioning it inside the main window's content area. Idempotent — calling
 * this on a view that's already attached just updates its bounds and re-asserts
 * it as the main window's current BrowserView.
 */
function attachProtonView(
  session_: ProtonSession,
  bounds?: { x: number; y: number; width: number; height: number }
): void {
  const mainWindow = findMainWindow()
  if (!mainWindow) return
  if (bounds) {
    try { session_.view.setBounds(bounds) } catch { /* ignored */ }
  } else if (session_.view.getBounds().width === 0) {
    // First attach with no explicit bounds — give it a sane default that
    // matches what the renderer used to compute (sidebar+titlebar offset).
    try { session_.view.setBounds({ x: 0, y: 0, width: 1024, height: 720 }) } catch { /* ignored */ }
  }
  try {
    mainWindow.setBrowserView(session_.view)
  } catch {
    // Window may already be destroyed
  }
}

/**
 * Wire up listeners on the per-account BrowserView for navigation, login
 * detection, refresh, and notification interception. Called exactly once per
 * newly-created view in `ensureProtonView`.
 */
function attachProtonListeners(view: BrowserView, accountId: string): void {
  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL()
    const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
    if (isLoggedIn) {
      try { view.webContents.send(IpcChannels.PROTON_NOTIFY_LOGIN, { accountId }) } catch { /* renderer might be down */ }
    }
    injectNotificationInterceptor(view)
    injectMailboxObserver(view)
  })

  // Re-inject scripts when SPA navigates to the inbox after login
  view.webContents.on('did-navigate-in-page', (_navEvent, url) => {
    const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
    if (isLoggedIn) {
      try { view.webContents.send(IpcChannels.PROTON_NOTIFY_LOGIN, { accountId }) } catch { /* renderer might be down */ }
      injectNotificationInterceptor(view)
      injectMailboxObserver(view)
    }
  })

  // Monitor page title changes to detect new email notifications.
  // Proton Mail updates the title with the unread count: "(3) Inbox"
  view.webContents.on('page-title-updated', (_e, title) => {
    const url = view.webContents.getURL()
    const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
    if (!isLoggedIn) {
      lastUnreadCounts.set(accountId, 0)
      return
    }

    const currentCount = parseUnreadCount(title)
    const prevCount = lastUnreadCounts.get(accountId) ?? -1

    if (prevCount >= 0 && currentCount > prevCount) {
      const increasedBy = currentCount - prevCount
      const cooldownKey = `${accountId}:${currentCount}`
      const lastTime = lastNotifTimestamps.get(cooldownKey) || 0
      if (Date.now() - lastTime < NOTIF_COOLDOWN_MS) {
        // Skip duplicate within cooldown window but keep the counter in sync.
        lastUnreadCounts.set(accountId, currentCount)
        return
      }
      lastNotifTimestamps.set(cooldownKey, Date.now())

      logger.info('New Proton email detected', {
        accountId,
        prevCount,
        currentCount,
        increase: increasedBy
      })

      notifyForProtonMail(view, accountId, currentCount, increasedBy)
    }

    lastUnreadCounts.set(accountId, currentCount)
  })

  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    logger.warn('Proton view load failed', { accountId, errorCode, errorDescription })
  })

  view.webContents.on('crashed', () => {
    logger.warn('Proton view crashed', { accountId })
  })

  // F5 / Ctrl+R refreshes this account's mailbox
  setupRefreshKeyHandler(accountId, view)
}

export function registerProtonHandlers(): void {
  ipcMain.handle(IpcChannels.PROTON_CREATE_SESSION, async (_event, accountId: string, bounds?: { x: number; y: number; width: number; height: number }) => {
    const wasExisting = sessions.has(accountId)
    const session_ = ensureProtonView(accountId, /* showNow */ true, bounds)
    return {
      accountId,
      sessionPath: session_.partition,
      restored: wasExisting
    }
  })

  // Background init: v2.28.0 change — pre-creating every account's Proton
  // BrowserView at startup was the dominant source of idle RAM (each view
  // routinely consumed 200-400MB of resident memory even before the user
  // clicked on it). Under the user's 500MB hard cap we no longer create
  // BrowserViews eagerly. Proton sessions are now created lazily, only
  // when the user actually clicks an account ("PROTON_SHOW_SESSION" below),
  // with one-active-session-at-a-time eviction.
  //
  // Trade-off: a 1-3s loading delay when switching between accounts while
  // the inactive BrowserView is destroyed and re-created on demand.
  // Notifications for the *currently active* account are unaffected.
  ipcMain.handle(IpcChannels.PROTON_INIT_SESSION, async (_event, accountId: string) => {
    // Load every Proton account in the background at startup so accounts come
    // up logged-in and active without the user having to open each one. The
    // view is created detached — it loads Proton Mail and the per-session
    // keep-alive / mailbox-sync timers keep it active. The MemoryWatchdog and
    // single-active-session eviction remain the RAM safety net.
    const existing = sessions.get(accountId)
    if (existing) {
      return { accountId, sessionPath: existing.partition, restored: true }
    }
    const session_ = ensureProtonView(accountId, /* showNow */ false)
    return { accountId, sessionPath: session_.partition, restored: false }
  })

  ipcMain.handle(IpcChannels.PROTON_SHOW_SESSION, async (_event, accountId: string, bounds?: { x: number; y: number; width: number; height: number }) => {
    // v2.28.0: enforce a single active BrowserView at a time. Free the
    // RAM occupied by every other Proton session before bringing up the
    // requested one. This is the main lever that lets us stay under the
    // 500MB cap when the user has multiple Proton accounts configured.
    //
    // We snapshot the keys first because `destroyProtonSession()` mutates
    // `sessions` in place.
    const otherIds = Array.from(sessions.keys()).filter(id => id !== accountId)
    for (const id of otherIds) {
      try { destroyProtonSession(id) } catch (err) {
        logger.warn('Failed to free idle Proton session during switch', { id, error: String(err) })
      }
    }

    const existing = sessions.get(accountId)
    if (!existing) {
      // Lazy-create on show — handler called before init/complete
      ensureProtonView(accountId, /* showNow */ true, bounds)
      return
    }
    try {
      attachProtonView(existing, bounds)
      // Re-start keep-alive and mailbox sync for this view
      startKeepAlive(accountId, existing.view)
      startMailboxSync(accountId, existing.view)
      startBackgroundSync(accountId, existing.view)
    } catch {
      throw new Error('Failed to show Proton session')
    }
  })

  ipcMain.handle(IpcChannels.PROTON_KEEP_ALIVE, async (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (session_) {
      startKeepAlive(accountId, session_.view)
      return true
    }
    return false
  })

  ipcMain.handle(IpcChannels.PROTON_REFRESH_SESSION, async (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (!session_) {
      throw new Error('Proton session not found')
    }
    try {
      // Try gentle mailbox sync first (via injected observer), fall back to full reload
      const synced = await triggerMailboxRefresh(session_.view)
      if (!synced) {
        session_.view.webContents.reload()
      }
    } catch {
      throw new Error('Proton session not found')
    }
  })

  ipcMain.handle(IpcChannels.PROTON_RESIZE_SESSION, async (_event, accountId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const session_ = sessions.get(accountId)
    if (!session_) return
    try {
      session_.view.setBounds(bounds)
    } catch {
      // View might be destroyed
    }
  })

  ipcMain.handle(IpcChannels.PROTON_DESTROY_SESSION, async (_event, accountId: string) => {
    destroyProtonSession(accountId)
  })

  ipcMain.handle(IpcChannels.PROTON_HIDE_SESSION, async (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (!session_) return
    try {
      const mainWindow = findMainWindow()
      if (mainWindow) {
        const current = mainWindow.getBrowserView()
        if (current === session_.view) {
          mainWindow.setBrowserView(null)
        }
      }
      // Sessions stay alive — keep-alive + mailbox timers continue so the
      // user doesn't lose Proton mail login state.
    } catch {
      // View might be destroyed
    }
  })

  ipcMain.handle(IpcChannels.PROTON_GET_SESSION_PATH, (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (!session_) return null
    return session_.partition
  })

  ipcMain.handle(IpcChannels.PROTON_IS_LOGGED_IN, async (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (!session_) return false
    try {
      const url = session_.view.webContents.getURL()
      return url.includes('/inbox') || url.includes('/mail')
    } catch {
      return false
    }
  })

  ipcMain.handle(IpcChannels.PROTON_STATUS, (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (!session_) return { accountId, status: 'logged-out' as const }
    return { accountId, status: 'logged-in' as const }
  })
}

// Register foreground↔background throttling lifecycle listeners as soon as this
// module is loaded. They become active immediately and start gating timer/
// observer activity the moment the first Proton BrowserView is attached. The
// registerProtonHandlers() and ensureProtonView() entry points above already
// mutate `sessions`, so by the time the visibility event fires those calls
// will behave as intended.
registerVisibilityHandlers()

/**
 * Tear down one Proton session: kill timers, detach from main window,
 * destroy the BrowserView entirely, wipe notification dedup state.
 */
function destroyProtonSession(accountId: string): void {
  const session_ = sessions.get(accountId)
  if (!session_) return
  stopKeepAlive(accountId)
  stopMailboxSync(accountId)
  stopBackgroundSync(accountId)
  try {
    const mainWindow = findMainWindow()
    if (mainWindow) {
      const current = mainWindow.getBrowserView()
      if (current === session_.view) {
        mainWindow.setBrowserView(null)
      }
    }
  } catch {
    // mainWindow might already be gone
  }
  try {
    // BrowserView's `destroy()` is exposed at runtime but isn't in every
    // typings rev. Cast through `unknown` (rather than `any`) so we don't
    // widen to any — view.destroy() tears down its webContents for us.
    ;(session_.view as unknown as { destroy?: () => void }).destroy?.()
  } catch {
    // Already torn down
  }
  sessions.delete(accountId)
  lastUnreadCounts.delete(accountId)
  wasLoggedInSessions.delete(accountId)
  // Don't drop lastNotifTimestamps entries — those keys are scoped by
  // (accountId,count) so leaving them is harmless and avoids re-firing
  // dedup gaps on quick destroy/recreate.
}

export function destroyAllProtonSessions(): void {
  // When "Clear session on exit" is enabled, wipe the persisted Proton login
  // data (cookies etc.) for every account — this forces a fresh login on the
  // next start even for accounts without a live session.
  try {
    if (storageService.getSettings().clearSessionOnExit === true) {
      for (const account of storageService.getAccounts()) {
        if (account.provider !== 'proton') continue
        try {
          session.fromPartition(`persist:proton-${account.id}`).clearStorageData()
        } catch { /* partition may not exist */ }
      }
    }
  } catch { /* settings/accounts may be unavailable during shutdown */ }
  for (const accountId of Array.from(sessions.keys())) {
    destroyProtonSession(accountId)
  }
  // Defensive sweep in case any map-level state lingered
  sessions.clear()
  keepAliveTimers.clear()
  mailboxSyncTimers.clear()
  backgroundSyncTimers.clear()
  lastUnreadCounts.clear()
  lastNotifTimestamps.clear()
}

/**
 * v2.28.0 helper for the main-process MemoryWatchdog.
 *
 * Destroys a single Proton session whose BrowserView is currently *not*
 * the attached foreground view of the main window — i.e. a session the
 * user is not actively looking at. Returns `true` if a session was evicted,
 * `false` if every active session is in use (no RAM to reclaim).
 *
 * The watchdog calls this in a tight loop until either the total Electron
 * RSS is back under target or no more idle sessions remain.
 */
export function evictIdleProtonSession(): boolean {
  const mainWindow = findMainWindow()
  const attachedView = (() => {
    try { return mainWindow?.getBrowserView?.() ?? null } catch { return null }
  })()

  // Pick the first session whose view is not the currently-attached one.
  // Map preserves insertion order — so the oldest idle session is evicted
  // first, which is the right trade-off for "least-recently-touched".
  for (const [accountId, session_] of Array.from(sessions.entries())) {
    if (attachedView && session_.view === attachedView) continue
    destroyProtonSession(accountId)
    logger.info('MemoryWatchdog evicted idle Proton session', { accountId })
    return true
  }
  return false
}
