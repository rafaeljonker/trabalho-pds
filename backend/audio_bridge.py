import asyncio
import ctypes.util
import json
import os
import queue
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import websockets
from scipy import signal

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
SAMPLE_RATE = 48000
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
    filterType: str = "highpass"
    cutoff: float = 110.0
    q: float = 0.9
    filterGain: float = 0.0  # dB
    outputGain: float = 1.0
    bypass: bool = False


state = FilterState()
coef_queue: queue.SimpleQueue[np.ndarray] = queue.SimpleQueue()
current_sos = None
zi = None


def db_to_linear(db_value: float) -> float:
    """Converte ganho em dB para fator linear."""
    return float(10 ** (db_value / 20))


def design_sos(params: FilterState) -> np.ndarray:
    """Desenha um biquad equivalente ao usado na UI."""
    nyq = SAMPLE_RATE / 2
    cutoff = float(np.clip(params.cutoff, 20.0, nyq - 500))
    q = float(np.clip(params.q, 0.1, 20.0))

    # Para bandpass/notch convertemos cutoff + Q em uma banda aproximada.
    if params.filterType in ("bandpass", "notch"):
        bandwidth = max(30.0, cutoff / q)
        low = max(20.0, cutoff - bandwidth / 2)
        high = min(nyq - 500, cutoff + bandwidth / 2)
        kind = "bandpass" if params.filterType == "bandpass" else "bandstop"
        return signal.iirfilter(4, [low / nyq, high / nyq], btype=kind, output="sos")

    if params.filterType in ("lowpass", "highpass"):
        return signal.iirfilter(4, cutoff / nyq, btype=params.filterType, output="sos")

    # Fallback: passa-tudo
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
    while not coef_queue.empty():
        current_sos = coef_queue.get_nowait()
        zi = signal.sosfilt_zi(current_sos)

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
