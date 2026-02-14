import { EditTool, TileType } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, FloorColor } from '../types.js'

export class EditorState {
  isEditMode = false
  activeTool: EditTool = EditTool.SELECT
  selectedTileType: TileTypeVal = TileType.FLOOR_1
  selectedFurnitureType: string = 'desk' // FurnitureType.DESK or asset ID

  // Floor color settings (applied to new tiles when painting)
  floorColor: FloorColor = { h: 35, s: 30, b: 15, c: 0 }

  // Picked furniture color (copied by pick tool, applied on placement)
  pickedFurnitureColor: FloorColor | null = null

  // Ghost preview position
  ghostCol = -1
  ghostRow = -1
  ghostValid = false

  // Selection
  selectedFurnitureUid: string | null = null

  // Mouse drag state (tile paint)
  isDragging = false

  // Undo / Redo stacks
  undoStack: OfficeLayout[] = []
  redoStack: OfficeLayout[] = []

  // Dirty flag — true when layout differs from last save
  isDirty = false

  // Drag-to-move state
  dragUid: string | null = null
  dragStartCol = 0
  dragStartRow = 0
  dragOffsetCol = 0
  dragOffsetRow = 0
  isDragMoving = false

  pushUndo(layout: OfficeLayout): void {
    this.undoStack.push(layout)
    // Limit undo stack size
    if (this.undoStack.length > 50) {
      this.undoStack.shift()
    }
  }

  popUndo(): OfficeLayout | null {
    return this.undoStack.pop() || null
  }

  pushRedo(layout: OfficeLayout): void {
    this.redoStack.push(layout)
    if (this.redoStack.length > 50) {
      this.redoStack.shift()
    }
  }

  popRedo(): OfficeLayout | null {
    return this.redoStack.pop() || null
  }

  clearRedo(): void {
    this.redoStack = []
  }

  clearSelection(): void {
    this.selectedFurnitureUid = null
  }

  clearGhost(): void {
    this.ghostCol = -1
    this.ghostRow = -1
    this.ghostValid = false
  }

  startDrag(uid: string, startCol: number, startRow: number, offsetCol: number, offsetRow: number): void {
    this.dragUid = uid
    this.dragStartCol = startCol
    this.dragStartRow = startRow
    this.dragOffsetCol = offsetCol
    this.dragOffsetRow = offsetRow
    this.isDragMoving = false
  }

  clearDrag(): void {
    this.dragUid = null
    this.isDragMoving = false
  }

  reset(): void {
    this.activeTool = EditTool.SELECT
    this.selectedFurnitureUid = null
    this.ghostCol = -1
    this.ghostRow = -1
    this.ghostValid = false
    this.isDragging = false
    this.undoStack = []
    this.redoStack = []
    this.isDirty = false
    this.dragUid = null
    this.isDragMoving = false
  }
}
