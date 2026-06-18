import React, { useRef, useCallback, useEffect } from 'react'

interface DraggableDividerProps {
  orientation: 'vertical' | 'horizontal'
  onResize: (delta: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
}

export function DraggableDivider({ orientation, onResize, onResizeStart, onResizeEnd }: DraggableDividerProps): React.ReactElement {
  const isDraggingRef = useRef(false)
  const lastPosRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true
    lastPosRef.current = orientation === 'vertical' ? e.clientX : e.clientY
    onResizeStart?.()
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [orientation, onResizeStart])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const currentPos = orientation === 'vertical' ? e.clientX : e.clientY
      const delta = currentPos - lastPosRef.current
      lastPosRef.current = currentPos
      onResize(delta)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        onResizeEnd?.()
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [orientation, onResize, onResizeEnd])

  return (
    <div
      className={`draggable-divider ${orientation}`}
      onMouseDown={handleMouseDown}
    >
      <div className="draggable-divider-handle" />
    </div>
  )
}
