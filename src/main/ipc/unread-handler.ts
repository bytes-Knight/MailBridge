import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { unreadCounter } from '../services/unread-counter'

export function registerUnreadHandlers(): void {
  ipcMain.handle(IpcChannels.UNREAD_GET_COUNT, () => {
    return unreadCounter.getPerAccount()
  })

  ipcMain.handle(IpcChannels.UNREAD_SET_INBOX_COUNT, (_event, accountId: string, count: number) => {
    unreadCounter.setInboxCount(accountId, count)
    return true
  })
}
