import React, { useState, useEffect } from 'react'
import { brandLogoService } from '../../services/brandLogoService'
import { getDeterministicGradient, getInitials, extractDomain } from '../../services/bimi'

interface AvatarDisplayProps {
  email: string
  name?: string
  size?: 'small' | 'medium' | 'large'
  color?: string
  className?: string
}

export function AvatarDisplay({ email, name, size = 'medium', color, className = '' }: AvatarDisplayProps): React.ReactElement {
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoType, setLogoType] = useState<'svg' | 'img' | 'initials'>('initials')
  const [loading, setLoading] = useState(true)

  const domain = extractDomain(email)
  const gradient = getDeterministicGradient(email)
  const bgColor = color || gradient[0]
  const initials = getInitials(name || '', email)

  useEffect(() => {
    let cancelled = false

    const resolve = async () => {
      setLoading(true)
      try {
        const result = await brandLogoService.resolveLogo(email, name)
        if (cancelled) return

        if (result.type === 'initials') {
          setLogoType('initials')
          setLogoUrl(null)
        } else {
          setLogoType(result.type)
          setLogoUrl(result.data)
        }
      } catch {
        if (!cancelled) setLogoType('initials')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    resolve()
    return () => { cancelled = true }
  }, [email, name])

  const sizePx = size === 'small' ? 28 : size === 'large' ? 48 : 36
  const borderRadius = size === 'small' ? 8 : size === 'large' ? 12 : 10

  return (
    <div
      className={`avatar-display ${className}`}
      style={{
        width: sizePx,
        height: sizePx,
        borderRadius,
        backgroundColor: bgColor,
        overflow: 'hidden',
        flexShrink: 0
      }}
    >
      {loading ? (
        <div className="avatar-loading" style={{ width: '100%', height: '100%' }} />
      ) : logoType !== 'initials' && logoUrl ? (
        <img
          src={logoUrl}
          alt={name || email}
          style={{
            width: '100%',
            height: '100%',
            objectFit: logoType === 'svg' ? 'contain' : 'cover',
            padding: logoType === 'svg' ? '4px' : '0'
          }}
        />
      ) : (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 600,
          fontSize: sizePx * 0.4,
          userSelect: 'none'
        }}>
          {initials}
        </div>
      )}
    </div>
  )
}
