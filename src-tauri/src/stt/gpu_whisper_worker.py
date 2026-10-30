"""Local Faster Whisper worker for complete 16 kHz PCM speech turns.

The Rust provider starts this process on demand. It binds to loopback only and
uses a locally cached Whisper Large v3 Turbo CTranslate2 model on the NVIDIA GPU.
"""

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def diagnostic(stage, **fields):
    """Emit metadata only; never print audio, transcript, paths or exception text."""
    print("NEXQ_DIAGNOSTIC " + json.dumps({"stage": stage, "fields": fields}),
          file=sys.stderr, flush=True)


diagnostic_operation = "imports"
worker_started = time.monotonic()


def report_uncaught(exc_type, _exc, _traceback):
    diagnostic("gpu_worker_error", operation=diagnostic_operation,
               error_kind=exc_type.__name__)


# Missing numpy/faster-whisper and CUDA initialization failures previously
# disappeared into null stderr on ordinary Explorer launches.
sys.excepthook = report_uncaught
threading.excepthook = lambda args: report_uncaught(args.exc_type, args.exc_value, args.exc_traceback)
diagnostic("gpu_worker_starting", worker_pid=os.getpid())

import numpy as np


def enable_cuda_dlls():
    base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    for package in ("cublas", "cudnn", "cuda_nvrtc"):
        path = os.path.join(base, package, "bin")
        if os.path.isdir(path):
            os.add_dll_directory(path)
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


enable_cuda_dlls()
from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.vad import get_speech_timestamps, VadOptions  # noqa: E402

# The Rust energy gate finds turn boundaries, but microphone noise can pass
# that gate. Silero checks for speech before decoding; it does not blacklist
# valid phrases such as "Thank you" or add a streaming endpoint delay.
VAD_PARAMETERS = dict(
    threshold=0.5, min_speech_duration_ms=150,
    min_silence_duration_ms=100, speech_pad_ms=100,
)

diagnostic_operation = "model_load"
try:
    model = WhisperModel(
        "h2oai/faster-whisper-large-v3-turbo", device="cuda",
        compute_type="int8_float16", local_files_only=True,
    )
    model_name = "large-v3-turbo"
except (OSError, ValueError) as exc:
    # Keep existing offline installations usable until Turbo is downloaded.
    diagnostic("gpu_worker_model_fallback", model="large-v3", error_kind=type(exc).__name__)
    model = WhisperModel("large-v3", device="cuda", compute_type="int8_float16", local_files_only=True)
    model_name = "large-v3"
model_lock = threading.Lock()
# Initialize CUDA kernels before the first real question. This moves the
# one-time 2-3 second inference penalty into meeting startup.
diagnostic_operation = "warmup"
warm_segments, _ = model.transcribe(
    np.zeros(16_000, dtype=np.float32),
    language="en", beam_size=1, vad_filter=False,
    condition_on_previous_text=False,
)
list(warm_segments)
# Initialize the small CPU speech detector before reporting ready as well.
get_speech_timestamps(np.zeros(16_000, dtype=np.float32), VadOptions(**VAD_PARAMETERS))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"ready": True, "model": model_name,
                               "speech_filter": "silero-vad-v1"})
        else:
            self.respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self.respond(404, {"error": "not found"})
            return
        size = int(self.headers.get("Content-Length", "0"))
        if size < 3200 or size > 16_000 * 2 * 45:
            self.respond(400, {"error": "invalid audio length"})
            return
        raw = self.rfile.read(size)
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        queued_at = time.monotonic()
        operation = "vad"
        try:
            with model_lock:
                decode_started = time.monotonic()
                queue_ms = round((decode_started - queued_at) * 1000)
                # Gate noise with VAD, but decode the original turn. Trimming
                # to VAD spans can remove quiet question prefixes/names in
                # telephone-band audio (e.g. "What did you do for CHC...").
                speech_spans = get_speech_timestamps(samples, VadOptions(**VAD_PARAMETERS))
                if not speech_spans:
                    self.respond(200, {"text": "", "diagnostics": {
                        "queue_ms": queue_ms, "decode_ms": round((time.monotonic() - decode_started) * 1000),
                        "speech_detected": False, "segments_accepted": 0, "segments_rejected": 0,
                    }})
                    return
                operation = "decode"
                segments, _ = model.transcribe(
                    samples,
                    language="en",
                    beam_size=1,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
                # Whisper can invent short phrases from fan noise and quiet
                # microphone hiss. Keep words only when the model is confident
                # that speech was present. Its default no-speech rule also
                # requires log probability below -1, which missed noise on
                # this PC. Quiet mic bursts produced false "Thank you" at
                # 0.59 no-speech / -1.28 log probability, while spoken test
                # questions were below 0.03 no-speech.
                accepted = []
                rejected = 0
                for segment in segments:
                    words = segment.text.strip()
                    if not re.search(r"[A-Za-z0-9]", words):
                        rejected += 1
                        continue
                    if segment.no_speech_prob > 0.5 and segment.avg_logprob < -0.5:
                        rejected += 1
                        continue
                    # Turbo reports near-zero no-speech probability even on
                    # quiet mic noise; low log probability catches those
                    # hallucinations without rejecting the tested questions.
                    if model_name == "large-v3-turbo" and segment.avg_logprob < -0.75:
                        rejected += 1
                        continue
                    accepted.append(words)
                text = " ".join(accepted).strip()
                text = re.sub(r"\bgo\s*(?:hi|high)\s*level\b", "GoHighLevel", text, flags=re.IGNORECASE)
                # Narrow marketing collocation; do not rewrite ordinary feet
                # measurements or infer a missing question from a fragment.
                text = re.sub(r"\bfeet(?=\s+offers?\b)", "feed", text, flags=re.IGNORECASE)
                decode_ms = round((time.monotonic() - decode_started) * 1000)
            self.respond(200, {"text": text, "diagnostics": {
                "queue_ms": queue_ms, "decode_ms": decode_ms, "speech_detected": True,
                "segments_accepted": len(accepted), "segments_rejected": rejected,
            }})
        except Exception as exc:
            diagnostic("gpu_worker_transcription_error", operation=operation,
                       error_kind=type(exc).__name__)
            self.respond(500, {"error": "transcription failed"})


if __name__ == "__main__":
    if len(sys.argv) > 1:
        parent_pid = int(sys.argv[1])

        def stop_with_parent():
            import ctypes
            kernel = ctypes.windll.kernel32
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.OpenProcess.argtypes = (ctypes.c_uint, ctypes.c_int, ctypes.c_uint)
            kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint)
            kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
            while True:
                time.sleep(5)
                handle = kernel.OpenProcess(0x00100000, False, parent_pid)
                if not handle:
                    os._exit(0)
                exited = kernel.WaitForSingleObject(handle, 0) == 0
                kernel.CloseHandle(handle)
                if exited:
                    os._exit(0)

        threading.Thread(target=stop_with_parent, daemon=True).start()
    diagnostic_operation = "server"
    server = ThreadingHTTPServer(("127.0.0.1", 18765), Handler)
    diagnostic("gpu_worker_ready", model=model_name,
               startup_ms=round((time.monotonic() - worker_started) * 1000))
    server.serve_forever()
