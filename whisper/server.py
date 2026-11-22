"""
JARVIS's own ears: Whisper speech-to-text running on this laptop.

A tiny HTTP server on 127.0.0.1 only. The JARVIS screen records one spoken
sentence, the bridge forwards the audio here, and this answers with the words.
It understands English, Tamil and Tanglish far better than the browser's own
recogniser, runs on the NVIDIA graphics card when it can (falls back to the
CPU with a smaller model when it can't), and needs no internet or account.

  GET  /health                 -> {"ok": true, "device": "cuda", "model": "large-v3-turbo"}
  POST /transcribe?lang=ta     -> {"text": "...", "language": "ta", "ms": 412}
       body: the audio bytes (webm/opus, ogg, wav, mp4 ...)

Started by scripts/start.mjs when whisper/.venv exists. Port: JARVIS_WHISPER_PORT
(default 8790). Model: JARVIS_WHISPER_MODEL (default large-v3-turbo on the GPU,
small on the CPU).
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("JARVIS_WHISPER_PORT", "8790"))


def add_cuda_dlls() -> None:
    """The NVIDIA libraries come as pip packages; Windows has to be told where their DLLs are."""
    site = HERE / ".venv" / "Lib" / "site-packages" / "nvidia"
    for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
        d = site / sub / "bin"
        if d.is_dir():
            os.add_dll_directory(str(d))
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


add_cuda_dlls()
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import av  # noqa: E402
import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402  (after the DLL paths)


def decode(audio: bytes) -> np.ndarray:
    """Audio bytes (webm/opus, wav, ogg, mp4...) -> 16 kHz mono float32.

    faster-whisper has its own decoder, but it passes an option PyAV 15+ no
    longer accepts, so the audio is decoded here and handed over as samples.
    """
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    out = []
    with av.open(io.BytesIO(audio), mode="r") as container:
        for frame in container.decode(audio=0):
            for f in resampler.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
        for f in resampler.resample(None):  # flush what the resampler holds back
            out.append(f.to_ndarray().reshape(-1))
    if not out:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(out).astype(np.float32) / 32768.0

# Words Whisper is likely to hear from this user; steering it towards them is
# what turns "hey service" into "Hey Jarvis" and keeps Tanglish in Latin letters.
PROMPT = (
    "Hey Jarvis. Brave open pannu. YouTube la latest Tamil song play pannu. "
    "Claude, Antigravity, VS Code, WhatsApp, Spotify. Downloads folder open pannu. "
    "Inniku weather eppadi irukku? Work protocol. Remind me at 5 pm."
)

# What Whisper "hears" in silence or a cough — never a real command.
PHANTOMS = {
    "", "you", "thank you", "thank you.", "thanks for watching", "thanks for watching!",
    "thank you for watching", "thank you for watching.", "bye", "bye.", ".", "okay.",
    "subtitles by the amara.org community",
}


def load_model() -> tuple[WhisperModel, str, str]:
    name = os.environ.get("JARVIS_WHISPER_MODEL")
    root = str(HERE / "models")
    try:
        m = name or "large-v3-turbo"
        model = WhisperModel(m, device="cuda", compute_type="float16", download_root=root)
        # Prove the GPU really runs it: a new card can load but fail on first use.
        list(model.transcribe(decode(silence_wav()), language="en")[0])
        return model, "cuda", m
    except Exception as err:  # noqa: BLE001
        print(f"[whisper] graphics card unavailable ({str(err).splitlines()[0]}); using the CPU", flush=True)
        m = name or "small"
        return WhisperModel(m, device="cpu", compute_type="int8", download_root=root), "cpu", m


def silence_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    import struct

    n = int(seconds * rate)
    data = b"\x00\x00" * n
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16
    ) + b"data" + struct.pack("<I", len(data))
    return header + data


print("[whisper] loading the speech model (the first run downloads it)...", flush=True)
MODEL, DEVICE, MODEL_NAME = load_model()
LOCK = threading.Lock()
print(f"[whisper] ready on {DEVICE} with {MODEL_NAME}, port {PORT}", flush=True)


def transcribe(audio: bytes, lang: str | None) -> dict:
    t0 = time.time()
    with LOCK:
        samples = decode(audio)
        if samples.size < 16000 * 0.3:  # under a third of a second: a click, not speech
            return {"text": "", "language": "", "ms": 0}
        segments, info = MODEL.transcribe(
            samples,
            language=lang,
            beam_size=5,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=PROMPT,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    if text.lower().strip(" .!?") in {p.strip(" .!?") for p in PHANTOMS}:
        text = ""
    return {"text": text, "language": info.language, "ms": int((time.time() - t0) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            return self._json(200, {"ok": True, "device": DEVICE, "model": MODEL_NAME})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        size = int(self.headers.get("content-length") or 0)
        if size <= 0 or size > 25 * 1024 * 1024:
            return self._json(413, {"error": "bad audio size"})
        audio = self.rfile.read(size)
        lang = (parse_qs(url.query).get("lang") or [""])[0].strip().lower() or None
        # English is the default setting, but forcing English makes Whisper
        # translate Tamil instead of writing it down — so only a non-English
        # choice is passed on; otherwise it detects the language itself.
        if lang in (None, "en"):
            lang = None
        try:
            self._json(200, transcribe(audio, lang))
        except Exception as err:  # noqa: BLE001
            self._json(500, {"error": str(err).splitlines()[0]})

    def log_message(self, *_args) -> None:  # quiet: the bridge logs what matters
        pass


if __name__ == "__main__":
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except OSError as err:
        print(f"[whisper] cannot listen on port {PORT}: {err}", file=sys.stderr, flush=True)
        sys.exit(1)
