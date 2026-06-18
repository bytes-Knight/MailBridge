import React, { useState, useEffect } from 'react'

interface ExternalLinkModalProps {
  url: string
  onCancel: () => void
  onConfirm: () => void
}

export function ExternalLinkModal({ url, onCancel, onConfirm }: ExternalLinkModalProps): React.ReactElement {
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, onConfirm])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('success')
      setTimeout(() => setCopyState('idle'), 1200)
    } catch {
      setCopyState('error')
      setTimeout(() => setCopyState('idle'), 1200)
    }
  }

  let hostname = ''
  try { hostname = new URL(url).hostname } catch { hostname = url }

  const displayUrl = url.length > 120 ? url.substring(0, 120) + '...' : url

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="external-link-modal" onClick={e => e.stopPropagation()}>
        <div className="external-link-modal-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </div>
        <div className="external-link-modal-title">External Link</div>
        <div className="external-link-modal-hostname">{hostname.toUpperCase()}</div>
        <div className="external-link-modal-url">{displayUrl}</div>
        <div className="external-link-modal-hint">Only follow links from senders you trust</div>
        <div className="external-link-modal-actions">
          <button className="btn ghost" onClick={handleCopy}>
            {copyState === 'success' ? (
              <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg> Copied</>
            ) : copyState === 'error' ? (
              <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg> Failed</>
            ) : 'Copy URL'}
          </button>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>Visit Link</button>
        </div>
      </div>
    </div>
  )
}
