# MailBridge

A desktop email client for **Proton Mail** built with Electron. Provides native desktop notifications, system tray integration, and a seamless Proton Mail browsing experience.

## Features

- **📧 Proton Mail integration** — BrowserView-based session for full Proton Mail web interface
- **🔔 Desktop notifications** — Real-time new email alerts with sender, subject, and preview via Proton Mail page monitoring
- **🖥️ System tray** — Minimize to tray, background operation, badge count for unread emails
- **🔐 Built-in encryption** — All account data encrypted at rest using Electron's `safeStorage`
- **🌗 Dark/light theme** — Customizable appearance with accent color picker
- **📋 Multiple Proton accounts** — Add and switch between multiple Proton Mail accounts

## Requirements

- Windows 10/11 (64-bit)
- Node.js 18+ (for development)

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Package the installer (.exe)
npm run dist
```

## Project Structure

```
src/
├── main/                   # Electron main process
│   ├── ipc/                # IPC handlers (accounts, proton, settings, etc.)
│   ├── services/           # Core services (encryption, storage, notifications, sync)
│   └── windows/            # Main window creation
├── renderer/               # Electron renderer process (React)
│   ├── src/
│   │   ├── components/     # React components (common, proton, settings, dashboard)
│   │   ├── context/        # React contexts (accounts, theme)
│   │   ├── hooks/          # React hooks (notifications, sync status, unread badges)
│   │   └── services/       # Renderer services (error reporting, brand logos)
│   └── index.html
├── preload/                # Electron preload script (IPC bridge)
└── shared/                 # Shared types, constants, IPC channels
```

## Tech Stack

- **Electron** + **electron-vite** — Desktop shell
- **React 18** — UI framework
- **TypeScript** — Type safety
- **sql.js** (SQLite via WebAssembly) — Local encrypted storage
- **Electron safeStorage** — Encryption at rest

## Account Management

Accounts are added via the **Add Account** button in the sidebar. Each account creates its own Proton Mail BrowserView session. Sessions persist across app restarts and are kept alive in the background to prevent Proton timeouts.

## Notifications

MailBridge monitors the Proton Mail web interface for new emails by detecting unread count changes in the page title. When a new email arrives:
1. A native toast notification slides in from the bottom-right corner
2. A notification sound plays (optional)
3. The system tray badge updates with the new unread count

## License

MIT
