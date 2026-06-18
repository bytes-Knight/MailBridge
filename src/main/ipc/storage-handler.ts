import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc'
import { storageService } from '../services/storage'

export function registerStorageHandlers(): void {
  ipcMain.handle(IpcChannels.STORAGE_GET_CACHE_SIZE, () => {
    return storageService.getCacheSize()
  })

  ipcMain.handle(IpcChannels.STORAGE_CLEAR_CACHE, () => {
    storageService.clearCache()
    return true
  })

  ipcMain.handle(IpcChannels.STORAGE_EXPORT_DATA, () => {
    return storageService.exportData()
  })

  ipcMain.handle(IpcChannels.STORAGE_IMPORT_DATA, (_event, encryptedBlob: string) => {
    return storageService.importData(encryptedBlob)
  })
}
