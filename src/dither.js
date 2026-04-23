// Bayer 4×4 ordered dithering + temporal smoothing on webcam video, audio-reactive
const BAYER = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
].map(v => (v / 16) * 255)

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
]

const CELL          = 4
const BASE_CONTRAST = 1.5   // softer than 1.8 — lets mid-tones breathe
const DARK_BIAS     = -20
const NOISE_AMT     = 18    // light grain only — temporal smoothing absorbs it
const SMOOTH        = 0.88  // 0=instant 1=frozen — heavy lag for filmic feel
const ACCENT        = '#FE2C11'
const MASK_THRESHOLD = 0.18
const GRID_TARGET_CELL = 68
const GRID_MIN_COLS = 8
const GRID_MAX_COLS = 22
const GRID_MIN_ROWS = 6
const GRID_MAX_ROWS = 16

let video     = null
let dst       = null
let dstCtx    = null
let off       = null
let offCtx    = null
let border    = null
let borderCtx = null
let smoothBuf = null
let cols = 0, rows = 0
let attackFlash = 0
let gridCols = 12, gridRows = 8
let gridEnabled = true
const gridTrack = {
  right: { x: 0, y: 0, glow: 0 },
  left:  { x: 0, y: 0, glow: 0 },
}

export function initDither(videoEl, overlayCanvas, borderCanvas) {
  video  = videoEl
  dst    = overlayCanvas
  dstCtx = overlayCanvas.getContext('2d')
  dstCtx.imageSmoothingEnabled = false

  off    = document.createElement('canvas')
  offCtx = off.getContext('2d', { willReadFrequently: true })
  offCtx.imageSmoothingEnabled = false

  border    = borderCanvas
  borderCtx = borderCanvas.getContext('2d')

  resize()
  window.addEventListener('resize', resize)
}

function resize() {
  const W = window.innerWidth, H = window.innerHeight
  dst.width  = W
  dst.height = H
  cols = Math.ceil(W / CELL)
  rows = Math.ceil(H / CELL)
  off.width  = cols
  off.height = rows
  smoothBuf  = new Float32Array(cols * rows)
  gridCols = Math.max(GRID_MIN_COLS, Math.min(GRID_MAX_COLS, Math.round(W / GRID_TARGET_CELL)))
  gridRows = Math.max(GRID_MIN_ROWS, Math.min(GRID_MAX_ROWS, Math.round(H / GRID_TARGET_CELL)))
  drawBorderFrame(W, H)
}

function drawBorderFrame(W, H) {
  border.width  = W
  border.height = H
  borderCtx.clearRect(0, 0, W, H)
}

export function tickDither(freqData, gateOpen, dt, landmarks, handLabels, personMask, gridOverlay) {
  const W = dst.width, H = dst.height

  if (gateOpen) {
    attackFlash = Math.min(1, attackFlash + dt * 10)
  } else {
    attackFlash = Math.max(0, attackFlash - dt * 4)
  }

  const bass     = (freqData[0] + freqData[1]) * 0.5
  const presence = (freqData[2] + freqData[3] + freqData[4]) / 3
  const brightnessOffset = bass * 50 + attackFlash * 45
  const contrastMult     = BASE_CONTRAST + presence * 1.2

  if (!video || video.readyState < 2) {
    dstCtx.fillStyle = '#D1D1D1'
    dstCtx.fillRect(0, 0, W, H)
    drawSkeleton(landmarks, handLabels, W, H)
    return
  }

  // Downsample mirrored video
  offCtx.save()
  offCtx.translate(cols, 0)
  offCtx.scale(-1, 1)
  offCtx.drawImage(video, 0, 0, cols, rows)
  offCtx.restore()

  const img = offCtx.getImageData(0, 0, cols, rows)
  const px  = img.data

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i   = (y * cols + x) * 4
      const raw = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]

      // Temporal smoothing — blend toward raw lum slowly
      const si  = y * cols + x
      smoothBuf[si] = smoothBuf[si] * SMOOTH + raw * (1 - SMOOTH)

      const noise    = (Math.random() - 0.5) * NOISE_AMT
      const adjusted = Math.min(255, Math.max(0,
        (smoothBuf[si] - 128) * contrastMult + 128 + DARK_BIAS + brightnessOffset + noise
      ))

      const maskAlpha = sampleMask(personMask, x, y)
      const insideBody = maskAlpha > MASK_THRESHOLD
      const out = insideBody
        ? (adjusted > BAYER[(y % 4) * 4 + (x % 4)] ? 0 : 255)
        : 0
      px[i] = px[i + 1] = px[i + 2] = out
    }
  }

  offCtx.putImageData(img, 0, 0)
  dstCtx.drawImage(off, 0, 0, W, H)
  if (gridEnabled) {
    try {
      drawAccentGrid(W, H, dt, gridOverlay)
    } catch {
      gridEnabled = false
    }
  }
  drawSkeleton(landmarks, handLabels, W, H)
}

function sampleMask(personMask, x, y) {
  if (!personMask || !personMask.data || !personMask.width || !personMask.height) return 1
  const mirroredX = 1 - (x / Math.max(1, cols - 1))
  const mx = Math.max(0, Math.min(personMask.width - 1, Math.floor(mirroredX * (personMask.width - 1))))
  const my = Math.max(0, Math.min(personMask.height - 1, Math.floor((y / Math.max(1, rows - 1)) * (personMask.height - 1))))
  return personMask.data[my * personMask.width + mx] || 0
}

function drawSkeleton(landmarks, handLabels, W, H) {
  if (!landmarks || landmarks.length === 0) return

  for (let h = 0; h < landmarks.length; h++) {
    const lm     = landmarks[h]
    const labels = handLabels ? handLabels[h] : []

    // Build path once, reuse for glow + solid passes
    const path = new Path2D()
    for (const [a, b] of CONNECTIONS) {
      path.moveTo((1 - lm[a].x) * W, lm[a].y * H)
      path.lineTo((1 - lm[b].x) * W, lm[b].y * H)
    }

    // --- Glow pass ---
    dstCtx.save()
    dstCtx.strokeStyle = ACCENT
    dstCtx.lineWidth   = 6
    dstCtx.lineJoin    = 'round'
    dstCtx.lineCap     = 'round'
    dstCtx.shadowColor = ACCENT
    dstCtx.shadowBlur  = 20
    dstCtx.globalAlpha = 0.55
    dstCtx.stroke(path)
    dstCtx.restore()

    // --- Solid pass ---
    dstCtx.save()
    dstCtx.strokeStyle = ACCENT
    dstCtx.lineWidth   = 4
    dstCtx.lineJoin    = 'round'
    dstCtx.lineCap     = 'round'
    dstCtx.stroke(path)
    dstCtx.restore()

    // Joint dots — glow then solid
    for (let j = 0; j < lm.length; j++) {
      const x   = (1 - lm[j].x) * W
      const y   = lm[j].y * H
      const tip = j === 4 || j === 8 || j === 12 || j === 16 || j === 20
      const r   = tip ? 9 : 5

      // Glow pass
      dstCtx.save()
      dstCtx.shadowColor = ACCENT
      dstCtx.shadowBlur  = 16
      dstCtx.globalAlpha = 0.6
      dstCtx.fillStyle   = ACCENT
      dstCtx.beginPath()
      dstCtx.arc(x, y, r, 0, Math.PI * 2)
      dstCtx.fill()
      dstCtx.restore()

      // Solid pass
      dstCtx.save()
      if (j === 8) {
        dstCtx.fillStyle   = '#ffffff'
        dstCtx.beginPath()
        dstCtx.arc(x, y, r, 0, Math.PI * 2)
        dstCtx.fill()
        dstCtx.strokeStyle = ACCENT
        dstCtx.lineWidth   = 2.5
        dstCtx.shadowColor = ACCENT
        dstCtx.shadowBlur  = 12
        dstCtx.stroke()
      } else {
        dstCtx.fillStyle = ACCENT
        dstCtx.beginPath()
        dstCtx.arc(x, y, r, 0, Math.PI * 2)
        dstCtx.fill()
      }
      dstCtx.restore()
    }

    // Label block anchored to wrist
    if (labels && labels.length > 0) {
      const wx = (1 - lm[0].x) * W
      const wy = lm[0].y * H

      const FONT_SIZE = 11
      const LINE_H    = 16
      const PAD_X     = 8
      const PAD_Y     = 5
      const boxW      = 140
      const boxH      = labels.length * LINE_H + PAD_Y * 2

      let bx = wx - boxW / 2
      let by = wy + 22
      bx = Math.max(4, Math.min(W - boxW - 4, bx))
      by = Math.max(4, Math.min(H - boxH - 4, by))

      dstCtx.fillStyle = 'rgba(0,0,0,0.82)'
      dstCtx.fillRect(bx, by, boxW, boxH)

      // Accent left strip with glow
      dstCtx.save()
      dstCtx.shadowColor = ACCENT
      dstCtx.shadowBlur  = 8
      dstCtx.fillStyle   = ACCENT
      dstCtx.fillRect(bx, by, 3, boxH)
      dstCtx.restore()

      dstCtx.font         = `bold ${FONT_SIZE}px "JetBrains Mono", monospace`
      dstCtx.fillStyle    = '#ffffff'
      dstCtx.textBaseline = 'top'
      labels.forEach((line, i) => {
        dstCtx.fillText(line, bx + PAD_X + 3, by + PAD_Y + i * LINE_H)
      })
    }
  }
}

function drawAccentGrid(W, H, dt, gridOverlay) {
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return
  if (!Number.isFinite(dt) || dt <= 0) dt = 0.016
  if (!Number.isFinite(gridCols) || !Number.isFinite(gridRows) || gridCols < 1 || gridRows < 1) return

  const cellW = W / gridCols
  const cellH = H / gridRows
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return

  dstCtx.save()
  dstCtx.strokeStyle = 'rgba(254,44,17,0.07)'
  dstCtx.lineWidth = 1
  for (let c = 1; c < gridCols; c++) {
    const x = Math.round(c * cellW) + 0.5
    dstCtx.beginPath()
    dstCtx.moveTo(x, 0)
    dstCtx.lineTo(x, H)
    dstCtx.stroke()
  }
  for (let r = 1; r < gridRows; r++) {
    const y = Math.round(r * cellH) + 0.5
    dstCtx.beginPath()
    dstCtx.moveTo(0, y)
    dstCtx.lineTo(W, y)
    dstCtx.stroke()
  }
  dstCtx.restore()

  updateGridTrack(gridTrack.right, gridOverlay?.right, dt)
  updateGridTrack(gridTrack.left, gridOverlay?.left, dt)
  drawActiveGridCell(gridTrack.right, W, H, cellW, cellH, 1)
  drawActiveGridCell(gridTrack.left, W, H, cellW, cellH, 0.72)
}

function updateGridTrack(track, handOverlay, dt) {
  if (!track) return
  const follow = 1 - Math.exp(-dt * 14)
  const decay = 1 - Math.exp(-dt * 7)

  if (handOverlay && handOverlay.active && handOverlay.norm) {
    const tx = Math.max(0, Math.min(1, 1 - handOverlay.norm.x))
    const ty = Math.max(0, Math.min(1, handOverlay.norm.y))
    track.x += (tx - track.x) * follow
    track.y += (ty - track.y) * follow
    const targetGlow = handOverlay.gateOpen ? 1 : 0.42
    track.glow += (targetGlow - track.glow) * follow
  } else {
    track.glow += (0 - track.glow) * decay
  }
}

function drawActiveGridCell(track, W, H, cellW, cellH, intensityScale) {
  if (!track || track.glow < 0.02) return
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 1 || cellH <= 1) return

  const col = Math.max(0, Math.min(gridCols - 1, Math.floor(track.x * gridCols)))
  const row = Math.max(0, Math.min(gridRows - 1, Math.floor(track.y * gridRows)))
  const x = col * cellW
  const y = row * cellH
  const glow = track.glow * intensityScale

  dstCtx.save()
  dstCtx.shadowColor = ACCENT
  dstCtx.shadowBlur = 22 * glow
  dstCtx.fillStyle = `rgba(254,44,17,${0.09 + glow * 0.22})`
  dstCtx.fillRect(x, y, cellW, cellH)
  dstCtx.restore()

  dstCtx.save()
  dstCtx.strokeStyle = `rgba(254,44,17,${0.25 + glow * 0.55})`
  dstCtx.lineWidth = 1.5
  dstCtx.strokeRect(x + 0.8, y + 0.8, cellW - 1.6, cellH - 1.6)
  dstCtx.restore()
}
