import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '@shared/ipc'

const mailbridge = {
  // Accounts
  accountsList: () => ipcRenderer.invoke(IpcChannels.ACCOUNTS_LIST),
  accountsAdd: (account: any) => ipcRenderer.invoke(IpcChannels.ACCOUNTS_ADD, account),
  accountsRemove: (accountId: string) => ipcRenderer.invoke(IpcChannels.ACCOUNTS_REMOVE, accountId),
  accountsUpdate: (account: any) => ipcRenderer.invoke(IpcChannels.ACCOUNTS_UPDATE, account),
  accountsSetDefault: (accountId: string) => ipcRenderer.invoke(IpcChannels.ACCOUNTS_SET_DEFAULT, accountId),
  // Proton
  protonInitSession: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_INIT_SESSION, accountId),
  protonCreateSession: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_CREATE_SESSION, accountId),
  protonRefreshSession: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_REFRESH_SESSION, accountId),
  protonResizeSession: (accountId: string, bounds: any) => ipcRenderer.invoke(IpcChannels.PROTON_RESIZE_SESSION, accountId, bounds),
  protonDestroySession: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_DESTROY_SESSION, accountId),
  protonHideSession: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_HIDE_SESSION, accountId),
  protonGetSessionPath: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_GET_SESSION_PATH, accountId),
  protonNotifyLogin: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_NOTIFY_LOGIN, accountId),
  protonNotifyLogout: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_NOTIFY_LOGOUT, accountId),
  protonIsLoggedIn: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_IS_LOGGED_IN, accountId),
  protonStatus: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_STATUS, accountId),
  protonShowSession: (accountId: string, bounds?: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(IpcChannels.PROTON_SHOW_SESSION, accountId, bounds),
  protonKeepAlive: (accountId: string) => ipcRenderer.invoke(IpcChannels.PROTON_KEEP_ALIVE, accountId),

  // Settings
  settingsGet: () => ipcRenderer.invoke(IpcChannels.SETTINGS_GET),
  settingsUpdate: (settings: any) => ipcRenderer.invoke(IpcChannels.SETTINGS_UPDATE, settings),
  settingsReset: () => ipcRenderer.invoke(IpcChannels.SETTINGS_RESET),

  // Storage
  storageGetCacheSize: () => ipcRenderer.invoke(IpcChannels.STORAGE_GET_CACHE_SIZE),
  storageClearCache: () => ipcRenderer.invoke(IpcChannels.STORAGE_CLEAR_CACHE),
  storageExportData: () => ipcRenderer.invoke(IpcChannels.STORAGE_EXPORT_DATA),
  storageImportData: (blob: string) => ipcRenderer.invoke(IpcChannels.STORAGE_IMPORT_DATA, blob),

  // Window
  windowMinimize: () => ipcRenderer.invoke(IpcChannels.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.invoke(IpcChannels.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.invoke(IpcChannels.WINDOW_CLOSE),
  windowIsMaximized: () => ipcRenderer.invoke(IpcChannels.WINDOW_IS_MAXIMIZED),

  // App
  appGetVersion: () => ipcRenderer.invoke(IpcChannels.APP_GET_VERSION),
  appGetPlatform: () => ipcRenderer.invoke(IpcChannels.APP_GET_PLATFORM),
  appOpenExternal: (url: string) => ipcRenderer.invoke(IpcChannels.APP_OPEN_EXTERNAL, url),
  dialogConfirm: (options: any) => ipcRenderer.invoke(IpcChannels.DIALOG_CONFIRM, options),
  errorReport: (report: any) => ipcRenderer.invoke(IpcChannels.ERROR_REPORT, report),

  // Unread
  unreadGetCount: () => ipcRenderer.invoke(IpcChannels.UNREAD_GET_COUNT),
  unreadSetInboxCount: (accountId: string, count: number) => ipcRenderer.invoke(IpcChannels.UNREAD_SET_INBOX_COUNT, accountId, count),

  // Brand Identity / Logos
  logoResolve: (params: { email: string; name?: string }) => ipcRenderer.invoke(IpcChannels.LOGO_RESOLVE, params),
  logoResolveBatch: (params: { entries: Array<{ email: string; name?: string }> }) => ipcRenderer.invoke(IpcChannels.LOGO_RESOLVE_BATCH, params),
  logoClearCache: () => ipcRenderer.invoke(IpcChannels.LOGO_CLEAR_CACHE),
  logoGetDiagnostics: () => ipcRenderer.invoke(IpcChannels.LOGO_GET_DIAGNOSTICS),

  // Notifications
  notificationSendTest: () => ipcRenderer.invoke(IpcChannels.NOTIFICATION_SEND_TEST),

  // Push event listeners
  onProtonStatus: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.PROTON_STATUS, handler)
    return () => ipcRenderer.removeListener(IpcChannels.PROTON_STATUS, handler)
  },
  onSyncStatusStarted: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.SYNC_STATUS_STARTED, handler)
    return () => ipcRenderer.removeListener(IpcChannels.SYNC_STATUS_STARTED, handler)
  },
  onSyncStatusCompleted: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.SYNC_STATUS_COMPLETED, handler)
    return () => ipcRenderer.removeListener(IpcChannels.SYNC_STATUS_COMPLETED, handler)
  },
  onSyncStatusFailed: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.SYNC_STATUS_FAILED, handler)
    return () => ipcRenderer.removeListener(IpcChannels.SYNC_STATUS_FAILED, handler)
  },
  onNewEmailNotification: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.NOTIFICATION_NEW_EMAIL, handler)
    return () => ipcRenderer.removeListener(IpcChannels.NOTIFICATION_NEW_EMAIL, handler)
  },
  onNotificationSoundPlay: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.NOTIFICATION_SOUND_PLAY, handler)
    return () => ipcRenderer.removeListener(IpcChannels.NOTIFICATION_SOUND_PLAY, handler)
  },
  onNotificationOpenConversation: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.NOTIFICATION_OPEN_CONVERSATION, handler)
    return () => ipcRenderer.removeListener(IpcChannels.NOTIFICATION_OPEN_CONVERSATION, handler)
  },
  onUnreadBadgeUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IpcChannels.UNREAD_BADGE_UPDATED, handler)
    return () => ipcRenderer.removeListener(IpcChannels.UNREAD_BADGE_UPDATED, handler)
  },
  onMaximizedChanged: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },

  // External link confirmation
  externalLinkResult: (confirmed: boolean) => ipcRenderer.send(IpcChannels.EXTERNAL_LINK_RESULT, confirmed),
  onExternalLinkConfirm: (callback: (url: string) => void) => {
    const handler = (_event: any, url: string) => callback(url)
    ipcRenderer.on(IpcChannels.EXTERNAL_LINK_CONFIRM, handler)
    return () => ipcRenderer.removeListener(IpcChannels.EXTERNAL_LINK_CONFIRM, handler)
  }
}

contextBridge.exposeInMainWorld('mailbridge', mailbridge)

export type MailBridgeAPI = typeof mailbridge
