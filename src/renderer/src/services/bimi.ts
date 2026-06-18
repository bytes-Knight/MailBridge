const GRADIENTS = [
  ['#6366f1', '#4f46e5'],
  ['#3b82f6', '#2563eb'],
  ['#06b6d4', '#0891b2'],
  ['#10b981', '#059669'],
  ['#f59e0b', '#d97706'],
  ['#ef4444', '#dc2626'],
  ['#ec4899', '#db2777'],
  ['#8b5cf6', '#7c3aed']
]

export async function queryBimiRecord(domain: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://dns.google/resolve?name=default._bimi.${domain}&type=TXT`
    )
    if (!response.ok) return null

    const data = await response.json()
    const answers = data.Answer as Array<{ data: string }> | undefined
    if (!answers) return null

    for (const answer of answers) {
      const text = answer.data.replace(/"/g, '')
      // Look for SVG URL in BIMI record
      const urlMatch = text.match(/https?:\/\/[^\s;"]+\.svg[^\s;"]*/i)
      if (urlMatch) return urlMatch[0]
    }
    return null
  } catch {
    return null
  }
}

export async function getFaviconUrl(domain: string): Promise<string | null> {
  try {
    // Try Google favicons service
    const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    const response = await fetch(googleUrl, { method: 'HEAD' })
    if (response.ok) return googleUrl

    // Try direct favicon.ico
    const directUrl = `https://${domain}/favicon.ico`
    const directResponse = await fetch(directUrl, { method: 'HEAD' })
    if (directResponse.ok) return directUrl

    return null
  } catch {
    return null
  }
}

export function getDeterministicGradient(email: string): string[] {
  const hash = email.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return GRADIENTS[hash % GRADIENTS.length]
}

export function getInitials(name: string, email: string): string {
  if (name) {
    const parts = name.split(' ').filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  }
  return email.substring(0, 2).toUpperCase()
}

export function extractDomain(email: string): string {
  const match = email.match(/@([\w.-]+)/)
  return match ? match[1].toLowerCase() : ''
}
