import { useEffect, useRef, useState } from 'react'
import './App.css'

type FilterKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch'

type Status = 'idle' | 'running' | 'error'

const defaults = {
  filterType: 'lowpass' as FilterKind,
  cutoff: 1200,
  q: 1,
  filterGain: 0,
  outputGain: 1,
}

const filters: { label: string; value: FilterKind; helper: string }[] = [
  { label: 'Low-pass', value: 'lowpass', helper: 'Suaviza agudos e deixa o som mais encorpado.' },
  { label: 'High-pass', value: 'highpass', helper: 'Remove graves e corta ruídos de ar/vento.' },
  { label: 'Band-pass', value: 'bandpass', helper: 'Isola uma faixa, útil para voz em chamada.' },
  { label: 'Notch', value: 'notch', helper: 'Corta uma banda estreita (zumbido de rede, chiados).' },
]

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [statusMsg, setStatusMsg] = useState('Pronto para iniciar a captura do microfone.')
  const [filterType, setFilterType] = useState<FilterKind>(defaults.filterType)
  const [cutoff, setCutoff] = useState(defaults.cutoff)
  const [q, setQ] = useState(defaults.q)
  const [filterGain, setFilterGain] = useState(defaults.filterGain)
  const [outputGain, setOutputGain] = useState(defaults.outputGain)

  const audioCtx = useRef<AudioContext | null>(null)
  const filterNode = useRef<BiquadFilterNode | null>(null)
  const gainNode = useRef<GainNode | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const micStream = useRef<MediaStream | null>(null)
  const rafId = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const stopAudio = () => {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }

    if (micStream.current) {
      micStream.current.getTracks().forEach((track) => track.stop())
      micStream.current = null
    }

    analyser.current?.disconnect()
    gainNode.current?.disconnect()
    filterNode.current?.disconnect()

    if (audioCtx.current) {
      audioCtx.current.close()
      audioCtx.current = null
    }

    setStatus('idle')
    setStatusMsg('Captura interrompida. Clique em "Iniciar" para reativar.')
  }

  useEffect(() => {
    return () => {
      stopAudio()
    }
  }, [])

  useEffect(() => {
    if (!filterNode.current) return
    filterNode.current.type = filterType
    filterNode.current.frequency.value = cutoff
    filterNode.current.Q.value = q
    filterNode.current.gain.value = filterGain
  }, [filterType, cutoff, q, filterGain])

  useEffect(() => {
    if (gainNode.current) {
      gainNode.current.gain.value = outputGain
    }
  }, [outputGain])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = width * dpr
      canvas.height = height * dpr
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const drawSpectrum = () => {
    const canvas = canvasRef.current
    const analyserNode = analyser.current
    if (!canvas || !analyserNode) return

    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    const dpr = window.devicePixelRatio || 1
    const { width, height } = canvas
    const bufferLength = analyserNode.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    analyserNode.getByteFrequencyData(dataArray)

    ctx2d.clearRect(0, 0, width, height)
    ctx2d.fillStyle = '#070d1a'
    ctx2d.fillRect(0, 0, width, height)

    ctx2d.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx2d.lineWidth = 1 * dpr
    for (let i = 0; i <= 6; i++) {
      const y = (i / 6) * height
      ctx2d.beginPath()
      ctx2d.moveTo(0, y)
      ctx2d.lineTo(width, y)
      ctx2d.stroke()
    }

    const bars = 140
    const step = Math.max(1, Math.floor(bufferLength / bars))
    const barWidth = width / bars

    for (let i = 0; i < bars; i++) {
      const value = dataArray[i * step] / 255
      const barHeight = value * height
      const x = i * barWidth
      const y = height - barHeight

      const gradient = ctx2d.createLinearGradient(0, y, 0, height)
      gradient.addColorStop(0, '#6df1cb')
      gradient.addColorStop(1, '#4da5ff')
      ctx2d.fillStyle = gradient
      ctx2d.fillRect(x + 2 * dpr, y, barWidth - 4 * dpr, barHeight)
    }

    ctx2d.fillStyle = 'rgba(255,255,255,0.6)'
    ctx2d.font = `${12 * dpr}px 'Space Grotesk', system-ui`
    ctx2d.fillText('FFT (freq ->)', 12 * dpr, 20 * dpr)

    rafId.current = requestAnimationFrame(drawSpectrum)
  }

  const startAudio = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error')
        setStatusMsg('Captura não suportada neste navegador.')
        return
      }

      stopAudio()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()
      const analyserNode = ctx.createAnalyser()

      filter.type = filterType
      filter.frequency.value = cutoff
      filter.Q.value = q
      filter.gain.value = filterGain

      gain.gain.value = outputGain

      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.7

      src.connect(filter)
      filter.connect(gain)
      gain.connect(analyserNode)
      analyserNode.connect(ctx.destination)

      audioCtx.current = ctx
      filterNode.current = filter
      gainNode.current = gain
      analyser.current = analyserNode
      micStream.current = stream

      setStatus('running')
      setStatusMsg('Capturando e filtrando áudio em tempo real.')

      drawSpectrum()
    } catch (err) {
      console.error(err)
      setStatus('error')
      setStatusMsg('Erro ao acessar microfone. Permita o uso do microfone e tente novamente.')
    }
  }

  const renderStatus = () => {
    const variants: Record<Status, string> = {
      idle: 'status idle',
      running: 'status running',
      error: 'status error',
    }

    return <span className={variants[status]}>{status.toUpperCase()}</span>
  }

  const resetControls = () => {
    setFilterType(defaults.filterType)
    setCutoff(defaults.cutoff)
    setQ(defaults.q)
    setFilterGain(defaults.filterGain)
    setOutputGain(defaults.outputGain)
  }

  const running = status === 'running'

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-left">
          <p className="eyebrow">Browser Audio Lab</p>
          <h1>Filtragem de áudio em tempo real</h1>
          <p className="lede">
            Clique em iniciar, permita o microfone e ajuste os filtros enquanto ouve o retorno. Use
            fones para evitar microfonia.
          </p>
          <div className="actions">
            <button className="primary" onClick={running ? stopAudio : startAudio}>
              {running ? 'Parar captura' : 'Iniciar captura'}
            </button>
            <button className="ghost" onClick={resetControls} disabled={running}>
              Restaurar padrões
            </button>
          </div>
          <div className="inline-help">
            <span>1. Inicie e autorize o microfone.</span>
            <span>2. Escolha o tipo de filtro e mova os sliders.</span>
            <span>3. Ajuste o volume de saída e observe o gráfico FFT.</span>
          </div>
        </div>
        <div className="status-card card">
          <div className="status-row">
            {renderStatus()}
            <span className="status-msg">{statusMsg}</span>
          </div>
          <div className="mini-grid">
            <div>
              <p className="pill-label">Filtro ativo</p>
              <p className="pill-value">{filters.find((f) => f.value === filterType)?.label}</p>
            </div>
            <div>
              <p className="pill-label">Cutoff</p>
              <p className="pill-value">{cutoff.toFixed(0)} Hz</p>
            </div>
            <div>
              <p className="pill-label">Q</p>
              <p className="pill-value">{q.toFixed(2)}</p>
            </div>
            <div>
              <p className="pill-label">Ganho</p>
              <p className="pill-value">{filterGain.toFixed(1)} dB</p>
            </div>
            <div>
              <p className="pill-label">Saída</p>
              <p className="pill-value">{(outputGain * 100).toFixed(0)}%</p>
            </div>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card controls">
          <div className="section-header">
            <div>
              <p className="eyebrow">Biquad Filters</p>
              <h2>Parâmetros do filtro</h2>
            </div>
            <span className="micro-hint">Dica: clique e arraste devagar para ouvir a mudança.</span>
          </div>
          <div className="filter-types">
            {filters.map((option) => (
              <button
                key={option.value}
                className={`chip ${filterType === option.value ? 'active' : ''}`}
                onClick={() => setFilterType(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.helper}</small>
              </button>
            ))}
          </div>

          <div className="sliders">
            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Cutoff</p>
                  <p className="hint">20 Hz — 20 kHz</p>
                </div>
                <span className="value">{cutoff.toFixed(0)} Hz</span>
              </div>
              <input
                type="range"
                min={20}
                max={20000}
                step={10}
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
              />
              <div className="rail-labels">
                <span>Mais grave</span>
                <span>Mais agudo</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Q (resonância)</p>
                  <p className="hint">0.1 — 20</p>
                </div>
                <span className="value">{q.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={20}
                step={0.05}
                value={q}
                onChange={(e) => setQ(Number(e.target.value))}
              />
              <div className="rail-labels">
                <span>Mais suave</span>
                <span>Mais estreito</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Ganho do filtro</p>
                  <p className="hint">-30 dB — +30 dB</p>
                </div>
                <span className="value">{filterGain.toFixed(1)} dB</span>
              </div>
              <input
                type="range"
                min={-30}
                max={30}
                step={0.5}
                value={filterGain}
                onChange={(e) => setFilterGain(Number(e.target.value))}
              />
              <div className="rail-labels">
                <span>Corta</span>
                <span>Realça</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Volume de saída</p>
                  <p className="hint">0 — 200%</p>
                </div>
                <span className="value">{(outputGain * 100).toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={outputGain}
                onChange={(e) => setOutputGain(Number(e.target.value))}
              />
              <div className="rail-labels">
                <span>Mais baixo</span>
                <span>Mais alto</span>
              </div>
            </div>
          </div>
        </section>

        <section className="card spectrum">
          <div className="section-header">
            <div>
              <p className="eyebrow">FFT</p>
              <h2>Espectro em tempo real</h2>
            </div>
            <span className="badge">2048-point FFT</span>
          </div>
          <div className="canvas-wrap">
            <canvas ref={canvasRef} className="visualizer" />
          </div>
          <p className="footnote">
            O gráfico mostra a intensidade das frequências. Se nada aparecer, confirme se a captura
            está ativa e se o microfone está liberado.
          </p>
        </section>

        <section className="card guide">
          <div className="section-header">
            <div>
              <p className="eyebrow">Dicas rápidas</p>
              <h2>Como obter um som melhor</h2>
            </div>
          </div>
          <ul className="step-list">
            <li>Use fones para evitar feedback entre microfone e caixas.</li>
            <li>Para remover zumbido de rede, experimente o filtro Notch perto de 50/60 Hz.</li>
            <li>Para voz clara, teste High-pass (corte 80-120 Hz) e ajuste Q para não soar fino.</li>
            <li>Volume de saída perto de 100% evita distorção; use mais ganho apenas se necessário.</li>
          </ul>
        </section>
      </main>
    </div>
  )
}

export default App
