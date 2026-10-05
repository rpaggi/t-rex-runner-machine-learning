// Teclas: P pausa (dump do tensor) | B liga/desliga o bot | R reseta o aprendizado | O liga/desliga o overlay

const GAME_FPS = 60

// antecedência do pulo, em segundos (o bot ajusta sozinho depois de cada batida)
const JUMP_LEAD_SECONDS = 0.3
const DUCK_LEAD_SECONDS = 0.5
// não pula para obstáculo que o dino já passou
const JUMP_LATE_LIMIT_PX = 10
const MAX_DETECTION_AGE_SECONDS = 0.8
// cactos mais próximos que isso viram um obstáculo só
const GROUP_GAP_PX = 30
const MIN_OBSTACLE_SCORE = 0.5

const MIN_FRAME_INTERVAL_MS = 50
const IDLE_FRAME_DELAY_MS = 150
const WATCHDOG_MS = 5000
const RESTART_DELAY_MS = 800

const LABEL_COLORS = { cacto: '#e53935', dino: '#1e88e5', ptero: '#43a047' }

// Aprendizado: a cada batida ajusta o lead conforme o dino estava subindo ou descendo.
// Não usei evolução por pontuação porque ela é muito ruidosa (obstáculos aleatórios).
const LEARNING = {
  storageKey: 'trex-bot-tuning-v1',
  minLead: 0.15,
  maxLead: 0.6,
  initialStep: 0.03,
  minStep: 0.005,
  stepDecay: 0.96,
}

const tuning = { jumpLead: JUMP_LEAD_SECONDS, step: LEARNING.initialStep, adjustments: 0 }

try {
  const saved = JSON.parse(localStorage.getItem(LEARNING.storageKey))
  if (saved) Object.assign(tuning, saved)
} catch { /* começa do padrão */ }

const saveTuning = () => {
  try { localStorage.setItem(LEARNING.storageKey, JSON.stringify(tuning)) } catch { /* ignora */ }
}

// subindo na batida = pulou tarde, descendo = pulou cedo.
// Sem pulo é falha de percepção/latência, então não ajusta.
function classifyCrash(tRex) {
  if (tRex.ducking) return { kind: 'abaixado', delta: 0 }
  if (!tRex.jumping) return { kind: 'sem-pulo', delta: 0 }
  return tRex.jumpVelocity < 0
    ? { kind: 'pulou-tarde', delta: +1 }
    : { kind: 'pulou-cedo', delta: -1 }
}

function learnFromCrash(tRex) {
  const { kind, delta } = classifyCrash(tRex)
  const before = tuning.jumpLead

  if (delta !== 0) {
    tuning.jumpLead = Math.min(LEARNING.maxLead, Math.max(LEARNING.minLead, before + delta * tuning.step))
    tuning.step = Math.max(LEARNING.minStep, tuning.step * LEARNING.stepDecay)
    tuning.adjustments += 1
    saveTuning()
  }
  console.log(`Aprendizado: ${kind} -> lead ${before.toFixed(3)}s -> ${tuning.jumpLead.toFixed(3)}s (passo ${tuning.step.toFixed(3)}, ${tuning.adjustments} ajustes)`)
}

// Overlay em canvas separado, senão as caixas entram no frame seguinte e atrapalham o modelo.
// Criado só no primeiro draw porque o jogo monta o canvas depois do main().
function createOverlay(game) {
  let canvas = null
  let ctx = null

  const ensureCanvas = () => {
    if (canvas) return true
    if (!game.containerEl || !game.canvas) return false

    canvas = document.createElement('canvas')
    canvas.width = game.canvas.width
    canvas.height = game.canvas.height
    Object.assign(canvas.style, {
      position: 'absolute', top: '0', left: '0', pointerEvents: 'none',
    })
    game.containerEl.appendChild(canvas)
    ctx = canvas.getContext('2d')
    return true
  }

  return function draw(detections, hud) {
    if (!ensureCanvas()) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = '10px monospace'
    ctx.textBaseline = 'bottom'

    for (const { label, score, box: [x1, y1, x2, y2] } of detections) {
      ctx.strokeStyle = ctx.fillStyle = LABEL_COLORS[label] ?? '#000'
      ctx.lineWidth = 1
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
      ctx.fillText(`${label} ${score.toFixed(2)}`, x1, y1 < 12 ? y1 + 12 : y1)
    }

    ctx.fillStyle = '#000'
    ctx.textBaseline = 'top'
    ctx.fillText(hud, 4, 4)
  }
}

function findDino(detections) {
  return detections
    .filter((d) => d.label === 'dino')
    .sort((a, b) => b.score - a.score)[0]
}

function groupObstacles(detections, minX) {
  const obstacles = detections
    .filter((d) => d.label !== 'dino' && d.score >= MIN_OBSTACLE_SCORE)
    .map((d) => ({ ...d, x1: d.box[0], y1: d.box[1], x2: d.box[2], y2: d.box[3] }))
    .filter((o) => o.x2 > minX)
    .sort((a, b) => a.x1 - b.x1)

  const groups = []
  for (const o of obstacles) {
    const last = groups[groups.length - 1]
    if (last && o.x1 - last.x2 <= GROUP_GAP_PX) {
      last.x2 = Math.max(last.x2, o.x2)
      last.y1 = Math.min(last.y1, o.y1)
      last.y2 = Math.max(last.y2, o.y2)
      last.isPtero ||= o.label === 'ptero'
    } else {
      groups.push({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, isPtero: o.label === 'ptero' })
    }
  }
  return groups
}

function shouldJump(distance, pxPerSecond) {
  return distance <= pxPerSecond * tuning.jumpLead && distance > -JUMP_LATE_LIMIT_PX
}

// distance = px do centro do obstáculo até a frente do dino
function decide(game, detections, ageSeconds, pxPerSecond) {
  const tRex = game.tRex

  // se o modelo não achou o dino, usa a posição do próprio jogo
  const dino = findDino(detections)
  const dinoLeft = dino ? dino.box[0] : tRex.xPos
  const dinoRight = dino ? dino.box[2] : tRex.xPos + tRex.config.WIDTH

  // a detecção já está velha: anda os obstáculos o quanto eles andaram desde a captura
  const shift = pxPerSecond * ageSeconds
  const projected = detections.map((d) =>
    d.label === 'dino'
      ? d
      : { ...d, box: [d.box[0] - shift, d.box[1], d.box[2] - shift, d.box[3]] },
  )

  const [next] = groupObstacles(projected, dinoLeft)
  if (!next) return { action: 'run', distance: Infinity, target: null }

  const distance = (next.x1 + next.x2) / 2 - dinoRight

  if (next.isPtero) {
    const standTop = tRex.groundYPos
    const duckTop = standTop + tRex.config.HEIGHT - tRex.config.HEIGHT_DUCK

    // o ptero aparece em 3 alturas, classificadas pela base da caixa:
    // alto passa por cima, médio abaixa, baixo tem que pular
    if (next.y2 <= standTop + 4) return { action: 'run', distance, target: next }

    if (next.y2 <= duckTop) {
      return {
        action: distance <= pxPerSecond * DUCK_LEAD_SECONDS ? 'duck' : 'run',
        distance,
        target: next,
      }
    }

    return {
      action: shouldJump(distance, pxPerSecond) ? 'jump' : 'run',
      distance,
      target: next,
    }
  }

  return {
    action: shouldJump(distance, pxPerSecond) ? 'jump' : 'run',
    distance,
    target: next,
  }
}

function act(game, action) {
  const tRex = game.tRex

  if (action === 'jump') {
    if (tRex.ducking) tRex.setDuck(false)
    if (!tRex.jumping) tRex.startJump(game.currentSpeed)
  } else if (action === 'duck') {
    if (!tRex.jumping && !tRex.ducking) tRex.setDuck(true)
  } else if (tRex.ducking) {
    tRex.setDuck(false)
  }
}

export default async function main(game) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  const drawOverlay = createOverlay(game)

  let modelReady = false
  let botEnabled = true
  let overlayEnabled = true
  let pausedByUser = false

  // última detecção + instante da captura; o controlLoop decide em cima dela a 60fps
  let latest = null
  let restartedAt = 0

  // O jogo move o obstáculo com floor(speed * FPS / 1000 * deltaTime) a cada frame,
  // então a velocidade real depende da taxa do monitor (em taxa alta fica menor que speed*60).
  // Repete a conta do jogo com os deltaTime reais dos últimos frames.
  const frameDeltas = []
  const FRAME_WINDOW = 60
  let lastFrameAt = 0

  const trackFrame = (now) => {
    if (lastFrameAt) {
      frameDeltas.push(now - lastFrameAt)
      if (frameDeltas.length > FRAME_WINDOW) frameDeltas.shift()
    }
    lastFrameAt = now
  }

  const effectivePxPerSecond = () => {
    if (frameDeltas.length < 10) return game.currentSpeed * GAME_FPS

    let pixels = 0
    let time = 0
    for (const dt of frameDeltas) {
      pixels += Math.floor((game.currentSpeed * GAME_FPS / 1000) * dt)
      time += dt
    }
    return (pixels / time) * 1000
  }

  // só manda um frame novo depois que o anterior voltou, para não acumular fila
  let inFlight = false
  let lastSentAt = 0
  let pendingDebug = false

  const isPaused = () => pausedByUser && game.paused && !game.crashed

  const sendFrame = async (debug = false) => {
    inFlight = true
    lastSentAt = performance.now()
    const timestamp = lastSentAt
    const bitmap = await createImageBitmap(game.canvas)
    worker.postMessage({ type: 'predict', image: bitmap, debug, timestamp }, [bitmap])
  }

  const requestNextFrame = () => {
    if (!modelReady || inFlight || isPaused()) return
    if (!game.canvas || !game.tRex) return void setTimeout(requestNextFrame, IDLE_FRAME_DELAY_MS)
    if (!game.playing) return void setTimeout(requestNextFrame, IDLE_FRAME_DELAY_MS)

    const wait = MIN_FRAME_INTERVAL_MS - (performance.now() - lastSentAt)
    if (wait > 0) setTimeout(requestNextFrame, wait)
    else sendFrame()
  }

  let games = 0
  let best = 0
  let restartTimer = null

  // últimas decisões, impressas a cada batida para ver o que deu errado
  const history = []
  const HISTORY_SIZE = 12
  const record = (action, distance, target, latencyMs) => {
    history.push({
      action,
      dist: Number.isFinite(distance) ? Math.round(distance) : null,
      alvo: target ? (target.isPtero ? 'ptero' : 'cacto') : '-',
      alvoY: target ? `${Math.round(target.y1)}-${Math.round(target.y2)}` : '-',
      alvoLarg: target ? Math.round(target.x2 - target.x1) : 0,
      vel: +game.currentSpeed.toFixed(1),
      pulando: game.tRex.jumping,
      abaixado: game.tRex.ducking,
      lat: Math.round(latencyMs),
    })
    if (history.length > HISTORY_SIZE) history.shift()
  }

  const handleGameOver = () => {
    if (restartTimer) return
    const score = game.distanceMeter.getActualDistance(Math.ceil(game.distanceRan))
    games += 1
    best = Math.max(best, score)
    console.log(`Partida ${games}: ${score} pts (recorde ${best})`)
    console.table(history)
    if (botEnabled) learnFromCrash(game.tRex)

    if (!botEnabled) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      restartedAt = performance.now()
      latest = null
      game.restart()
    }, RESTART_DELAY_MS)
  }

  worker.onmessage = ({ data }) => {
    if (data.type === 'model-loaded') {
      modelReady = true
      requestNextFrame()
      return
    }

    if (data.type === 'error') {
      inFlight = false
      requestNextFrame()
      return
    }

    if (data.type !== 'detections') return
    inFlight = false

    const ageSeconds = (performance.now() - data.timestamp) / 1000
    const { action, distance, target } = decide(game, data.detections, ageSeconds, effectivePxPerSecond())
    if (game.playing) record(action, distance, target, ageSeconds * 1000)

    if (overlayEnabled) drawOverlay(
      data.detections,
      `${botEnabled ? 'BOT' : 'manual'} | ${action} | dist ${Number.isFinite(distance) ? Math.round(distance) : '-'}px | lat ${Math.round(ageSeconds * 1000)}ms | lead ${tuning.jumpLead.toFixed(2)}s`,
    )

    if (game.crashed) {
      latest = null
      handleGameOver()
    } else if (game.playing && data.timestamp >= restartedAt) {
      latest = { detections: data.detections, timestamp: data.timestamp }
    }

    if (isPaused()) {
      if (pendingDebug) {
        pendingDebug = false
        sendFrame(true)
      }
      return
    }
    requestNextFrame()
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return

    if (e.code === 'KeyB') {
      botEnabled = !botEnabled
      if (!botEnabled && game.tRex.ducking) game.tRex.setDuck(false)
      console.log(`Bot ${botEnabled ? 'ligado' : 'desligado'}`)
      return
    }

    if (e.code === 'KeyR') {
      Object.assign(tuning, { jumpLead: JUMP_LEAD_SECONDS, step: LEARNING.initialStep, adjustments: 0 })
      saveTuning()
      console.log('Aprendizado resetado')
      return
    }

    if (e.code === 'KeyO') {
      overlayEnabled = !overlayEnabled
      if (!overlayEnabled) drawOverlay([], '')
      console.log(`Overlay ${overlayEnabled ? 'ligado' : 'desligado'}`)
      return
    }

    if (e.code !== 'KeyP') return

    if (isPaused()) {
      game.play()
      requestNextFrame()
    } else if (game.playing && !game.crashed) {
      pausedByUser = true
      game.stop()
      // com inferência em andamento o worker descartaria o frame, então espera ela voltar
      if (inFlight) pendingDebug = true
      else sendFrame(true)
    }
  })

  // a inferência demora ~200ms, então decide a cada frame de tela com a última detecção
  // (decide já projeta a posição dos obstáculos pela idade dela)
  const controlLoop = (now) => {
    requestAnimationFrame(controlLoop)
    trackFrame(now)

    if (!botEnabled || !latest || !game.playing || isPaused() || !game.tRex) return

    const ageSeconds = (performance.now() - latest.timestamp) / 1000
    if (ageSeconds > MAX_DETECTION_AGE_SECONDS) return act(game, 'run')

    act(game, decide(game, latest.detections, ageSeconds, effectivePxPerSecond()).action)
  }
  requestAnimationFrame(controlLoop)

  // destrava o loop se uma resposta do worker se perder
  setInterval(() => {
    if (inFlight && performance.now() - lastSentAt > WATCHDOG_MS) {
      inFlight = false
      requestNextFrame()
    }
  }, WATCHDOG_MS)

  return game.app
}
