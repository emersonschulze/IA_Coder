"""
Servidor HTTP mínimo para o Piper (texto → fala), em pt-BR — e agora com
várias vozes para escolher, trocadas em tempo real pela tela de Configurações.

Existe porque as imagens prontas de Piper falam o protocolo Wyoming, feito para
o Home Assistant. Aqui a gente só quer um POST com texto e um WAV de volta —
menos peça no meio, menos coisa para quebrar.

Cada voz é baixada na PRIMEIRA vez que alguém pede ela, e fica em memória (e no
volume, em disco) depois disso — trocar de voz não reinicia o container, só
demora um pouco mais na primeira fala daquela voz.
"""
import io
import os
import wave
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlretrieve

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from piper.voice import PiperVoice

DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "pt_BR-faber-medium")
VOICE_DIR = Path(os.environ.get("PIPER_VOICE_DIR", "/voices"))
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Catálogo curado — só vozes que já testamos. O Piper tem dezenas de outras;
# adicionar uma aqui é só copiar o id (pasta do repositório da Hugging Face:
# rhasspy/piper-voices/tree/main/<lang>/<lang_REGION>/<speaker>/<quality>) e um
# rótulo. `installed` no `/voices` diz se já foi baixada nesta máquina.
CATALOG = [
    {"id": "pt_BR-faber-medium", "label": "Faber (PT-BR, masculina)"},
    {"id": "pt_BR-edresson-low", "label": "Edresson (PT-BR, masculina, leve)"},
    {"id": "pt_PT-tugão-medium", "label": "Tugão (PT-PT, masculina)"},
    {"id": "en_US-amy-medium", "label": "Amy (EN-US, feminina)"},
    {"id": "en_US-ryan-high", "label": "Ryan (EN-US, masculina)"},
]
if DEFAULT_VOICE not in {v["id"] for v in CATALOG}:
    CATALOG.insert(0, {"id": DEFAULT_VOICE, "label": DEFAULT_VOICE})

app = FastAPI(title="IA_Coder · Piper")
# Vozes já carregadas em memória, por id — carregar de novo a cada fala seria
# reabrir o modelo (centenas de ms) sem necessidade nenhuma.
loaded: dict[str, PiperVoice] = {}


def model_paths(voice_id: str) -> tuple[Path, Path]:
    return VOICE_DIR / f"{voice_id}.onnx", VOICE_DIR / f"{voice_id}.onnx.json"


def is_installed(voice_id: str) -> bool:
    model, config = model_paths(voice_id)
    return model.exists() and config.exists()


def ensure_voice(voice_id: str) -> PiperVoice:
    cached = loaded.get(voice_id)
    if cached is not None:
        return cached

    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model, config = model_paths(voice_id)

    if not model.exists():
        # pt_BR-faber-medium → pt/pt_BR/faber/medium. quote() porque nomes como
        # "tugão" têm acento, e isso quebra a conexão HTTP se for cru na URL.
        language, speaker, quality = voice_id.split("-")
        remote = (
            f"{BASE}/{language.split('_')[0]}/{language}/{quote(speaker)}/{quality}/{quote(voice_id)}"
        )
        print(f"[piper] baixando {voice_id}…", flush=True)
        urlretrieve(f"{remote}.onnx", model)
        urlretrieve(f"{remote}.onnx.json", config)
        print(f"[piper] {voice_id} pronta", flush=True)

    voice = PiperVoice.load(str(model), config_path=str(config))
    loaded[voice_id] = voice
    return voice


class Speech(BaseModel):
    text: str
    # Vazio ou ausente usa PIPER_VOICE (a padrão do container).
    voice: str | None = None
    # 1.0 é o ritmo natural; acima disso fala mais devagar.
    length_scale: float | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "voice": DEFAULT_VOICE, "loaded": list(loaded.keys())}


@app.get("/voices")
def voices() -> list[dict]:
    return [
        {"id": v["id"], "label": v["label"], "installed": is_installed(v["id"])}
        for v in CATALOG
    ]


@app.post("/speak")
def speak(body: Speech) -> Response:
    text = (body.text or "").strip()
    if not text:
        return Response(status_code=204)

    engine = ensure_voice(body.voice or DEFAULT_VOICE)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        engine.synthesize(text, wav, length_scale=body.length_scale)

    return Response(content=buffer.getvalue(), media_type="audio/wav")
