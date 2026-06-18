import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { storageService } from '../services/storage'
import { logger } from '../services/logger'
import type { MailAccount } from '@shared/types'

export function registerAccountsHandlers(): void {
  ipcMain.handle(IpcChannels.ACCOUNTS_LIST, () => {
    return storageService.getAccounts()
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_ADD, (_event, account: MailAccount) => {
    storageService.saveAccount(account)
    logger.info('Account added', { id: account.id, provider: account.provider, email: account.email })
    return account
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_REMOVE, (_event, accountId: string) => {
    storageService.deleteAccount(accountId)
    logger.info('Account removed', { accountId })
    return true
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_UPDATE, (_event, account: MailAccount) => {
    storageService.saveAccount(account)
    return account
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_SET_DEFAULT, (_event, accountId: string) => {
    const accounts = storageService.getAccounts()
    for (const acc of accounts) {
      acc.isDefault = acc.id === accountId
      storageService.saveAccount(acc)
    }
    return true
  })
}

