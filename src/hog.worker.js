// Each worker is its own V8 isolate with its own heap, so allocations stack up
// across workers until the tab's renderer process hits its memory limit.
const MB = 1024 * 1024
const PAGE_WORDS = 1024 // one 4 KiB page, in Uint32 words
const WASM_PAGE = 64 * 1024
const WASM_MAX_PAGES = 65536 // 4 GiB per WebAssembly.Memory
const HEAP_CAP = 1536 * MB // stay under V8's heap limit; heap OOM kills the tab instead of throwing
const REPORT_MS = 250
const RETRY_MS = 2000

let running = false
let maxed = false
let keepHot = true
let baseChunkMB = 64
let chunkMB = 64
let strategies = { buffer: true, wasm: true, heap: false }
let wasmMaxPages = WASM_MAX_PAGES
let rr = 0
let failures = 0
let lastError = null
let lastReport = 0
let lastRetry = 0

const buffers = [] // Uint32Array views over ArrayBuffers
const wasmMems = [] // WebAssembly.Memory instances
const heapArrays = [] // plain JS arrays of doubles
const totals = { buffer: 0, wasm: 0, heap: 0 }

let touchIndex = 0
let touchOffset = 0
let pageSalt = 1

// 1 MiB of random words, copied into every chunk. A unique salt per page then
// defeats both memory compression and page combining.
const seed = new Uint32Array(MB / 4)
let s = (Math.random() * 0xffffffff) >>> 0 || 1
for (let i = 0; i < seed.length; i++) {
  s ^= s << 13
  s ^= s >>> 17
  s ^= s << 5
  seed[i] = s >>> 0
}

function scramble(u32) {
  for (let off = 0; off < u32.length; off += seed.length) {
    const n = Math.min(seed.length, u32.length - off)
    u32.set(n === seed.length ? seed : seed.subarray(0, n), off)
  }
  for (let p = 0; p < u32.length; p += PAGE_WORDS) u32[p] ^= pageSalt++
}

function allocBuffer(bytes) {
  const u32 = new Uint32Array(new ArrayBuffer(bytes))
  scramble(u32)
  buffers.push(u32)
}

function allocWasm(bytes) {
  const pages = bytes / WASM_PAGE
  let mem = wasmMems[wasmMems.length - 1]
  if (!mem || mem.buffer.byteLength / WASM_PAGE + pages > wasmMaxPages) {
    try {
      mem = new WebAssembly.Memory({ initial: 0, maximum: wasmMaxPages })
    } catch (e) {
      // Older engines cap wasm32 memories at 2 GiB.
      if (wasmMaxPages === WASM_MAX_PAGES) wasmMaxPages = WASM_MAX_PAGES / 2
      throw e
    }
    wasmMems.push(mem)
  }
  const before = mem.buffer.byteLength
  mem.grow(pages)
  scramble(new Uint32Array(mem.buffer, before, bytes / 4))
}

function allocHeap(bytes) {
  const n = bytes / 8
  const arr = new Array(n)
  for (let i = 0; i < n; i++) arr[i] = Math.random()
  heapArrays.push(arr)
}

const allocators = { buffer: allocBuffer, wasm: allocWasm, heap: allocHeap }

function nextStrategy(bytes) {
  const names = Object.keys(allocators).filter(
    (k) => strategies[k] && !(k === 'heap' && totals.heap + bytes > HEAP_CAP),
  )
  if (!names.length) return null
  return names[rr++ % names.length]
}

function allocOnce() {
  const bytes = chunkMB * MB
  const kind = nextStrategy(bytes)
  if (!kind) {
    maxed = true
    return
  }
  try {
    allocators[kind](bytes)
    totals[kind] += bytes
    failures = 0
  } catch (e) {
    lastError = `${kind}: ${e && e.message ? e.message : e}`
    failures++
    if (chunkMB > 1) chunkMB = Math.max(1, chunkMB >> 1)
    else if (failures >= 6) maxed = true
  }
}

// Rewrite one word per page so the OS keeps everything resident and dirty
// instead of paging it out or compressing it.
function touchSome(pageBudget) {
  const views = buffers.length + wasmMems.length
  if (!views) return
  while (pageBudget > 0) {
    if (touchIndex >= views) touchIndex = 0
    const u32 =
      touchIndex < buffers.length
        ? buffers[touchIndex]
        : new Uint32Array(wasmMems[touchIndex - buffers.length].buffer)
    for (; touchOffset < u32.length && pageBudget > 0; touchOffset += PAGE_WORDS, pageBudget--) {
      u32[touchOffset] ^= 0x9e3779b9
    }
    if (touchOffset >= u32.length) {
      touchOffset = 0
      touchIndex++
    }
  }
}

function report(force) {
  const now = performance.now()
  if (!force && now - lastReport < REPORT_MS) return
  lastReport = now
  postMessage({
    type: 'stats',
    allocated: totals.buffer + totals.wasm + totals.heap,
    totals: { ...totals },
    chunkMB,
    maxed,
    running,
    lastError,
  })
}

function step() {
  if (!running) return
  const now = performance.now()
  if (maxed && now - lastRetry > RETRY_MS) {
    // Something else may have freed memory; try to grab it.
    lastRetry = now
    maxed = false
    failures = 0
    chunkMB = Math.min(16, baseChunkMB)
  }
  if (!maxed) allocOnce()
  if (keepHot) touchSome(maxed ? 65536 : 8192)
  report(false)
  setTimeout(step, maxed ? 20 : 0)
}

onmessage = ({ data }) => {
  if (data.cmd === 'start') {
    baseChunkMB = chunkMB = data.chunkMB
    strategies = data.strategies
    keepHot = data.keepHot
    maxed = false
    failures = 0
    if (!running) {
      running = true
      step()
    }
  } else if (data.cmd === 'stop') {
    running = false
    report(true)
  } else if (data.cmd === 'config') {
    keepHot = data.keepHot
    strategies = data.strategies
  }
}
