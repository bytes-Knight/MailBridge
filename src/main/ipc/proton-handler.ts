import { ipcMain, BrowserView, session, BrowserWindow, shell, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IpcChannels } from '@shared/ipc'
import { PROTON_MAIL_URL } from '@shared/constants'
import { logger } from '../services/logger'
import { notificationService } from '../services/notification-service'
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
const NOTIF_COOLDOWN_MS = 3000 // 3 seconds

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
 * Show a native confirmation dialog for an external link.
 * Returns true if the user confirmed, false otherwise.
 */
async function confirmExternalLink(url: string): Promise<boolean> {
  const mainWindow = BrowserWindow.getFocusedWindow()
  if (!mainWindow) return false

  let hostname = ''
  try { hostname = new URL(url).hostname } catch { hostname = url }

  const displayUrl = url.length > 100 ? url.substring(0, 100) + '...' : url

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'External Link',
    message: `Open this external link?`,
    detail: `This will open in your system's default browser:\n\n${displayUrl}`,
    buttons: ['Cancel', 'Visit Link'],
    defaultId: 0,
    cancelId: 0
  })

  return result.response === 1
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
  emailInfo: { sender?: string; senderEmail?: string; subject?: string; snippet?: string } | null
): string {
  const sender = String(emailInfo?.senderEmail || emailInfo?.sender || '').trim().toLowerCase()
  const subject = String(emailInfo?.subject || '').trim().toLowerCase()
  const snippet = String(emailInfo?.snippet || '').trim().toLowerCase()
  return [accountId, sender, subject, snippet].filter(Boolean).join('|') || `${accountId}|proton`
}

/**
 * Inject a content script into the Proton webview that overrides the
 * Notification API to capture Proton's own notification data (sender + subject).
 * This is far more reliable than querying the DOM for specific class names,
 * since Proton Mail uses obfuscated, dynamically-generated CSS classes.
 */
async function fetchLatestUnreadEmail(view: BrowserView): Promise<{ sender: string; senderEmail: string; subject: string; snippet: string } | null> {
  try {
    const result = await view.webContents.executeJavaScript(`
      (function() {
        // Helper: find first email-like string in text
        function extractEmailFromText(text) {
          var match = text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
          return match ? match[0] : '';
        }

        // Helper: find an email address in or around the element
        function findSenderEmail(el) {
          if (!el) return '';
          // Check element's own text and nearby elements
          var text = el.textContent || '';
          var email = extractEmailFromText(text);
          if (email) return email;
          // Check parent for email
          var parent = el.parentElement;
          if (parent) {
            email = extractEmailFromText(parent.textContent || '');
            if (email) return email;
          }
          // Check previous sibling
          var prev = el.previousElementSibling;
          if (prev) {
            email = extractEmailFromText(prev.textContent || '');
            if (email) return email;
          }
          // Check next sibling
          var next = el.nextElementSibling;
          if (next) {
            email = extractEmailFromText(next.textContent || '');
            if (email) return email;
          }
          return '';
        }

        // Try to get email from a DOM element
        function tryGetSenderEmailFromRow(rowElement) {
          if (!rowElement) return '';
          // Look for elements with href="mailto:..."
          var mailtoLinks = rowElement.querySelectorAll('a[href^="mailto:"]');
          for (var i = 0; i < mailtoLinks.length; i++) {
            var href = mailtoLinks[i].getAttribute('href') || '';
            var email = href.replace('mailto:', '').split('?')[0].trim();
            if (email) return email;
          }
          // Fallback: look for email pattern in any text
          var allText = rowElement.textContent || '';
          var match = allText.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
          return match ? match[0] : '';
        }

        // --- Strategy 0: Read from the mailbox observer (most reliable) ---
        if (window.__mailbridgeLastMailboxItems && window.__mailbridgeLastMailboxItems.length > 0) {
          var firstItem = window.__mailbridgeLastMailboxItems[0];
          if (firstItem && firstItem.sender) {
            return {
              sender: firstItem.sender || 'New Email',
              senderEmail: firstItem.senderEmail || '',
              subject: firstItem.subject || '(No Subject)',
              snippet: firstItem.snippet || ''
            };
          }
        }

        // --- Strategy 1: Check if Proton fired a browser notification ---
        var captured = window.__lastProtonNotification;
        window.__lastProtonNotification = null;
        if (captured && captured.sender) {
          return {
            sender: captured.sender || 'New Email',
            senderEmail: captured.senderEmail || '',
            subject: captured.subject || '(No Subject)',
            snippet: captured.snippet || ''
          };
        }

        // --- Strategy 2: Robust DOM extraction (no hardcoded selectors) ---
        try {
          var bestList = null;
          var bestScore = 0;

          var allElements = document.querySelectorAll('div, section, main, ul, ol');
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var children = el.children;
            if (children.length < 2) continue;

            var score = 0;
            var visibleChildren = 0;
            for (var j = 0; j < children.length; j++) {
              var child = children[j];
              var textNodes = [];
              var walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, null, false);
              var node;
              while (node = walker.nextNode()) {
                var t = (node.textContent || '').trim();
                if (t.length > 0) textNodes.push(t);
              }
              if (textNodes.length >= 3) {
                score += textNodes.length;
                visibleChildren++;
              }
            }

            if (visibleChildren >= 2 && score > bestScore) {
              bestScore = score;
              bestList = el;
            }
          }

          if (!bestList || bestList.children.length === 0) return null;

          var firstItem = bestList.children[0];
          var texts = [];
          var tw = document.createTreeWalker(firstItem, NodeFilter.SHOW_TEXT, null, false);
          var tn;
          while (tn = tw.nextNode()) {
            var t = (tn.textContent || '').trim();
            if (t.length > 0) texts.push(t);
          }

          if (texts.length === 0) return null;

          var meaningful = texts.filter(function(t) { return t.length > 1; });

          // Extract sender email from the row
          var senderEmail = tryGetSenderEmailFromRow(firstItem);

          return {
            sender: meaningful[0] || 'New Email',
            senderEmail: senderEmail,
            subject: meaningful[1] || '(No Subject)',
            snippet: meaningful.slice(2).join(' ').substring(0, 200) || ''
          };
        } catch (e) {
          return null;
        }
      })()
    `)
    return result
  } catch {
    return null
  }
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
          snippet: snippet || ''
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

      function isLikelyMailboxMetadataBlock(el) {
        if (!el) return false;
        var text = extractText(el);
        if (!text) return false;
        // Metadata blocks are typically small badges or labels
        if (text.length > 30) return false;
        // Common badge patterns: "Official", "Proton", "1-5 of 20"
        if (/^(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/i.test(text)) return true;
        if (/^(Official|Proton|Sent|Draft|Starred|Important)$/i.test(text)) return true;
        if (text === text.toUpperCase() && text.length > 1 && text.length < 15) return true;
        return false;
      }

      function getMeaningfulTextBlocks(el) {
        if (!el) return [];
        var texts = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while (node = walker.nextNode()) {
          var t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 1 && !/^[\s\d\s]*$/.test(t)) {
            var p = node.parentElement;
            // Skip metadata blocks
            if (p && !isLikelyMailboxMetadataBlock(p)) {
              texts.push(t);
            }
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
          // Must be in viewport or at least have dimensions
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          if (rect.width < 50) return false; // too narrow

          // Must have text content
          var text = extractText(el);
          if (!text || text.length < 10) return false;

          // Must not be in excluded regions
          if (isExcludedMailboxRegion(el)) return false;

          // Must have date signal nearby or within
          if (hasDateSignal(el)) return true;

          // Fallback: check direct children for structured content
          var children = el.children;
          var textChildCount = 0;
          for (var i = 0; i < children.length; i++) {
            var ct = extractText(children[i]);
            if (ct.length > 5) textChildCount++;
          }
          if (textChildCount >= 2) return true;

          return false;
        } catch(e) {
          return false;
        }
      }

      // ── Row collection ────────────────────────────────────────────
      function dedupeRows(rows) {
        // Remove nested/overlapping rows by spatial coordinates
        var seen = [];
        return rows.filter(function(r) {
          try {
            var rect = r.getBoundingClientRect();
            var key = rect.top + '-' + rect.left + '-' + rect.width + '-' + rect.height;
            if (seen.indexOf(key) >= 0) return false;
            seen.push(key);
            return true;
          } catch(e) {
            return false;
          }
        });
      }

      function collectRows() {
        var rows = [];

        // Pass 1: Explicit selectors (Proton's data attributes and test IDs)
        var explicitSelectors = [
          '[data-proton-thread]',
          '[role="row"][data-proton-thread]',
          '[data-testid*="message-row"]',
          '[data-testid*="conversation"]',
          '[data-testid*="thread"]'
        ];
        var selector = explicitSelectors.join(',');
        var explicit = document.querySelectorAll(selector);
        for (var i = 0; i < explicit.length; i++) {
          if (isLikelyMailboxRow(explicit[i])) {
            rows.push(explicit[i]);
          }
        }

        // Pass 2: Generic fallback - look for structured list items
        if (rows.length === 0) {
          var generic = document.querySelectorAll(
            'div[class*="items"] > div, ' +
            'div[class*="list"] > div, ' +
            'main > div > div, ' +
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

      // ── Main sync function ────────────────────────────────────────
      function syncMailbox() {
        try {
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
 * Start a periodic 10-second mailbox sync (heartbeat) that calls
 * __mailbridgeMailboxSyncNow to gently refresh Proton's mailbox view.
 * This matches the Proton project's PROTON_MAILBOX_REFRESH_HEARTBEAT_MS = 10s.
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
      
      // Then, click the refresh button with trusted input events
      clickRefreshButton(view).catch(() => {
        // Ignore errors
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

        // Fetch latest email details from the webview DOM
        fetchLatestUnreadEmail(view).then(emailInfo => {
          const notification: NewEmailNotification = {
            id: `proton-${accountId}-${currentCount}-${Date.now()}`,
            accountId,
            provider: 'proton',
            notificationKey: buildNotificationKey(accountId, emailInfo),
            from: {
              name: emailInfo?.sender || 'New Email',
              address: emailInfo?.senderEmail || ''
            },
            subject: emailInfo?.subject || 'New message in Proton Mail',
            snippet: emailInfo?.snippet || `You have ${increasedBy} new message(s)`,
            timestamp: Date.now()
          }
          notificationService.enqueueNotification(notification)
        }).catch(() => {
          // Fallback: generic notification
          const notification: NewEmailNotification = {
            id: `proton-${accountId}-${currentCount}-${Date.now()}`,
            accountId,
            provider: 'proton',
            notificationKey: `${accountId}|fallback|${currentCount}`,
            from: { name: 'Proton Mail', address: '' },
            subject: 'New message in Proton Mail',
            snippet: `You have ${increasedBy} new message(s)`,
            timestamp: Date.now()
          }
          notificationService.enqueueNotification(notification)
        })
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

        fetchLatestUnreadEmail(view).then(emailInfo => {
          const notification: NewEmailNotification = {
            id: `proton-${accountId}-${currentCount}-${Date.now()}`,
            accountId,
            provider: 'proton',
            notificationKey: buildNotificationKey(accountId, emailInfo),
            from: { name: emailInfo?.sender || 'New Email', address: emailInfo?.senderEmail || '' },
            subject: emailInfo?.subject || 'New message in Proton Mail',
            snippet: emailInfo?.snippet || `You have ${increasedBy} new message(s)`,
            timestamp: Date.now()
          }
          notificationService.enqueueNotification(notification)
        }).catch(() => {
          const notification: NewEmailNotification = {
            id: `proton-${accountId}-${currentCount}-${Date.now()}`,
            accountId,
            provider: 'proton',
            notificationKey: `${accountId}|fallback|${currentCount}`,
            from: { name: 'New Email', address: '' },
            subject: 'New message in Proton Mail',
            snippet: `You have ${increasedBy} new message(s)`,
            timestamp: Date.now()
          }
          notificationService.enqueueNotification(notification)
        })
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
        const win = BrowserWindow.getFocusedWindow()
        if (win) {
          win.removeBrowserView(session_.view)
        }
        ;(session_.view as any).destroy()
      } catch {
        // View might already be destroyed
      }
    }
  }
  sessions.clear()
}
