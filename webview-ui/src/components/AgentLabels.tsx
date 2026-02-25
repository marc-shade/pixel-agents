import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { SubagentCharacter, AgentMeta } from '../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../office/types.js'

interface AgentLabelsProps {
  officeState: OfficeState
  agents: number[]
  agentStatuses: Record<number, string>
  agentMeta: Record<number, AgentMeta>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  subagentCharacters: SubagentCharacter[]
}

export function AgentLabels({
  officeState,
  agents,
  agentStatuses,
  agentMeta,
  containerRef,
  zoom,
  panRef,
  subagentCharacters,
}: AgentLabelsProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  // Compute device pixel offset (same math as renderFrame, including pan)
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  // Build sub-agent label lookup
  const subLabelMap = new Map<number, string>()
  for (const sub of subagentCharacters) {
    subLabelMap.set(sub.id, sub.label)
  }

  // All character IDs to render labels for (regular agents + sub-agents)
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        // Character position: device pixels → CSS pixels (follow sitting offset)
        const sittingOffset = ch.state === CharacterState.TYPE ? 6 : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - 24) * zoom) / dpr

        const status = agentStatuses[id]
        const isWaiting = status === 'waiting'
        const isActive = ch.isActive
        const isSub = ch.isSubagent

        let dotColor = 'transparent'
        if (isWaiting) {
          dotColor = 'var(--vscode-charts-yellow, #cca700)'
        } else if (isActive) {
          dotColor = 'var(--vscode-charts-blue, #3794ff)'
        }

        const meta = agentMeta[id]
        const subLabel = subLabelMap.get(id)
        // Show project name (last 2 path segments) or fallback
        let labelText: string
        if (subLabel) {
          labelText = subLabel
        } else if (meta?.projectName) {
          const parts = meta.projectName.split('/').filter(Boolean)
          labelText = parts.length > 1 ? parts.slice(-2).join('/') : parts[parts.length - 1] || `Agent #${id}`
        } else {
          labelText = `Agent #${id}`
        }
        const nodeColor = meta?.nodeColor || '#888888'
        const nodeName = meta?.nodeName

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 16,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: 'none',
              zIndex: 40,
            }}
          >
            {dotColor !== 'transparent' && (
              <span
                className={isActive && !isWaiting ? 'pixel-agents-pulse' : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: dotColor,
                  marginBottom: 2,
                }}
              />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {nodeName && !isSub && (
                <span
                  style={{
                    fontSize: '14px',
                    color: '#000',
                    background: nodeColor,
                    padding: '0px 3px',
                    borderRadius: 2,
                    fontWeight: 'bold',
                    lineHeight: '16px',
                  }}
                >
                  {nodeName.split('-').map(w => w[0]).join('').toUpperCase()}
                </span>
              )}
              <span
                style={{
                  fontSize: isSub ? '16px' : '18px',
                  fontStyle: isSub ? 'italic' : undefined,
                  color: 'var(--vscode-foreground)',
                  background: 'rgba(10,6,18,0.85)',
                  padding: '1px 4px',
                  borderRadius: 2,
                  borderLeft: `2px solid ${nodeColor}`,
                  whiteSpace: 'nowrap',
                  maxWidth: isSub ? 120 : 180,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {labelText}
              </span>
            </div>
          </div>
        )
      })}
    </>
  )
}
