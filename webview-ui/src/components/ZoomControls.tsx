import { useState, useEffect, useRef } from 'react'

interface ZoomControlsProps {
  zoom: number
  onZoomChange: (zoom: number) => void
}

const btnBase: React.CSSProperties = {
  width: 40,
  height: 40,
  padding: 0,
  background: '#1e1e2e',
  color: 'rgba(255, 255, 255, 0.8)',
  border: '2px solid #4a4a6a',
  borderRadius: 0,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '2px 2px 0px #0a0a14',
}

export function ZoomControls({ zoom, onZoomChange }: ZoomControlsProps) {
  const [hovered, setHovered] = useState<'minus' | 'plus' | null>(null)
  const [showLevel, setShowLevel] = useState(false)
  const [fadeOut, setFadeOut] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevZoomRef = useRef(zoom)

  const minDisabled = zoom <= 1
  const maxDisabled = zoom >= 10

  // Show zoom level briefly when zoom changes
  useEffect(() => {
    if (zoom === prevZoomRef.current) return
    prevZoomRef.current = zoom

    // Clear existing timers
    if (timerRef.current) clearTimeout(timerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)

    setShowLevel(true)
    setFadeOut(false)

    // Start fade after 1.5s
    fadeTimerRef.current = setTimeout(() => {
      setFadeOut(true)
    }, 1500)

    // Hide completely after 2s
    timerRef.current = setTimeout(() => {
      setShowLevel(false)
      setFadeOut(false)
    }, 2000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [zoom])

  return (
    <>
      {/* Zoom level indicator at top-center */}
      {showLevel && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            background: '#1e1e2e',
            border: '2px solid #4a4a6a',
            borderRadius: 0,
            padding: '4px 12px',
            boxShadow: '2px 2px 0px #0a0a14',
            fontSize: '26px',
            color: 'rgba(255, 255, 255, 0.8)',
            userSelect: 'none',
            opacity: fadeOut ? 0 : 1,
            transition: 'opacity 0.5s ease-out',
            pointerEvents: 'none',
          }}
        >
          {zoom}x
        </div>
      )}

      {/* Vertically stacked round buttons — top-left */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          onClick={() => onZoomChange(zoom + 1)}
          disabled={maxDisabled}
          onMouseEnter={() => setHovered('plus')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            background: hovered === 'plus' && !maxDisabled ? 'rgba(255, 255, 255, 0.15)' : btnBase.background,
            cursor: maxDisabled ? 'default' : 'pointer',
            opacity: maxDisabled ? 0.3 : 1,
          }}
          title="Zoom in (Ctrl+Scroll)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <line x1="9" y1="3" x2="9" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={() => onZoomChange(zoom - 1)}
          disabled={minDisabled}
          onMouseEnter={() => setHovered('minus')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            background: hovered === 'minus' && !minDisabled ? 'rgba(255, 255, 255, 0.15)' : btnBase.background,
            cursor: minDisabled ? 'default' : 'pointer',
            opacity: minDisabled ? 0.3 : 1,
          }}
          title="Zoom out (Ctrl+Scroll)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </>
  )
}
