import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, SpriteData, Seat, FloorColor } from '../types.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, getPetSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js'
import { hasWallSprites, getWallInstances, wallColorToHex } from '../wallTiles.js'
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  SELECTION_DASH_PATTERN,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  FALLBACK_FLOOR_COLOR,
  SEAT_OWN_COLOR,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  GRID_LINE_COLOR,
  VOID_TILE_OUTLINE_COLOR,
  VOID_TILE_DASH_PATTERN,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_VALID_TINT,
  GHOST_INVALID_TINT,
  SELECTION_HIGHLIGHT_COLOR,
  DELETE_BUTTON_BG,
  ROTATE_BUTTON_BG,
} from '../../constants.js'

// ── Module-level ARC lab data (set by OfficeCanvas before each frame) ──

let currentArcData: ArcLabHUDData | null = null

export function setArcLabData(data: ArcLabHUDData | null): void {
  currentArcData = data
}

// ── Render functions ────────────────────────────────────────────

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom
  const useSpriteFloors = hasFloorSprites()
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const layoutCols = cols ?? tmCols

  // Floor tiles + wall base color
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c]

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c
          const wallColor = tileColors?.[colorIdx]
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s)
        continue
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }
      const sprite = getColorizedFloorSprite(tile, color)
      const cached = getCachedSprite(sprite, zoom)
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s)
    }
  }

}

interface ZDrawable {
  zY: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = []

  // Furniture
  const now = performance.now()
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom)
    const fx = offsetX + f.x * zoom
    const fy = offsetY + f.y * zoom
    const isServerRack = f.type === 'server-rack'
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        c.drawImage(cached, fx, fy)
        // Blinking LEDs on server racks — color driven by ARC lab health
        if (isServerRack) {
          const ledSize = Math.max(1, Math.round(2 * zoom))
          const spriteW = f.sprite[0]?.length ?? 16
          const spriteH = f.sprite.length
          const arcHealth = currentArcData?.health
          const healthyCount = arcHealth
            ? [arcHealth.apiServer, arcHealth.webSocket, arcHealth.orchestrator, arcHealth.reactor].filter(Boolean).length
            : 0
          const ledPositions = [
            { row: Math.round(spriteH * 0.25), phase: 0, service: arcHealth?.apiServer },
            { row: Math.round(spriteH * 0.45), phase: 1.2, service: arcHealth?.webSocket },
            { row: Math.round(spriteH * 0.65), phase: 2.4, service: arcHealth?.orchestrator },
          ]
          for (const led of ledPositions) {
            const t = (now + led.phase * 700) / 800
            const blink = Math.sin(t) > 0
            let color: string
            if (arcHealth) {
              // Green if service is up, red if down, amber if partial
              color = led.service ? (blink ? '#00ff88' : '#008844') : (blink ? '#ff3344' : '#881122')
            } else {
              color = blink ? '#00ff88' : '#ff3344'
            }
            c.fillStyle = color
            c.shadowColor = color
            c.shadowBlur = healthyCount >= 3 ? 3 * zoom : 0
            const lx = fx + Math.round((spriteW * 0.65) * zoom)
            const ly = fy + Math.round(led.row * zoom)
            c.fillRect(lx, ly, ledSize, ledSize)
            c.shadowBlur = 0
          }
        }
      },
    })
  }

  // Characters
  for (const ch of characters) {
    const sprites = ch.isPet && ch.petType
      ? getPetSprites(ch.petType)
      : getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX
      const mDrawY = drawY
      const mSpriteData = spriteData
      const mCh = ch
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom)
        },
      })
      continue
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const olDrawX = drawX - zoom  // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom  // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save()
          c.globalAlpha = outlineAlpha
          c.drawImage(outlineCached, olDrawX, olDrawY)
          c.restore()
        },
      })
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY)
      },
    })
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY)

  for (const d of drawables) {
    d.draw(ctx)
  }
}

// ── Seat indicators ─────────────────────────────────────────────

export function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return
  const selectedChar = characters.get(selectedAgentId)
  if (!selectedChar) return

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue

    const s = TILE_SIZE * zoom
    const x = offsetX + seat.seatCol * s
    const y = offsetY + seat.seatRow * s

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR
    }
    ctx.fillRect(x, y, s, s)
    break
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom
  ctx.strokeStyle = GRID_LINE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5
    ctx.moveTo(x, offsetY)
    ctx.lineTo(x, offsetY + rows * s)
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5
    ctx.moveTo(offsetX, y)
    ctx.lineTo(offsetX + cols * s, y)
  }
  ctx.stroke()

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save()
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1)
        }
      }
    }
    ctx.restore()
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
export function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom
  ctx.save()

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = []
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 })
    ghostTiles.push({ c, r: rows })
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r })
    ghostTiles.push({ c: cols, r })
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s
    const y = offsetY + r * s
    const isHovered = c === ghostHoverCol && r === ghostHoverRow
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL
      ctx.fillRect(x, y, s, s)
    }
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
  }

  ctx.restore()
}

export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const cached = getCachedSprite(sprite, zoom)
  const x = offsetX + col * TILE_SIZE * zoom
  const y = offsetY + row * TILE_SIZE * zoom
  ctx.save()
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA
  ctx.drawImage(cached, x, y)
  // Tint overlay
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT
  ctx.fillRect(x, y, cached.width, cached.height)
  ctx.restore()
}

export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom
  const x = offsetX + col * s
  const y = offsetY + row * s
  ctx.save()
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash(SELECTION_DASH_PATTERN)
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2)
  ctx.restore()
}

export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1
  const cy = offsetY + row * s - 1
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DELETE_BUTTON_BG
  ctx.fill()

  // X mark
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  ctx.moveTo(cx - xSize, cy - xSize)
  ctx.lineTo(cx + xSize, cy + xSize)
  ctx.moveTo(cx + xSize, cy - xSize)
  ctx.lineTo(cx - xSize, cy + xSize)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

export function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)
  const cx = offsetX + col * s - 1
  const cy = offsetY + row * s - 1

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = ROTATE_BUTTON_BG
  ctx.fill()

  // Circular arrow icon
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7)
  ctx.stroke()
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7
  const endX = cx + arcR * Math.cos(endAngle)
  const endY = cy + arcR * Math.sin(endAngle)
  const arrowSize = radius * 0.35
  ctx.beginPath()
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3)
  ctx.lineTo(endX, endY)
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue

    const sprite = ch.bubbleType === 'permission'
      ? BUBBLE_PERMISSION_SPRITE
      : BUBBLE_WAITING_SPRITE

    // Compute opacity: permission = full, waiting = fade in last 0.5s
    let alpha = 1.0
    if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
    }

    const cached = getCachedSprite(sprite, zoom)
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const bubbleY = Math.round(offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - cached.height - 1 * zoom)

    ctx.save()
    if (ch.bubbleType === 'permission') {
      // Pulsing neon glow for permission bubbles
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300)
      ctx.shadowColor = '#ff00ff'
      ctx.shadowBlur = (8 + pulse * 8) * zoom
    }
    if (alpha < 1.0) ctx.globalAlpha = alpha
    ctx.drawImage(cached, bubbleX, bubbleY)
    ctx.restore()
  }

  // Sleep "Zzz" for sleeping pets
  const sleepNow = performance.now()
  for (const ch of characters) {
    if (ch.state !== CharacterState.SLEEP) continue
    // Bobbing vertical offset (2px amplitude)
    const bob = Math.sin(sleepNow / 600) * 2 * zoom
    const zX = Math.round(offsetX + ch.x * zoom + 4 * zoom)
    const zY = Math.round(offsetY + (ch.y - 20) * zoom + bob)
    const fontSize = Math.max(8, Math.round(10 * zoom))
    ctx.save()
    ctx.font = `bold ${fontSize}px monospace`
    ctx.fillStyle = '#aaccff'
    ctx.globalAlpha = 0.85
    ctx.fillText('Zzz', zX, zY)
    ctx.restore()
  }
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number
  /** Center Y in device pixels */
  cy: number
  /** Radius in device pixels */
  radius: number
}

export type DeleteButtonBounds = ButtonBounds
export type RotateButtonBounds = ButtonBounds

export interface EditorRenderState {
  showGrid: boolean
  ghostSprite: SpriteData | null
  ghostCol: number
  ghostRow: number
  ghostValid: boolean
  selectedCol: number
  selectedRow: number
  selectedW: number
  selectedH: number
  hasSelection: boolean
  isRotatable: boolean
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number
}

export interface SelectionRenderState {
  selectedAgentId: number | null
  hoveredAgentId: number | null
  hoveredTile: { col: number; row: number } | null
  seats: Map<string, Seat>
  characters: Map<number, Character>
}

// ── Room labels ──────────────────────────────────────────────────

const ROOM_LABELS: Array<{ label: string; color: string; roomCol: number; roomRow: number; roomW: number; roomH: number }> = [
  { label: 'mac-studio',  color: '#00e5ff', roomCol: 1,  roomRow: 1,  roomW: 19, roomH: 11 },
  { label: 'macbook-air', color: '#66ff66', roomCol: 22, roomRow: 1,  roomW: 19, roomH: 11 },
  { label: 'macmini',     color: '#ff44ff', roomCol: 1,  roomRow: 14, roomW: 19, roomH: 11 },
  { label: 'macpro51',    color: '#ff8844', roomCol: 22, roomRow: 14, roomW: 19, roomH: 11 },
]

function renderRoomLabels(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
): void {
  if (cols < 42 || rows < 26) return // only for 4-room layout
  const s = TILE_SIZE * zoom
  const fontSize = Math.max(7, Math.round(8 * zoom))
  ctx.save()
  ctx.font = `bold ${fontSize}px monospace`
  ctx.textBaseline = 'top'
  for (const room of ROOM_LABELS) {
    const x = offsetX + (room.roomCol + 0.5) * s
    const y = offsetY + (room.roomRow + 0.2) * s
    // Glow effect
    ctx.shadowColor = room.color
    ctx.shadowBlur = 6 * zoom
    ctx.fillStyle = room.color
    ctx.globalAlpha = 0.7
    ctx.fillText(room.label, x, y)
    ctx.shadowBlur = 0
  }
  ctx.restore()
}

// ── Network activity visualization ───────────────────────────────

interface NetworkParticle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
}

const networkParticles: NetworkParticle[] = []
let lastNetworkSpawn = 0

function renderNetworkActivity(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
): void {
  if (cols < 42 || rows < 26) return
  const now = performance.now()
  const s = TILE_SIZE * zoom

  // Count active (typing/reading) agents to drive particle density
  const activeCount = characters.filter(
    (ch) => !ch.isPet && (ch.state === CharacterState.TYPE || ch.currentTool),
  ).length

  if (activeCount === 0 && networkParticles.length === 0) return

  // Corridor center (the 2-tile-wide corridors at cols 20-21 and rows 12-13)
  const corridorCX = offsetX + 21 * s  // horizontal corridor center
  const corridorCY = offsetY + 13 * s  // vertical corridor center

  // Spawn particles from the corridor intersection
  if (activeCount > 0 && now - lastNetworkSpawn > 200 / activeCount) {
    lastNetworkSpawn = now
    const angle = Math.random() * Math.PI * 2
    const speed = (0.3 + Math.random() * 0.4) * zoom
    const colors = ['#00e5ff', '#66ff66', '#ff44ff', '#ff8844']
    networkParticles.push({
      x: corridorCX + (Math.random() - 0.5) * s,
      y: corridorCY + (Math.random() - 0.5) * s,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      color: colors[Math.floor(Math.random() * colors.length)],
    })
  }

  // Update and draw particles
  ctx.save()
  for (let i = networkParticles.length - 1; i >= 0; i--) {
    const p = networkParticles[i]
    p.x += p.vx
    p.y += p.vy
    p.life -= 0.012
    if (p.life <= 0) {
      networkParticles.splice(i, 1)
      continue
    }
    const size = Math.max(1, Math.round(2 * zoom * p.life))
    ctx.globalAlpha = p.life * 0.6
    ctx.shadowColor = p.color
    ctx.shadowBlur = 4 * zoom
    ctx.fillStyle = p.color
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
  }
  ctx.restore()
}

// ── ARC-AGI-3 Lab HUD ───────────────────────────────────────────

export interface ArcLabHUDData {
  health: {
    apiServer: boolean
    webSocket: boolean
    orchestrator: boolean
    reactor: boolean
  }
  experiments: Array<{
    id: number
    name: string
    type: string
    status: string
    startedAt: string
  }>
  recentEvents: Array<{
    id: number
    category: string
    severity: string
    title: string
    timestamp: string
    source: string
  }>
  scores: {
    liveScore: string
    localEval: string
    blackBoxEval: string
  }
  training: Array<{
    name: string
    node: string
    epoch: number
    totalEpochs: number
    status: string
  }>
}

let eventTickerOffset = 0

const NODE_HUD_COLORS: Record<string, string> = {
  'macpro51': '#ff8844',
  'gcloud-t4': '#ffcc00',
  'mac-studio': '#00e5ff',
  'macmini': '#ff44ff',
  'macbook-air': '#66ff66',
}

export function renderArcLabHUD(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  data: ArcLabHUDData,
): void {
  const margin = 12
  const panelW = 280
  const lineH = 20
  const pad = 10

  // Calculate panel height
  let rows = 2 // title + score
  rows += 2 // health label + 2 dot rows
  if (data.training.length > 0) {
    rows += 1 + data.training.length
  }
  if (data.experiments.length > 0) {
    rows += 1 + Math.min(data.experiments.length, 3)
  }

  const panelH = rows * lineH + pad * 2 + 4
  const panelX = canvasWidth - panelW - margin
  const panelY = margin

  ctx.save()

  // Panel background
  ctx.fillStyle = 'rgba(8, 4, 20, 0.88)'
  ctx.fillRect(panelX, panelY, panelW, panelH)

  // Panel border (neon cyan)
  ctx.strokeStyle = '#00e5ff'
  ctx.lineWidth = 2
  ctx.shadowColor = '#00e5ff'
  ctx.shadowBlur = 6
  ctx.strokeRect(panelX, panelY, panelW, panelH)
  ctx.shadowBlur = 0

  let y = panelY + pad + lineH * 0.75
  const textX = panelX + pad

  // Title
  ctx.font = 'bold 15px monospace'
  ctx.fillStyle = '#00e5ff'
  ctx.shadowColor = '#00e5ff'
  ctx.shadowBlur = 8
  ctx.fillText('ARC-AGI-3 LAB', textX, y)
  ctx.shadowBlur = 0

  // Separator line
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.25)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(textX, y + 5)
  ctx.lineTo(panelX + panelW - pad, y + 5)
  ctx.stroke()
  y += lineH

  // Score
  ctx.font = 'bold 13px monospace'
  const scoreVal = data.scores.liveScore
  const scoreColor = scoreVal === '--' ? '#555' : '#00ff88'
  ctx.fillStyle = scoreColor
  ctx.shadowColor = scoreColor
  ctx.shadowBlur = scoreVal === '--' ? 0 : 6
  ctx.fillText(`SCORE: ${scoreVal}`, textX, y)
  if (data.scores.localEval !== '--') {
    ctx.font = '11px monospace'
    ctx.fillStyle = '#888'
    ctx.shadowBlur = 0
    ctx.fillText(`local: ${data.scores.localEval}`, textX + 140, y)
  }
  ctx.shadowBlur = 0
  y += lineH

  // Health section
  ctx.font = 'bold 11px monospace'
  ctx.fillStyle = '#777'
  ctx.fillText('SERVICES', textX, y)
  y += lineH - 2

  const services = [
    { label: 'API', up: data.health.apiServer },
    { label: 'WS', up: data.health.webSocket },
    { label: 'ORCH', up: data.health.orchestrator },
    { label: 'REACT', up: data.health.reactor },
  ]

  ctx.font = '11px monospace'
  const dotSpacing = (panelW - pad * 2) / services.length
  for (let i = 0; i < services.length; i++) {
    const s = services[i]
    const sx = textX + i * dotSpacing
    // Dot
    ctx.fillStyle = s.up ? '#00ff88' : '#ff3344'
    if (s.up) {
      ctx.shadowColor = '#00ff88'
      ctx.shadowBlur = 4
    }
    ctx.beginPath()
    ctx.arc(sx + 6, y - 3, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    // Label
    ctx.fillStyle = s.up ? '#aaa' : '#666'
    ctx.fillText(s.label, sx + 14, y)
  }
  y += lineH

  // Training section
  if (data.training.length > 0) {
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = '#777'
    ctx.fillText('TRAINING', textX, y)
    y += lineH - 2

    for (const t of data.training) {
      const progress = t.totalEpochs > 0 ? t.epoch / t.totalEpochs : 0
      const barW = panelW - pad * 2 - 100
      const barH = 8
      const barX = textX + 68

      // Label
      ctx.font = '10px monospace'
      const nodeColor = NODE_HUD_COLORS[t.node] || '#aaa'
      ctx.fillStyle = nodeColor
      const label = t.name.length > 8 ? t.name.slice(0, 8) : t.name
      ctx.fillText(label, textX, y)

      // Progress bar background
      const barY = y - 7
      ctx.fillStyle = '#1a1a2e'
      ctx.fillRect(barX, barY, barW, barH)

      // Progress bar fill
      const fillColor = t.status === 'running' ? nodeColor : '#444'
      ctx.fillStyle = fillColor
      ctx.shadowColor = fillColor
      ctx.shadowBlur = t.status === 'running' ? 3 : 0
      ctx.fillRect(barX, barY, barW * progress, barH)
      ctx.shadowBlur = 0

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.lineWidth = 1
      ctx.strokeRect(barX, barY, barW, barH)

      // Epoch text
      ctx.fillStyle = '#888'
      ctx.font = '10px monospace'
      ctx.fillText(`${t.epoch}/${t.totalEpochs}`, barX + barW + 6, y)

      y += lineH
    }
  }

  // Experiments section
  if (data.experiments.length > 0) {
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = '#777'
    ctx.fillText('EXPERIMENTS', textX, y)
    y += lineH - 2

    ctx.font = '10px monospace'
    for (const exp of data.experiments.slice(0, 3)) {
      const statusColor = exp.status === 'running' ? '#00e5ff'
        : exp.status === 'completed' ? '#00ff88'
        : exp.status === 'failed' ? '#ff3344'
        : '#ff8844'
      const statusIcon = exp.status === 'running' ? '\u25B6'
        : exp.status === 'completed' ? '\u2713'
        : exp.status === 'failed' ? '\u2717'
        : '\u25CB'
      ctx.fillStyle = statusColor
      ctx.fillText(statusIcon, textX, y)
      ctx.fillStyle = '#aaa'
      const expName = exp.name.length > 22 ? exp.name.slice(0, 22) + '..' : exp.name
      ctx.fillText(expName, textX + 14, y)
      y += lineH
    }
  }

  ctx.restore()

  // ── Event ticker at bottom ──────────────────────────────────
  if (data.recentEvents.length > 0) {
    const tickerH = 22
    const tickerY = canvasHeight - tickerH - 4

    ctx.save()

    // Ticker background
    ctx.fillStyle = 'rgba(8, 4, 20, 0.8)'
    ctx.fillRect(0, tickerY, canvasWidth, tickerH)

    // Top border line
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, tickerY)
    ctx.lineTo(canvasWidth, tickerY)
    ctx.stroke()

    // Build ticker text
    const tickerText = data.recentEvents
      .map((e) => {
        const sev = e.severity === 'error' ? '\u2717' : e.severity === 'warning' ? '\u26A0' : '\u25C6'
        return `${sev} ${e.title}`
      })
      .join('     ')

    ctx.font = '12px monospace'
    ctx.fillStyle = '#00e5ff'
    ctx.globalAlpha = 0.85

    const textWidth = ctx.measureText(tickerText).width
    const totalScroll = textWidth + canvasWidth

    // Scroll
    eventTickerOffset = (eventTickerOffset + 0.6) % totalScroll

    const drawX = canvasWidth - eventTickerOffset
    ctx.fillText(tickerText, drawX, tickerY + tickerH * 0.72)

    ctx.restore()
  }
}

// ── Mini-map ────────────────────────────────────────────────────

const MINIMAP_ROOM_COLORS: Array<{ color: string; minCol: number; maxCol: number; minRow: number; maxRow: number }> = [
  { color: '#00e5ff', minCol: 0, maxCol: 19, minRow: 0, maxRow: 11 },   // mac-studio
  { color: '#66ff66', minCol: 22, maxCol: 41, minRow: 0, maxRow: 11 },  // macbook-air
  { color: '#ff44ff', minCol: 0, maxCol: 19, minRow: 14, maxRow: 25 },  // macmini
  { color: '#ff8844', minCol: 22, maxCol: 41, minRow: 14, maxRow: 25 }, // macpro51
]

export function renderMiniMap(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  characters: Character[],
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (cols < 42 || rows < 26) return

  const mapW = 140
  const mapH = Math.round(mapW * (rows / cols))
  const margin = 10
  const mapX = margin
  const mapY = canvasHeight - mapH - 36 // above event ticker strip (26px)
  const tileW = mapW / cols
  const tileH = mapH / rows

  ctx.save()

  // Background
  ctx.fillStyle = 'rgba(8, 4, 20, 0.8)'
  ctx.fillRect(mapX - 2, mapY - 2, mapW + 4, mapH + 4)

  // Border
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)'
  ctx.lineWidth = 1
  ctx.strokeRect(mapX - 2, mapY - 2, mapW + 4, mapH + 4)

  // Room quadrants
  for (const room of MINIMAP_ROOM_COLORS) {
    ctx.fillStyle = room.color
    ctx.globalAlpha = 0.15
    ctx.fillRect(
      mapX + room.minCol * tileW,
      mapY + room.minRow * tileH,
      (room.maxCol - room.minCol + 1) * tileW,
      (room.maxRow - room.minRow + 1) * tileH,
    )
  }
  ctx.globalAlpha = 1.0

  // Corridor lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.lineWidth = 1
  // Vertical corridor (cols 20-21)
  ctx.strokeRect(mapX + 20 * tileW, mapY, 2 * tileW, mapH)
  // Horizontal corridor (rows 12-13)
  ctx.strokeRect(mapX, mapY + 12 * tileH, mapW, 2 * tileH)

  // Character dots
  for (const ch of characters) {
    if (ch.matrixEffect === 'despawn') continue
    const dotX = mapX + (ch.x / TILE_SIZE) * tileW
    const dotY = mapY + (ch.y / TILE_SIZE) * tileH
    const dotR = ch.isPet ? 1.5 : 2.5

    if (ch.isPet) {
      ctx.fillStyle = '#ffcc44'
      ctx.globalAlpha = 0.6
    } else {
      // Use room color based on position
      const roomIdx = (ch.tileCol >= 22 ? 1 : 0) + (ch.tileRow >= 14 ? 2 : 0)
      ctx.fillStyle = MINIMAP_ROOM_COLORS[roomIdx]?.color || '#ffffff'
      ctx.globalAlpha = ch.isActive ? 1.0 : 0.5
    }
    ctx.beginPath()
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1.0

  // Viewport rectangle
  const mapPxW = cols * TILE_SIZE * zoom
  const mapPxH = rows * TILE_SIZE * zoom
  const vpLeft = (-offsetX) / mapPxW * mapW
  const vpTop = (-offsetY) / mapPxH * mapH
  const vpW = (canvasWidth / mapPxW) * mapW
  const vpH = (canvasHeight / mapPxH) * mapH

  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.5
  ctx.strokeRect(
    mapX + Math.max(0, vpLeft),
    mapY + Math.max(0, vpTop),
    Math.min(vpW, mapW),
    Math.min(vpH, mapH),
  )
  ctx.globalAlpha = 1.0

  ctx.restore()
}

// ── Day/night cycle ─────────────────────────────────────────────

export function renderDayNightCycle(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const hour = new Date().getHours() + new Date().getMinutes() / 60

  let tintColor: string
  let alpha: number

  if (hour >= 6 && hour < 9) {
    // Morning: warm orange tint
    const t = (hour - 6) / 3 // 0→1
    alpha = 0.06 * (1 - t) // fades as morning progresses
    tintColor = `rgba(255, 180, 80, ${alpha})`
  } else if (hour >= 9 && hour < 17) {
    // Day: no tint
    return
  } else if (hour >= 17 && hour < 20) {
    // Evening: warm sunset
    const t = (hour - 17) / 3 // 0→1
    alpha = 0.04 + 0.08 * t
    tintColor = `rgba(255, 140, 50, ${alpha})`
  } else {
    // Night: cool blue
    let intensity: number
    if (hour >= 20) {
      intensity = Math.min(1, (hour - 20) / 3) // ramps up 20→23
    } else {
      intensity = Math.max(0, 1 - (hour / 6)) // ramps down 0→6
    }
    alpha = 0.08 + 0.1 * intensity
    tintColor = `rgba(20, 30, 80, ${alpha})`
  }

  ctx.save()
  ctx.fillStyle = tintColor
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
  ctx.restore()
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0)
  const rows = layoutRows ?? tileMap.length

  // Center map in viewport + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols)

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(ctx, selection.seats, selection.characters, selection.selectedAgentId, selection.hoveredTile, offsetX, offsetY, zoom)
  }

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : []
  const allFurniture = wallInstances.length > 0
    ? [...wallInstances, ...furniture]
    : furniture

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, allFurniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId)

  // Room labels (node hostnames, below bubbles)
  renderRoomLabels(ctx, offsetX, offsetY, zoom, cols, rows)

  // Network activity visualization (animated particles between rooms)
  renderNetworkActivity(ctx, characters, offsetX, offsetY, zoom, cols, rows)

  // Speech bubbles (always on top of characters)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom)

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap)
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(ctx, offsetX, offsetY, zoom, cols, rows, editor.ghostBorderHoverCol, editor.ghostBorderHoverRow)
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      renderGhostPreview(ctx, editor.ghostSprite, editor.ghostCol, editor.ghostRow, editor.ghostValid, offsetX, offsetY, zoom)
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      editor.deleteButtonBounds = renderDeleteButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      } else {
        editor.rotateButtonBounds = null
      }
    } else {
      editor.deleteButtonBounds = null
      editor.rotateButtonBounds = null
    }
  }

  return { offsetX, offsetY }
}
