import * as Tone from 'tone'

// --- Scale quantization ---
const SCALES = {
  PENTA: [0, 2, 4, 7, 9],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  MAJOR: [0, 2, 4, 5, 7, 9, 11],
  FREE:  null,
}
const SCALE_NAMES = Object.keys(SCALES)
let scaleIndex = 0

function quantizeHz(hz) {
  const scale = SCALES[SCALE_NAMES[scaleIndex]]
  if (!scale) return hz
  const midi = 12 * Math.log2(hz / 440) + 69
  const octave = Math.floor(midi / 12)
  const pc = ((midi % 12) + 12) % 12
  let best = scale[0], bestDist = Infinity
  for (const deg of scale) {
    const d = Math.min(Math.abs(pc - deg), 12 - Math.abs(pc - deg))
    if (d < bestDist) { bestDist = d; best = deg }
  }
  return 440 * Math.pow(2, (octave * 12 + best - 69) / 12)
}

// --- Instruments (default = DUO for richness) ---
const INSTRUMENTS = [
  {
    name: 'DUO',
    make: () => new Tone.DuoSynth({
      harmonicity: 1.5, vibratoAmount: 0.15, vibratoRate: 4,
      voice0: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.04, decay: 0.1, sustain: 0.85, release: 0.6 } },
      voice1: { oscillator: { type: 'triangle' }, envelope: { attack: 0.06, decay: 0.1, sustain: 0.85, release: 0.6 } },
    }),
  },
  {
    name: 'FM',
    make: () => new Tone.FMSynth({
      harmonicity: 3.01, modulationIndex: 14,
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.5 },
      modulationEnvelope: { attack: 0.2, decay: 0.01, sustain: 1, release: 0.5 },
    }),
  },
  {
    name: 'AM',
    make: () => new Tone.AMSynth({
      harmonicity: 2,
      envelope: { attack: 0.05, decay: 0.2, sustain: 0.7, release: 0.9 },
      modulationEnvelope: { attack: 0.5, decay: 0.01, sustain: 1, release: 0.5 },
    }),
  },
  {
    name: 'MONO',
    make: () => new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.01, decay: 0.08, sustain: 0.7, release: 0.4 },
      filterEnvelope: { attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.2, baseFrequency: 300, octaves: 3 },
    }),
  },
]

let currentIndex = 0
let synth        = null
let vibrato      = null
let filter       = null
let delay        = null
let reverb       = null
let bitcrusher   = null
let drive        = null
let tremolo      = null
let pitchShift   = null
let analyser     = null
let masterBus    = null
let arpPattern   = null
let arpActive    = false
let currentFreq  = 440
let audioStarted = false
let gateOpen     = false   // true = note is currently held
let currentBpm   = 120
const DELAY_DIVISIONS = [
  { label: '1/16', mult: 0.25 },
  { label: '1/8T', mult: 1 / 3 },
  { label: '1/8',  mult: 0.5 },
  { label: '1/4T', mult: 2 / 3 },
  { label: '1/4',  mult: 1 },
  { label: '1/2',  mult: 2 },
]
let delayDivisionIndex = 2
let recorder = null
let loopPlayer = null
let loopState = 'IDLE'
let loopCaptureTimer = null
let loopCaptureStartMs = 0
let loopCaptureEndMs = 0
let loopBlobUrl = null
let filterCutoffNorm = (3000 - 200) / 7800
let filterQValue = 1
let reverbWetValue = 0.5
let reverbDecayValue = 3
let vibratoDepthValue = 0
let vibratoRateValue = 5
let delayFeedbackValue = 0.35
let delayWetValue = 0.25
let bitcrushWetValue = 0
let bitDepthValue = 8
let driveAmountValue = 0
let pitchShiftValue = 0
let stutterDepthValue = 0
let stutterRateValue = 8
let freezeActive = false

function applyDelaySyncTime(ramp = 0.05) {
  if (!delay) return
  const quarterSec = 60 / currentBpm
  const seconds = quarterSec * DELAY_DIVISIONS[delayDivisionIndex].mult
  delay.delayTime.rampTo(seconds, ramp)
}

function buildChain() {
  synth.chain(vibrato, filter, bitcrusher, drive, tremolo, pitchShift, delay, reverb, masterBus)
}

export function initAudio() {
  vibrato  = new Tone.Vibrato({ frequency: 5, depth: 0, wet: 1 })
  filter   = new Tone.Filter({ frequency: 3000, type: 'lowpass', rolloff: -24 })
  bitcrusher = new Tone.BitCrusher(8)
  bitcrusher.wet.value = 0
  drive = new Tone.Distortion({ distortion: 0, oversample: '2x', wet: 0 })
  tremolo = new Tone.Tremolo({ frequency: 8, depth: 0, wet: 1 }).start()
  pitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1, delayTime: 0, feedback: 0, wet: 0 })
  delay    = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.35, wet: 0.25 })
  reverb   = new Tone.Reverb({ decay: 3, wet: 0.5 })
  analyser = new Tone.Analyser('fft', 16)
  masterBus = new Tone.Gain(1)
  try {
    recorder = new Tone.Recorder()
  } catch {
    recorder = null
    loopState = 'UNAVAILABLE'
  }
  masterBus.connect(analyser)
  if (recorder) masterBus.connect(recorder)
  masterBus.connect(Tone.getDestination())

  synth = INSTRUMENTS[currentIndex].make()
  buildChain()
  Tone.getDestination().volume.value = -8
  Tone.Transport.bpm.value = currentBpm
  applyDelaySyncTime(0.01)
  delay.feedback.value = delayFeedbackValue
  delay.wet.value = delayWetValue
  filter.Q.value = filterQValue
  reverb.wet.value = reverbWetValue
  reverb.decay = reverbDecayValue
  vibrato.depth.value = vibratoDepthValue
  vibrato.frequency.value = vibratoRateValue
  bitcrusher.bits = bitDepthValue
  bitcrusher.wet.value = bitcrushWetValue
  drive.distortion = driveAmountValue
  drive.wet.value = driveAmountValue > 0.01 ? 1 : 0
  tremolo.depth.value = stutterDepthValue
  tremolo.frequency.value = stutterRateValue
  pitchShift.pitch = pitchShiftValue
}

export async function startAudio() {
  await Tone.start()
  audioStarted = true
  // Don't auto-attack — wait for first pinch
}

// Called every frame with current pinch value
export function setPinchGate(pinch) {
  if (!synth || !audioStarted || arpActive) return
  const shouldOpen = pinch < 0.08
  const shouldClose = pinch > 0.15
  if (shouldOpen && !gateOpen) {
    synth.triggerAttack(currentFreq)
    gateOpen = true
  } else if (shouldClose && gateOpen) {
    synth.triggerRelease()
    gateOpen = false
  }
}

export function nextInstrument() {
  if (!synth || !audioStarted) return
  if (arpActive) { stopArp() }
  if (gateOpen) { synth.triggerRelease(); gateOpen = false }
  synth.disconnect()
  synth.dispose()

  currentIndex = (currentIndex + 1) % INSTRUMENTS.length
  synth = INSTRUMENTS[currentIndex].make()
  buildChain()
}

export function getCurrentInstrumentName() { return INSTRUMENTS[currentIndex].name }
export function getCurrentInstrumentIndex() { return currentIndex }
export function setInstrumentIndex(index) {
  if (!synth || !audioStarted) return
  const safe = Math.max(0, Math.min(INSTRUMENTS.length - 1, index | 0))
  if (safe === currentIndex) return
  if (arpActive) { stopArp() }
  if (gateOpen) { synth.triggerRelease(); gateOpen = false }
  synth.disconnect()
  synth.dispose()
  currentIndex = safe
  synth = INSTRUMENTS[currentIndex].make()
  buildChain()
}

export function cycleScale() {
  scaleIndex = (scaleIndex + 1) % SCALE_NAMES.length
}
export function getCurrentScaleName() { return SCALE_NAMES[scaleIndex] }
export function getCurrentScaleIndex() { return scaleIndex }
export function setScaleIndex(index) {
  const safe = Math.max(0, Math.min(SCALE_NAMES.length - 1, index | 0))
  scaleIndex = safe
}

function stopArp() {
  if (arpPattern) { arpPattern.stop(); arpPattern.dispose(); arpPattern = null }
  Tone.Transport.stop()
  arpActive = false
}

export function toggleArp(rootFreq) {
  if (!synth || !audioStarted) return
  if (arpActive) {
    stopArp()
    return
  }

  if (gateOpen) { synth.triggerRelease(); gateOpen = false }

  const scale = SCALES[SCALE_NAMES[scaleIndex]] || SCALES.PENTA
  const root  = 440 * Math.pow(2, Math.round(12 * Math.log2(rootFreq / 440)) / 12)
  const notes = scale.map(deg => root * Math.pow(2, deg / 12))
    .concat(scale.map(deg => root * Math.pow(2, (deg + 12) / 12)))

  arpPattern = new Tone.Pattern((time, freq) => {
    synth.triggerAttackRelease(freq, '16n', time)
  }, notes, 'upDown')
  arpPattern.interval = '8n'
  arpPattern.start(0)
  Tone.Transport.bpm.value = currentBpm
  Tone.Transport.start()
  arpActive = true
}

export function isArpActive() { return arpActive }
export function getCurrentFrequency() { return currentFreq }

export function setFrequency(hz) {
  if (!synth) return
  currentFreq = Math.max(80, Math.min(1200, quantizeHz(hz)))
  if (gateOpen || arpActive) {
    synth.frequency.rampTo(currentFreq, 0.04)
  }
}

export function setVolume(norm) {
  if (!synth) return
  const clamped = Math.max(0, Math.min(1, norm))
  const db = clamped < 0.01 ? -Infinity : Tone.gainToDb(clamped) - 4
  Tone.getDestination().volume.rampTo(db, 0.05)
}

export function setFilterCutoff(norm) {
  if (!filter) return
  filterCutoffNorm = Math.max(0, Math.min(1, norm))
  filter.frequency.rampTo(200 + filterCutoffNorm * 7800, 0.05)
}

export function setReverbWet(norm) {
  if (!reverb) return
  reverbWetValue = Math.max(0.1, Math.min(0.85, norm))
  if (!freezeActive) reverb.wet.rampTo(reverbWetValue, 0.1)
}

export function setVibrato(norm) {
  if (!vibrato) return
  vibratoDepthValue = Math.max(0, Math.min(0.5, norm))
  vibrato.depth.rampTo(vibratoDepthValue, 0.1)
}

export function setVibratoRate(hz) {
  if (!vibrato) return
  vibratoRateValue = Math.max(1, Math.min(10, hz))
  vibrato.frequency.rampTo(vibratoRateValue, 0.1)
}

export function setFilterQ(q) {
  if (!filter) return
  filterQValue = Math.max(0.5, Math.min(20, q))
  filter.Q.rampTo(filterQValue, 0.05)
}

export function setTempoFromNorm(norm) {
  currentBpm = Math.round(70 + Math.max(0, Math.min(1, norm)) * 100)
  Tone.Transport.bpm.rampTo(currentBpm, 0.08)
  applyDelaySyncTime(0.08)
}

export function getTempoBpm() { return currentBpm }
export function getDelayDivisionLabel() { return DELAY_DIVISIONS[delayDivisionIndex].label }
export function getLoopState() { return loopState }
export function getLoopCaptureProgress() {
  if (loopState !== 'RECORDING') return 0
  const span = Math.max(1, loopCaptureEndMs - loopCaptureStartMs)
  return Math.max(0, Math.min(1, (Date.now() - loopCaptureStartMs) / span))
}

export function setDelay(timeControl, feedback, wet) {
  if (!delay) return
  const norm = Math.max(0, Math.min(1, timeControl))
  const idx = Math.round(norm * (DELAY_DIVISIONS.length - 1))
  delayDivisionIndex = Math.max(0, Math.min(DELAY_DIVISIONS.length - 1, idx))
  applyDelaySyncTime(0.05)
  delayFeedbackValue = Math.max(0, Math.min(0.85, feedback))
  delayWetValue = Math.max(0, Math.min(0.9, wet))
  delay.feedback.rampTo(delayFeedbackValue, 0.05)
  delay.wet.rampTo(delayWetValue, 0.05)
  if (pitchShift) {
    // Adds a pitched feedback character as delay feedback increases.
    pitchShiftValue = (delayFeedbackValue * 10) - 5
    pitchShift.pitch = pitchShiftValue
    pitchShift.wet.rampTo(Math.max(0, Math.min(0.45, delayFeedbackValue * 0.7)), 0.08)
  }
}

export function setDelayPitchMix(norm) {
  if (!pitchShift) return
  const mix = Math.max(0, Math.min(1, norm))
  pitchShift.wet.rampTo(mix, 0.08)
}

export function setBitcrush(norm) {
  if (!bitcrusher) return
  const n = Math.max(0, Math.min(1, norm))
  bitcrushWetValue = n
  bitDepthValue = Math.round(12 - n * 9)
  bitcrusher.bits = Math.max(2, bitDepthValue)
  bitcrusher.wet.rampTo(bitcrushWetValue, 0.06)
}

export function setDrive(norm) {
  if (!drive) return
  driveAmountValue = Math.max(0, Math.min(0.95, norm))
  drive.distortion = driveAmountValue
  drive.wet.rampTo(driveAmountValue > 0.02 ? 1 : 0, 0.08)
}

export function setStutter(rateNorm, depthNorm) {
  if (!tremolo) return
  stutterRateValue = 4 + Math.max(0, Math.min(1, rateNorm)) * 24
  stutterDepthValue = Math.max(0, Math.min(1, depthNorm))
  tremolo.frequency.rampTo(stutterRateValue, 0.05)
  tremolo.depth.rampTo(stutterDepthValue, 0.05)
}

export function setTransitionMacro(norm) {
  const n = Math.max(0, Math.min(1, norm))
  setFilterCutoff(n)
  const q = 0.8 + Math.sin(n * Math.PI) * 14
  setFilterQ(q)
  setDrive(Math.max(0, (1 - n) * 0.55))
}

export function setReverbFreeze(active) {
  if (!reverb) return
  if (active === freezeActive) return
  freezeActive = active
  if (freezeActive) {
    reverb.decay = 20
    reverb.wet.rampTo(0.95, 0.08)
  } else {
    reverb.decay = reverbDecayValue
    reverb.wet.rampTo(reverbWetValue, 0.1)
  }
}

export function getSceneState() {
  try {
    return {
      instrumentIndex: currentIndex,
      scaleIndex,
      bpm: currentBpm,
      delayDivisionIndex,
      filterCutoffNorm,
      filterQValue,
      reverbWetValue,
      reverbDecayValue,
      freezeActive,
      vibratoDepthValue,
      vibratoRateValue,
      delayFeedbackValue,
      delayWetValue,
      bitcrushWetValue,
      bitDepthValue,
      driveAmountValue,
      pitchShiftValue,
      stutterDepthValue,
      stutterRateValue,
    }
  } catch {
    return null
  }
}

export function applySceneState(scene) {
  if (!scene || !synth || !audioStarted) return false
  try {
    if (typeof scene.instrumentIndex === 'number') setInstrumentIndex(scene.instrumentIndex)
    if (typeof scene.scaleIndex === 'number') setScaleIndex(scene.scaleIndex)
    if (typeof scene.bpm === 'number') {
      const bpmNorm = (Math.max(70, Math.min(170, scene.bpm)) - 70) / 100
      setTempoFromNorm(bpmNorm)
    }
    if (typeof scene.delayDivisionIndex === 'number') {
      const norm = Math.max(0, Math.min(1, scene.delayDivisionIndex / (DELAY_DIVISIONS.length - 1)))
      setDelay(norm, scene.delayFeedbackValue ?? delayFeedbackValue, scene.delayWetValue ?? delayWetValue)
    }
    if (typeof scene.filterCutoffNorm === 'number') setFilterCutoff(scene.filterCutoffNorm)
    if (typeof scene.filterQValue === 'number') setFilterQ(scene.filterQValue)
    if (typeof scene.reverbWetValue === 'number') setReverbWet(scene.reverbWetValue)
    if (typeof scene.reverbDecayValue === 'number') reverbDecayValue = Math.max(1, Math.min(30, scene.reverbDecayValue))
    if (typeof scene.bitcrushWetValue === 'number') setBitcrush(scene.bitcrushWetValue)
    if (typeof scene.driveAmountValue === 'number') setDrive(scene.driveAmountValue)
    if (typeof scene.stutterRateValue === 'number' || typeof scene.stutterDepthValue === 'number') {
      const rateNorm = ((scene.stutterRateValue ?? stutterRateValue) - 4) / 24
      setStutter(rateNorm, scene.stutterDepthValue ?? stutterDepthValue)
    }
    if (typeof scene.vibratoDepthValue === 'number') setVibrato(scene.vibratoDepthValue)
    if (typeof scene.vibratoRateValue === 'number') setVibratoRate(scene.vibratoRateValue)
    if (typeof scene.freezeActive === 'boolean') setReverbFreeze(scene.freezeActive)
    return true
  } catch {
    return false
  }
}

async function finalizeLoopCapture() {
  if (!recorder || loopState !== 'RECORDING') return false
  loopCaptureTimer = null
  let recording = null
  try {
    recording = await recorder.stop()
  } catch {
    loopState = loopPlayer ? 'PLAYING' : 'IDLE'
    return false
  }
  if (!recording) {
    loopState = loopPlayer ? 'PLAYING' : 'IDLE'
    return false
  }

  if (loopPlayer) {
    try { loopPlayer.stop() } catch {}
    loopPlayer.dispose()
    loopPlayer = null
  }
  if (loopBlobUrl) {
    URL.revokeObjectURL(loopBlobUrl)
    loopBlobUrl = null
  }

  loopBlobUrl = URL.createObjectURL(recording)
  loopPlayer = new Tone.Player({ loop: true, fadeIn: 0.01, fadeOut: 0.02 }).connect(masterBus)
  await loopPlayer.load(loopBlobUrl)
  loopPlayer.start()
  loopState = 'PLAYING'
  return true
}

export async function captureOneBarLoop() {
  if (!audioStarted || !recorder) return false
  if (loopState === 'RECORDING') return false
  if (loopCaptureTimer) {
    clearTimeout(loopCaptureTimer)
    loopCaptureTimer = null
  }

  loopState = 'RECORDING'
  loopCaptureStartMs = Date.now()
  loopCaptureEndMs = loopCaptureStartMs + (60 / currentBpm) * 4 * 1000
  try {
    recorder.start()
  } catch {
    loopState = loopPlayer ? 'PLAYING' : 'IDLE'
    return false
  }
  loopCaptureTimer = setTimeout(() => {
    finalizeLoopCapture().catch(() => {
      loopState = loopPlayer ? 'PLAYING' : 'IDLE'
    })
  }, Math.max(120, loopCaptureEndMs - loopCaptureStartMs))
  return true
}

export async function clearLoop() {
  if (loopCaptureTimer) {
    clearTimeout(loopCaptureTimer)
    loopCaptureTimer = null
  }

  if (loopState === 'RECORDING' && recorder) {
    try { await recorder.stop() } catch {}
  }

  if (loopPlayer) {
    try { loopPlayer.stop() } catch {}
    loopPlayer.dispose()
    loopPlayer = null
  }
  if (loopBlobUrl) {
    URL.revokeObjectURL(loopBlobUrl)
    loopBlobUrl = null
  }
  loopState = 'IDLE'
}

export function getFreqData() {
  if (!analyser) return new Float32Array(8)
  const raw = analyser.getValue()
  const out = new Float32Array(8)
  for (let i = 0; i < 8; i++) {
    out[i] = Math.max(0, Math.min(1, (raw[i] + 100) / 100))
  }
  return out
}
