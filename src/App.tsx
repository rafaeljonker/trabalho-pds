import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

/**
 * AUDIO FILTERING & EQ - PROFESSIONAL REFERENCE
 *
 * FREQUÊNCIAS DE VOZ HUMANA:
 * - Voz masculina fundamental: 85-180 Hz, harmonics 900Hz-8kHz
 * - Voz feminina fundamental: 165-255 Hz, harmonics 3kHz-17kHz
 * - Corpo/Peso: 80-120 Hz
 * - Calor/Warmth: 200-500 Hz
 * - Clareza/Inteligibilidade: 2-4 kHz (MAIS IMPORTANTE)
 * - Presença: 4-6 kHz
 * - Brilho/Air: 6-12 kHz
 * - Sibilância (problema): 5-15 kHz
 *
 * HIGH-PASS FILTER:
 * - Rumble subsônico: 40 Hz
 * - Voz padrão: 80-100 Hz
 * - Diálogo/clareza: 120 Hz
 * - Slope: -12 ou -24 dB/oitava
 *
 * LOW-PASS FILTER:
 * - Podcast: 10-12 kHz
 * - Reduzir chiado: 8-10 kHz
 * - Efeito telefone: 3-4 kHz
 *
 * Q FACTOR:
 * - 0.5-0.7: Muito largo (boost suave/musical)
 * - 1.0-1.4: Normal
 * - 2.0-4.0: Estreito (cortes cirúrgicos)
 * - 8.0-12.0: Muito estreito (notch para zumbido)
 *
 * PROBLEMAS COMUNS:
 * - Muddy/Turvo (300-500 Hz): Cortar -3dB Q=1.2
 * - Boxy/Caixa (400-500 Hz): Cortar -2dB
 * - Nasal (1-4.5 kHz): Cortar -2dB Q estreito
 * - Harsh/Áspero (2.5-4 kHz): Cortar -3dB Q estreito
 * - Sibilância (5-8 kHz): Cortar -4dB Q=4 (de-esser)
 * - Sem presença (4-6 kHz): Boost +2dB
 * - Sem clareza (2-4 kHz): Boost +2dB
 */

type FilterKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch'

type Status = 'idle' | 'running' | 'error'
type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

type Preset = {
  id: string
  label: string
  description: string
  category?: 'voice' | 'fix' | 'effect' // Categoria opcional para organização visual
  settings: {
    filterType: FilterKind
    cutoff: number
    q: number
    filterGain: number
    outputGain?: number
    pitchRatio?: number // 1.0 = normal, >1 = agudo (feminino), <1 = grave (masculino)
  }
}

const defaults = {
  filterType: 'highpass' as FilterKind,
  cutoff: 80, // Hz - Remove rumble subsônico, preserva fundamental masculina (85-180Hz)
  q: 0.7, // Q baixo = slope suave e musical
  filterGain: 0, // dB - Transparente (ajuste com presets ou slider)
  outputGain: 1, // Unity gain (100%)
}

const filters: { label: string; value: FilterKind; helper: string }[] = [
  {
    label: 'Low-pass',
    value: 'lowpass',
    helper: 'Corta agudos acima do cutoff. Remove chiados, sibilância e ruído de alta frequência. Deixa som mais suave e encorpado.'
  },
  {
    label: 'High-pass',
    value: 'highpass',
    helper: 'Corta graves abaixo do cutoff. Remove rumble, ruído de ar/vento e melhora clareza vocal. Use 80-100Hz para voz.'
  },
  {
    label: 'Band-pass',
    value: 'bandpass',
    helper: 'Isola faixa específica entre duas frequências. Útil para efeitos de telefone/rádio (300Hz-3.4kHz).'
  },
  {
    label: 'Notch',
    value: 'notch',
    helper: 'Corta banda estreita específica. Essencial para remover zumbido elétrico 50/60Hz ou frequências problemáticas. Use Q alto (8-12).'
  },
]

const presets: Preset[] = [
  {
    id: 'voice-male',
    label: 'Voz Masculina',
    description: 'Realça graves - Som mais encorpado e profundo.',
    category: 'voice',
    settings: { filterType: 'lowpass', cutoff: 3500, q: 0.8, filterGain: 3, outputGain: 1.1, pitchRatio: 0.92 },
  },
  {
    id: 'voice-female',
    label: 'Voz Feminina',
    description: 'Realça agudos - Som mais brilhante e leve.',
    category: 'voice',
    settings: { filterType: 'highpass', cutoff: 180, q: 0.7, filterGain: 2, outputGain: 1.0, pitchRatio: 1.08 },
  },
  {
    id: 'voice-clear',
    label: 'Voz clara',
    description: 'Corta graves leves e deixa voz mais inteligível.',
    category: 'voice',
    settings: { filterType: 'highpass', cutoff: 110, q: 0.9, filterGain: 0, outputGain: 1.0 },
  },
  {
    id: 'remove-hum',
    label: 'Remover zumbido',
    description: 'Notch estreito perto de 60 Hz (rede elétrica).',
    category: 'fix',
    settings: { filterType: 'notch', cutoff: 60, q: 12, filterGain: -12, outputGain: 1.0 },
  },
  {
    id: 'background-soft',
    label: 'Suavizar fundo',
    description: 'Low-pass suave reduzindo chiados de alta frequência.',
    category: 'fix',
    settings: { filterType: 'lowpass', cutoff: 4500, q: 0.7, filterGain: 0, outputGain: 1.0 },
  },
  {
    id: 'walkie',
    label: 'Modo rádio',
    description: 'Band-pass médio para efeito de walkie-talkie.',
    category: 'effect',
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
  const [pitchRatio, setPitchRatio] = useState(1.0) // 1.0 = normal, >1 = agudo, <1 = grave
  // Equalizador 3 bandas (em dB)
  const [eqBass, setEqBass] = useState(0) // 100Hz
  const [eqMid, setEqMid] = useState(0)  // 1000Hz
  const [eqTreble, setEqTreble] = useState(0) // 8000Hz
  const [showVirtualModal, setShowVirtualModal] = useState(false)
  const sinkName = 'VirtualMicPDS'
  const inputDeviceName = 'default'
  const outputDeviceName = sinkName
  const [deviceStatus, setDeviceStatus] = useState('')
  const [autoDeviceApplied, setAutoDeviceApplied] = useState(false)
  const [wizardStep, setWizardStep] = useState(0)
  const [copyHint, setCopyHint] = useState('')
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected')
  const helperDownloadUrl = `${import.meta.env.BASE_URL}audio-helper.zip`

  // ========== AI Voice Lab States ==========
  const [aiVoice, setAiVoice] = useState<string>('nova')
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatHistory, setChatHistory] = useState<{role: string, content: string}[]>([])
  const [aiAudioUrl, setAiAudioUrl] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  const aiVoices = [
    { id: 'nova', name: 'Feminina', desc: 'Voz feminina natural' },
    { id: 'onyx', name: 'Masculina', desc: 'Voz masculina grave' },
    { id: 'alloy', name: 'Robô', desc: 'Voz sintética neutra' },
  ]

  const audioCtx = useRef<AudioContext | null>(null)
  const sourceNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const filterNode = useRef<BiquadFilterNode | null>(null)
  const gainNode = useRef<GainNode | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const micStream = useRef<MediaStream | null>(null)
  const pitchShifterNode = useRef<ScriptProcessorNode | null>(null)
  // EQ 3-band nodes
  const eqBassNode = useRef<BiquadFilterNode | null>(null)
  const eqMidNode = useRef<BiquadFilterNode | null>(null)
  const eqTrebleNode = useRef<BiquadFilterNode | null>(null)
  const pitchRatioRef = useRef(1.0) // Para acessar dentro do callback
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
    pitchShifterNode.current?.disconnect()
    filterNode.current?.disconnect()
    eqBassNode.current?.disconnect()
    eqMidNode.current?.disconnect()
    eqTrebleNode.current?.disconnect()
    sourceNode.current?.disconnect()
    pitchShifterNode.current = null
    eqBassNode.current = null
    eqMidNode.current = null
    eqTrebleNode.current = null

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
    pitchShifterNode.current?.disconnect()
    eqBassNode.current?.disconnect()
    eqMidNode.current?.disconnect()
    eqTrebleNode.current?.disconnect()
    gainNode.current.disconnect()
    analyser.current.disconnect()

    // Fluxo: source -> filter -> pitchShifter -> EQ (bass->mid->treble) -> gain -> analyser -> destination
    let lastNode: AudioNode = sourceNode.current

    // Filtro principal (se não bypass)
    if (!bypass && filterNode.current) {
      lastNode.connect(filterNode.current)
      lastNode = filterNode.current
    }

    // Pitch shifter
    if (pitchShifterNode.current) {
      lastNode.connect(pitchShifterNode.current)
      lastNode = pitchShifterNode.current
    }

    // EQ 3-band chain
    if (eqBassNode.current && eqMidNode.current && eqTrebleNode.current) {
      lastNode.connect(eqBassNode.current)
      eqBassNode.current.connect(eqMidNode.current)
      eqMidNode.current.connect(eqTrebleNode.current)
      lastNode = eqTrebleNode.current
    }

    // Gain e saída
    lastNode.connect(gainNode.current)
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

  // Sincroniza pitchRatioRef para uso no callback do pitch shifter
  useEffect(() => {
    pitchRatioRef.current = pitchRatio
  }, [pitchRatio])

  // Atualiza EQ em tempo real
  useEffect(() => {
    if (eqBassNode.current) eqBassNode.current.gain.value = eqBass
    if (eqMidNode.current) eqMidNode.current.gain.value = eqMid
    if (eqTrebleNode.current) eqTrebleNode.current.gain.value = eqTreble
  }, [eqBass, eqMid, eqTreble])

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

      // EQ 3-band: Bass (lowshelf), Mid (peaking), Treble (highshelf)
      const eqBass = ctx.createBiquadFilter()
      eqBass.type = 'lowshelf'
      eqBass.frequency.value = 100 // Hz
      eqBass.gain.value = 0 // será atualizado pelos sliders

      const eqMidFilter = ctx.createBiquadFilter()
      eqMidFilter.type = 'peaking'
      eqMidFilter.frequency.value = 1000 // Hz
      eqMidFilter.Q.value = 1.0
      eqMidFilter.gain.value = 0

      const eqTreble = ctx.createBiquadFilter()
      eqTreble.type = 'highshelf'
      eqTreble.frequency.value = 8000 // Hz
      eqTreble.gain.value = 0

      // Pitch Shifter - Algoritmo simplificado e testado
      // Baseado em github.com/urtzurd/html-audio
      const grainSize = 512  // Menor = menos latência, mais suave
      const pitchShifter = ctx.createScriptProcessor(grainSize, 1, 1)

      // Buffer de overlap-add
      const buffer = new Float32Array(grainSize * 2)

      // Janela Hann
      const grainWindow = new Float32Array(grainSize)
      for (let i = 0; i < grainSize; i++) {
        grainWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / grainSize))
      }

      pitchShifter.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0)
        const outputData = event.outputBuffer.getChannelData(0)
        const ratio = pitchRatioRef.current

        // Bypass se ratio ~1.0
        if (Math.abs(ratio - 1.0) < 0.02) {
          for (let i = 0; i < grainSize; i++) {
            outputData[i] = inputData[i]
          }
          return
        }

        // Aplica janela ao input e shift buffer
        for (let i = 0; i < grainSize; i++) {
          inputData[i] *= grainWindow[i]
          buffer[i] = buffer[i + grainSize]
          buffer[i + grainSize] = 0.0
        }

        // Reamostragem com interpolação linear
        const grainData = new Float32Array(grainSize)
        for (let i = 0; i < grainSize; i++) {
          const j = i * ratio
          const index = Math.floor(j) % grainSize
          const nextIndex = (index + 1) % grainSize
          const frac = j - Math.floor(j)
          grainData[i] = (inputData[index] * (1 - frac) + inputData[nextIndex] * frac) * grainWindow[i]
        }

        // Overlap-add com 50% overlap
        const overlapSamples = grainSize / 2
        for (let i = 0; i < grainSize; i += overlapSamples) {
          for (let j = 0; j < grainSize; j++) {
            buffer[i + j] += grainData[j]
          }
        }

        // Output
        for (let i = 0; i < grainSize; i++) {
          outputData[i] = buffer[i]
        }
      }

      audioCtx.current = ctx
      sourceNode.current = src
      filterNode.current = filter
      gainNode.current = gain
      analyser.current = analyserNode
      micStream.current = stream
      pitchShifterNode.current = pitchShifter
      eqBassNode.current = eqBass
      eqMidNode.current = eqMidFilter
      eqTrebleNode.current = eqTreble

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
    // Aplica pitch ratio (1.0 = normal se não definido)
    setPitchRatio(preset.settings.pitchRatio ?? 1.0)
  }

  const resetControls = () => {
    setFilterType(defaults.filterType)
    setCutoff(defaults.cutoff)
    setQ(defaults.q)
    setFilterGain(defaults.filterGain)
    setOutputGain(defaults.outputGain)
    setPitchRatio(1.0)
    setBypass(false)
    // Reset EQ
    setEqBass(0)
    setEqMid(0)
    setEqTreble(0)
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

  const sendDeviceSelection = useCallback(() => {
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
  }, [inputDeviceName, outputDeviceName])

  useEffect(() => {
    if (wsStatus === 'connected' && !autoDeviceApplied) {
      setDeviceStatus(
        `Aplicando padrão: input=${inputDeviceName || 'default'} / output=${outputDeviceName || sinkName}`
      )
      sendDeviceSelection()
      setAutoDeviceApplied(true)
    }
    if (wsStatus === 'disconnected' || wsStatus === 'error') {
      setAutoDeviceApplied(false)
    }
  }, [wsStatus, autoDeviceApplied, sendDeviceSelection, inputDeviceName, outputDeviceName, sinkName])

  // ========== AI Voice Lab Functions ==========

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        stream.getTracks().forEach(track => track.stop())
        await processVoiceToVoice(audioBlob)
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err) {
      console.error('Erro ao iniciar gravação:', err)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  const processVoiceToVoice = async (audioBlob: Blob) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setAiResponse('Backend não conectado')
      return
    }

    setIsProcessing(true)
    setTranscript('')
    setAiResponse('')
    setAiAudioUrl(null)

    try {
      const reader = new FileReader()
      reader.readAsDataURL(audioBlob)
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1]

        const handleResponse = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data)
            if (data.action === 'voiceToVoice') {
              wsRef.current?.removeEventListener('message', handleResponse)
              setIsProcessing(false)

              if (data.ok) {
                setTranscript(data.transcript)

                // Criar URL para o áudio transformado
                const audioBytes = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0))
                const audioBlob = new Blob([audioBytes], { type: 'audio/mp3' })
                const url = URL.createObjectURL(audioBlob)
                setAiAudioUrl(url)
              } else {
                setTranscript(`Erro: ${data.error}`)
              }
            }
          } catch (err) {
            console.error('Erro ao processar resposta:', err)
          }
        }

        wsRef.current?.addEventListener('message', handleResponse)
        wsRef.current?.send(JSON.stringify({
          action: 'voiceToVoice',
          audio: base64,
          voice: aiVoice
        }))
      }
    } catch (err) {
      console.error('Erro ao processar áudio:', err)
      setIsProcessing(false)
    }
  }

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    const userMessage = chatInput.trim()
    setChatInput('')
    setChatHistory(prev => [...prev, { role: 'user', content: userMessage }])

    const handleResponse = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        if (data.action === 'chatAgent') {
          wsRef.current?.removeEventListener('message', handleResponse)
          if (data.ok) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: data.response }])
          } else {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `Erro: ${data.error}` }])
          }
        }
      } catch (err) {
        console.error('Erro ao processar resposta:', err)
      }
    }

    wsRef.current.addEventListener('message', handleResponse)
    wsRef.current.send(JSON.stringify({
      action: 'chatAgent',
      message: userMessage
    }))
  }

  const textToSpeech = async (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    const handleResponse = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        if (data.action === 'tts') {
          wsRef.current?.removeEventListener('message', handleResponse)
          if (data.ok) {
            const audioBytes = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0))
            const audioBlob = new Blob([audioBytes], { type: 'audio/mp3' })
            const url = URL.createObjectURL(audioBlob)
            const audio = new Audio(url)
            audio.play()
          }
        }
      } catch (err) {
        console.error('Erro TTS:', err)
      }
    }

    wsRef.current.addEventListener('message', handleResponse)
    wsRef.current.send(JSON.stringify({
      action: 'tts',
      text: text,
      voice: aiVoice
    }))
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
              <h3>Presets Profissionais</h3>
              <p className="preset-hint">Escolha um preset e ajuste pelos sliders.</p>
            </div>
            <div className="preset-grid">
              {presets.map((preset) => {
                const categoryLabels = {
                  voice: '🎤 Voz',
                  fix: '🔧 Correção',
                  effect: '✨ Efeito',
                }
                const categoryColors = {
                  voice: 'rgba(77, 165, 255, 0.2)',
                  fix: 'rgba(109, 241, 203, 0.2)',
                  effect: 'rgba(255, 159, 64, 0.2)',
                }
                return (
                  <button key={preset.id} className="preset-card" onClick={() => applyPreset(preset)}>
                    <div className="preset-top">
                      <span className="preset-name">{preset.label}</span>
                      {preset.category && (
                        <span
                          className="preset-badge"
                          style={{
                            background: categoryColors[preset.category],
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: '500',
                          }}
                        >
                          {categoryLabels[preset.category]}
                        </span>
                      )}
                    </div>
                    <p className="preset-desc">{preset.description}</p>
                  </button>
                )
              })}
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
                  <p className="label">Cutoff (Frequência de Corte)</p>
                  <p className="hint">20 Hz — 20 kHz | Graves: 20-250Hz | Médios: 250Hz-4kHz | Agudos: 4-20kHz</p>
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
                <span>Sub-graves (20-80Hz)</span>
                <span>Presença/Brilho (4-20kHz)</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Q (Largura de Banda / Ressonância)</p>
                  <p className="hint">0.1 — 20 | Largo: 0.5-0.7 | Normal: 1-1.4 | Estreito: 2-4 | Cirúrgico: 8-12</p>
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
                <span>Suave/Musical (boost)</span>
                <span>Cirúrgico (notch)</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Ganho do Filtro (dB)</p>
                  <p className="hint">-30 dB — +30 dB | Cortes: -2 a -6dB | Boosts suaves: +1 a +3dB | Evite excessos</p>
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
                <span>Atenua/Corta</span>
                <span>Realça/Boost</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Volume de Saída (Master)</p>
                  <p className="hint">0 — 200% | Mantenha próximo de 100% para evitar distorção/clipping</p>
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
                <span>Silêncio</span>
                <span>+6dB (dobro)</span>
              </div>
            </div>

            <div className="slider">
              <div className="slider-header">
                <div>
                  <p className="label">Pitch (Tom da Voz)</p>
                  <p className="hint">0.5 = Grave/Masculino | 1.0 = Normal | 1.5 = Agudo/Feminino</p>
                </div>
                <span className="value">{pitchRatio.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={pitchRatio}
                onChange={(e) => setPitchRatio(Number(e.target.value))}
              />
              <div className="rail-labels">
                <span>Grave (Masculino)</span>
                <span>Agudo (Feminino)</span>
              </div>
            </div>
          </div>

          {/* Equalizador 3-band */}
          <div className="eq-section" style={{ marginTop: '24px' }}>
            <div className="section-header" style={{ marginBottom: '16px' }}>
              <div>
                <p className="eyebrow">Equalizador</p>
                <h3 style={{ margin: 0 }}>EQ 3-Bandas</h3>
              </div>
              <span className="micro-hint">Ajuste graves, médios e agudos</span>
            </div>

            <div className="eq-sliders" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <div className="slider" style={{ flex: 1, minWidth: '200px' }}>
                <div className="slider-header">
                  <div>
                    <p className="label">🔊 Graves (Bass)</p>
                    <p className="hint">100 Hz - Peso e profundidade</p>
                  </div>
                  <span className="value">{eqBass > 0 ? '+' : ''}{eqBass.toFixed(0)} dB</span>
                </div>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  step={1}
                  value={eqBass}
                  onChange={(e) => setEqBass(Number(e.target.value))}
                  style={{ accentColor: '#4da5ff' }}
                />
                <div className="rail-labels">
                  <span>-60 dB</span>
                  <span>+60 dB</span>
                </div>
              </div>

              <div className="slider" style={{ flex: 1, minWidth: '200px' }}>
                <div className="slider-header">
                  <div>
                    <p className="label">🎤 Médios (Mid)</p>
                    <p className="hint">1000 Hz - Corpo e clareza</p>
                  </div>
                  <span className="value">{eqMid > 0 ? '+' : ''}{eqMid.toFixed(0)} dB</span>
                </div>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  step={1}
                  value={eqMid}
                  onChange={(e) => setEqMid(Number(e.target.value))}
                  style={{ accentColor: '#6df1cb' }}
                />
                <div className="rail-labels">
                  <span>-60 dB</span>
                  <span>+60 dB</span>
                </div>
              </div>

              <div className="slider" style={{ flex: 1, minWidth: '200px' }}>
                <div className="slider-header">
                  <div>
                    <p className="label">✨ Agudos (Treble)</p>
                    <p className="hint">8000 Hz - Brilho e presença</p>
                  </div>
                  <span className="value">{eqTreble > 0 ? '+' : ''}{eqTreble.toFixed(0)} dB</span>
                </div>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  step={1}
                  value={eqTreble}
                  onChange={(e) => setEqTreble(Number(e.target.value))}
                  style={{ accentColor: '#ff9f40' }}
                />
                <div className="rail-labels">
                  <span>-60 dB</span>
                  <span>+60 dB</span>
                </div>
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
              <p className="eyebrow">Guia Profissional</p>
              <h2>Melhores Práticas de EQ e Filtragem</h2>
            </div>
          </div>
          <ul className="step-list">
            <li><strong>SEMPRE use fones</strong> para evitar feedback entre microfone e caixas de som.</li>
            <li><strong>Zumbido elétrico:</strong> Use Notch Q=10 em 50Hz (Europa) ou 60Hz (Brasil/USA) com ganho -12dB.</li>
            <li><strong>Voz clara masculina:</strong> High-pass 80Hz Q=0.7-0.9. Realce opcional em 3kHz +2dB para inteligibilidade.</li>
            <li><strong>Voz clara feminina:</strong> High-pass 100Hz Q=0.7. Realce em 4kHz +2dB para presença/brilho.</li>
            <li><strong>Remover "lama"/muddy:</strong> High-pass 150Hz ou corte 300-500Hz com Q=1.2-1.4.</li>
            <li><strong>Sibilância excessiva:</strong> Use De-Esser (Notch 6kHz Q=4 -4dB) ou Low-pass 10-12kHz.</li>
            <li><strong>Som nasal/metálico:</strong> Corte 1-4.5kHz com Q estreito (2-3) e ganho -2 a -3dB.</li>
            <li><strong>Adicionar "ar"/brilho:</strong> Realce suave 8-12kHz com Q largo (0.5-0.7) +2 a +3dB.</li>
            <li><strong>Q Factor:</strong> Largo (0.5-0.7) para boosts musicais | Estreito (2-4) para cortes cirúrgicos | Muito estreito (8-12) para notch.</li>
            <li><strong>Ganho:</strong> Cortes podem ser mais agressivos (-6dB). Boosts devem ser sutis (+2 a +3dB) para evitar distorção.</li>
            <li><strong>Volume Master:</strong> Mantenha próximo de 100%. Se precisar mais volume, ajuste ganho na fonte ou aplicativo final.</li>
          </ul>
        </section>

        {/* ========== SEÇÃO AI SONORIZAÇÃO ========== */}
        <section className="card ai-section" style={{ gridColumn: '1 / -1' }}>
          <div className="section-header">
            <div>
              <p className="eyebrow">AI Expert Assistant</p>
              <h2>Assistente Especialista em Sonorização</h2>
            </div>
          </div>

          <div className="ai-intro" style={{ marginBottom: '24px' }}>
            <p style={{ fontSize: '1.1rem', lineHeight: '1.6', marginBottom: '16px' }}>
              Tire dúvidas sobre <strong>filtros, equalização e processamento de áudio</strong> desta aplicação.
            </p>
          </div>

          {/* Chat sobre Sonorização */}
          <div className="ai-chat-section">
            <h3 style={{ marginBottom: '12px' }}>Pergunte sobre Sonorização e Áudio</h3>
            <div className="chat-container" style={{
              background: 'rgba(0,0,0,0.3)',
              borderRadius: '12px',
              padding: '16px',
              maxHeight: '300px',
              overflowY: 'auto',
              marginBottom: '12px'
            }}>
              {chatHistory.length === 0 ? (
                <p className="muted">Faça uma pergunta sobre sonorização, filtros, frequências de voz, equalização...</p>
              ) : (
                chatHistory.map((msg, idx) => (
                  <div key={idx} style={{
                    marginBottom: '12px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: msg.role === 'user' ? 'rgba(77, 165, 255, 0.2)' : 'rgba(109, 241, 203, 0.1)',
                    textAlign: msg.role === 'user' ? 'right' : 'left'
                  }}>
                    <small style={{ opacity: 0.7 }}>{msg.role === 'user' ? 'Você' : 'Especialista AI'}</small>
                    <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{msg.content}</p>
                    {msg.role === 'assistant' && (
                      <button
                        className="ghost"
                        style={{ marginTop: '8px', fontSize: '12px' }}
                        onClick={() => textToSpeech(msg.content)}
                      >
                        🔊 Ouvir resposta
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                placeholder="Ex: Como remover zumbido de 60Hz? Qual o Q ideal para de-esser?"
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(0,0,0,0.2)',
                  color: 'white'
                }}
              />
              <button className="primary" onClick={sendChatMessage} disabled={wsStatus !== 'connected'}>
                Enviar
              </button>
            </div>
          </div>
        </section>

        {/* ========== VOICE LAB ========== */}
        <section className="card voice-lab" style={{ gridColumn: '1 / -1' }}>
          <div className="section-header">
            <div>
              <p className="eyebrow">Voice Lab</p>
              <h2>Transformador de Voz com AI (Voice Cloning)</h2>
            </div>
          </div>

          <p style={{ marginBottom: '20px', opacity: 0.8 }}>
            Grave sua voz falando qualquer coisa. A AI Whisper irá transcrever suas palavras e
            resintetizar com a voz AI selecionada. Perfeito para dublar sua voz ou criar demonstrações.
          </p>

          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '24px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>Voz de saída:</label>
              <select
                value={aiVoice}
                onChange={(e) => setAiVoice(e.target.value)}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(0,0,0,0.3)',
                  color: 'white',
                  minWidth: '180px'
                }}
              >
                {aiVoices.map(v => (
                  <option key={v.id} value={v.id}>{v.name} - {v.desc}</option>
                ))}
              </select>
            </div>

            <button
              className={isRecording ? 'ghost' : 'primary'}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isProcessing || wsStatus !== 'connected'}
              style={{ padding: '12px 24px' }}
            >
              {isRecording ? '⏹ Parar Gravação' : '🎤 Gravar Voz'}
            </button>

            {isProcessing && (
              <span style={{ opacity: 0.7 }}>Processando com AI...</span>
            )}
          </div>

          {(transcript || aiAudioUrl) && (
            <div style={{
              background: 'rgba(0,0,0,0.3)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              {transcript && (
                <div style={{ marginBottom: '16px' }}>
                  <h4 style={{ marginBottom: '8px', color: '#4da5ff' }}>Texto transcrito:</h4>
                  <p style={{ opacity: 0.9 }}>{transcript}</p>
                </div>
              )}

              {aiAudioUrl && (
                <div>
                  <h4 style={{ marginBottom: '8px', color: '#6df1cb' }}>Sua voz transformada:</h4>
                  <audio controls src={aiAudioUrl} style={{ width: '100%' }} />
                </div>
              )}
            </div>
          )}
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
