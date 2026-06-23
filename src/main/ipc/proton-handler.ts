import { ipcMain, BrowserView, session, BrowserWindow, shell, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IpcChannels } from '@shared/ipc'
import { PROTON_MAIL_URL } from '@shared/constants'
import { withTimeout } from '@shared/helpers'
import { logger } from '../services/logger'
import { notificationService } from '../services/notification-service'
import { storageService } from '../services/storage'
import type { NewEmailNotification } from '@shared/types'

const sessions = new Map<string, { view: BrowserView; partition: string }>()

/** Periodic keep-alive timers for each Proton session to prevent logout. */
const keepAliveTimers = new Map<string, ReturnType<typeof setInterval>>()

/** Periodic mailbox sync timers (refreshing Proton's own mailbox view). */
const mailboxSyncTimers = new Map<string, ReturnType<typeof setInterval>>()
const backgroundSyncTimers = new Map<string, ReturnType<typeof setInterval>>()

/** 10-second heartbeat — matches Proton project's PROTON_MAILBOX_REFRESH_HEARTBEAT_MS */
const MAILBOX_SYNC_INTERVAL_MS = 10_000

/** 15-minute background sync — matches Proton project's PROTON_BACKGROUND_SYNC_INTERVAL_MS */
const BACKGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000

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
 * Send an external link confirmation request to the renderer.
 * Returns true if the user confirmed, false otherwise.
 */
/**
 * Send an external link confirmation request to the renderer.
 * Returns true if the user confirmed, false otherwise.
 * Automatically confirms for domains the user has marked as trusted.
 */
async function confirmExternalLink(url: string): Promise<boolean> {
  const mainWindow = BrowserWindow.getFocusedWindow()
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
 * Set up external link handling on a Proton BrowserView:
 * - Intercept will-navigate for link clicks within the page
 * - Intercept new-window for target=_blank links
 * - Show confirmation dialog for external URLs
 * - Open confirmed URLs in the system's default browser
 */
function setupExternalLinkHandler(view: BrowserView): void {
  // Handler for in-page navigation (normal link clicks, redirects)
  view.webContents.on('will-navigate', (event, url) => {
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
  view.webContents.setWindowOpenHandler(({ url }) => {
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
    // We need to do this asynchronously, so we'll confirm synchronously here
    // and open via shell if the user accepts
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
 * Inject a content script into the Proton webview that overrides the
 * Notification API to capture Proton's own notification data (sender + subject).
 * This is far more reliable than querying the DOM for specific class names,
 * since Proton Mail uses obfuscated, dynamically-generated CSS classes.
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
 * Inject a script into the Proton webview that monkey-patches the
 * Notification constructor. This runs once after the page loads,
 * capturing Proton Mail's own notification data (sender name, subject).
 */
function injectNotificationInterceptor(view: BrowserView): void {
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
        if (/\b(star|unstar|moved|deleted|removed|archived|trashed)\b/i.test(sender)) {
          return new OrigNotification(title, options);
        }

        // Extract subject + snippet from notification body
        var body = (options && options.body || '').trim();
        var subject = body;
        var snippet = '';
        var senderEmail = '';

        // Try to split body into subject and preview
        // Proton uses actual newline characters (\n) to separate subject from snippet
        if (body.indexOf('\\n') >= 0) {
          var parts = body.split('\\n');
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
              sender = options.body.split('\\n')[0] || sender;
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
 * Inject a mailbox observer into the Proton webview, faithfully ported from
 * the Proton project's protonMailboxObserver.ts.
 *
 * Features:
 * - MutationObserver on document.documentElement (childList+subtree+attributes)
 * - Two-pass row collection: explicit selectors (data-proton-thread, etc.) then generic fallback
 * - Row deduplication by spatial coordinates
 * - Row validation: visibility, dimensions, excluded regions, date signals
 * - Sender/subject/snippet extraction with multi-strategy heuristics
 * - Unread inference via aria-label or font-weight
 * - Periodic sync every 10s
 * - Exposes __mailbridgeMailboxSyncNow() for gentle manual refresh
 * - Stores extracted items in window.__mailbridgeLastMailboxItems
 * - Cleanup on beforeunload
 */
function injectMailboxObserver(view: BrowserView): void {
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
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
      }

      function extractHref(el) {
        if (!el) return '';
        if (el.tagName === 'A') return el.getAttribute('href') || '';
        var a = el.querySelector('a');
        return a ? (a.getAttribute('href') || '') : '';
      }

      function normalizeBlockText(text) {
        return text
          .replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, ' ')
          .replace(/^\s+|\s+$/g, '')
          .replace(/\s{2,}/g, ' ');
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
        if (/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*(ago)?$/i.test(text)) return true;
        // Date patterns like "Jan 15", "Jan 15, 2024", "01/15", "15 Jan"
        if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(,?\s+\d{4})?\b/i.test(text)) return true;
        // Time patterns like "10:30 AM", "14:30"
        if (/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i.test(text)) return true;
        return false;
      }

      function isLikelyMailboxIdentityText(text) {
        if (!text) return false;
        // Email addresses
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return true;
        // Name patterns (not pure numbers, not dates, not very short)
        if (/^\d+$/.test(text)) return false;
        if (/^\d{1,2}:\d{2}/.test(text)) return false;
        if (text.length < 2) return false;
        if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(text) && /\d/.test(text)) return false;
        return true;
      }

      function isLikelyDateText(text) {
        if (!text) return false;
        if (/^(\d+)\s*(m|min|h|hr|d|day)\s*ago$/i.test(text.trim())) return true;
        if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(text.trim())) return true;
        if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(text.trim())) return true;
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
          /^\d+\s*-\s*\d+\s+of\s+\d+$/i.test(normalized) ||
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
          var t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 1 && !/^[\s\d\s]*$/.test(t)) {
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
        var label = el.getAttribute('aria-label') || '';
        if (/\bunread\b/i.test(label)) return true;
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
          var id = row.getAttribute('data-proton-thread') || row.getAttribute('data-message-id') || '';
          var textBlocks = getMeaningfulTextBlocks(row);
          var dateEl = row.querySelector('[datetime], [data-timestamp]');
          var dateText = dateEl ? extractText(dateEl) : '';
          var href = extractHref(row);

          // Extract sender, subject, snippet from text blocks
          var sender = '';
          var subject = '';
          var snippet = '';
          var senderEmail = '';

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
                identityTexts[k] = identityTexts[k].replace(emailMatch[0], '').replace(/[<>()\[\]]/g, '').trim();
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

          if (identityTexts.length >= 1) {
            sender = identityTexts[0];
          }
          if (identityTexts.length >= 2) {
            subject = identityTexts[1];
          }
          if (identityTexts.length >= 3) {
            snippet = identityTexts.slice(2).join(' ');
          } else {
            // Fallback: use remaining text blocks after subject
            var remaining = textBlocks.slice(identityTexts.length);
            remaining = remaining.filter(function(t) { return !isLikelyDateText(t); });
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

          return hasDateSignal(el) && /\/mail|\/inbox|message/i.test(href);
        } catch(e) {
          return false;
        }
      }

      // ── Separator-only line detection ────────────────────────────
      function isSeparatorOnlyLine(text) {
        var normalized = (text || '').replace(/\s+/g, '');
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
          var normalized = pathname.replace(/\/+$/, '');
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

          // Also try clicking Proton's refresh button for gentle refresh
          // The refresh icon is an SVG with data-testid="navigation-link:refresh-folder"
          // The SVG itself has a 'hidden' class — we need to find the parent <button> element
          try {
            var refreshBtn = document.querySelector(
              '[data-testid="navigation-link:refresh-folder"], ' +
              '[title*="Refresh" i], ' +
              '[data-testid*="refresh" i], ' +
              '[class*="refresh" i], ' +
              '[icon*="refresh" i]'
            );
            if (refreshBtn) {
              // If it's not a button, find the closest button parent (the SVG lives inside a button)
              var clickTarget = refreshBtn.tagName === 'BUTTON' ? refreshBtn : refreshBtn.closest('button');
              if (!clickTarget) clickTarget = refreshBtn;
              // Dispatch a real MouseEvent with isTrusted=true behavior via executeJavaScript
              clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }
          } catch(e) {}

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

      // ── Periodic sync ────────────────────────────────────────────
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
        window.__mailbridgeMailboxSyncNow = null;
        window.__mailbridgeLastMailboxItems = null;
        window.__mailbridgeLastMailboxSenders = null;
        window.__mailbridgeLastMailboxSubjects = null;
      });
    })();
  `).catch(function() { /* page might not be ready yet, ignore */ });
}

/**
 * Start a periodic keep-alive ping for a Proton session.
 * Pings every 4 minutes to keep the session from being marked as inactive.
 */
function startKeepAlive(accountId: string, view: BrowserView): void {
  // Clear any existing timer first
  stopKeepAlive(accountId)

  const timer = setInterval(() => {
    try {
      view.webContents.executeJavaScript('void(0)', false).catch(() => {
        stopKeepAlive(accountId)
      })
    } catch {
      stopKeepAlive(accountId)
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
    `);
    
    if (coords) {
      // Simulate real mouse press and release using trusted input events
      await view.webContents.sendInputEvent({
        type: 'mouseDown',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1
      });
      // Small delay between mousedown and mouseup to mimic real user behavior
      await new Promise(resolve => setTimeout(resolve, 50));
      await view.webContents.sendInputEvent({
        type: 'mouseUp',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1
      });
    }
  } catch {
    // Ignore errors - page might not be ready
  }
}

/**
 * Check if the Proton webview is currently on the inbox root view.
 * Only auto-refresh when on the exact inbox — skip sub-views like /inbox/conversation/..., /inbox/message/..., etc.
 */
async function isOnInboxView(view: BrowserView): Promise<boolean> {
  try {
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
 * This matches the Proton project's PROTON_MAILBOX_REFRESH_HEARTBEAT_MS = 10s.
 * Auto-refresh only runs when the user is on the inbox view.
 */
function startMailboxSync(accountId: string, view: BrowserView): void {
  stopMailboxSync(accountId)

  const runSyncTick = () => {
    try {
      // First, sync the mailbox data via injected observer
      view.webContents.executeJavaScript(`
        (function() {
          if (typeof window.__mailbridgeMailboxSyncNow === 'function') {
            window.__mailbridgeMailboxSyncNow();
          }
        })();
      `).catch(() => {
        stopMailboxSync(accountId)
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
 * Start a 15-minute background sync timer — matches the Proton project's
 * PROTON_BACKGROUND_SYNC_INTERVAL_MS. Performs a more thorough refresh
 * in the background to keep data fresh.
 */
function startBackgroundSync(accountId: string, view: BrowserView): void {
  stopBackgroundSync(accountId)

  const timer = setInterval(() => {
    try {
      view.webContents.executeJavaScript(`
        (function() {
          // Full background sync: collect rows, sync, and also reload
          // the URL to ensure we're on the latest Proton Mail page
          if (typeof window.__mailbridgeMailboxSyncNow === 'function') {
            window.__mailbridgeMailboxSyncNow();
          }
        })();
      `).catch(() => {
        stopBackgroundSync(accountId)
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

export function registerProtonHandlers(): void {
  ipcMain.handle(IpcChannels.PROTON_CREATE_SESSION, async (_event, accountId: string) => {
    // If session already exists, just show it (don't create twice)
    const existing = sessions.get(accountId)
    if (existing) {
      const mainWindow = BrowserWindow.getFocusedWindow()
      if (mainWindow) {
        mainWindow.setBrowserView(existing.view)
        existing.view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      }
      startKeepAlive(accountId, existing.view)
      return { accountId, sessionPath: existing.partition, restored: true }
    }

    const mainWindow = BrowserWindow.getFocusedWindow()
    if (!mainWindow) throw new Error('No main window')

    const partition = `persist:proton-${accountId}`
    const view = new BrowserView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    mainWindow.setBrowserView(view)
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    view.webContents.loadURL(PROTON_MAIL_URL)

    view.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    view.webContents.on('did-finish-load', () => {
      const url = view.webContents.getURL()
      const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
      if (isLoggedIn) {
        _event.sender.send(IpcChannels.PROTON_NOTIFY_LOGIN, { accountId })
      }
      // Always inject scripts — the observer will work once the DOM is ready
      injectNotificationInterceptor(view)
      injectMailboxObserver(view)
    })

    // Re-inject scripts when SPA navigates to the inbox after login
    view.webContents.on('did-navigate-in-page', (_navEvent, url) => {
      const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
      if (isLoggedIn) {
        // Notify the renderer that the user has logged in
        _event.sender.send(IpcChannels.PROTON_NOTIFY_LOGIN, { accountId })
        injectNotificationInterceptor(view)
        injectMailboxObserver(view)
      }
    })

    // Monitor page title changes to detect new email notifications
    // Proton Mail updates the title with unread count: "(3) Inbox"
    view.webContents.on('page-title-updated', (_e, title) => {
      // Only process if logged in (url contains inbox/mail)
      const url = view.webContents.getURL()
      const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
      if (!isLoggedIn) {
        lastUnreadCounts.set(accountId, 0)
        return
      }

      const currentCount = parseUnreadCount(title)
      const prevCount = lastUnreadCounts.get(accountId) ?? -1

      // Only fire notification if we have a previous count and it increased
      if (prevCount >= 0 && currentCount > prevCount) {
        const increasedBy = currentCount - prevCount

        // Cooldown check: prevent duplicate notifications from rapid title oscillations
        // (e.g., "(1) Inbox" → "(0) Inbox" → "(1) Inbox" within milliseconds)
        const cooldownKey = `${accountId}:${currentCount}`
        const lastTime = lastNotifTimestamps.get(cooldownKey) || 0
        if (Date.now() - lastTime < NOTIF_COOLDOWN_MS) {
          // Skip duplicate within cooldown window, but still update the count
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
      logger.warn('Proton BrowserView load failed', { accountId, errorCode, errorDescription })
    })

    // Monitor for crashes or unresponsive state
    view.webContents.on('crashed', () => {
      logger.warn('Proton BrowserView crashed', { accountId })
    })

    setupExternalLinkHandler(view)

    sessions.set(accountId, { view, partition })
    startKeepAlive(accountId, view)
    startMailboxSync(accountId, view)
    startBackgroundSync(accountId, view)
    logger.info('Proton session created', { accountId })

    return { accountId, sessionPath: partition, restored: false }
  })

  // Background init: creates a Proton session without attaching to any window.
  // This pre-loads Proton Mail so it's ready when the user clicks on the account.
  ipcMain.handle(IpcChannels.PROTON_INIT_SESSION, async (_event, accountId: string) => {
    // If session already exists, nothing to do
    const existing = sessions.get(accountId)
    if (existing) {
      return { accountId, sessionPath: existing.partition, restored: true }
    }

    const partition = `persist:proton-${accountId}`
    const view = new BrowserView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    view.webContents.loadURL(PROTON_MAIL_URL)
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    view.webContents.on('did-finish-load', () => {
      // Always inject scripts — the observer will work once the DOM is ready
      injectNotificationInterceptor(view)
      injectMailboxObserver(view)
    })

    // Re-inject scripts when SPA navigates to the inbox after login
    view.webContents.on('did-navigate-in-page', (_navEvent, url) => {
      const isLoggedIn = url.includes('/inbox') || url.includes('/mail') || url.includes('/conversations')
      if (isLoggedIn) {
        injectNotificationInterceptor(view)
        injectMailboxObserver(view)
      }
    })

    // Monitor page title for new email notifications
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
          lastUnreadCounts.set(accountId, currentCount)
          return
        }
        lastNotifTimestamps.set(cooldownKey, Date.now())

        logger.info('New Proton email detected (background)', {
          accountId, prevCount, currentCount, increase: increasedBy
        })

        notifyForProtonMail(view, accountId, currentCount, increasedBy)
      }

      lastUnreadCounts.set(accountId, currentCount)
    })

    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      logger.warn('Proton background init load failed', { accountId, errorCode, errorDescription })
    })

    view.webContents.on('crashed', () => {
      logger.warn('Proton background init crashed', { accountId })
    })

    setupExternalLinkHandler(view)

    sessions.set(accountId, { view, partition })
    startKeepAlive(accountId, view)
    startMailboxSync(accountId, view)
    startBackgroundSync(accountId, view)
    logger.info('Proton session initialized in background', { accountId })

    return { accountId, sessionPath: partition, restored: false }
  })

  ipcMain.handle(IpcChannels.PROTON_SHOW_SESSION, async (_event, accountId: string, bounds?: { x: number; y: number; width: number; height: number }) => {
    const existing = sessions.get(accountId)
    if (!existing) {
      throw new Error('Proton session not found')
    }
    try {
      const mainWindow = BrowserWindow.getFocusedWindow()
      if (mainWindow) {
        mainWindow.setBrowserView(existing.view)
        if (bounds) {
          existing.view.setBounds(bounds)
        }
        // Re-start keep-alive and mailbox sync for this session
        startKeepAlive(accountId, existing.view)
        startMailboxSync(accountId, existing.view)
        startBackgroundSync(accountId, existing.view)
      }
    } catch {
      throw new Error('Failed to show Proton session')
    }
  })

  ipcMain.handle(IpcChannels.PROTON_KEEP_ALIVE, async (_event, accountId: string) => {
    const existing = sessions.get(accountId)
    if (existing) {
      startKeepAlive(accountId, existing.view)
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
    const session_ = sessions.get(accountId)
    if (session_) {
      stopKeepAlive(accountId)
      stopMailboxSync(accountId)
      stopBackgroundSync(accountId)
      try {
        const win = BrowserWindow.getFocusedWindow()
        if (win) {
          win.removeBrowserView(session_.view)
        }
        ;(session_.view as any).destroy()
      } catch {
        // View might already be destroyed
      }
      sessions.delete(accountId)
    }
  })

  ipcMain.handle(IpcChannels.PROTON_HIDE_SESSION, async (_event, accountId: string) => {
    const session_ = sessions.get(accountId)
    if (session_) {
      try {
        const win = BrowserWindow.getFocusedWindow()
        if (win) {
          win.removeBrowserView(session_.view)
        }
      } catch {
        // View might be destroyed
      }
      // Keep the session alive — just detach from window
      // Keep-alive and mailbox sync timers continue to prevent Proton timeout
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

export function destroyAllProtonSessions(): void {
  for (const [accountId] of sessions) {
    stopKeepAlive(accountId)
    stopMailboxSync(accountId)
    stopBackgroundSync(accountId)
    const session_ = sessions.get(accountId)
    if (session_) {
      try {
        // Destroy the webContents first — this properly tears down the renderer
        // without triggering crash events. Works reliably even when the parent
        // window is already being destroyed during app quit.
        if (!session_.view.webContents.isDestroyed()) {
          session_.view.webContents.destroy()
        }
      } catch {
        // webContents might already be destroyed
      }
      try {
        ;(session_.view as any).destroy()
      } catch {
        // View might already be destroyed
      }
    }
  }
  sessions.clear()
  // Clear all session-related state maps for a clean restart
  keepAliveTimers.clear()
  mailboxSyncTimers.clear()
  backgroundSyncTimers.clear()
  lastUnreadCounts.clear()
  lastNotifTimestamps.clear()
}
