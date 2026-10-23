"""本機語音辨識服務：啟動時載入一次 Whisper 模型，提供 HTTP 介面給 server.js 呼叫。
只監聽 127.0.0.1，錄音不會送到外部的語音辨識服務。

兩種引擎（STT_BACKEND）：
- mlx：mlx-whisper，Apple 晶片的 Mac（預設，在 Mac 上由 server.js 自動啟動）
    uv run --offline --no-project --python 3.11 --with-requirements stt/requirements.txt python stt/stt_server.py
- faster-whisper：一般 Linux 伺服器，只用 CPU（套件見 stt/requirements-linux.txt）
    STT_BACKEND=faster-whisper python stt/stt_server.py
"""

import json
import os
import subprocess
import sys
import tempfile
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

PORT = int(os.environ.get("STT_PORT", "3010"))
BACKEND = os.environ.get("STT_BACKEND", "mlx")
DEFAULT_MODELS = {"mlx": "mlx-community/whisper-large-v3-turbo", "faster-whisper": "small"}
if BACKEND not in DEFAULT_MODELS:
    sys.exit(f"STT_BACKEND 只能是 {' / '.join(DEFAULT_MODELS)}，收到：{BACKEND}")
MODEL = os.environ.get("STT_MODEL", DEFAULT_MODELS[BACKEND])
LANGUAGE = os.environ.get("STT_LANGUAGE", "zh")
# 提示詞：讓模型偏向繁體中文，並認得花蓮的人名、地名與常用詞
INITIAL_PROMPT = os.environ.get(
    "STT_PROMPT",
    "以下是繁體中文的提問。花蓮縣長候選人魏嘉賢的政見、質詢、縣議會、縣政府。"
    "花蓮市、鳳林鎮、玉里鎮、新城鄉、吉安鄉、壽豐鄉、光復鄉、豐濱鄉、瑞穗鄉、富里鄉、"
    "秀林鄉、萬榮鄉、卓溪鄉、太魯閣、蘇花公路、台9線、臺鐵、高鐵。",
)
MAX_BYTES = 20 * 1024 * 1024
# Whisper 在幾乎無聲的片段常會「幻聽」出這類字句
HALLUCINATIONS = ("字幕", "訂閱", "點贊", "點讚", "謝謝觀看", "感謝觀看", "請不吝")


def to_wav(data: bytes) -> str:
    """把瀏覽器錄到的 webm / mp4 / ogg 轉成 Whisper 用的 16kHz 單聲道 wav。"""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".input") as src:
        src.write(data)
    wav = src.name + ".wav"
    try:
        proc = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", src.name, "-ar", "16000", "-ac", "1", wav],
            capture_output=True,
        )
    finally:
        os.unlink(src.name)
    if proc.returncode != 0:
        raise ValueError("音訊格式無法轉換：" + proc.stderr.decode(errors="ignore")[-200:])
    return wav


if BACKEND == "mlx":
    import mlx_whisper

    def load_model() -> None:
        # 先跑一次一秒的靜音，把模型載入記憶體，之後每次辨識就不用等載入
        mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language=LANGUAGE, verbose=None)

    def run_whisper(audio) -> list[dict]:
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=MODEL,
            language=LANGUAGE,
            initial_prompt=INITIAL_PROMPT,
            condition_on_previous_text=False,
            verbose=None,
        )
        return result.get("segments", [])

else:
    from faster_whisper import WhisperModel

    whisper_model = None

    def load_model() -> None:
        global whisper_model
        # int8 在 CPU 上最快、最省記憶體；執行緒數預設用全部 CPU
        threads = int(os.environ.get("STT_THREADS", "0")) or (os.cpu_count() or 1)
        whisper_model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=threads)

    def read_wav(path: str) -> np.ndarray:
        # 直接讀 ffmpeg 轉好的 16kHz 單聲道 16-bit wav；不經過 faster-whisper 內建的 PyAV 解碼
        with wave.open(path, "rb") as w:
            pcm = w.readframes(w.getnframes())
        return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0

    def run_whisper(audio) -> list[dict]:
        segments, _ = whisper_model.transcribe(
            read_wav(audio),
            language=LANGUAGE,
            initial_prompt=INITIAL_PROMPT,
            condition_on_previous_text=False,
            beam_size=int(os.environ.get("STT_BEAM_SIZE", "1")),
            vad_filter=True,  # 先切掉沒人說話的部分，CPU 上快很多，也比較不會幻聽
        )
        return [
            {
                "text": s.text,
                "no_speech_prob": s.no_speech_prob,
                "compression_ratio": s.compression_ratio,
                "avg_logprob": s.avg_logprob,
            }
            for s in segments
        ]


def transcribe(data: bytes) -> str:
    wav = to_wav(data)
    try:
        raw_segments = run_whisper(wav)
    finally:
        os.unlink(wav)
    # 去掉多半是雜訊或幻聽的片段：像是沒人說話、文字大量重複、或模型自己都沒把握
    segments = [
        s
        for s in raw_segments
        if s.get("no_speech_prob", 0) < 0.6
        and s.get("compression_ratio", 0) < 2.4
        and s.get("avg_logprob", 0) > -1.0
    ]
    text = "".join(s.get("text", "") for s in segments).strip()
    if any(h in text for h in HALLUCINATIONS):
        return ""
    return text


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BYTES:
            return self._send(400, {"error": "錄音檔大小不正確"})
        try:
            text = transcribe(self.rfile.read(length))
        except ValueError as err:
            return self._send(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 - 回報給前端，不讓服務中斷
            return self._send(500, {"error": f"語音辨識失敗：{err}"})
        self._send(200, {"text": text})

    def log_message(self, format, *args) -> None:  # noqa: A002 - 覆寫內建方法的參數名稱
        pass  # 不在終端機印出每次請求


def main() -> None:
    print(f"語音辨識：載入模型 {MODEL}（{BACKEND}）…", flush=True)
    load_model()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"語音辨識：已就緒 http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
