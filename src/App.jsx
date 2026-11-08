import { useEffect, useRef } from 'react'
import './App.css'

const WORKERS = navigator.hardwareConcurrency || 8
const CONFIG = { cmd: 'start', chunkMB: 64, strategies: { buffer: true, wasm: true, heap: false }, keepHot: true }

export default function App() {
  const workersRef = useRef([])

  function consume() {
    if (workersRef.current.length) return
    for (let i = 0; i < WORKERS; i++) {
      const w = new Worker(new URL('./hog.worker.js', import.meta.url), { type: 'module' })
      w.postMessage(CONFIG)
      workersRef.current.push(w)
    }
  }

  useEffect(
    () => () => {
      for (const w of workersRef.current) w.terminate()
      workersRef.current = []
    },
    [],
  )

  return (
    <main>
      <button onClick={consume}>consume</button>
    </main>
  )
}
