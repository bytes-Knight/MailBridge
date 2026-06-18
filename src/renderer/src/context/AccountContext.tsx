import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { MailAccount } from '@shared/types'

interface AccountContextValue {
  accounts: MailAccount[]
  defaultAccount: MailAccount | null
  loading: boolean
  refreshAccounts: () => Promise<void>
  addAccount: (account: MailAccount) => Promise<void>
  removeAccount: (accountId: string) => Promise<void>
  updateAccount: (account: MailAccount) => Promise<void>
  setDefaultAccount: (accountId: string) => Promise<void>
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [loading, setLoading] = useState(true)

  const refreshAccounts = useCallback(async () => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.accountsList) {
        const list = await mb.accountsList()
        setAccounts(list || [])
      }
    } catch {
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshAccounts()
  }, [refreshAccounts])

  const defaultAccount = accounts.find(a => a.isDefault) || accounts[0] || null

  const addAccount = useCallback(async (account: MailAccount) => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.accountsAdd) {
        await mb.accountsAdd(account)
        await refreshAccounts()
      }
    } catch (err) {
      console.error('Failed to add account', err)
    }
  }, [refreshAccounts])

  const removeAccount = useCallback(async (accountId: string) => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.accountsRemove) {
        await mb.accountsRemove(accountId)
        await refreshAccounts()
      }
    } catch (err) {
      console.error('Failed to remove account', err)
    }
  }, [refreshAccounts])

  const updateAccount = useCallback(async (account: MailAccount) => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.accountsUpdate) {
        await mb.accountsUpdate(account)
        await refreshAccounts()
      }
    } catch (err) {
      console.error('Failed to update account', err)
    }
  }, [refreshAccounts])

  const setDefault = useCallback(async (accountId: string) => {
    try {
      const mb = (window as any).mailbridge
      if (mb?.accountsSetDefault) {
        await mb.accountsSetDefault(accountId)
        await refreshAccounts()
      }
    } catch (err) {
      console.error('Failed to set default account', err)
    }
  }, [refreshAccounts])

  return (
    <AccountContext.Provider value={{
      accounts,
      defaultAccount,
      loading,
      refreshAccounts,
      addAccount,
      removeAccount,
      updateAccount,
      setDefaultAccount: setDefault
    }}>
      {children}
    </AccountContext.Provider>
  )
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext)
  if (!ctx) throw new Error('useAccount must be used within AccountProvider')
  return ctx
}
