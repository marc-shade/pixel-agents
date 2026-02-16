import { useState } from 'react'
import { vscode } from '../vscodeApi.js'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
}

const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontSize: '24px',
  color: 'rgba(255, 255, 255, 0.8)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

export function SettingsModal({ isOpen, onClose, isDebugMode, onToggleDebugMode }: SettingsModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  if (!isOpen) return null

  return (
    <>
      {/* Invisible backdrop to close on click-outside */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          zIndex: 49,
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '100%',
          right: 0,
          marginBottom: 6,
          zIndex: 50,
          background: '#1e1e2e',
          border: '2px solid #4a4a6a',
          borderRadius: 0,
          padding: '4px',
          boxShadow: '2px 2px 0px #0a0a14',
          minWidth: 170,
        }}
      >
        <button
          onClick={() => {
            vscode.postMessage({ type: 'openSessionsFolder' })
            onClose()
          }}
          onMouseEnter={() => setHovered('sessions')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sessions' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Open Sessions Folder
        </button>
        <button
          onClick={onToggleDebugMode}
          onMouseEnter={() => setHovered('debug')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'debug' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span>Debug View</span>
          {isDebugMode && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'rgba(90, 140, 255, 0.8)',
                flexShrink: 0,
              }}
            />
          )}
        </button>
      </div>
    </>
  )
}
