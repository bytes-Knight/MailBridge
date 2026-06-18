import React, { useState } from 'react'
import { useAccount } from '../../context/AccountContext'
import type { MailAccount } from '@shared/types'

interface SidebarProps {
  activeAccountId: string | null
  onSelectAccount: (accountId: string) => void
  onAddAccount: () => void
  onDashboard: () => void
}

export function Sidebar({ activeAccountId, onSelectAccount, onAddAccount, onDashboard }: SidebarProps): React.ReactElement {
  const { accounts } = useAccount()
  const [protonExpanded, setProtonExpanded] = useState(true)

  const protonAccounts = accounts.filter(a => a.provider === 'proton')

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <button className="sidebar-nav-item active" onClick={onDashboard}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span>Dashboard</span>
        </button>
      </div>

      {accounts.length === 0 && (
        <div className="sidebar-empty">
          <p>No accounts yet</p>
          <p className="sidebar-empty-hint">Add an account to get started</p>
        </div>
      )}

      {protonAccounts.length > 0 && (
        <div className="sidebar-section">
          <button
            className="sidebar-section-header"
            onClick={() => setProtonExpanded(!protonExpanded)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: protonExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M9 18l6-6-6-6" />
            </svg>
            <span>Proton</span>
            <span className="sidebar-count">{protonAccounts.length}</span>
          </button>

          {protonExpanded && (
            <div className="sidebar-items">
              {protonAccounts.map(account => (
                <button
                  key={account.id}
                  className={`sidebar-item ${activeAccountId === account.id ? 'active' : ''}`}
                  onClick={() => onSelectAccount(account.id)}
                >
                  <div
                    className="sidebar-avatar"
                    style={{ backgroundColor: account.color }}
                  >
                    {account.avatarInitial || account.email[0].toUpperCase()}
                  </div>
                  <div className="sidebar-item-info">
                    <span className="sidebar-item-name">{account.name || account.email.split('@')[0]}</span>
                    <span className="sidebar-item-email">{account.email}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-nav-item" onClick={onAddAccount}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <span>Add Account</span>
        </button>
      </div>
    </aside>
  )
}
