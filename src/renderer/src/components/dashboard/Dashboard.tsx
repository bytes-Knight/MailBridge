import React from 'react'
import { useAccount } from '../../context/AccountContext'
import { useUnreadBadge } from '../../hooks/useUnreadBadge'
import { AvatarDisplay } from '../common/AvatarDisplay'

interface DashboardProps {
  onSelectAccount: (accountId: string) => void
  onAddAccount: () => void
}

export function Dashboard({ onSelectAccount, onAddAccount }: DashboardProps): React.ReactElement {
  const { accounts } = useAccount()
  const { badge } = useUnreadBadge()

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const protonCount = accounts.filter(a => a.provider === 'proton').length
  const totalUnread = badge?.total || 0

  return (
    <div className="dashboard">
      <div className="dashboard-greeting">
        <h1>{greeting}</h1>
        <p>Welcome to MailBridge</p>
      </div>

      <div className="dashboard-stats">
        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon" style={{ background: 'rgba(99,102,241,0.15)' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 7L2 7" />
            </svg>
          </div>
          <div className="dashboard-stat-info">
            <span className="dashboard-stat-value">{accounts.length}</span>
            <span className="dashboard-stat-label">Total Accounts</span>
          </div>
        </div>

        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon" style={{ background: 'rgba(239,68,68,0.15)' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div className="dashboard-stat-info">
            <span className="dashboard-stat-value">{totalUnread}</span>
            <span className="dashboard-stat-label">Unread</span>
          </div>
        </div>

        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon" style={{ background: 'rgba(139,92,246,0.15)' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div className="dashboard-stat-info">
            <span className="dashboard-stat-value">{protonCount}</span>
            <span className="dashboard-stat-label">Proton</span>
          </div>
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Accounts</h2>
          <div className="dashboard-account-list">
            {accounts.map(account => (
              <button
                key={account.id}
                className="dashboard-account-card"
                onClick={() => onSelectAccount(account.id)}
              >
                <AvatarDisplay
                  email={account.email}
                  name={account.name}
                  color={account.color}
                  size="large"
                />
                <div className="dashboard-account-info">
                  <span className="dashboard-account-name">{account.name || account.email.split('@')[0]}</span>
                  <span className="dashboard-account-email">{account.email}</span>
                </div>
                <span className="dashboard-account-badge proton">
                  PROTON
                </span>
                {badge?.perAccount[account.id] ? (
                  <span className="dashboard-account-unread">{badge.perAccount[account.id]}</span>
                ) : null}
                <svg className="dashboard-account-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {accounts.length === 0 && (
        <div className="dashboard-empty">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M22 7l-10 7L2 7" />
          </svg>
          <h2>No accounts yet</h2>
          <p>Add your first email account to get started</p>
          <button className="btn primary" onClick={onAddAccount}>Add Account</button>
        </div>
      )}
    </div>
  )
}
