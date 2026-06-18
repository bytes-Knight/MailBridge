import React, { useState, useEffect, useCallback } from 'react'
import type { AppSettings, ThemeMode, AccentColor } from '@shared/types'
import { useTheme } from '../../context/ThemeContext'
import { useAccount } from '../../context/AccountContext'

const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sync', label: 'Sync' },
  { id: 'browser', label: 'Browser' },
  { id: 'cache', label: 'Data & Cache' }
] as const

export function SettingsView(): React.ReactElement {
  const { accounts, removeAccount } = useAccount()
  const { setTheme, setAccentColor } = useTheme()
  const [activeSection, setActiveSection] = useState<string>('general')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [cacheSize, setCacheSize] = useState('Calculating...')

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const mb = (window as any).mailbridge
        const s = await mb?.settingsGet?.()
        if (s) setSettings(s)
      } catch { /* ignore */ }
    }
    loadSettings()
    getCacheSize()
  }, [])

  const getCacheSize = async () => {
    try {
      const mb = (window as any).mailbridge
      const size = await mb?.storageGetCacheSize?.()
      if (size !== undefined) {
        const units = ['B', 'KB', 'MB', 'GB']
        const i = Math.floor(Math.log(size) / Math.log(1024))
        setCacheSize(`${(size / Math.pow(1024, i)).toFixed(1)} ${units[i]}`)
      }
    } catch { setCacheSize('N/A') }
  }

  const updateSetting = useCallback(async (key: keyof AppSettings, value: any) => {
    try {
      const mb = (window as any).mailbridge
      await mb?.settingsUpdate?.({ [key]: value })
      setSettings(prev => prev ? { ...prev, [key]: value } : prev)
    } catch { /* ignore */ }
  }, [])

  const handleTestNotification = async () => {
    setTestStatus('Sending...')
    try {
      const mb = (window as any).mailbridge
      await mb?.notificationSendTest?.()
      setTestStatus('Test notification sent!')
      setTimeout(() => setTestStatus(null), 3000)
    } catch {
      setTestStatus('Failed to send test notification')
    }
  }

  const handleExport = async () => {
    try {
      const mb = (window as any).mailbridge
      const data = await mb?.storageExportData?.()
      if (data) {
        const blob = new Blob([data], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'mailbridge-export.dat'
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch { /* ignore */ }
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.dat'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const mb = (window as any).mailbridge
        await mb?.storageImportData?.(text)
      } catch { /* ignore */ }
    }
    input.click()
  }

  const handleClearCache = async () => {
    try {
      const mb = (window as any).mailbridge
      await mb?.storageClearCache?.()
      getCacheSize()
    } catch { /* ignore */ }
  }

  if (!settings) {
    return <div className="settings-loading">Loading settings...</div>
  }

  const renderSection = () => {
    switch (activeSection) {
      case 'general':
        return (
          <div className="settings-section">
            <h2>General</h2>
            <div className="settings-group">
              <SettingToggle label="Launch on startup" value={settings.launchOnStartup} onChange={(v) => updateSetting('launchOnStartup', v)} />
              <SettingToggle label="Minimize to tray" value={settings.minimizeToTray} onChange={(v) => updateSetting('minimizeToTray', v)} />
              <SettingToggle label="Open to dashboard" value={settings.openToDashboard} onChange={(v) => updateSetting('openToDashboard', v)} />
              <SettingSelect label="Default account" value={settings.defaultAccount || ''} options={accounts.map(a => ({ value: a.id, label: a.email }))} onChange={(v) => updateSetting('defaultAccount', v || null)} />
            </div>
          </div>
        )

      case 'appearance':
        return (
          <div className="settings-section">
            <h2>Appearance</h2>
            <div className="settings-group">
              <SettingSelect label="Theme" value={settings.theme} options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' }
              ]} onChange={(v) => { updateSetting('theme', v as ThemeMode); setTheme(v as ThemeMode) }} />

              <div className="settings-field">
                <label className="settings-label">Accent Color</label>
                <div className="accent-picker">
                  {(['indigo', 'blue', 'cyan', 'emerald', 'amber', 'red', 'pink', 'violet'] as AccentColor[]).map(color => {
                    const colors: Record<AccentColor, string> = { indigo: '#6366f1', blue: '#3b82f6', cyan: '#06b6d4', emerald: '#10b981', amber: '#f59e0b', red: '#ef4444', pink: '#ec4899', violet: '#8b5cf6' }
                    return (
                      <button
                        key={color}
                        className={`accent-picker-swatch ${settings.accentColor === color ? 'active' : ''}`}
                        style={{ backgroundColor: colors[color] }}
                        onClick={() => { updateSetting('accentColor', color); setAccentColor(color) }}
                        title={color}
                      />
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )

      case 'accounts':
        return (
          <div className="settings-section">
            <h2>Accounts</h2>
            <div className="settings-group">
              {accounts.map(account => (
                <div key={account.id} className="settings-account-row">
                  <div className="settings-account-icon" style={{ backgroundColor: account.color }}>
                    {(account.name || account.email)[0].toUpperCase()}
                  </div>
                  <div className="settings-account-info">
                    <span className="settings-account-name">{account.name || account.email}</span>
                    <span className="settings-account-email">{account.email}</span>
                    <span className="settings-account-badge">{account.provider.toUpperCase()}</span>
                  </div>
                  <button className="btn ghost danger" onClick={() => removeAccount(account.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )

      case 'notifications':
        return (
          <div className="settings-section">
            <h2>Notifications</h2>
            <div className="settings-group">
              <SettingToggle label="Enable notifications" value={settings.notificationsEnabled} onChange={(v) => updateSetting('notificationsEnabled', v)} />
              <SettingToggle label="Notification sound" value={settings.notificationSound} onChange={(v) => updateSetting('notificationSound', v)} />
              <SettingToggle label="Show previews" value={settings.showPreviews} onChange={(v) => updateSetting('showPreviews', v)} />
              <SettingToggle label="Proton notifications" value={settings.notifyForProton} onChange={(v) => updateSetting('notifyForProton', v)} />
              <SettingToggle label="Do Not Disturb" value={settings.doNotDisturb} onChange={(v) => updateSetting('doNotDisturb', v)} />
              <SettingSelect label="Auto-dismiss" value={String(settings.autoDismissDuration)} options={[
                { value: '3000', label: '3 seconds' },
                { value: '5000', label: '5 seconds' },
                { value: '10000', label: '10 seconds' },
                { value: '0', label: 'Until dismissed' }
              ]} onChange={(v) => updateSetting('autoDismissDuration', Number(v))} />
              <SettingSelect label="Click behavior" value={settings.clickBehavior} options={[
                { value: 'open-message', label: 'Open message' },
                { value: 'open-inbox', label: 'Open inbox' }
              ]} onChange={(v) => updateSetting('clickBehavior', v as 'open-message' | 'open-inbox')} />

              <div className="settings-field">
                <span className="settings-label">Test Notification</span>
                <button className="btn" onClick={handleTestNotification}>
                  Send Test Notification
                </button>
                {testStatus && <span className="settings-status">{testStatus}</span>}
              </div>
            </div>
          </div>
        )

      case 'sync':
        return (
          <div className="settings-section">
            <h2>Sync</h2>
            <div className="settings-group">
              <SettingToggle label="Auto-sync" value={settings.autoSync} onChange={(v) => updateSetting('autoSync', v)} />
              <SettingToggle label="Sync on startup" value={settings.syncOnStartup} onChange={(v) => updateSetting('syncOnStartup', v)} />
              <SettingSelect label="Sync interval" value={String(settings.syncInterval)} options={[
                { value: '20', label: '20 seconds' },
                { value: '30', label: '30 seconds' },
                { value: '60', label: '1 minute' },
                { value: '300', label: '5 minutes' },
                { value: '900', label: '15 minutes' },
                { value: '3600', label: '1 hour' }
              ]} onChange={(v) => updateSetting('syncInterval', Number(v))} />
            </div>
          </div>
        )

      case 'browser':
        return (
          <div className="settings-section">
            <h2>Browser (Proton)</h2>
            <div className="settings-group">
              <SettingToggle label="Clear session on exit" value={settings.clearSessionOnExit} onChange={(v) => updateSetting('clearSessionOnExit', v)} />
              <SettingToggle label="Block third-party cookies" value={settings.blockThirdPartyCookies} onChange={(v) => updateSetting('blockThirdPartyCookies', v)} />
            </div>
          </div>
        )

      case 'cache':
        return (
          <div className="settings-section">
            <h2>Data &amp; Cache</h2>
            <div className="settings-group">
              <div className="settings-field">
                <span className="settings-label">Cached data size</span>
                <span className="settings-value">{cacheSize}</span>
              </div>
              <button className="btn" onClick={handleClearCache}>Clear Cache</button>
              <SettingToggle label="Auto-clean" value={settings.autoClean} onChange={(v) => updateSetting('autoClean', v)} />
              <div className="settings-field">
                <span className="settings-label">Export/Import</span>
                <div className="settings-buttons">
                  <button className="btn" onClick={handleExport}>Export Data</button>
                  <button className="btn" onClick={handleImport}>Import Data</button>
                </div>
              </div>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="settings-view">
      <nav className="settings-nav">
        {SETTINGS_SECTIONS.map(section => (
          <button
            key={section.id}
            className={`settings-nav-item ${activeSection === section.id ? 'active' : ''}`}
            onClick={() => setActiveSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {renderSection()}
      </div>
    </div>
  )
}

// Helper components
function SettingToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="settings-field">
      <span className="settings-label">{label}</span>
      <button
        className={`toggle-switch ${value ? 'on' : 'off'}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <div className="toggle-switch-thumb" />
      </button>
    </div>
  )
}

function SettingSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <div className="settings-field">
      <span className="settings-label">{label}</span>
      <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}
