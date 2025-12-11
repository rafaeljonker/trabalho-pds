# Filtro de áudio em tempo real

Interface React (Vite) para ajustar filtros biquad e backend Python que captura o microfone, aplica os parâmetros recebidos via WebSocket e envia o áudio filtrado para um dispositivo virtual (microfone loopback). Escolha esse dispositivo virtual em Zoom/Meet/Discord para usar o áudio processado.

## Requisitos
- Node 18+ e npm (para a UI).
- Python 3.10+.
- Dispositivo virtual de áudio (ex.: VB-CABLE/Voicemeeter no Windows, BlackHole/Loopback no macOS, módulo loopback do PipeWire/PulseAudio no Linux).

## Usar a UI
```bash
npm install
npm run dev
```
Abra o endereço indicado (padrão http://localhost:5173). A UI mostra o estado da conexão WebSocket (`ws://localhost:8765`).

## Configurar o backend Python
1) Instale dependências em um venv:
```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
```
2) Descubra nomes/índices dos dispositivos e edite `backend/audio_bridge.py` (constantes `INPUT_DEVICE` e `OUTPUT_DEVICE`):
```bash
python - <<'PY'
import sounddevice as sd
print(sd.query_devices())
PY
```
   - `INPUT_DEVICE`: seu microfone físico (ou `None` para padrão).
   - `OUTPUT_DEVICE`: o dispositivo virtual (ex.: "CABLE Input", "BlackHole 2ch"). Por padrão usamos
     `VirtualMicPDS` e, se não existir, o backend cai para a saída padrão (`pulse`).

3) Rode o backend:
```bash
python backend/audio_bridge.py
```
Ele inicia um servidor WebSocket em `ws://0.0.0.0:8765`. Ao mover os sliders na UI, os parâmetros são enviados para o backend e aplicados em tempo real.

## Fluxo de uso
1. Inicie o backend Python apontando a saída para o dispositivo virtual.
2. Abra a UI, ajuste filtros/ganho e confirme que o status “Backend conectado” aparece.
3. Nas reuniões, selecione o dispositivo virtual como microfone.
4. Opcional: na própria UI você pode clicar “Iniciar captura” para ouvir o retorno filtrado localmente (use fones para evitar microfonia).

## Notas
- O backend usa filtros IIR (biquad) equivalentes aos usados no Web Audio e reenvia o áudio em mono com controle de ganho.
- O slider “bypass” envia áudio cru para o backend (mantendo apenas o ganho de saída).
- A taxa de amostragem padrão é 48000 Hz; ajuste `SAMPLE_RATE` em `backend/audio_bridge.py` se seu dispositivo exigir outro valor.
