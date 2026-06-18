import React, { useState } from 'react'
import { useAccount } from '../../context/AccountContext'
import { ACCOUNT_COLORS } from '@shared/constants'
import type { ProtonAccount } from '@shared/types'

interface AddAccountModalProps {
  onClose: () => void
}

export function AddAccountModal({ onClose }: AddAccountModalProps): React.ReactElement {
  const { accounts, addAccount } = useAccount()
  const [protonEmail, setProtonEmail] = useState('')
  const [protonName, setProtonName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleProtonAdd = async () => {
    if (!protonEmail.trim()) return
    setStatus('Adding Proton account...')
    setError(null)
    try {
      const colorIndex = accounts.length % ACCOUNT_COLORS.length
      const account: ProtonAccount = {
        id: `proton-${Date.now()}`,
        provider: 'proton',
        email: protonEmail.trim(),
        name: protonName.trim() || undefined,
        avatarInitial: (protonName.trim() || protonEmail.trim())[0].toUpperCase(),
        color: ACCOUNT_COLORS[colorIndex],
        isDefault: accounts.length === 0,
        isLoggedIn: false
      }
      await addAccount(account)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add account')
      setStatus(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Proton Account</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="add-account-form">
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className="form-input"
                type="email"
                placeholder="user@proton.me"
                value={protonEmail}
                onChange={e => setProtonEmail(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Display Name (optional)</label>
              <input
                className="form-input"
                type="text"
                placeholder="Your Name"
                value={protonName}
                onChange={e => setProtonName(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              onClick={handleProtonAdd}
              disabled={!protonEmail.trim() || !!status}
            >
              {status || 'Add Account'}
            </button>
            {error && <p className="add-account-error">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
