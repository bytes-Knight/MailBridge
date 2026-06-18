import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Report to main process
    try {
      const mb = (window as any).mailbridge
      if (mb?.errorReport) {
        mb.errorReport({
          id: `err-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          timestamp: Date.now(),
          source: 'renderer',
          level: 'error',
          message: error.message,
          stack: error.stack,
          context: { componentStack: errorInfo.componentStack }
        })
      }
    } catch {
      // Silent
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#0f0f13',
          color: '#e4e4e7',
          fontFamily: '-apple-system, sans-serif',
          padding: 32,
          textAlign: 'center',
          gap: 12
        }}>
          <h1 style={{ color: '#6366f1', fontSize: 24 }}>MailBridge</h1>
          <p>Something went wrong</p>
          <p style={{ fontSize: 12, color: '#71717a', maxWidth: 400 }}>
            {this.state.error?.message}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            style={{
              padding: '8px 20px',
              background: '#6366f1',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
