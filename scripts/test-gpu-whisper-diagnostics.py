"""Exercise worker diagnostics without loading CUDA, a model, or a server."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch


class Array:
    def astype(self, _dtype):
        return self

    def __truediv__(self, _scale):
        return self


class WorkerDiagnosticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        numpy = types.ModuleType("numpy")
        numpy.zeros = Mock(return_value=Array())
        numpy.frombuffer = Mock(return_value=Array())
        numpy.float32 = object()
        whisper = types.ModuleType("faster_whisper")
        cls.model = Mock()
        cls.model.transcribe.return_value = (iter(()), None)
        whisper.WhisperModel = Mock(return_value=cls.model)
        vad = types.ModuleType("faster_whisper.vad")
        cls.vad = vad.get_speech_timestamps = Mock(return_value=[])
        vad.VadOptions = lambda **kwargs: kwargs
        source = Path(__file__).resolve().parents[1] / "src-tauri/src/stt/gpu_whisper_worker.py"
        spec = importlib.util.spec_from_file_location("diagnostic_test_worker", source)
        cls.worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"numpy": numpy, "faster_whisper": whisper, "faster_whisper.vad": vad}), \
                patch.object(os.path, "isdir", return_value=False), \
                patch.object(sys, "excepthook"), patch.object(__import__("threading"), "excepthook"), \
                contextlib.redirect_stderr(io.StringIO()):
            spec.loader.exec_module(cls.worker)

    def setUp(self):
        self.model.reset_mock()
        self.model.transcribe.side_effect = None
        self.vad.return_value = [{"start": 0, "end": 1600}]
        self.handler = object.__new__(self.worker.Handler)
        self.handler.path = "/transcribe"
        self.handler.headers = {"Content-Length": "3200"}
        self.handler.rfile = io.BytesIO(bytes(3200))
        self.replies = []
        self.handler.respond = lambda code, body: self.replies.append((code, body))

    def test_noise_keeps_empty_transcript_and_reports_gate_decision(self):
        self.vad.return_value = []
        self.handler.do_POST()
        code, body = self.replies[0]
        self.assertEqual((code, body["text"]), (200, ""))
        self.assertFalse(body["diagnostics"]["speech_detected"])
        self.assertEqual(body["diagnostics"]["segments_accepted"], 0)
        self.model.transcribe.assert_not_called()

    def test_counts_rejections_without_recording_segment_content(self):
        def segment(text, no_speech, logprob):
            return types.SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob)
        self.model.transcribe.return_value = (iter([
            segment("Hello", .01, -.1), segment("private noise text", .9, -.9),
            segment("another private noise text", .01, -.8),
        ]), None)
        self.handler.do_POST()
        code, body = self.replies[0]
        self.assertEqual((code, body["text"]), (200, "Hello"))
        metadata = body["diagnostics"]
        self.assertEqual((metadata["segments_accepted"], metadata["segments_rejected"]), (1, 2))
        self.assertTrue(metadata["speech_detected"])
        self.assertIsInstance(metadata["queue_ms"], int)
        self.assertIsInstance(metadata["decode_ms"], int)
        self.assertNotIn("private", json.dumps(metadata))

    def test_decode_error_retains_category_without_exception_payload(self):
        self.model.transcribe.side_effect = RuntimeError("private transcript and user path")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.handler.do_POST()
        self.assertEqual(self.replies, [(500, {"error": "transcription failed"})])
        diagnostic = json.loads(stderr.getvalue().removeprefix("NEXQ_DIAGNOSTIC "))
        self.assertEqual(diagnostic, {"stage": "gpu_worker_transcription_error",
                                     "fields": {"operation": "decode", "error_kind": "RuntimeError"}})
        self.assertNotIn("private", stderr.getvalue())

    def test_startup_error_hook_does_not_emit_traceback_or_message(self):
        self.worker.diagnostic_operation = "imports"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.worker.report_uncaught(ModuleNotFoundError, ModuleNotFoundError("private path"), None)
        diagnostic = json.loads(stderr.getvalue().removeprefix("NEXQ_DIAGNOSTIC "))
        self.assertEqual(diagnostic["fields"], {"operation": "imports", "error_kind": "ModuleNotFoundError"})
        self.assertNotIn("private", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
