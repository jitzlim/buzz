import { FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision'

let handLandmarker = null
let imageSegmenter = null
let lastTimestamp  = -1
let rawLandmarks   = []
let personMask     = null
let personMaskW    = 0
let personMaskH    = 0
let personLabelIdx = 15
let segmentTick    = 0

// Primary hand (melody)
let state = {
  attractor: { x: 0, y: 0, z: 0 },
  pinch:     0.3,
  spread:    0.1,
  depth:     0,
  active:    false,
}

// Secondary hand (effects)
let state2 = { attractor: { x: 0, y: 0, z: 0 }, pinch: 0.3, active: false }

// One-frame gesture flags — reset at start of each tick
let peaceReady     = false
let arpToggleReady = false
let peace2Ready    = false

// --- Right-hand peace sign (instrument cycle) ---
const PEACE_COOLDOWN = 1100
const PEACE_HOLD     = 180
let peaceCooldown = 0, peaceStartT = 0, peaceFired = false

// --- Left-hand peace sign (FX mode cycle) ---
const PEACE2_COOLDOWN = 1300
const PEACE2_HOLD     = 260
let peace2Cooldown = 0, peace2StartT = 0, peace2Fired = false

// --- Open palm hold (arp toggle) ---
const PALM_HOLD    = 600
const ARP_COOLDOWN = 1200
let wasPalm = false, palmT = 0, palmFired = false, arpCooldown = 0

// --- Helpers ---
function detectPeace(lm) {
  const indexUp   = lm[8].y  < (lm[6].y - 0.025)
  const middleUp  = lm[12].y < (lm[10].y - 0.025)
  const ringDown  = lm[16].y > (lm[14].y + 0.012)
  const pinkyDown = lm[20].y > (lm[18].y + 0.012)
  const vSplit    = Math.abs(lm[8].x - lm[12].x) > 0.03
  return indexUp && middleUp && ringDown && pinkyDown && vSplit
}

function detectOpenPalm(lm) {
  return [lm[8].y < lm[5].y, lm[12].y < lm[9].y,
          lm[16].y < lm[13].y, lm[20].y < lm[17].y].filter(Boolean).length >= 3
}

function calcSpread(lm) {
  const dx = lm[8].x - lm[20].x, dy = lm[8].y - lm[20].y
  return Math.sqrt(dx * dx + dy * dy)
}

function calcPinch(lm) {
  const dx = lm[4].x - lm[8].x, dy = lm[4].y - lm[8].y
  return Math.sqrt(dx * dx + dy * dy)
}

function updateGestures(lm, now) {
  const pinch = calcPinch(lm)
  const isPalm  = detectOpenPalm(lm)
  const isPeace = detectPeace(lm) && pinch > 0.09

  if (isPeace) {
    if (!peaceStartT) peaceStartT = now
    if (!peaceFired && (now - peaceStartT) >= PEACE_HOLD && now > peaceCooldown) {
      peaceReady = true
      peaceFired = true
      peaceCooldown = now + PEACE_COOLDOWN
    }
  } else {
    peaceStartT = 0
    peaceFired = false
  }

  if (isPalm && !isPeace) {
    if (!wasPalm) { palmT = now; palmFired = false }
    if (!palmFired && (now - palmT) > PALM_HOLD && now > arpCooldown) {
      arpToggleReady = true; palmFired = true; arpCooldown = now + ARP_COOLDOWN
    }
  } else { palmFired = false }
  wasPalm = isPalm && !isPeace
}

function updateGestures2(lm2, now) {
  const pinch = calcPinch(lm2)
  const isPeace2 = detectPeace(lm2) && pinch > 0.11

  if (isPeace2) {
    if (!peace2StartT) peace2StartT = now
    if (!peace2Fired && (now - peace2StartT) >= PEACE2_HOLD && now > peace2Cooldown) {
      peace2Ready = true
      peace2Fired = true
      peace2Cooldown = now + PEACE2_COOLDOWN
    }
  } else {
    peace2StartT = 0
    peace2Fired = false
  }
}

export async function initVision(videoEl) {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
  )
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
  })
  try {
    imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite',
        // CPU is slower but significantly more stable on some machines/browsers.
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  } catch {
    imageSegmenter = null
  }

  if (imageSegmenter) {
    const labels = imageSegmenter.getLabels()
    const resolvedIdx = labels.findIndex(label => label.toLowerCase() === 'person')
    if (resolvedIdx >= 0) personLabelIdx = resolvedIdx
  }
}

export function tickVision(timestamp) {
  peaceReady = arpToggleReady = peace2Ready = false

  if (!handLandmarker) return
  if (timestamp <= lastTimestamp) return

  const video = document.getElementById('webcam-video')
  if (!video || video.readyState < 2) return

  lastTimestamp = timestamp
  segmentTick++
  if (imageSegmenter && (segmentTick % 2 === 0)) {
    try {
      const segmentResult = imageSegmenter.segmentForVideo(video, timestamp)
      const mask = segmentResult.confidenceMasks?.[personLabelIdx]
      if (mask) {
        const nextMask = mask.getAsFloat32Array()
        if (!personMask || personMask.length !== nextMask.length) {
          personMask = new Float32Array(nextMask)
        } else {
          for (let i = 0; i < nextMask.length; i++) {
            personMask[i] = personMask[i] * 0.72 + nextMask[i] * 0.28
          }
        }
        personMaskW = mask.width
        personMaskH = mask.height
      }
      segmentResult.close()
    } catch {
      // Disable segmentation if it becomes unstable; hand tracking continues.
      imageSegmenter = null
    }
  }

  const results = handLandmarker.detectForVideo(video, timestamp)

  if (!results.landmarks || results.landmarks.length === 0) {
    state.active = false; state2.active = false
    peaceStartT = 0; peaceFired = false
    peace2StartT = 0; peace2Fired = false
    wasPalm = false
    rawLandmarks = []
    return
  }

  rawLandmarks = results.landmarks
  const handedness = results.handedness || []
  let primaryIdx = -1
  let secondaryIdx = -1

  // MediaPipe handedness can appear flipped in some webcam/selfie pipelines.
  // We map labels so performance behavior remains:
  // right hand -> primary (voice), left hand -> secondary (effects).
  for (let i = 0; i < results.landmarks.length; i++) {
    const label = handedness[i]?.[0]?.categoryName?.toLowerCase()
    if (label === 'left' && primaryIdx === -1) primaryIdx = i
    if (label === 'right' && secondaryIdx === -1) secondaryIdx = i
  }

  if (primaryIdx === -1 && results.landmarks.length > 0) primaryIdx = 0
  if (secondaryIdx === -1) {
    for (let i = 0; i < results.landmarks.length; i++) {
      if (i !== primaryIdx) { secondaryIdx = i; break }
    }
  }

  // Primary hand
  if (primaryIdx >= 0) {
    const lm   = results.landmarks[primaryIdx]
    const idx  = lm[8], thumb = lm[4]
    state.attractor.x =  (idx.x - 0.5) * 6
    state.attractor.y = -(idx.y - 0.5) * 4
    state.attractor.z =   idx.z * 10
    state.depth        =  lm[0].z
    state.spread       =  calcSpread(lm)
    const dx = thumb.x - idx.x, dy = thumb.y - idx.y
    state.pinch  = Math.sqrt(dx * dx + dy * dy)
    state.active = true
    updateGestures(lm, timestamp)
  } else {
    state.active = false
    peaceStartT = 0
    peaceFired = false
  }

  // Secondary hand
  if (secondaryIdx >= 0) {
    const lm2    = results.landmarks[secondaryIdx]
    const idx2   = lm2[8], thumb2 = lm2[4]
    state2.attractor.x =  (idx2.x - 0.5) * 6
    state2.attractor.y = -(idx2.y - 0.5) * 4
    state2.attractor.z =   idx2.z * 10
    const dx2 = thumb2.x - idx2.x, dy2 = thumb2.y - idx2.y
    state2.pinch  = Math.sqrt(dx2 * dx2 + dy2 * dy2)
    state2.active = true
    updateGestures2(lm2, timestamp)
  } else {
    state2.active = false
    peace2StartT = 0
    peace2Fired = false
  }
}

export function getHandState()            { return state        }
export function getHandState2()           { return state2       }
export function getLandmarks()            { return rawLandmarks }
export function getPersonMask()          { return { data: personMask, width: personMaskW, height: personMaskH } }

export function checkPeaceGesture()       { return peaceReady      }
export function checkArpToggleGesture()   { return arpToggleReady  }
export function checkPeaceGestureHand2()  { return peace2Ready     }
