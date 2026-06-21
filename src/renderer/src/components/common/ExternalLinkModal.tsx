import React, { useState, useEffect, useCallback } from 'react'

interface ExternalLinkModalProps {
  url: string
  onCancel: () => void
  onConfirm: () => void
}

function validateUrl(url: string): { valid: boolean; isHttps: boolean; hostname: string; suspicious: boolean; warning: string } {
  try {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const hostname = parsed.hostname
    
    // Check for suspicious patterns
    let suspicious = false
    let warning = ''
    
    // IP address instead of domain name
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      suspicious = true
      warning = 'This link uses an IP address instead of a domain name'
    }
    
    // Missing protocol = suspicious (already parsed, so it has one)
    if (!parsed.protocol || parsed.protocol === 'about:' || parsed.protocol === 'chrome-extension:') {
      suspicious = true
      warning = warning || 'This link uses an unsupported protocol'
    }
    
    return { valid: true, isHttps, hostname, suspicious, warning }
  } catch {
    return { valid: false, isHttps: false, hostname: url, suspicious: true, warning: 'This URL appears to be malformed' }
  }
}

export function ExternalLinkModal({ url, onCancel, onConfirm }: ExternalLinkModalProps): React.ReactElement {
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')
  const [mounted, setMounted] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const urlInfo = validateUrl(url)

  useEffect(() => {
    // Trigger staggered entrance animation after mount
    const t = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(t)
  }, [])

  const handleConfirm = useCallback(() => {
    onConfirm()
    // If user checked "Don't ask again", save preference
    // Uses atomic write — only writes the trustedDomains field to avoid
    // race conditions with other settings changes
    if (dontAskAgain && urlInfo.hostname) {
      try {
        const mb = (window as any).mailbridge
        mb?.settingsGet?.().then((settings: any) => {
          const currentTrusted: string[] = settings?.trustedDomains || []
          if (!currentTrusted.includes(urlInfo.hostname)) {
            const updated = [...currentTrusted, urlInfo.hostname]
            mb?.settingsUpdate?.({ trustedDomains: updated })
          }
        })
      } catch {}
    }
  }, [onConfirm, dontAskAgain, urlInfo.hostname])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('success')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch {
      setCopyState('error')
      setTimeout(() => setCopyState('idle'), 1500)
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') handleConfirm()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, handleConfirm])

  const hostname = urlInfo.hostname
  const displayUrl = url.length > 120 ? url.substring(0, 120) + '...' : url

  return (
    <div className="elm-backdrop" onClick={onCancel}>
      <div
        className={`elm-card ${mounted ? 'elm-mounted' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Animated gradient border glow */}
        <div className="elm-glow" />

        {/* Inner wrapper clips content so the glow can flow behind */}
        <div className="elm-card-inner">

        {/* Header with icon */}
        <div className={`elm-section elm-header-row ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '40ms' }}>
          <div className={`elm-icon-ring ${urlInfo.suspicious ? 'elm-icon-ring-warning' : ''}`}>
            <div className="elm-icon-pulse" />
            <div className={`elm-icon-inner ${!urlInfo.isHttps ? 'elm-icon-insecure' : ''}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </div>
          </div>
          <div className="elm-header-text">
            <div className="elm-title">Open External Link?</div>
            <div className={`elm-hostname ${!urlInfo.isHttps ? 'elm-hostname-insecure' : ''}`}>{hostname.toUpperCase()}</div>
            <div className="elm-protocol-badge">
              <span className={`elm-protocol-dot ${urlInfo.isHttps ? 'elm-protocol-secure' : 'elm-protocol-insecure'}`} />
              {urlInfo.isHttps ? 'HTTPS (secure)' : 'HTTP (not encrypted)'}
            </div>
          </div>
        </div>

        {/* URL display */}
        <div className={`elm-section ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '100ms' }}>
          <div className="elm-url-box">
            <div className="elm-url-label">Destination URL</div>
            <div className="elm-url-text">{displayUrl}</div>
          </div>
        </div>

        {/* Security warning */}
        {urlInfo.warning && (
          <div className={`elm-section ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '140ms' }}>
            <div className="elm-warning">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{urlInfo.warning}</span>
            </div>
          </div>
        )}

        {/* Hint */}
        <div className={`elm-section ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '180ms' }}>
          <div className="elm-hint">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>Only follow links from senders you trust</span>
          </div>
        </div>

        {/* Don't ask again checkbox */}
        <div className={`elm-section ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '200ms' }}>
          <label className="elm-remember">
            <input
              type="checkbox"
              className="elm-remember-checkbox"
              checked={dontAskAgain}
              onChange={e => setDontAskAgain(e.target.checked)}
            />
            <span className="elm-remember-text">Don't ask again for <strong>{hostname}</strong></span>
          </label>
        </div>

        {/* Actions */}
        <div className={`elm-section ${mounted ? 'elm-section-visible' : ''}`} style={{ transitionDelay: '240ms' }}>
          <div className="elm-actions">
            <button
              className={`elm-btn elm-btn-copy${copyState === 'success' ? ' elm-copied' : ''}${copyState === 'error' ? ' elm-copy-error' : ''}`}
              onClick={handleCopy}
            >
              {copyState === 'success' ? (
                <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg> Copied</>
              ) : copyState === 'error' ? (
                <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg> Failed</>
              ) : (
                <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg> Copy URL</>
              )}
            </button>
            <button className="elm-btn elm-btn-cancel" onClick={onCancel}>Cancel</button>
            <button className="elm-btn elm-btn-confirm" onClick={handleConfirm}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              Visit Link
            </button>
          </div>
        </div>
        </div>{/* end elm-card-inner */}
      </div>
    </div>
  )
}
