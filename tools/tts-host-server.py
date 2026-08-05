import json
import os
import sys
import tempfile
import threading
import traceback
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files

os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def normalize_text(text: str) -> str:
    if not text:
        return ""
    # Replace non-breaking hyphen (\u2011) and other unicode hyphens/dashes with standard '-'
    text = re.sub(r"[\u2010\u2011\u2012\u2013\u2014\u2015]", "-", text)
    # Replace non-breaking space (\u00a0) and other unusual spaces with standard space
    text = re.sub(r"[\u00a0\u2000-\u200b\u202f\u205f\u3000]", " ", text)
    # Replace typographic quotes with simple quotes
    text = text.replace("«", '"').replace("»", '"').replace("“", '"').replace("”", '"')
    text = text.replace("‘", "'").replace("’", "'").replace("„", '"')
    # Replace ellipsis
    text = text.replace("…", "...")
    return text


import soundfile as sf
import numpy as np
from cached_path import cached_path
from hydra.utils import get_class
from omegaconf import OmegaConf

from f5_tts.infer.utils_infer import (
    infer_process,
    load_model,
    load_vocoder,
    preprocess_ref_audio_text,
)


HOST = os.environ.get("UCONTENT_TTS_HOST", "0.0.0.0")
PORT = int(os.environ.get("UCONTENT_TTS_PORT", "8765"))
DEFAULT_REF_AUDIO = os.environ.get("UCONTENT_TTS_REF_AUDIO", "C:/Ucontent/ref.wav")
DEFAULT_REF_TEXT = os.environ.get(
    "UCONTENT_TTS_REF_TEXT",
    "Буквально. буквально вот, из недавнего, в рамках одной недели я успел пожить и в лесах на Курильских островах, и среди гор Кавказа.",
)
DEFAULT_CKPT = os.environ.get("UCONTENT_TTS_CKPT", "C:/Ucontent/data/models/my_russian_voice/model_last.pt")
DEFAULT_VOCAB = os.environ.get(
    "UCONTENT_TTS_VOCAB",
    "C:/Users/Nemifist/.speechedit_venv/Lib/data/my_russian_voice_char/vocab.txt",
)
DEFAULT_DEVICE = os.environ.get("UCONTENT_TTS_DEVICE", "cuda")
DEFAULT_TAIL_SILENCE_SECONDS = float(os.environ.get("UCONTENT_TTS_TAIL_SILENCE_SECONDS", "0.45"))

_state_lock = threading.Lock()
_generation_lock = threading.Lock()
_vocoder = None
_model = None
_model_key = None


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler):
    length = int(handler.headers.get("content-length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def resolve_checkpoint(value, fallback):
    target = value or fallback
    if target.startswith("hf://"):
        return str(cached_path(target))
    return target


def load_runtime(ckpt_file, vocab_file, device):
    global _vocoder, _model, _model_key
    key = (ckpt_file, vocab_file, device)
    with _state_lock:
        if _vocoder is not None and _model is not None and _model_key == key:
            return _vocoder, _model

        print("[tts] loading vocoder...", flush=True)
        vocoder = load_vocoder(
            vocoder_name="vocos",
            is_local=False,
            local_path="../checkpoints/vocos-mel-24khz",
            device=device,
        )

        print("[tts] loading model...", flush=True)
        model_cfg_path = str(files("f5_tts").joinpath("configs/F5TTS_v1_Base.yaml"))
        model_cfg = OmegaConf.load(model_cfg_path)
        model_cls = get_class(f"f5_tts.model.{model_cfg.model.backbone}")
        model = load_model(
            model_cls,
            model_cfg.model.arch,
            ckpt_file,
            mel_spec_type="vocos",
            vocab_file=vocab_file,
            device=device,
        )

        _vocoder = vocoder
        _model = model
        _model_key = key
        print("[tts] model ready", flush=True)
        return _vocoder, _model


def generate_wav(job):
    text = normalize_text(str(job.get("text") or job.get("gen_text") or "").strip())
    if not text:
        raise ValueError("empty text")
    if len(text) > 10000:
        raise ValueError("text is too long")

    ref_audio = str(job.get("ref_audio") or DEFAULT_REF_AUDIO)
    ref_text = normalize_text(str(job.get("ref_text") or DEFAULT_REF_TEXT))
    device = str(job.get("device") or DEFAULT_DEVICE)
    speed = float(job.get("speed") or 1.0)
    tail_silence_seconds = max(0.0, float(job.get("tail_silence_seconds") or DEFAULT_TAIL_SILENCE_SECONDS))
    ckpt_file = resolve_checkpoint(str(job.get("ckpt_file") or ""), DEFAULT_CKPT)
    vocab_file = resolve_checkpoint(str(job.get("vocab_file") or ""), DEFAULT_VOCAB)

    for label, file_path in (
        ("ref audio", ref_audio),
        ("checkpoint", ckpt_file),
        ("vocab", vocab_file),
    ):
        if file_path and not os.path.isfile(file_path):
            raise FileNotFoundError(f"{label} not found: {file_path}")

    vocoder, model = load_runtime(ckpt_file, vocab_file, device)
    ref_audio_processed, ref_text_processed = preprocess_ref_audio_text(ref_audio, ref_text)

    with _generation_lock:
        print(f"[tts] generating {len(text)} chars...", flush=True)
        audio_segment, sample_rate, _spectrogram = infer_process(
            ref_audio_processed,
            ref_text_processed,
            text,
            model,
            vocoder,
            mel_spec_type="vocos",
            device=device,
            speed=speed,
        )

    fd, output_path = tempfile.mkstemp(prefix="ucontent_voice_", suffix=".wav")
    os.close(fd)
    if tail_silence_seconds > 0:
        silence_shape = (int(sample_rate * tail_silence_seconds),) + tuple(audio_segment.shape[1:])
        audio_segment = np.concatenate([audio_segment, np.zeros(silence_shape, dtype=audio_segment.dtype)])
    sf.write(output_path, audio_segment, sample_rate)
    return output_path


class Handler(BaseHTTPRequestHandler):
    server_version = "UContentTTS/1.0"

    def do_GET(self):
        if self.path == "/health":
            json_response(self, 200, {"ok": True, "model_loaded": _model is not None})
            return
        json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            json_response(self, 404, {"ok": False, "error": "not found"})
            return
        output_path = ""
        try:
            output_path = generate_wav(read_json(self))
            with open(output_path, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            traceback.print_exc()
            json_response(self, 500, {"ok": False, "error": str(exc)})
        finally:
            if output_path:
                try:
                    os.remove(output_path)
                except OSError:
                    pass

    def log_message(self, fmt, *args):
        print(f"[tts] {self.address_string()} {fmt % args}", flush=True)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[tts] listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
