const CHARS   = [' ', '·', '+', '*', '#', '@']  // light → dark
const CELL    = 10   // px per cell
const SKIP    = 2    // render every N frames for performance

let srcCanvas  = null
let dstCanvas  = null
let dstCtx     = null
let offscreen  = null
let offCtx     = null
let frameCount = 0
let cols = 0, rows = 0

export function initAscii(threeCanvas, overlayCanvas) {
  srcCanvas = threeCanvas
  dstCanvas = overlayCanvas
  dstCtx    = overlayCanvas.getContext('2d')

  offscreen = document.createElement('canvas')
  offCtx    = offscreen.getContext('2d', { willReadFrequently: true })

  resize()
  window.addEventListener('resize', resize)
}

function resize() {
  const W = window.innerWidth, H = window.innerHeight
  dstCanvas.width  = W
  dstCanvas.height = H
  cols = Math.ceil(W / CELL)
  rows = Math.ceil(H / CELL)
  offscreen.width  = cols
  offscreen.height = rows
}

export function tickAscii() {
  if (!srcCanvas || !dstCtx) return
  frameCount++
  if (frameCount % SKIP !== 0) return

  const W = dstCanvas.width, H = dstCanvas.height

  // Downsample Three.js frame to (cols × rows) pixels in one draw call
  offCtx.drawImage(srcCanvas, 0, 0, cols, rows)
  const pixels = offCtx.getImageData(0, 0, cols, rows).data

  // Clear overlay with background colour
  dstCtx.fillStyle = '#D1D1D1'
  dstCtx.fillRect(0, 0, W, H)

  dstCtx.fillStyle   = '#1A1A1A'
  dstCtx.font        = `${CELL}px "JetBrains Mono", monospace`
  dstCtx.textBaseline = 'top'

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i   = (row * cols + col) * 4
      const r   = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
      // Luminance: perceptual weights, inverted (dark particle → bright char)
      const lum = 1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255
      const idx = Math.min(CHARS.length - 1, Math.floor(lum * CHARS.length))
      if (idx > 0) {
        dstCtx.fillText(CHARS[idx], col * CELL, row * CELL)
      }
    }
  }
}
