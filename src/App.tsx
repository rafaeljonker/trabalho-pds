import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type FilterKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch'

type Status = 'idle' | 'running' | 'error'
type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

type Preset = {
  id: string
  label: string
  description: string
  settings: {
    filterType: FilterKind
    cutoff: number
    q: number
    filterGain: number
    outputGain?: number
  }
}

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

const presets: Preset[] = [
  {
    id: 'voice-clear',
    label: 'Voz clara',
    description: 'Corta graves leves e deixa voz mais inteligível.',
    settings: { filterType: 'highpass', cutoff: 110, q: 0.9, filterGain: 0 },
  },
  {
    id: 'remove-hum',
    label: 'Remover zumbido',
    description: 'Notch estreito perto de 60 Hz (rede elétrica).',
    settings: { filterType: 'notch', cutoff: 60, q: 12, filterGain: -12 },
  },
  {
    id: 'background-soft',
    label: 'Suavizar fundo',
    description: 'Low-pass suave reduzindo chiados de alta frequência.',
    settings: { filterType: 'lowpass', cutoff: 4500, q: 0.7, filterGain: 0 },
  },
  {
    id: 'walkie',
    label: 'Modo rádio',
    description: 'Band-pass médio para efeito de walkie-talkie.',
    settings: { filterType: 'bandpass', cutoff: 1500, q: 3.2, filterGain: 3, outputGain: 1.1 },
  },
]

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [statusMsg, setStatusMsg] = useState('Pronto para iniciar a captura do microfone.')
  const [filterType, setFilterType] = useState<FilterKind>(defaults.filterType)
  const [cutoff, setCutoff] = useState(defaults.cutoff)
  const [q, setQ] = useState(defaults.q)
  const [filterGain, setFilterGain] = useState(defaults.filterGain)
  const [outputGain, setOutputGain] = useState(defaults.outputGain)
  const [bypass, setBypass] = useState(false)
  const [showVirtualModal, setShowVirtualModal] = useState(false)
  const sinkName = 'VirtualMicPDS'
  const inputDeviceName = 'default'
  const outputDeviceName = sinkName
  const [deviceStatus, setDeviceStatus] = useState('')
  const [wizardStep, setWizardStep] = useState(0)
  const [copyHint, setCopyHint] = useState('')
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected')
  const helperDownloadUrl = `${import.meta.env.BASE_URL}audio-helper.zip`

  const audioCtx = useRef<AudioContext | null>(null)
  const sourceNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const filterNode = useRef<BiquadFilterNode | null>(null)
  const gainNode = useRef<GainNode | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const micStream = useRef<MediaStream | null>(null)
  const rafId = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)

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
    sourceNode.current?.disconnect()

    if (audioCtx.current) {
      audioCtx.current.close()
      audioCtx.current = null
    }

    setStatus('idle')
    setStatusMsg('Captura interrompida. Clique em "Iniciar" para reativar.')
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyHint('Copiado!')
      window.setTimeout(() => setCopyHint(''), 1200)
    } catch (err) {
      console.error('Falha ao copiar', err)
      setCopyHint('Falha ao copiar')
      window.setTimeout(() => setCopyHint(''), 1200)
    }
  }

  const wireGraph = useCallback(() => {
    if (!audioCtx.current || !sourceNode.current || !gainNode.current || !analyser.current) return

    sourceNode.current.disconnect()
    filterNode.current?.disconnect()
    gainNode.current.disconnect()
    analyser.current.disconnect()

    if (bypass || !filterNode.current) {
      sourceNode.current.connect(gainNode.current)
    } else {
      sourceNode.current.connect(filterNode.current)
      filterNode.current.connect(gainNode.current)
    }

    gainNode.current.connect(analyser.current)
    analyser.current.connect(audioCtx.current.destination)
  }, [bypass])

  useEffect(() => {
    return () => {
      stopAudio()
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current)
      }
      wsRef.current?.close()
    }
  }, [])

  useEffect(() => {
    if (!filterNode.current) return
    filterNode.current.type = filterType
    filterNode.current.frequency.value = cutoff
    filterNode.current.Q.value = q
    filterNode.current.gain.value = filterGain
    wireGraph()
  }, [filterType, cutoff, q, filterGain, wireGraph])

  useEffect(() => {
    if (gainNode.current) {
      gainNode.current.gain.value = outputGain
    }
  }, [outputGain])
  useEffect(() => {
    wireGraph()
  }, [bypass, wireGraph])

  useEffect(() => {
    let closed = false

    const connect = () => {
      if (closed) return
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      setWsStatus('connecting')

      try {
        const ws = new WebSocket('ws://localhost:8765')
        wsRef.current = ws

        ws.onopen = () => {
          if (closed) return
          setWsStatus('connected')
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.action === 'setDevices') {
              if (data.ok) {
                setDeviceStatus(
                  `Aplicado: input=${data.device?.input ?? ''} / output=${data.device?.output ?? ''}`
                )
              } else {
                setDeviceStatus(`Erro ao aplicar devices: ${data.error}`)
              }
              return
            }
          } catch (err) {
            console.error('Falha ao ler mensagem do backend', err)
          }
        }

        ws.onclose = () => {
          if (closed) return
          setWsStatus('disconnected')
          if (reconnectTimer.current) {
            window.clearTimeout(reconnectTimer.current)
          }
          reconnectTimer.current = window.setTimeout(connect, 2000)
        }

        ws.onerror = () => {
          if (closed) return
          setWsStatus('error')
          ws.close()
        }
      } catch (err) {
        console.error('Erro ao abrir WebSocket', err)
        setWsStatus('error')
        if (reconnectTimer.current) {
          window.clearTimeout(reconnectTimer.current)
        }
        reconnectTimer.current = window.setTimeout(connect, 2000)
      }
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      wsRef.current?.close()
    }
  }, [])

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

  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    const payload = JSON.stringify({
      filterType,
      cutoff,
      q,
      filterGain,
      outputGain,
      bypass,
    })

    const timeoutId = window.setTimeout(() => {
      try {
        wsRef.current?.send(payload)
      } catch (err) {
        console.error('Falha ao enviar parâmetros para o backend', err)
      }
    }, 120)

    return () => window.clearTimeout(timeoutId)
  }, [filterType, cutoff, q, filterGain, outputGain, bypass, wsStatus])

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

      audioCtx.current = ctx
      sourceNode.current = src
      filterNode.current = filter
      gainNode.current = gain
      analyser.current = analyserNode
      micStream.current = stream

      wireGraph()

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

  const renderBackendStatus = () => {
    const labels: Record<WsStatus, string> = {
      connected: 'Backend conectado',
      connecting: 'Conectando ao backend...',
      disconnected: 'Aguardando backend (ws://localhost:8765)',
      error: 'Erro na conexão com backend',
    }

    return <span className={`pill-value ws-${wsStatus}`}>{labels[wsStatus]}</span>
  }

  const applyPreset = (preset: Preset) => {
    setFilterType(preset.settings.filterType)
    setCutoff(preset.settings.cutoff)
    setQ(preset.settings.q)
    setFilterGain(preset.settings.filterGain)
    if (preset.settings.outputGain !== undefined) {
      setOutputGain(preset.settings.outputGain)
    }
  }

  const resetControls = () => {
    setFilterType(defaults.filterType)
    setCutoff(defaults.cutoff)
    setQ(defaults.q)
    setFilterGain(defaults.filterGain)
    setOutputGain(defaults.outputGain)
    setBypass(false)
  }

  const running = status === 'running'
  const linuxCreateCmd = `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}`
  const helperOnline = wsStatus === 'connected'

  const nextStep = () => setWizardStep((s) => Math.min(s + 1, 2))
  const prevStep = () => setWizardStep((s) => Math.max(s - 1, 0))

  const finishWizard = () => {
    sendDeviceSelection()
    setShowVirtualModal(false)
    setWizardStep(0)
  }

  const sendDeviceSelection = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setDeviceStatus('Backend offline ou desconectado.')
      return
    }
    const payload = {
      action: 'setDevices',
      input: inputDeviceName || null,
      output: outputDeviceName || null,
    }
    try {
      wsRef.current.send(JSON.stringify(payload))
      setDeviceStatus('Enviando devices ao backend...')
    } catch (err) {
      console.error('Falha ao enviar devices', err)
      setDeviceStatus('Erro ao enviar devices')
    }
  }

  return (
    <div className="page">
      {(wsStatus === 'disconnected' || wsStatus === 'error') && (
        <div className="alert">
          <div>
            <p className="alert-title">Helper local não encontrado</p>
            <p className="alert-text">
              Abra o helper/binário que acompanha o projeto para que o site controle seu áudio.
              Depois recarregue ou aguarde reconexão automática.
            </p>
          </div>
          <button className="ghost" onClick={() => setShowVirtualModal(true)}>
            Ver guia rápido
          </button>
        </div>
      )}

      <header className="hero">
        <div className="hero-left">
          <p className="eyebrow">Browser Audio Lab</p>
          <h1>Filtragem de áudio em tempo real</h1>
          <p className="lede">
            Conecte ao helper local (ws://localhost:8765), ajuste filtros no site e envie o som
            filtrado para seu microfone virtual. Use fones para evitar microfonia.
          </p>
          <div className="actions">
            <button className="primary" onClick={running ? stopAudio : startAudio}>
              {running ? 'Parar captura' : 'Iniciar captura'}
            </button>
            <button className="ghost" onClick={resetControls} disabled={running}>
              Restaurar padrões
            </button>
            <button className="ghost" onClick={() => setShowVirtualModal(true)}>
              Guia: microfone virtual
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
              <p className="pill-label">Backend Python</p>
              {renderBackendStatus()}
            </div>
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
          <div className="preset-block">
            <div className="preset-header">
              <h3>Presets rápidos</h3>
              <p className="preset-hint">Escolha um atalho e ajuste fino pelos sliders.</p>
            </div>
            <div className="preset-grid">
              {presets.map((preset) => (
                <button key={preset.id} className="preset-card" onClick={() => applyPreset(preset)}>
                  <div className="preset-top">
                    <span className="preset-name">{preset.label}</span>
                  </div>
                  <p className="preset-desc">{preset.description}</p>
                </button>
              ))}
            </div>
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

          <div className="bypass-row">
            <label className="toggle">
              <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
              <span className="checkmark" />
              <div>
                <p className="label">Ouvir voz original (bypass)</p>
                <p className="hint">Ignora o filtro e envia o áudio cru para a saída.</p>
              </div>
            </label>
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

      {showVirtualModal && (
        <div className="modal-backdrop" onClick={() => setShowVirtualModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Virtual Mic</p>
                <h2>Passo a passo</h2>
                <p className="muted">
                  Siga as etapas para baixar o helper, criar o microfone virtual e conectar. Ao
                  concluir, aplicamos os devices no backend local.
                </p>
              </div>
              <button className="ghost close" onClick={() => setShowVirtualModal(false)}>
                Fechar
              </button>
            </div>

            <div className="wizard-steps">
              <button className={`step-btn ${wizardStep === 0 ? 'active' : ''}`} onClick={() => setWizardStep(0)}>
                1. Baixar helper
              </button>
              <button className={`step-btn ${wizardStep === 1 ? 'active' : ''}`} onClick={() => setWizardStep(1)}>
                2. Criar mic virtual
              </button>
              <button className={`step-btn ${wizardStep === 2 ? 'active' : ''}`} onClick={() => setWizardStep(2)}>
                3. Finalizar
              </button>
            </div>

            {wizardStep === 0 && (
              <div className="modal-section">
                <h3>Baixe e abra o helper local</h3>
                <p className="muted">
                  O helper é quem captura seu microfone e envia para o mic virtual. Baixe e execute antes de usar o
                  site.
                </p>
                <a className="primary link-btn" href={helperDownloadUrl} download>
                  Baixar helper
                </a>
                <small className="muted">
                  O download vem do arquivo público audio-helper.zip; ajuste o link se hospedar em outro lugar.
                </small>
                <div className="muted" style={{ marginTop: '12px' }}>
                  <p style={{ marginBottom: 6 }}>Como executar (Linux):</p>
                  <pre className="code-block" style={{ marginBottom: 8 }}>
                    unzip audio-helper.zip{'\n'}
                    chmod +x audio-helper{'\n'}
                    ./audio-helper
                  </pre>
                  <p style={{ marginBottom: 6 }}>
                    Deixe o terminal aberto; o site reconecta automaticamente. Em Windows/macOS (se empacotar para
                    essas plataformas), apenas abra o binário correspondente.
                  </p>
                </div>
              </div>
            )}

            {wizardStep === 1 && (
              <div className="modal-grid">
                <div className="modal-section">
                  <h3>Linux (PulseAudio/PipeWire)</h3>
                  <p className="muted">Criar sink virtual</p>
                  <pre className="code-block">{linuxCreateCmd}</pre>
                  <button className="ghost" onClick={() => copyToClipboard(linuxCreateCmd)}>
                    Copiar comando
                  </button>
                </div>
                <div className="modal-section">
                  <h3>Windows</h3>
                  <ul className="muted">
                    <li>Instale VB-CABLE (ou Voicemeeter).</li>
                    <li>O dispositivo aparece como &quot;CABLE Input&quot;/&quot;CABLE Output&quot;.</li>
                    <li>No Discord/Meet, selecione &quot;CABLE Output&quot; como microfone.</li>
                  </ul>
                </div>
                <div className="modal-section">
                  <h3>macOS</h3>
                  <ul className="muted">
                    <li>Instale BlackHole (2ch).</li>
                    <li>Use &quot;BlackHole 2ch&quot; como saída do helper.</li>
                    <li>Nos apps, escolha &quot;BlackHole 2ch&quot; como microfone.</li>
                  </ul>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="modal-section">
                <h3>Finalizar e aplicar</h3>
                <p className="muted">
                  Vamos aplicar o padrão: input=<strong>default</strong> / output=<strong>{sinkName}</strong>. Depois
                  feche o modal, ajuste os filtros e selecione o mic virtual no Discord/Meet.
                </p>
                <p className="muted">
                  Se precisar escolher dispositivos específicos, edite o backend ou personalize o código.
                </p>
                <p className="muted">
                  Input: <strong>{inputDeviceName || 'default'}</strong> / Output:{' '}
                  <strong>{outputDeviceName || sinkName}</strong>
                </p>
                <button className="primary" onClick={finishWizard} disabled={!helperOnline}>
                  Concluir e aplicar
                </button>
                {!helperOnline && <small className="muted">Helper não conectado. Abra o helper e tente de novo.</small>}
                {deviceStatus && <p className="muted">Status: {deviceStatus}</p>}
              </div>
            )}

            <div className="wizard-actions">
              <button className="ghost" onClick={prevStep} disabled={wizardStep === 0}>
                Voltar
              </button>
              {wizardStep < 2 ? (
                <button className="primary" onClick={nextStep}>
                  Próximo
                </button>
              ) : (
                <button className="ghost" onClick={() => setShowVirtualModal(false)}>
                  Fechar
                </button>
              )}
            </div>

            {copyHint && <p className="copy-hint">{copyHint}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
