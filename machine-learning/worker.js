//worker.js
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest');

const MODEL_PATH = 'model/model.json'
const LABELS_PATH = 'model/labels.json'
const INPUT_MODEL_DIMENTIONS = 640
const CLASS_THRESHOLD = 0.4

let _labels = []
let _model = null
async function loadModelAndLabels() {
  await tf.ready()
  console.log('[perf] backend do tfjs:', tf.getBackend())

  _labels = await (await fetch(LABELS_PATH)).json()
  _model = await tf.loadGraphModel(MODEL_PATH)

  //warmup
  const dummyInput = tf.ones(_model.inputs[0].shape)
  // execute() basta: o modelo não tem fluxo de controle (o tfjs avisava a cada frame)
  _model.execute(dummyInput).dispose()
  tf.dispose(dummyInput)

  postMessage({type: 'model-loaded'})
}

// o canvas do jogo é transparente e fromPixels descarta o alfa (vira fundo preto),
// mas o dataset de treino tem fundo branco
function flattenOnWhite(bitmap){
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0)
  return canvas
}

function preprocessImage(input){
  return tf.tidy(() => {
    const image = tf.browser.fromPixels(flattenOnWhite(input))

    return tf.image
      .resizeBilinear(image, [INPUT_MODEL_DIMENTIONS, INPUT_MODEL_DIMENTIONS])
      .div(255)
      .expandDims(0)
  })  
}

const IOU_THRESHOLD = 0.5
const MAX_DETECTIONS = 10
async function logTensorDebug(predictions) {
  const all = await predictions.array()   // [8400][7], leitura única da GPU

  const top = all
    .map((r, i) => ({ i, score: Math.max(r[4], r[5], r[6]), r }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  console.log('===== PAUSE DEBUG =====')
  console.log('tensor [candidatos, 7]:', predictions.shape)
  console.table(top.map(({ i, r }) => ({
    i,
    cx: +r[0].toFixed(1), cy: +r[1].toFixed(1),
    w: +r[2].toFixed(1),  h: +r[3].toFixed(1),
    ...Object.fromEntries(_labels.map((label, k) => [label, +r[4 + k].toFixed(3)])),
  })))
}

async function postProcessTensor(input, debug = false){
  const predictions = tf.tidy(() => input.squeeze([0]).transpose([1, 0]))
  input.dispose()

  if (debug) await logTensorDebug(predictions)

  const { boxes, scores, classIds } = tf.tidy(() => {
    const boxes = predictions.slice([0, 0], [-1, 4])          // [8400, 4]  cx, cy, w, h
    const classScores = predictions.slice([0, 4], [-1, -1])   // [8400, 3]

    return {
      boxes,
      scores: classScores.max(1),       // [8400]
      classIds: classScores.argMax(1),  // [8400]
    }
  })
  predictions.dispose()

  const corners = tf.tidy(() => {
    const [cx, cy, w, h] = tf.split(boxes, 4, 1)
    const halfW = w.div(2)
    const halfH = h.div(2)

    return tf.concat([
      cx.sub(halfW),   // x1
      cy.sub(halfH),   // y1
      cx.add(halfW),   // x2
      cy.add(halfH),   // y2
    ], 1)                                                      // [8400, 4]
  })
  boxes.dispose()
  
  const keep = await tf.image.nonMaxSuppressionAsync(
    corners, scores, MAX_DETECTIONS, IOU_THRESHOLD, CLASS_THRESHOLD
  )

  const [keepData, cornersData, scoresData, classIdsData] = await Promise.all([
    keep.data(),
    corners.data(),
    scores.data(),
    classIds.data(),
  ])

  tf.dispose([keep, corners, scores, classIds])

  const detections = Array.from(keepData, i => ({
    label: _labels[classIdsData[i]],
    score: scoresData[i],
    box: Array.from(cornersData.slice(i * 4, i * 4 + 4)),   // [x1, y1, x2, y2]
  }))

  if (debug) {
    console.log('detecções finais (caixas em pixels 640x640):')
    console.table(detections.map(d => ({
      label: d.label,
      score: +d.score.toFixed(3),
      box: d.box.map(v => Math.round(v)).join(', '),
    })))
  }

  //if (detections.length) console.log(detections)
  return detections
}

// tempo médio de cada fase, para ver onde está a latência
const PERF_EVERY = 40
const _perf = { n: 0, pre: 0, exec: 0, post: 0 }

function logPerf(pre, exec, post){
  _perf.n++
  _perf.pre += pre
  _perf.exec += exec
  _perf.post += post
  if (_perf.n < PERF_EVERY) return

  const avg = (v) => (v / _perf.n).toFixed(0)
  console.log(
    `[perf] média de ${_perf.n} frames: pré-processamento ${avg(_perf.pre)}ms | ` +
    `modelo ${avg(_perf.exec)}ms | pós (NMS + leitura da GPU) ${avg(_perf.post)}ms`
  )
  Object.assign(_perf, { n: 0, pre: 0, exec: 0, post: 0 })
}

async function runInference(tensor, debug = false, preMs = 0){
  const t0 = performance.now()
  const output = _model.execute(tensor)
  tf.dispose(tensor)
  const t1 = performance.now()

  const detections = await postProcessTensor(output, debug)
  logPerf(preMs, t1 - t0, performance.now() - t1)

  return detections
}

loadModelAndLabels()

// o modelo vê a imagem esticada em 640x640; volta as caixas para pixels do canvas (600x150)
function toCanvasSpace(detections, width, height) {
  const sx = width / INPUT_MODEL_DIMENTIONS
  const sy = height / INPUT_MODEL_DIMENTIONS

  return detections.map(({ label, score, box: [x1, y1, x2, y2] }) => ({
    label,
    score,
    box: [x1 * sx, y1 * sy, x2 * sx, y2 * sy],
  }))
}

// descarta frames novos enquanto há inferência em andamento, em vez de enfileirar
let _busy = false

self.onmessage = async({data}) => {
  if (data.type !== 'predict') return

  const { image, timestamp, debug } = data

  // o ImageBitmap precisa de close() em todos os caminhos, senão vaza memória
  if (!_model || _busy) {
    image.close()
    return
  }

  _busy = true
  try {
    const { width, height } = image
    const t0 = performance.now()
    const input = preprocessImage(image)
    image.close()

    const detections = await runInference(input, debug, performance.now() - t0)

    postMessage({
      type: 'detections',
      detections: toCanvasSpace(detections, width, height),
      timestamp,
      debug,
    })
  } catch (error) {
    console.error('Falha na inferência:', error)
    postMessage({ type: 'error', timestamp, debug })
  } finally {
    _busy = false
  }
}

console.log('YOLOv8 Web Woker initialized')
