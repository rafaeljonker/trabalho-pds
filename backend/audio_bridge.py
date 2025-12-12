"""
AUDIO BRIDGE - REAL-TIME BIQUAD FILTERING FOR VOICE

Este módulo implementa processamento de áudio em tempo real usando filtros biquad IIR.
Os filtros são implementados como Second-Order Sections (SOS) em cascata para estabilidade numérica.

FILTROS IMPLEMENTADOS:
- Lowpass: Corta agudos acima do cutoff (-24dB/oitava)
- Highpass: Corta graves abaixo do cutoff (-24dB/oitava)
- Bandpass: Isola banda específica (útil para efeitos telefone/rádio)
- Notch (Bandstop): Rejeita banda estreita (zumbido 50/60Hz)

PARÂMETROS DE CONTROLE:
- Cutoff: Frequência de corte (20-20000 Hz)
- Q: Largura de banda (0.1-20.0)
  * Q baixo (0.5-0.7): Slope suave, transição musical
  * Q médio (1.0-1.4): Slope normal
  * Q alto (2.0-4.0): Slope íngreme, corte cirúrgico
  * Q muito alto (8.0-12.0): Notch estreitíssimo para zumbido
- Gain: Ganho do filtro em dB (-30 a +30)
- Output: Ganho de saída linear (0.0 a 2.0)

PRESETS PROFISSIONAIS:
Ver App.tsx para lista completa de 16 presets organizados por categoria:
- Voz Profissional (masculina, feminina, podcast, streaming)
- Correção de Problemas (zumbido, sibilância, muddy, reverb)
- Efeitos Criativos (telefone, rádio AM, walkie-talkie, lo-fi)

TECNICAL SPECS:
- Sample Rate: 44100 Hz
- Block Size: 512 samples (~11.6ms latência)
- Filter Order: 4th order (2 biquads em cascata)
- Rolloff: -24dB/oitava
- Bit Depth: float32
"""

import asyncio
import base64
import ctypes.util
import io
import json
import os
import queue
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import websockets
from dotenv import load_dotenv
from scipy import signal

# Carrega variáveis de ambiente do .env
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# OpenAI client
from openai import OpenAI
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Tenta carregar libportaudio empacotada (baixada via apt-get download libportaudio2)
BASE_DIR = Path(__file__).resolve().parent.parent
PORTAUDIO_LIB = BASE_DIR / "deps" / "portaudio-pkg" / "usr" / "lib" / "x86_64-linux-gnu" / "libportaudio.so.2.0.0"


def patch_portaudio_loader() -> None:
    """Força ctypes a encontrar a libportaudio embutida, se existir."""
    if not PORTAUDIO_LIB.exists():
        return

    lib_dir = str(PORTAUDIO_LIB.parent)
    os.environ["LD_LIBRARY_PATH"] = f"{lib_dir}:{os.environ.get('LD_LIBRARY_PATH', '')}"

    original_find = ctypes.util.find_library

    def _custom_find(name: str):
        if name and "portaudio" in name:
            return str(PORTAUDIO_LIB)
        return original_find(name)

    ctypes.util.find_library = _custom_find


patch_portaudio_loader()
import sounddevice as sd

current_stream: Optional[sd.Stream] = None
stream_lock = asyncio.Lock()

# ---------- Configurações principais ----------
# Ajuste estes valores para os dispositivos corretos.
# Use sd.query_devices() para descobrir nomes/índices.
SAMPLE_RATE = 44100  # Ajustado para coincidir com PulseAudio (era 48000)
CHANNELS = 1
def _parse_device(env_value: Optional[str], default: str) -> int | str:
    if env_value is None:
        return default
    env_value = env_value.strip()
    if env_value.isdigit():
        return int(env_value)
    return env_value


INPUT_DEVICE: Optional[int | str] = _parse_device(os.getenv("INPUT_DEVICE"), "pulse")  # ex.: "alsa_input..."
OUTPUT_DEVICE: Optional[int | str] = _parse_device(
    os.getenv("OUTPUT_DEVICE"), "VirtualMicPDS"
)  # ex.: "VirtualMicPDS"
WS_HOST = "0.0.0.0"
WS_PORT = 8765


@dataclass
class FilterState:
    """Estado do filtro de áudio.

    Valores default otimizados para voz masculina clara:
    - High-pass 80Hz remove rumble subsônico sem afetar fundamental (85-180Hz)
    - Q 0.7 = slope suave e musical
    - Ganho 0dB = transparente (ajuste com presets)
    - Output 1.0 = unity gain (100%)
    """
    filterType: str = "highpass"
    cutoff: float = 80.0  # Hz - Otimizado para voz
    q: float = 0.7  # Q factor - Slope suave
    filterGain: float = 0.0  # dB - Transparente
    outputGain: float = 1.0  # Linear - Unity gain
    bypass: bool = False


state = FilterState()
coef_queue: queue.SimpleQueue[np.ndarray] = queue.SimpleQueue()
current_sos = None
zi = None


def db_to_linear(db_value: float) -> float:
    """Converte ganho em dB para fator linear."""
    return float(10 ** (db_value / 20))


def design_sos(params: FilterState) -> np.ndarray:
    """Desenha cascata de biquad filters (Second-Order Sections).

    Implementa filtros IIR de 4ª ordem (2 biquads em cascata) para:
    - Lowpass: Corta frequências acima do cutoff (-24dB/oitava)
    - Highpass: Corta frequências abaixo do cutoff (-24dB/oitava)
    - Bandpass: Isola banda entre (cutoff - bandwidth/2) e (cutoff + bandwidth/2)
    - Notch: Rejeita banda estreita (bandwidth = cutoff/Q)

    Q Factor:
    - Q baixo (0.5-0.7): Slope suave, transição musical
    - Q médio (1-1.4): Slope normal
    - Q alto (2-4): Slope íngreme, corte cirúrgico
    - Q muito alto (8-12): Notch estreitíssimo para zumbido 50/60Hz

    Args:
        params: Estado do filtro com type, cutoff, Q

    Returns:
        Array SOS (Second-Order Sections) para sosfilt
    """
    nyq = SAMPLE_RATE / 2
    cutoff = float(np.clip(params.cutoff, 20.0, nyq - 500))
    q = float(np.clip(params.q, 0.1, 20.0))

    # Para bandpass/notch convertemos cutoff + Q em uma banda aproximada.
    if params.filterType in ("bandpass", "notch"):
        # Bandwidth inversamente proporcional a Q (Q alto = banda estreita)
        bandwidth = max(30.0, cutoff / q)
        low = max(20.0, cutoff - bandwidth / 2)
        high = min(nyq - 500, cutoff + bandwidth / 2)
        kind = "bandpass" if params.filterType == "bandpass" else "bandstop"
        # 4ª ordem = -24dB/oitava de rolloff
        return signal.iirfilter(4, [low / nyq, high / nyq], btype=kind, output="sos")

    if params.filterType in ("lowpass", "highpass"):
        # 4ª ordem = 2 biquads = -24dB/oitava
        return signal.iirfilter(4, cutoff / nyq, btype=params.filterType, output="sos")

    # Fallback: passa-tudo (não deveria acontecer)
    return signal.iirfilter(2, [0.05, 0.95], btype="bandpass", output="sos")


def prime_filter():
    """Inicializa coeficientes e estado do filtro."""
    global current_sos, zi
    current_sos = design_sos(state)
    zi = signal.sosfilt_zi(current_sos)


def open_stream(input_device, output_device) -> sd.Stream:
    """Abre e inicia o stream de áudio com os dispositivos informados."""
    stream = sd.Stream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="float32",
        callback=audio_cb,
        device=(input_device, output_device),
        blocksize=512,  # Reduz latência (era default ~2048)
        latency="low",  # Solicita baixa latência ao driver
    )
    stream.start()
    return stream


async def restart_stream(input_device, output_device):
    """Reinicia o stream trocando dispositivos sem derrubar o backend."""
    global current_stream, INPUT_DEVICE, OUTPUT_DEVICE
    async with stream_lock:
        if current_stream:
            current_stream.stop()
            current_stream.close()
            current_stream = None

        INPUT_DEVICE = input_device
        OUTPUT_DEVICE = output_device
        prime_filter()
        current_stream = open_stream(INPUT_DEVICE, OUTPUT_DEVICE)
        print(f"Capturando em {INPUT_DEVICE!r} -> enviando para {OUTPUT_DEVICE!r}")
        return INPUT_DEVICE, OUTPUT_DEVICE


def audio_cb(indata, outdata, frames, time, status):  # noqa: ANN001
    """Callback do PortAudio: processa mic -> filtro -> saída virtual."""
    global current_sos, zi, state
    if status:
        print("Audio status:", status)

    # Consume atualizações de coeficientes sem travar áudio.
    # Mantém estado anterior para transição suave (evita clicks)
    while not coef_queue.empty():
        new_sos = coef_queue.get_nowait()
        new_zi = signal.sosfilt_zi(new_sos)
        # Escala o novo estado inicial pelo valor médio do anterior (suaviza transição)
        if zi is not None and new_zi is not None:
            scale = np.mean(np.abs(zi)) / (np.mean(np.abs(new_zi)) + 1e-10)
            scale = np.clip(scale, 0.1, 10.0)  # Limita escala para evitar explosão
            new_zi = new_zi * min(scale, 1.0)
        current_sos = new_sos
        zi = new_zi

    x = indata[:, 0]

    if state.bypass:
        y = x.copy()
    else:
        y, zi = signal.sosfilt(current_sos, x, zi=zi)
        y *= db_to_linear(state.filterGain)

    y *= float(state.outputGain)
    outdata[:, 0] = np.clip(y, -1.0, 1.0)


async def ws_handler(websocket):
    """Recebe parâmetros da UI e atualiza o filtro."""
    async for message in websocket:
        try:
            payload: Dict = json.loads(message)

            # Ações específicas (trocar devices, listar devices, etc.)
            action = payload.get("action")
            if action == "setDevices":
                input_dev = payload.get("input", INPUT_DEVICE)
                output_dev = payload.get("output", OUTPUT_DEVICE)
                try:
                    await restart_stream(input_dev, output_dev)
                    await websocket.send(
                        json.dumps(
                            {
                                "ok": True,
                                "action": "setDevices",
                                "device": {"input": input_dev, "output": output_dev},
                            }
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    await websocket.send(
                        json.dumps(
                            {"ok": False, "action": "setDevices", "error": str(exc)}
                        )
                    )
                continue

            if action == "listDevices":
                try:
                    devices = []
                    for idx, dev in enumerate(sd.query_devices()):
                        devices.append(
                            {
                                "id": idx,
                                "name": dev["name"],
                                "maxInput": int(dev["max_input_channels"]),
                                "maxOutput": int(dev["max_output_channels"]),
                            }
                        )
                    await websocket.send(
                        json.dumps(
                            {"ok": True, "action": "listDevices", "devices": devices}
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    await websocket.send(
                        json.dumps(
                            {"ok": False, "action": "listDevices", "error": str(exc)}
                        )
                    )
                continue

            # ========== AI ENDPOINTS ==========

            # Transcrever áudio com Whisper
            if action == "transcribe":
                try:
                    audio_b64 = payload.get("audio", "")
                    audio_bytes = base64.b64decode(audio_b64)

                    # Salva temporariamente para enviar ao Whisper
                    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                        f.write(audio_bytes)
                        temp_path = f.name

                    with open(temp_path, "rb") as audio_file:
                        transcript = openai_client.audio.transcriptions.create(
                            model="whisper-1",
                            file=audio_file,
                            language="pt"
                        )

                    os.unlink(temp_path)  # Remove arquivo temporário

                    await websocket.send(json.dumps({
                        "ok": True,
                        "action": "transcribe",
                        "text": transcript.text
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "ok": False,
                        "action": "transcribe",
                        "error": str(exc)
                    }))
                continue

            # Gerar áudio com TTS (Text-to-Speech)
            if action == "tts":
                try:
                    text = payload.get("text", "")
                    voice = payload.get("voice", "alloy")  # alloy, echo, fable, onyx, nova, shimmer

                    response = openai_client.audio.speech.create(
                        model="tts-1",
                        voice=voice,
                        input=text
                    )

                    # Converte para base64
                    audio_b64 = base64.b64encode(response.content).decode("utf-8")

                    await websocket.send(json.dumps({
                        "ok": True,
                        "action": "tts",
                        "audio": audio_b64,
                        "voice": voice
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "ok": False,
                        "action": "tts",
                        "error": str(exc)
                    }))
                continue

            # Chat sobre Sonorização
            if action == "chatAgent":
                try:
                    user_message = payload.get("message", "")

                    response = openai_client.chat.completions.create(
                        model="gpt-4o-mini",
                        messages=[
                            {
                                "role": "system",
                                "content": """Você é um especialista em Sonorização e Processamento de Áudio.

Esta aplicação oferece:
- Filtros de áudio (low-pass, high-pass, band-pass, notch)
- Transcrição e transformação de voz com AI
- Visualização FFT em tempo real

Responda de forma clara e concisa. Seu papel é CLARIFICAR conceitos sobre áudio e filtros."""
                            },
                            {"role": "user", "content": user_message}
                        ],
                        max_tokens=500
                    )

                    ai_response = response.choices[0].message.content

                    await websocket.send(json.dumps({
                        "ok": True,
                        "action": "chatAgent",
                        "response": ai_response
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "ok": False,
                        "action": "chatAgent",
                        "error": str(exc)
                    }))
                continue

            # Transformador de Voz: Transcrever -> TTS (dubla sua fala com voz diferente)
            if action == "voiceToVoice":
                try:
                    audio_b64 = payload.get("audio", "")
                    voice = payload.get("voice", "nova")
                    audio_bytes = base64.b64decode(audio_b64)

                    # 1. Transcrever com Whisper
                    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                        f.write(audio_bytes)
                        temp_path = f.name

                    with open(temp_path, "rb") as audio_file:
                        transcript = openai_client.audio.transcriptions.create(
                            model="whisper-1",
                            file=audio_file,
                            language="pt"
                        )
                    os.unlink(temp_path)

                    # 2. Converter transcrição diretamente para voz (transformação de voz)
                    tts_response = openai_client.audio.speech.create(
                        model="tts-1",
                        voice=voice,
                        input=transcript.text
                    )
                    output_audio = base64.b64encode(tts_response.content).decode("utf-8")

                    await websocket.send(json.dumps({
                        "ok": True,
                        "action": "voiceToVoice",
                        "transcript": transcript.text,
                        "audio": output_audio,
                        "voice": voice
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "ok": False,
                        "action": "voiceToVoice",
                        "error": str(exc)
                    }))
                continue

            # Fluxo antigo: apenas parâmetros do filtro.
            for key in ("filterType", "cutoff", "q", "filterGain", "outputGain", "bypass"):
                if key in payload:
                    value = payload[key]
                    if key in ("cutoff", "q", "filterGain", "outputGain"):
                        value = float(value)
                    if key == "filterType":
                        value = str(value)
                    if key == "bypass":
                        value = bool(value)
                    setattr(state, key, value)
            coef_queue.put(design_sos(state))
            await websocket.send(json.dumps({"ok": True, "state": state.__dict__}))
        except Exception as exc:  # noqa: BLE001
            await websocket.send(json.dumps({"ok": False, "error": str(exc)}))


async def main():
    try:
        await restart_stream(INPUT_DEVICE, OUTPUT_DEVICE)
    except Exception as exc:  # noqa: BLE001
        # Se o mic virtual não existir, tenta cair para o padrão do sistema.
        fallback_output = "pulse"
        print(
            f"Falha ao iniciar em {INPUT_DEVICE!r}->{OUTPUT_DEVICE!r}: {exc}. "
            f"Tentando fallback para {fallback_output!r}."
        )
        await restart_stream(INPUT_DEVICE, fallback_output)
    print(f"WebSocket pronto em ws://{WS_HOST}:{WS_PORT}")

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        await asyncio.Future()  # roda para sempre


if __name__ == "__main__":
    asyncio.run(main())
