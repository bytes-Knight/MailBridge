import React, { useEffect, useRef, useCallback, useState } from 'react'
import type { EmailContextMenuAction } from '@shared/types'

interface ContextMenuProps {
  x: number
  y: number
  items: EmailContextMenuAction[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(-1)

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    // Clamp to viewport
    const rect = menu.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - 8
    const maxY = window.innerHeight - rect.height - 8
    if (x > maxX) menu.style.left = `${maxX}px`
    if (y > maxY) menu.style.top = `${maxY}px`
  }, [x, y])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const enabledItems = items.filter(i => !i.separator && !i.disabled)
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex(prev => Math.min(prev + 1, enabledItems.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex(prev => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (focusedIndex >= 0 && focusedIndex < enabledItems.length) {
            enabledItems[focusedIndex].onClick()
            onClose()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setTimeout(() => onClose(), 10)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mousedown', handleClickOutside)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [items, focusedIndex, onClose])

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return <div key={`sep-${idx}`} className="context-menu-separator" />
        }

        const enabledItems = items.filter(i => !i.separator && !i.disabled)
        const enabledIdx = enabledItems.indexOf(item)
        const isFocused = enabledIdx === focusedIndex

        return (
          <button
            key={item.id}
            className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''} ${isFocused ? 'focused' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            onMouseEnter={() => setFocusedIndex(enabledIdx)}
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
