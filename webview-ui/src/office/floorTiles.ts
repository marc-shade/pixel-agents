/**
 * Floor tile pattern storage and caching.
 *
 * Stores 7 grayscale floor patterns loaded from floors.png.
 * Uses shared colorize module for HSL tinting (Photoshop-style Colorize).
 * Caches colorized SpriteData by (pattern, h, s, b, c) key.
 */

import type { SpriteData, FloorColor } from './types.js'
import { getColorizedSprite, clearColorizeCache } from './colorize.js'

/** Module-level storage for the 7 floor tile sprites (set once on load) */
let floorSprites: SpriteData[] = []

/** Wall color constant */
export const WALL_COLOR = '#3A3A5C'

/** Set floor tile sprites (called once when extension sends floorTilesLoaded) */
export function setFloorSprites(sprites: SpriteData[]): void {
  floorSprites = sprites
  clearColorizeCache()
}

/** Get the raw (grayscale) floor sprite for a pattern index (1-7 -> array index 0-6) */
export function getFloorSprite(patternIndex: number): SpriteData | null {
  const idx = patternIndex - 1
  if (idx < 0 || idx >= floorSprites.length) return null
  return floorSprites[idx]
}

/** Check if floor sprites have been loaded */
export function hasFloorSprites(): boolean {
  return floorSprites.length > 0
}

/** Get count of available floor patterns */
export function getFloorPatternCount(): number {
  return floorSprites.length
}

/** Get all floor sprites (for preview rendering) */
export function getAllFloorSprites(): SpriteData[] {
  return floorSprites
}

/**
 * Get a colorized version of a floor sprite.
 * Uses Photoshop-style Colorize: grayscale -> HSL with given hue/saturation,
 * then brightness/contrast adjustment.
 */
export function getColorizedFloorSprite(patternIndex: number, color: FloorColor): SpriteData {
  const key = `floor-${patternIndex}-${color.h}-${color.s}-${color.b}-${color.c}`

  const base = getFloorSprite(patternIndex)
  if (!base) {
    // Return a 16x16 magenta error tile
    const err: SpriteData = Array.from({ length: 16 }, () => Array(16).fill('#FF00FF'))
    return err
  }

  // Floor tiles are always colorized (grayscale patterns need Photoshop-style Colorize)
  return getColorizedSprite(key, base, { ...color, colorize: true })
}
