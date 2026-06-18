import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ThemeProvider } from './context/ThemeContext'
import { AccountProvider } from './context/AccountContext'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import './styles/global.css'
import { initErrorReporter } from './services/errorReporter'

initErrorReporter()

const rootElement = document.getElementById('root')
if (!rootElement) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0f0f13;color:#e4e4e7;font-family:system-ui,sans-serif;">
      <div style="text-align:center;">
        <h1 style="color:#6366f1;">MailBridge</h1>
        <p>Failed to initialize. Please restart the application.</p>
      </div>
    </div>
  `
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <AccountProvider>
            <App />
          </AccountProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>
  )
}
