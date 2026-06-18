export const IpcChannels = {
  // Accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ADD: 'accounts:add',
  ACCOUNTS_REMOVE: 'accounts:remove',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_SET_DEFAULT: 'accounts:set-default',
  // Proton
  PROTON_INIT_SESSION: 'proton:init-session',
  PROTON_CREATE_SESSION: 'proton:create-session',
  PROTON_REFRESH_SESSION: 'proton:refresh-session',
  PROTON_RESIZE_SESSION: 'proton:resize-session',
  PROTON_DESTROY_SESSION: 'proton:destroy-session',
  PROTON_HIDE_SESSION: 'proton:hide-session',
  PROTON_GET_SESSION_PATH: 'proton:get-session-path',
  PROTON_NOTIFY_LOGIN: 'proton:notify-login',
  PROTON_NOTIFY_LOGOUT: 'proton:notify-logout',
  PROTON_IS_LOGGED_IN: 'proton:is-logged-in',
  PROTON_STATUS: 'proton:status',
  PROTON_SHOW_SESSION: 'proton:show-session',
  PROTON_KEEP_ALIVE: 'proton:keep-alive',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',

  // Storage
  STORAGE_GET_CACHE_SIZE: 'storage:get-cache-size',
  STORAGE_CLEAR_CACHE: 'storage:clear-cache',
  STORAGE_EXPORT_DATA: 'storage:export-data',
  STORAGE_IMPORT_DATA: 'storage:import-data',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',

  // App
  APP_GET_VERSION: 'app:get-version',
  APP_GET_PLATFORM: 'app:get-platform',
  APP_OPEN_EXTERNAL: 'app:open-external',

  // Unread
  UNREAD_GET_COUNT: 'unread:get-count',
  UNREAD_BADGE_UPDATED: 'unread:badge-updated',
  UNREAD_SET_INBOX_COUNT: 'unread:set-inbox-count',

  // Sync
  SYNC_STATUS_STARTED: 'sync:status:started',
  SYNC_STATUS_COMPLETED: 'sync:status:completed',
  SYNC_STATUS_FAILED: 'sync:status:failed',

  // Dialog
  DIALOG_CONFIRM: 'dialog:confirm',

  // Notifications
  NOTIFICATION_NEW_EMAIL: 'notification:new-email',
  NOTIFICATION_GET_PREFERENCES: 'notification:get-preferences',
  NOTIFICATION_UPDATE_PREFERENCES: 'notification:update-preferences',
  NOTIFICATION_SOUND_PLAY: 'notification:sound-play',
  NOTIFICATION_GET_SOUND_DATA: 'notification:get-sound-data',
  NOTIFICATION_OPEN_CONVERSATION: 'notification:open-conversation',
  NOTIFICATION_SEND_TEST: 'notification:send-test',

  // Brand Identity / Logos
  LOGO_RESOLVE: 'logo:resolve',
  LOGO_RESOLVE_BATCH: 'logo:resolve-batch',
  LOGO_CLEAR_CACHE: 'logo:clear-cache',
  LOGO_GET_DIAGNOSTICS: 'logo:get-diagnostics',

  // Error
  ERROR_REPORT: 'error:report'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export const SYNC_STATUS_EVENTS = [
  IpcChannels.SYNC_STATUS_STARTED,
  IpcChannels.SYNC_STATUS_COMPLETED,
  IpcChannels.SYNC_STATUS_FAILED,
] as const

export const NOTIFICATION_EVENTS = [
  IpcChannels.NOTIFICATION_NEW_EMAIL,
  IpcChannels.NOTIFICATION_SOUND_PLAY,
  IpcChannels.NOTIFICATION_OPEN_CONVERSATION,
] as const
