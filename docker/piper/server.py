"""
Servidor HTTP mínimo para o Piper (texto → fala), em pt-BR.

Existe porque as imagens prontas de Piper falam o protocolo Wyoming, feito para
o Home Assistant. Aqui a gente só quer um POST com texto e um WAV de volta —
menos peça no meio, menos coisa para quebrar.

O modelo de voz é baixado na primeira execução e fica no volume.
"""
import io
import os
import wave
from pathlib import Path
from urllib.request import urlretrieve

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from piper.voice import PiperVoice

VOICE = os.environ.get("PIPER_VOICE", "pt_BR-faber-medium")
VOICE_DIR = Path(os.environ.get("PIPER_VOICE_DIR", "/voices"))
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# pt_BR-faber-medium → pt/pt_BR/faber/medium
language, speaker, quality = VOICE.split("-")[0], VOICE.split("-")[1], VOICE.split("-")[2]
REMOTE = f"{BASE}/{language.split('_')[0]}/{language}/{speaker}/{quality}/{VOICE}"

app = FastAPI(title="IA_Coder · Piper")
voice: PiperVoice | None = None


def ensure_voice() -> PiperVoice:
    global voice
    if voice is not None:
        return voice

    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model = VOICE_DIR / f"{VOICE}.onnx"
    config = VOICE_DIR / f"{VOICE}.onnx.json"

    if not model.exists():
        print(f"[piper] baixando {VOICE}…", flush=True)
        urlretrieve(f"{REMOTE}.onnx", model)
        urlretrieve(f"{REMOTE}.onnx.json", config)
        print("[piper] voz pronta", flush=True)

    voice = PiperVoice.load(str(model), config_path=str(config))
    return voice


class Speech(BaseModel):
    text: str
    # 1.0 é o ritmo natural; acima disso fala mais devagar.
    length_scale: float | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "voice": VOICE, "loaded": voice is not None}


@app.post("/speak")
def speak(body: Speech) -> Response:
    text = (body.text or "").strip()
    if not text:
        return Response(status_code=204)

    engine = ensure_voice()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        engine.synthesize(text, wav, length_scale=body.length_scale)

    return Response(content=buffer.getvalue(), media_type="audio/wav")
