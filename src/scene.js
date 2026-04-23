import * as THREE from 'three'

const N        = 3000
const N2       = 600
const SPRING   = 0.08
const DAMPING  = 0.92

export function initScene(container) {
  const W = window.innerWidth
  const H = window.innerHeight

  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(W, H)
  renderer.setPixelRatio(1)
  renderer.setClearColor(0xD1D1D1, 1)
  container.appendChild(renderer.domElement)

  const scene  = new THREE.Scene()
  scene.background = new THREE.Color(0xD1D1D1)
  const camera = new THREE.PerspectiveCamera(75, W / H, 0.1, 100)
  camera.position.z = 5

  // --- Primary particle cloud ---
  const positions  = new Float32Array(N * 3)
  const velocities = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 6
    positions[i * 3 + 1] = (Math.random() - 0.5) * 4
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2
  }
  const geo = new THREE.BufferGeometry()
  const posAttr = new THREE.BufferAttribute(positions, 3)
  posAttr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', posAttr)
  const mat = new THREE.PointsMaterial({ size: 0.06, color: 0x1A1A1A })
  scene.add(new THREE.Points(geo, mat))

  // --- Secondary particle cloud (left hand) ---
  const positions2  = new Float32Array(N2 * 3)
  const velocities2 = new Float32Array(N2 * 3)
  for (let i = 0; i < N2; i++) {
    positions2[i * 3]     = (Math.random() - 0.5) * 4
    positions2[i * 3 + 1] = (Math.random() - 0.5) * 3
    positions2[i * 3 + 2] = (Math.random() - 0.5) * 2
  }
  const geo2 = new THREE.BufferGeometry()
  const posAttr2 = new THREE.BufferAttribute(positions2, 3)
  posAttr2.setUsage(THREE.DynamicDrawUsage)
  geo2.setAttribute('position', posAttr2)
  const mat2 = new THREE.PointsMaterial({ size: 0.05, color: 0x666666, transparent: true, opacity: 0.7 })
  const points2 = new THREE.Points(geo2, mat2)
  scene.add(points2)

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  })

  function tickParticles(pos, vel, count, attractor, pinch, dt) {
    const explodeMag = pinch < 0.08 ? (0.08 - pinch) * 80 : 0
    for (let i = 0; i < count; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2
      const px = pos[ix], py = pos[iy], pz = pos[iz]

      const fx = (attractor.x - px) * SPRING
      const fy = (attractor.y - py) * SPRING
      const fz = (attractor.z - pz) * SPRING

      const dx = px - attractor.x, dy = py - attractor.y, dz = pz - attractor.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001

      vel[ix] = (vel[ix] + fx + (dx / dist) * explodeMag) * DAMPING
      vel[iy] = (vel[iy] + fy + (dy / dist) * explodeMag) * DAMPING
      vel[iz] = (vel[iz] + fz + (dz / dist) * explodeMag) * DAMPING

      pos[ix] += vel[ix] * dt
      pos[iy] += vel[iy] * dt
      pos[iz] += vel[iz] * dt
    }
  }

  // Idle attractor so secondary particles don't freeze at origin when no hand
  const idleAttractor2 = { x: 0, y: 0, z: 0 }

  return function tick({ dt, attractor, pinch, filterNorm = 0, secondAttractor, secondActive }) {
    // Primary particles
    tickParticles(positions, velocities, N, attractor, pinch, dt)
    geo.attributes.position.needsUpdate = true

    // Primary color: interpolate between #1A1A1A (cold) and a warm tint as filter opens
    const h = 0.6 - filterNorm * 0.55  // blue → reddish-orange
    mat.color.setHSL(h, filterNorm * 0.4, 0.1 + filterNorm * 0.1)

    // Secondary particles
    const att2 = secondActive ? secondAttractor : idleAttractor2
    tickParticles(positions2, velocities2, N2, att2, 1, dt)
    geo2.attributes.position.needsUpdate = true
    points2.visible = secondActive

    renderer.render(scene, camera)
  }
}
