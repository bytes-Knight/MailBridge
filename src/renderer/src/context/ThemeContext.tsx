import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ThemeMode, AccentColor } from '@shared/types'

interface ThemeContextValue {
  theme: ThemeMode
  accentColor: AccentColor
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: ThemeMode) => void
  setAccentColor: (color: AccentColor) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const ACCENT_COLORS: Record<AccentColor, { base: string; hover: string; muted: string; glow: string }> = {
  indigo: { base: '#6366f1', hover: '#818cf8', muted: 'rgba(99,102,241,0.15)', glow: 'rgba(99,102,241,0.3)' },
  blue: { base: '#3b82f6', hover: '#60a5fa', muted: 'rgba(59,130,246,0.15)', glow: 'rgba(59,130,246,0.3)' },
  cyan: { base: '#06b6d4', hover: '#22d3ee', muted: 'rgba(6,182,212,0.15)', glow: 'rgba(6,182,212,0.3)' },
  emerald: { base: '#10b981', hover: '#34d399', muted: 'rgba(16,185,129,0.15)', glow: 'rgba(16,185,129,0.3)' },
  amber: { base: '#f59e0b', hover: '#fbbf24', muted: 'rgba(245,158,11,0.15)', glow: 'rgba(245,158,11,0.3)' },
  red: { base: '#ef4444', hover: '#f87171', muted: 'rgba(239,68,68,0.15)', glow: 'rgba(239,68,68,0.3)' },
  pink: { base: '#ec4899', hover: '#f472b6', muted: 'rgba(236,72,153,0.15)', glow: 'rgba(236,72,153,0.3)' },
  violet: { base: '#8b5cf6', hover: '#a78bfa', muted: 'rgba(139,92,246,0.15)', glow: 'rgba(139,92,246,0.3)' }
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [theme, setThemeState] = useState<ThemeMode>('dark')
  const [accentColor, setAccentColorState] = useState<AccentColor>('indigo')
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme())

  // Load settings from main process
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const mb = (window as any).mailbridge
        if (mb?.settingsGet) {
          const settings = await mb.settingsGet()
          if (settings.theme) setThemeState(settings.theme)
          if (settings.accentColor) setAccentColorState(settings.accentColor)
        }
      } catch {
        // Use defaults
      }
    }
    loadSettings()
  }, [])

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light')
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  const resolvedTheme = theme === 'system' ? systemTheme : theme

  // Apply theme and accent colors as CSS variables
  useEffect(() => {
    const root = document.documentElement
    const isDark = resolvedTheme === 'dark'

    root.setAttribute('data-theme', resolvedTheme)
    root.style.setProperty('--bg-primary', isDark ? '#0f0f13' : '#ffffff')
    root.style.setProperty('--bg-secondary', isDark ? '#1a1a23' : '#f5f5f7')
    root.style.setProperty('--bg-tertiary', isDark ? '#252533' : '#e8e8ed')
    root.style.setProperty('--bg-card', isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)')
    root.style.setProperty('--bg-glass', isDark ? 'rgba(26,26,35,0.85)' : 'rgba(255,255,255,0.85)')
    root.style.setProperty('--text-primary', isDark ? '#e4e4e7' : '#18181b')
    root.style.setProperty('--text-secondary', isDark ? '#a1a1aa' : '#52525b')
    root.style.setProperty('--text-tertiary', isDark ? '#71717a' : '#a1a1aa')
    root.style.setProperty('--border-color', isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')
    root.style.setProperty('--border-hover', isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)')

    const accent = ACCENT_COLORS[accentColor]
    if (accent) {
      root.style.setProperty('--accent', accent.base)
      root.style.setProperty('--accent-hover', accent.hover)
      root.style.setProperty('--accent-muted', accent.muted)
      root.style.setProperty('--accent-glow', accent.glow)
    }
  }, [resolvedTheme, accentColor])

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setThemeState(newTheme)
    try {
      const mb = (window as any).mailbridge
      if (mb?.settingsUpdate) {
        mb.settingsUpdate({ theme: newTheme })
      }
    } catch { /* ignore */ }
  }, [])

  const setAccentColor = useCallback((color: AccentColor) => {
    setAccentColorState(color)
    try {
      const mb = (window as any).mailbridge
      if (mb?.settingsUpdate) {
        mb.settingsUpdate({ accentColor: color })
      }
    } catch { /* ignore */ }
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, accentColor, resolvedTheme, setTheme, setAccentColor }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
