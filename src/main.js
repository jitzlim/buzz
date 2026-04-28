import {
  initAudio, startAudio,
  setFrequency, setVolume, setPinchGate, getFreqData,
  nextInstrument, getCurrentInstrumentName, getCurrentFrequency,
  getCurrentScaleName, getKeyLabel, cycleRootNote, getTempoBpm, getDelayDivisionLabel,
  getLoopState, getLoopLayerCount, getLoopCaptureProgress, captureOneBarLoop, stopLoopCapture, clearLoop,
  getSceneState, applySceneState,
  setDelayPitchMix,
  toggleArp, isArpActive,
  setBitcrush, setDrive, setStutter, setTransitionMacro, setReverbFreeze,
  setFilterCutoff, setFilterQ, setReverbWet,
  setVibrato, setVibratoRate, setDelay,
  setChordMode, setChordShape, getChordState, isBassInstrument, playUnlockCue,
} from './audio.js'
import {
  initVision, tickVision,
  getHandState, getHandState2, getLandmarks, getPersonMask,
  checkPeaceGesture, checkArpToggleGesture, checkPeaceGestureHand2, checkRootCycleGesture,
} from './vision.js'
import { initDither, tickDither } from './dither.js'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const LEFT_FX_MODES = ['ECHO', 'SPACE', 'FILTER', 'PERF', 'CHORD']
const SMOOTHING_PRESETS = [
  { name: 'RAW', posUp: 13, posDown: 10, pinchUp: 16, pinchDown: 12, angle: 15 },
  { name: 'SMOOTH', posUp: 7, posDown: 6, pinchUp: 10, pinchDown: 8, angle: 9 },
  { name: 'GLIDE', posUp: 3.5, posDown: 3, pinchUp: 6, pinchDown: 5, angle: 5 },
]

const hud = {
  refs: null,
  meters: {
    track: 0.12,
    gate: 0,
    fx: 0,
    bass: 0,
    presence: 0,
  },
  pulses: {
    instrument: 0,
    arp: 0,
    mode: 0,
  },
}

let leftFxMode = 0
let lastTime = 0
let frameCount = 0
let lastFpsTime = 0
let fpsValue = 0
let audioStarted = false
let audioUnlocking = false
let audioInitialized = false
let signalStatus = 'INIT'
let lastArpRoot = 440
const handSmooth = { x: 0, y: 0, z: 0, pinch: 0.3, angle: 0, spread: 0.1, depth: 0, seeded: false }
const hand2Smooth = { x: 0, y: 0, z: 0, pinch: 0, angle: 0, seeded: false }
let dualPinchStart = 0
let dualPinchActive = false
let dualPinchAction = ''
let loopArmed = false
let loopGestureRecording = false
let loopArmSince = 0
let performanceLocked = false
let smoothingPresetIndex = 1
const LOOP_HOLD_LONG = 1200
const LOOP_HOLD_SHORT_MAX = 700
const FX_ARM_PINCH = 0.18
const sceneSlots = [null, null, null]
let scenePointer = 0
let sceneBanner = ''
let sceneBannerUntil = 0
let sceneSystemEnabled = true

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function smooth(current, target, dt, speedUp = 10, speedDown = 4) {
  const speed = target > current ? speedUp : speedDown
  const alpha = 1 - Math.exp(-speed * Math.max(0, dt))
  return current + (target - current) * alpha
}

function smoothAngle(current, target, dt, speed = 8) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  const alpha = 1 - Math.exp(-speed * Math.max(0, dt))
  return current + delta * alpha
}

function angleNorm(angle) {
  return (angle + Math.PI) / (Math.PI * 2)
}

function freqToNote(hz) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1)
}

function setSignalStatus(status) {
  signalStatus = status
}

function resolveSignalStatus(active, landmarksCount) {
  if (signalStatus === 'CAM ERROR' || signalStatus === 'AUDIO ERROR' || signalStatus === 'LOADING') {
    return signalStatus
  }
  if (active) return 'LOCKED'
  if (landmarksCount > 0) return 'SEARCHING'
  return audioStarted ? 'STANDBY' : 'ARMED'
}

function vectorText(hand) {
  if (!hand.active) return 'X+00 / Y+00'
  const x = `${hand.attractor.x >= 0 ? '+' : '-'}${Math.abs(hand.attractor.x).toFixed(2)}`
  const y = `${hand.attractor.y >= 0 ? '+' : '-'}${Math.abs(hand.attractor.y).toFixed(2)}`
  return `X${x} / Y${y}`
}

function fieldLabel(spread) {
  if (spread < 0.15) return 'TIGHT'
  if (spread < 0.25) return 'BOUND'
  if (spread < 0.38) return 'OPEN'
  return 'FLARED'
}

function gateLabel(pinch) {
  if (pinch < 0.08) return 'OPEN'
  if (pinch > 0.15) return 'CLOSED'
  return 'THRESHOLD'
}

function loopLabel(loopState, loopLayers, loopProgress) {
  if (loopState === 'RECORDING') return `LOOP REC ${Math.round(loopProgress * 100)}%`
  if (loopArmed) return 'LOOP ARMED'
  if (loopState === 'PLAYING') return `LOOP ${loopLayers}/3`
  return ''
}

function currentSmoothing() {
  return SMOOTHING_PRESETS[smoothingPresetIndex]
}

function cycleSmoothingPreset(now) {
  smoothingPresetIndex = (smoothingPresetIndex + 1) % SMOOTHING_PRESETS.length
  pushSceneBanner(`SMOOTH ${currentSmoothing().name}`, now)
  hud.pulses.mode = 1
}

function togglePerformanceLock(now) {
  performanceLocked = !performanceLocked
  pushSceneBanner(performanceLocked ? 'PERF LOCK ON' : 'PERF LOCK OFF', now)
  hud.pulses.mode = 1
}

function smoothPrimaryHand(hand, dt) {
  if (!hand.active) {
    handSmooth.seeded = false
    return { ...hand }
  }

  const preset = currentSmoothing()
  if (!handSmooth.seeded) {
    handSmooth.x = hand.attractor.x
    handSmooth.y = hand.attractor.y
    handSmooth.z = hand.attractor.z
    handSmooth.pinch = hand.pinch
    handSmooth.spread = hand.spread
    handSmooth.depth = hand.depth
    handSmooth.angle = hand.angle || 0
    handSmooth.seeded = true
  } else {
    handSmooth.x = smooth(handSmooth.x, hand.attractor.x, dt, preset.posUp, preset.posDown)
    handSmooth.y = smooth(handSmooth.y, hand.attractor.y, dt, preset.posUp, preset.posDown)
    handSmooth.z = smooth(handSmooth.z, hand.attractor.z, dt, preset.posUp, preset.posDown)
    handSmooth.pinch = smooth(handSmooth.pinch, hand.pinch, dt, preset.pinchUp, preset.pinchDown)
    handSmooth.spread = smooth(handSmooth.spread, hand.spread, dt, preset.posUp, preset.posDown)
    handSmooth.depth = smooth(handSmooth.depth, hand.depth, dt, preset.posUp, preset.posDown)
    handSmooth.angle = smoothAngle(handSmooth.angle, hand.angle || 0, dt, preset.angle)
  }

  return {
    ...hand,
    attractor: { x: handSmooth.x, y: handSmooth.y, z: handSmooth.z },
    pinch: handSmooth.pinch,
    angle: handSmooth.angle,
    spread: handSmooth.spread,
    depth: handSmooth.depth,
  }
}

function frequencyFromHand(hand) {
  if (isBassInstrument()) {
    return 40 + ((hand.attractor.y + 2) / 4) * 240
  }
  return 100 + ((hand.attractor.y + 2) / 4) * 1100
}

function buildChordTelemetry(envelope = 0) {
  const chord = getChordState()
  return {
    mode: 'CHORD',
    envelope,
    row1: ['Density', `${chord.density}/3`],
    row2: ['Tint', chord.tint],
    row3: ['Spread', `${chord.spread}`],
    summary: 'CHORD VOICE',
    summaryValue: chord.density ? `${chord.density + 1} NOTE` : 'MONO',
  }
}

function setupHud() {
  hud.refs = {
    titleSignal: document.getElementById('title-signal'),
    titleLock: document.getElementById('title-lock'),
    titleScale: document.getElementById('title-scale'),
    titleFps: document.getElementById('title-fps'),
    topVoice: document.getElementById('top-voice'),
    topMode: document.getElementById('top-mode'),
    spectrumBase: document.getElementById('spectrum-base'),
    spectrumAccent: document.getElementById('spectrum-accent'),
    statusCells: [...document.querySelectorAll('#status-matrix .status-cell')],
    trackMeter: document.getElementById('meter-track'),
    trackLabel: document.getElementById('left-track-label'),
    trackValue: document.getElementById('left-track-value'),
    leftVector: document.getElementById('left-vector'),
    leftDepth: document.getElementById('left-depth'),
    leftField: document.getElementById('left-field'),
    triggerLights: [...document.querySelectorAll('#trigger-array .status-light')],
    gateMeter: document.getElementById('meter-gate'),
    gateLabel: document.getElementById('right-gate-label'),
    gateValue: document.getElementById('right-gate-value'),
    fxRow1Label: document.getElementById('fx-row-1-label'),
    fxRow1Value: document.getElementById('fx-row-1-value'),
    fxRow2Label: document.getElementById('fx-row-2-label'),
    fxRow2Value: document.getElementById('fx-row-2-value'),
    fxRow3Label: document.getElementById('fx-row-3-label'),
    fxRow3Value: document.getElementById('fx-row-3-value'),
    fxMeter: document.getElementById('meter-fx'),
    fxEnvelopeLabel: document.getElementById('fx-envelope-label'),
    fxEnvelopeValue: document.getElementById('fx-envelope-value'),
    bottomCarrier: document.getElementById('bottom-carrier'),
    bottomNote: document.getElementById('bottom-note'),
    bottomGate: document.getElementById('bottom-gate'),
    bottomArp: document.getElementById('bottom-arp'),
    bottomMode: document.getElementById('bottom-mode'),
    bottomVoice: document.getElementById('bottom-voice'),
    bottomScale: document.getElementById('bottom-scale'),
    bottomLock: document.getElementById('bottom-lock'),
    bottomSmooth: document.getElementById('bottom-smooth'),
    energyBass: document.getElementById('energy-bass'),
    energyPresence: document.getElementById('energy-presence'),
    energyGesture: document.getElementById('energy-gesture'),
    loopMeter: document.getElementById('meter-loop'),
    loopStatus: document.getElementById('loop-status'),
    loopLayers: document.getElementById('loop-layers'),
    panelTrack: document.getElementById('panel-track'),
    panelPrimary: document.getElementById('panel-primary'),
    panelGate: document.getElementById('panel-gate'),
    panelFx: document.getElementById('panel-fx'),
    panelLoop: document.getElementById('panel-loop'),
    panelMode: document.getElementById('panel-mode'),
    panelVoice: document.getElementById('panel-voice'),
    panelCarrier: document.getElementById('panel-carrier'),
    panelNote: document.getElementById('panel-note'),
    panelGateState: document.getElementById('panel-gate-state'),
    panelArp: document.getElementById('panel-arp'),
  }
}

async function init() {
  const video = document.getElementById('webcam-video')
  initDither(video, document.getElementById('dither-canvas'), document.getElementById('border-frame'))
  setupHud()
  buildHudSvg()
  window.addEventListener('resize', buildHudSvg)
  requestAnimationFrame(loop)

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    video.srcObject = stream
    await video.play()
    setSignalStatus('LOADING')
    await initVision(video)
    setSignalStatus('SEARCHING')
  } catch {
    setSignalStatus('CAM ERROR')
  }
}

async function unlockAudio() {
  if (audioStarted || audioUnlocking) return
  audioUnlocking = true
  try {
    await startAudio()
    if (!audioInitialized) {
      initAudio()
      audioInitialized = true
    }
    playUnlockCue()
    audioStarted = true
    const prompt = document.getElementById('audio-prompt')
    if (prompt) prompt.classList.add('hidden')
    removeAudioUnlockListeners()
  } catch {
    audioStarted = false
    setSignalStatus('AUDIO ERROR')
  } finally {
    audioUnlocking = false
  }
}

function removeAudioUnlockListeners() {
  document.removeEventListener('pointerdown', unlockAudio)
  document.removeEventListener('touchend', unlockAudio)
  document.removeEventListener('click', unlockAudio)
}

document.addEventListener('pointerdown', unlockAudio, { passive: true })
document.addEventListener('touchend', unlockAudio, { passive: true })
document.addEventListener('click', unlockAudio, { passive: true })

function loop(now) {
  requestAnimationFrame(loop)
  try {
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016
    lastTime = now

    tickVision(now)
    updateFps(now)

    const hand = getHandState()
    const hand2 = getHandState2()
    const controlHand = smoothPrimaryHand(hand, dt)
    const { attractor, pinch, spread, active } = controlHand

    let fxTelemetry = {
      mode: LEFT_FX_MODES[leftFxMode],
      envelope: 0,
      row1: ['Echo Wet', '0%'],
      row2: ['Time', '0ms'],
      row3: ['Feedback', '0%'],
      summary: 'MOD FLUX',
      summaryValue: '00%',
    }

    if (audioStarted) {
    const peacePrimary = checkPeaceGesture()
    const peaceSecondary = checkPeaceGestureHand2()
    const rootCycle = checkRootCycleGesture()
    if (peacePrimary && hand2.palm) {
      cycleSmoothingPreset(now)
    } else if (peacePrimary && peaceSecondary) {
      handleSceneGesture(now, active, attractor)
      hud.pulses.mode = 1
      hud.pulses.instrument = 1
    } else if (peacePrimary) {
      nextInstrument()
      hud.pulses.instrument = 1
    }
    if (rootCycle) {
      const root = cycleRootNote()
      pushSceneBanner(`KEY ROOT ${root}`, now)
      hud.pulses.mode = 1
    }
    if (checkArpToggleGesture() && !hand2.palm) {
      lastArpRoot = active ? frequencyFromHand(controlHand) : 440
      toggleArp(lastArpRoot)
      hud.pulses.arp = 1
    }
    if (peaceSecondary && !peacePrimary) {
      leftFxMode = (leftFxMode + 1) % LEFT_FX_MODES.length
      hud.pulses.mode = 1
    }
    }

    handleLoopGesture(now, controlHand, hand2, audioStarted)
    setChordMode(leftFxMode === 4)

    if (active && audioStarted) {
    const freq = frequencyFromHand(controlHand)
    setFrequency(freq)
    setPinchGate(pinch)
    setVolume(1 - Math.min(pinch / 0.3, 1))

    const vibratoNorm = clamp((spread - 0.1) / 0.4, 0, 1)
    setVibrato(vibratoNorm)
    } else if (audioStarted) {
      setPinchGate(1)
      setVolume(0)
    }

    if (hand2.active) {
    if (!hand2Smooth.seeded) {
      hand2Smooth.x = hand2.attractor.x
      hand2Smooth.y = hand2.attractor.y
      hand2Smooth.z = hand2.attractor.z
      hand2Smooth.pinch = hand2.pinch
      hand2Smooth.angle = hand2.angle || 0
      hand2Smooth.seeded = true
    } else {
      hand2Smooth.x = smooth(hand2Smooth.x, hand2.attractor.x, dt, 9, 7)
      hand2Smooth.y = smooth(hand2Smooth.y, hand2.attractor.y, dt, 9, 7)
      hand2Smooth.z = smooth(hand2Smooth.z, hand2.attractor.z, dt, 9, 7)
      hand2Smooth.pinch = smooth(hand2Smooth.pinch, hand2.pinch, dt, 11, 8)
      hand2Smooth.angle = smoothAngle(hand2Smooth.angle, hand2.angle || 0, dt, 10)
    }
    } else {
      hand2Smooth.seeded = false
    }

    const fxArmed = hand2.active && audioStarted && !performanceLocked && hand2Smooth.pinch < FX_ARM_PINCH

    if (fxArmed) {
    const y2 = hand2Smooth.y
    const x2 = hand2Smooth.x
    const p2 = hand2Smooth.pinch
    const rot2 = angleNorm(hand2Smooth.angle)

      if (leftFxMode === 0) {
      const wet = clamp(1 - Math.min(p2 / FX_ARM_PINCH, 1), 0, 0.9)
      const timeControl = rot2
      const fb = clamp((y2 + 2) / 4, 0, 0.8)
      setDelay(timeControl, fb, wet)
      setStutter(0.2, 0)
      setBitcrush(0)
      fxTelemetry = {
        mode: 'ECHO',
        envelope: wet,
        row1: ['Echo Wet', `${Math.round(wet * 100)}%`],
        row2: ['Tempo', `${getTempoBpm()} BPM`],
        row3: ['Delay Div', getDelayDivisionLabel()],
        summary: 'ECHO FLUX',
        summaryValue: `${Math.round(((wet + fb) * 0.5) * 100)}%`,
      }
      } else if (leftFxMode === 1) {
        setDelayPitchMix(0)
      const revWet = clamp(1 - Math.min(p2 / FX_ARM_PINCH, 1), 0.1, 0.9)
      const vibDepth = clamp(rot2, 0, 0.6)
      const freeze = p2 < 0.055
      setReverbWet(revWet)
      setReverbFreeze(freeze)
      setVibrato(vibDepth)
      setStutter(0.2, 0)
      setBitcrush(0)
      fxTelemetry = {
        mode: 'SPACE',
        envelope: revWet,
        row1: ['Space Wet', `${Math.round(revWet * 100)}%`],
        row2: ['Vibrato', `${Math.round(vibDepth * 100)}%`],
        row3: ['Freeze', freeze ? 'ON' : 'OFF'],
        summary: 'SPACE FLUX',
        summaryValue: `${Math.round(((revWet + vibDepth) * 0.5) * 100)}%`,
      }
      } else if (leftFxMode === 2) {
        setDelayPitchMix(0)
      setReverbFreeze(false)
      const cutoffNorm = rot2
      const q = clamp(((y2 + 2) / 4) * 18, 0.5, 18)
      const vibratoRate = clamp((1 - Math.min(p2 / FX_ARM_PINCH, 1)) * 10, 1, 10)
      setFilterCutoff(cutoffNorm)
      setFilterQ(q)
      setVibratoRate(vibratoRate)
      setStutter(0.2, 0)
      setBitcrush(0)
      fxTelemetry = {
        mode: 'FILTER',
        envelope: cutoffNorm,
        row1: ['Cutoff', `${Math.round(200 + cutoffNorm * 7800)}Hz`],
        row2: ['Resonance', q.toFixed(1)],
        row3: ['Rate', `${vibratoRate.toFixed(1)}Hz`],
        summary: 'FILTER FLUX',
        summaryValue: `${Math.round(cutoffNorm * 100)}%`,
      }
      } else if (leftFxMode === 3) {
        setDelayPitchMix(0)
      setReverbFreeze(false)
      const macro = rot2
      const crush = clamp((x2 + 3) / 6, 0, 1)
      const drive = clamp(1 - Math.min(p2 / FX_ARM_PINCH, 1), 0, 1)
      const stutterRate = rot2
      const stutterDepth = clamp(crush * 0.9, 0, 1)

      setTransitionMacro(macro)
      setBitcrush(crush)
      setDrive(drive * 0.7)
      setStutter(stutterRate, stutterDepth)

      fxTelemetry = {
        mode: 'PERF',
        envelope: Math.max(crush, drive),
        row1: ['Crush', `${Math.round(crush * 100)}%`],
        row2: ['Drive', `${Math.round(drive * 100)}%`],
        row3: ['Stutter', `${Math.round(stutterDepth * 100)}%`],
        summary: 'PERF MACRO',
        summaryValue: `${Math.round(macro * 100)}%`,
      }
      } else if (leftFxMode === 4) {
        setDelayPitchMix(0)
      setReverbFreeze(false)
      setBitcrush(0)
      setDrive(0)
      setStutter(0.2, 0)
      const spreadNorm = clamp((y2 + 2) / 4, 0, 1)
      const tintNorm = rot2
      const densityNorm = clamp(1 - Math.min(p2 / FX_ARM_PINCH, 1), 0, 1)
      setChordShape({ spread: spreadNorm, tint: tintNorm, density: densityNorm })
      fxTelemetry = buildChordTelemetry(densityNorm)
      }
    } else if (hand2.active && audioStarted) {
      const lockedLabel = performanceLocked ? 'YES' : 'NO'
      fxTelemetry = {
        mode: LEFT_FX_MODES[leftFxMode],
        envelope: 0,
        row1: ['FX Lock', lockedLabel],
        row2: ['Pinch', `${Math.round((1 - Math.min(hand2Smooth.pinch / FX_ARM_PINCH, 1)) * 100)}%`],
        row3: ['Rotate', `${Math.round(angleNorm(hand2Smooth.angle) * 100)}%`],
        summary: performanceLocked ? 'PERF LOCK' : 'FX IDLE',
        summaryValue: performanceLocked ? 'ON' : 'PINCH',
      }
    }

    if (leftFxMode === 4 && (!hand2.active || !audioStarted)) {
      fxTelemetry = buildChordTelemetry(getChordState().density / 3)
    }

    const gateOpen = active && pinch < 0.1
    const gateOpen2 = hand2.active && hand2.pinch < 0.1
    const freqData = getFreqData()
    const landmarks = getLandmarks()
    const personMask = getPersonMask()
    const currentFreq = getCurrentFrequency()
    const loopState = getLoopState()
    const loopLayers = getLoopLayerCount()
    const gridOverlay = buildGridOverlayData(controlHand, hand2, gateOpen, gateOpen2)
    const telemetry = buildTelemetry({
      dt,
      now,
      hand: controlHand,
      hand2,
      currentFreq,
      freqData,
      gateOpen,
      fxTelemetry,
      loopState,
      loopLayers,
      loopProgress: getLoopCaptureProgress(),
      landmarksCount: landmarks.length,
    })

    tickDither(freqData, gateOpen, dt, landmarks, buildHandLabels(telemetry), personMask, gridOverlay)
    renderHud(telemetry)
  } catch {
    setSignalStatus('RUNTIME ERROR')
  }
}

function updateFps(now) {
  frameCount++
  if (now - lastFpsTime >= 1000) {
    fpsValue = frameCount
    frameCount = 0
    lastFpsTime = now
  }
}

function handleLoopGesture(now, hand, hand2, enabled) {
  if (!enabled) {
    loopArmed = false
    loopGestureRecording = false
    loopArmSince = 0
    return
  }

  const rightPinch = hand.active && hand.pinch < 0.08
  const rightRelease = !hand.active || hand.pinch > 0.15
  if (loopArmed && rightPinch && !loopGestureRecording) {
    captureOneBarLoop().then(ok => {
      if (!ok) loopGestureRecording = false
    }).catch(() => {
      loopGestureRecording = false
    })
    loopGestureRecording = true
    hud.pulses.arp = 1
  } else if (loopGestureRecording && rightRelease) {
    stopLoopCapture().catch(() => {})
    loopGestureRecording = false
    loopArmed = false
    loopArmSince = 0
    hud.pulses.arp = 1
  }

  const bothPalms = hand.active && hand2.active && hand.palm && hand2.palm
  if (bothPalms && !loopGestureRecording) {
    loopArmed = true
    if (!loopArmSince) loopArmSince = now
    return
  }

  if (!bothPalms && loopArmed && !loopGestureRecording && !rightPinch) {
    loopArmed = false
    loopArmSince = 0
  }

  const dualPinchNow = enabled
    && hand.active && hand2.active
    && hand.pinch < 0.07
    && hand2.pinch < 0.07

  if (dualPinchNow) {
    if (!dualPinchActive) {
      dualPinchActive = true
      dualPinchStart = now
      dualPinchAction = ''
      return
    }

    const hold = now - dualPinchStart
    if (hold >= LOOP_HOLD_LONG && dualPinchAction !== 'clear') {
      clearLoop().catch(() => {})
      loopArmed = false
      loopGestureRecording = false
      loopArmSince = 0
      hud.pulses.mode = 1
      dualPinchAction = 'clear'
    }
    return
  }

  if (!dualPinchActive) return

  const hold = now - dualPinchStart
  if (hold >= 260 && hold < LOOP_HOLD_SHORT_MAX && dualPinchAction !== 'clear') {
    togglePerformanceLock(now)
  }
  dualPinchActive = false
  dualPinchStart = 0
  dualPinchAction = ''
}

function buildGridOverlayData(hand, hand2, gateOpen, gateOpen2) {
  const rightNorm = hand.active ? {
    x: clamp(hand.attractor.x / 6 + 0.5, 0, 1),
    y: clamp(0.5 - hand.attractor.y / 4, 0, 1),
  } : null

  const leftNorm = hand2.active ? {
    x: clamp(hand2.attractor.x / 6 + 0.5, 0, 1),
    y: clamp(0.5 - hand2.attractor.y / 4, 0, 1),
  } : null

  return {
    right: { active: hand.active, gateOpen, norm: rightNorm },
    left: { active: hand2.active, gateOpen: gateOpen2, norm: leftNorm },
  }
}

function buildTelemetry({ dt, now, hand, hand2, currentFreq, freqData, gateOpen, fxTelemetry, loopState, loopLayers, loopProgress, landmarksCount }) {
  hud.pulses.instrument = Math.max(0, hud.pulses.instrument - dt * 1.35)
  hud.pulses.arp = Math.max(0, hud.pulses.arp - dt * 1.25)
  hud.pulses.mode = Math.max(0, hud.pulses.mode - dt * 1.15)

  const bass = ((freqData[0] || 0) + (freqData[1] || 0)) * 0.5
  const presence = ((freqData[2] || 0) + (freqData[3] || 0) + (freqData[4] || 0)) / 3
  const gateEnergy = hand.active ? 1 - clamp(hand.pinch / 0.3, 0, 1) : 0
  const trackTarget = landmarksCount === 0 ? 0.12 : hand.active && hand2.active ? 1 : hand.active || hand2.active ? 0.76 : 0.38

  hud.meters.track = smooth(hud.meters.track, trackTarget, dt, 7, 3)
  hud.meters.gate = smooth(hud.meters.gate, gateEnergy, dt, 12, 5)
  hud.meters.fx = smooth(hud.meters.fx, fxTelemetry.envelope, dt, 10, 4)
  hud.meters.bass = smooth(hud.meters.bass, bass, dt, 8, 4)
  hud.meters.presence = smooth(hud.meters.presence, presence, dt, 8, 4)

  const gestureState = hud.pulses.instrument > 0.15
    ? 'VOICE SHIFT'
    : hud.pulses.mode > 0.15
      ? 'BUS SHIFT'
      : hud.pulses.arp > 0.15
        ? 'ARP LATCH'
        : hand.active || hand2.active
          ? 'LISTENING'
          : 'QUIET'

  return {
    signal: resolveSignalStatus(hand.active, landmarksCount),
    lock: hud.meters.track,
    fps: fpsValue,
    instrument: getCurrentInstrumentName(),
    scale: getCurrentScaleName(),
    key: getKeyLabel(),
    mode: LEFT_FX_MODES[leftFxMode],
    currentFreq,
    tempoBpm: getTempoBpm(),
    note: hand.active || isArpActive() ? freqToNote(currentFreq) : '---',
    gate: gateLabel(hand.pinch),
    gateOpen,
    hand,
    hand2,
    freqData,
    bass: hud.meters.bass,
    presence: hud.meters.presence,
    fx: fxTelemetry,
    loopState,
    loopLayers,
    loopProgress,
    loopArmed,
    performanceLocked,
    smoothingPreset: currentSmoothing().name,
    sceneBanner: now < sceneBannerUntil ? sceneBanner : '',
    arpActive: isArpActive(),
    arpRoot: lastArpRoot,
    gestureState,
    pulses: { ...hud.pulses },
    statusCells: [
      hand.active,
      hand2.active,
      audioStarted,
      gateOpen,
      isArpActive(),
      hud.pulses.instrument > 0.15,
      hud.pulses.mode > 0.15,
      hud.pulses.arp > 0.15,
    ],
  }
}

function buildHandLabels(telemetry) {
  const labels = []

  if (telemetry.hand.active) {
    labels[0] = [
      `CARRIER ${telemetry.note}`,
      `GATE    ${telemetry.gate}`,
      `FIELD   ${fieldLabel(telemetry.hand.spread)}`,
      `VOICE   ${telemetry.instrument}`,
    ]
  }

  if (telemetry.hand2.active) {
    labels[1] = [
      `MOD BUS ${telemetry.mode}`,
      `${telemetry.fx.row1[0].toUpperCase().padEnd(8, ' ')} ${telemetry.fx.row1[1]}`,
      `${telemetry.fx.row2[0].toUpperCase().padEnd(8, ' ')} ${telemetry.fx.row2[1]}`,
      `${telemetry.fx.row3[0].toUpperCase().padEnd(8, ' ')} ${telemetry.fx.row3[1]}`,
    ]
  }

  return labels
}

function renderHud(telemetry) {
  if (!hud.refs) return
  const r = hud.refs

  r.titleSignal.textContent = `SIGNAL / ${telemetry.signal}`
  r.titleLock.textContent = `TRACK / ${Math.round(telemetry.lock * 100)}%`
  r.titleScale.textContent = `KEY / ${telemetry.key}`
  r.titleFps.textContent = `SCAN / ${String(telemetry.fps).padStart(2, '0')} FPS`
  r.topVoice.textContent = telemetry.instrument
  r.topMode.textContent = telemetry.mode

  setMeter(r.trackMeter, telemetry.lock)
  r.trackLabel.textContent = telemetry.signal === 'LOCKED' ? 'LOCKED' : telemetry.signal
  r.trackValue.textContent = `${Math.round(telemetry.lock * 100)}%`
  r.leftVector.textContent = vectorText(telemetry.hand)
  r.leftDepth.textContent = telemetry.hand.active ? `${Math.round(angleNorm(telemetry.hand.angle) * 100)}%` : '00%'
  r.leftField.textContent = telemetry.hand.active ? fieldLabel(telemetry.hand.spread) : 'DORMANT'

  setMeter(r.gateMeter, hud.meters.gate)
  r.gateLabel.textContent = telemetry.gate
  r.gateValue.textContent = `${Math.round(hud.meters.gate * 100)}%`

  r.fxRow1Label.textContent = telemetry.fx.row1[0]
  r.fxRow1Value.textContent = telemetry.fx.row1[1]
  r.fxRow2Label.textContent = telemetry.fx.row2[0]
  r.fxRow2Value.textContent = telemetry.fx.row2[1]
  r.fxRow3Label.textContent = telemetry.fx.row3[0]
  r.fxRow3Value.textContent = telemetry.fx.row3[1]
  setMeter(r.fxMeter, hud.meters.fx)
  r.fxEnvelopeLabel.textContent = telemetry.fx.summary
  r.fxEnvelopeValue.textContent = telemetry.fx.summaryValue

  r.bottomCarrier.textContent = `${Math.round(telemetry.currentFreq)}Hz`
  r.bottomNote.textContent = telemetry.note
  r.bottomGate.textContent = telemetry.gate
  r.bottomArp.textContent = telemetry.arpActive ? `ONLINE ${freqToNote(telemetry.arpRoot)}` : 'OFFLINE'
  r.bottomMode.textContent = `${telemetry.mode} CHAMBER`
  r.bottomVoice.textContent = telemetry.instrument
  r.bottomScale.textContent = `${telemetry.key} / ${telemetry.tempoBpm} BPM`
  if (r.bottomLock) r.bottomLock.textContent = telemetry.performanceLocked ? 'ON' : 'OFF'
  if (r.bottomSmooth) r.bottomSmooth.textContent = telemetry.smoothingPreset
  r.energyBass.textContent = `${Math.round(telemetry.bass * 100)}%`
  r.energyPresence.textContent = `${Math.round(telemetry.presence * 100)}%`
  const activeLoopLabel = loopLabel(telemetry.loopState, telemetry.loopLayers, telemetry.loopProgress)
  r.energyGesture.textContent = activeLoopLabel
    ? activeLoopLabel
    : telemetry.sceneBanner
      ? telemetry.sceneBanner
      : telemetry.gestureState

  const loopMeter = telemetry.loopState === 'RECORDING'
    ? telemetry.loopProgress
    : telemetry.loopState === 'PLAYING'
      ? clamp(telemetry.loopLayers / 3, 0, 1)
      : telemetry.loopArmed
        ? 0.5
        : 0
  const loopStatus = telemetry.loopState === 'RECORDING'
    ? 'REC'
    : telemetry.loopArmed
      ? 'ARMED'
      : telemetry.loopState === 'PLAYING'
        ? 'PLAY'
        : 'IDLE'
  setMeter(r.loopMeter, loopMeter)
  if (r.loopStatus) r.loopStatus.textContent = loopStatus
  if (r.loopLayers) r.loopLayers.textContent = `LAYER ${telemetry.loopLayers}/3`

  updateWaveform(telemetry)
  updateStatusMatrix(telemetry)
  updateTriggerLights(telemetry)

  setPanelState(r.panelTrack, telemetry.hand.active || telemetry.hand2.active, telemetry.lock < 0.45)
  setPanelState(r.panelPrimary, telemetry.hand.active, !telemetry.hand.active)
  setPanelState(r.panelGate, telemetry.gateOpen, !telemetry.hand.active)
  setPanelState(r.panelFx, telemetry.hand2.active || telemetry.mode === 'CHORD' || hud.pulses.mode > 0.1, !telemetry.hand2.active && telemetry.mode !== 'CHORD')
  setPanelState(r.panelLoop, telemetry.loopState !== 'IDLE' || telemetry.loopArmed, telemetry.loopState === 'IDLE' && !telemetry.loopArmed)
  setPanelState(r.panelMode, telemetry.hand2.active || hud.pulses.mode > 0.1, false)
  setPanelState(r.panelVoice, hud.pulses.instrument > 0.1 || telemetry.hand.active, false)
  setPanelState(r.panelCarrier, telemetry.hand.active || telemetry.arpActive, false)
  setPanelState(r.panelNote, telemetry.gateOpen || telemetry.arpActive, false)
  setPanelState(r.panelGateState, telemetry.gateOpen, false)
  setPanelState(r.panelArp, telemetry.arpActive || hud.pulses.arp > 0.1, !telemetry.arpActive)
}

function setMeter(el, value) {
  if (!el) return
  el.style.setProperty('--level', clamp(value, 0, 1).toFixed(3))
}

function setPanelState(panel, hot, muted) {
  if (!panel) return
  panel.classList.toggle('hot', hot)
  panel.classList.toggle('muted', muted)
}

function updateStatusMatrix(telemetry) {
  telemetry.statusCells.forEach((active, i) => {
    const cell = hud.refs.statusCells[i]
    if (!cell) return
    cell.classList.toggle('live', active)
    cell.classList.toggle('white', i === 2 && active)
  })
}

function updateTriggerLights(telemetry) {
  const states = [
    telemetry.hand.active,
    telemetry.gateOpen,
    telemetry.pulses.instrument > 0.1,
    telemetry.hand2.active,
    telemetry.pulses.mode > 0.1,
    telemetry.pulses.arp > 0.1 || telemetry.arpActive,
  ]

  hud.refs.triggerLights.forEach((light, i) => {
    if (!light) return
    light.classList.toggle('active', states[i] && i !== 0)
    light.classList.toggle('soft', states[i] && i === 0)
  })
}

function updateWaveform(telemetry) {
  const data = telemetry.freqData
  const width = 220
  const height = 48
  const step = width / (data.length - 1 || 1)
  const basePoints = []
  const accentPoints = []

  for (let i = 0; i < data.length; i++) {
    const x = i * step
    const baseY = 24 - data[i] * 10
    const accentY = 34 - data[i] * 26
    basePoints.push(`${x},${baseY.toFixed(2)}`)
    accentPoints.push(`${x},${accentY.toFixed(2)}`)
  }

  hud.refs.spectrumBase.setAttribute('points', basePoints.join(' '))
  hud.refs.spectrumAccent.setAttribute('points', accentPoints.join(' '))
}

function pushSceneBanner(text, now) {
  sceneBanner = text
  sceneBannerUntil = now + 1800
}

function handleSceneGesture(now, active, attractor) {
  if (!sceneSystemEnabled) {
    pushSceneBanner('SCENE SYS OFF', now)
    return
  }
  try {
    const saveMode = active && attractor.y > 1.0
    if (saveMode) {
      const slot = saveScene()
      pushSceneBanner(slot ? `SCENE ${slot} SAVED` : 'SCENE SAVE FAIL', now)
    } else {
      const loaded = recallScene()
      pushSceneBanner(loaded ? `SCENE ${loaded} LOADED` : 'NO SCENE SAVED', now)
    }
  } catch {
    sceneSystemEnabled = false
    pushSceneBanner('SCENE SYS OFF', now)
  }
}

function saveScene() {
  const slot = scenePointer
  const sceneAudio = getSceneState()
  if (!sceneAudio) return 0
  sceneSlots[slot] = { leftFxMode, audio: sceneAudio }
  scenePointer = (scenePointer + 1) % sceneSlots.length
  return slot + 1
}

function recallScene() {
  for (let n = 0; n < sceneSlots.length; n++) {
    const idx = (scenePointer + n) % sceneSlots.length
    const scene = sceneSlots[idx]
    if (!scene) continue
    leftFxMode = scene.leftFxMode
    applySceneState(scene.audio)
    scenePointer = (idx + 1) % sceneSlots.length
    hand2Smooth.seeded = false
    return idx + 1
  }
  return 0
}

function buildHudSvg() {
  const svg = document.getElementById('hud-svg')
  const W = window.innerWidth
  const H = window.innerHeight
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

  const cx = W / 2
  const cy = H / 2

  let markup = ''
  markup += `<line x1="${cx - 18}" y1="${cy}" x2="${cx + 18}" y2="${cy}" stroke="#ffffff" stroke-width="0.8" opacity="0.28"/>`
  markup += `<line x1="${cx}" y1="${cy - 18}" x2="${cx}" y2="${cy + 18}" stroke="#ffffff" stroke-width="0.8" opacity="0.28"/>`
  markup += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="#ffffff" stroke-width="0.8" opacity="0.28"/>`

  svg.innerHTML = markup
}

init()
