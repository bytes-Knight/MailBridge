import { safeStorage } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { logger } from './logger'

export class EncryptionService {
  private keyPath: string
  private fileKey: Buffer | null = null

  constructor() {
    this.keyPath = path.join(app.getPath('userData'), '.mailbridge-key')
  }

  encrypt(plaintext: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(plaintext)
        return 'ss:' + encrypted.toString('base64')
      } catch (err) {
        logger.warn('safeStorage encrypt failed, falling back to file key', err)
      }
    }
    return 'fk:' + this.encryptWithFileKey(plaintext)
  }

  decrypt(ciphertext: string): string {
    if (ciphertext.startsWith('ss:')) {
      // Try safeStorage first, fall back to file key if safeStorage is not available or fails
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const data = Buffer.from(ciphertext.slice(3), 'base64')
          return safeStorage.decryptString(data)
        } catch (err) {
          logger.warn('safeStorage decrypt failed, trying file key fallback', err)
          // Fall through to file key attempt
        }
      } else {
        logger.warn('safeStorage not available for ss: ciphertext, trying file key')
        // Fall through to file key attempt
      }
      // Attempt file key as fallback (strip ss: prefix and try fk: decryption on the raw data)
      try {
        return this.decryptWithFileKey(ciphertext.slice(3))
      } catch (err) {
        logger.warn('safeStorage + file key fallback both failed for ss: ciphertext', err)
        // One more attempt: try decrypting the raw base64 as if it were a legacy fk: format
        try {
          return this.decryptWithFileKey(ciphertext.slice(3))
        } catch {
          throw new Error('Failed to decrypt with both safeStorage and file key')
        }
      }
    }
    if (ciphertext.startsWith('fk:')) {
      return this.decryptWithFileKey(ciphertext.slice(3))
    }
    // Legacy format (no prefix)
    return this.decryptWithFileKey(ciphertext)
  }

  canDecrypt(): boolean {
    if (safeStorage.isEncryptionAvailable()) return true
    return fs.existsSync(this.keyPath)
  }

  hash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex')
  }

  private getFileKey(): Buffer {
    if (this.fileKey) return this.fileKey
    if (fs.existsSync(this.keyPath)) {
      this.fileKey = fs.readFileSync(this.keyPath)
    } else {
      this.fileKey = crypto.randomBytes(32)
      fs.writeFileSync(this.keyPath, this.fileKey)
    }
    return this.fileKey
  }

  private encryptWithFileKey(plaintext: string): string {
    const key = this.getFileKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    let encrypted = cipher.update(plaintext, 'utf-8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')
    return iv.toString('hex') + ':' + authTag + ':' + encrypted
  }

  private decryptWithFileKey(ciphertext: string): string {
    const key = this.getFileKey()
    const parts = ciphertext.split(':')
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted format')
    }
    const iv = Buffer.from(parts[0], 'hex')
    const authTag = Buffer.from(parts[1], 'hex')
    const encrypted = parts[2]
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8')
    decrypted += decipher.final('utf-8')
    return decrypted
  }
}

export const encryptionService = new EncryptionService()
