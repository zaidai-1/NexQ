//! Local GPU Whisper provider. Sends complete speech turns to a persistent
//! Faster Whisper worker on loopback; audio never leaves this PC.

use async_trait::async_trait;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};

use crate::audio::AudioChunk;
use super::provider::{STTProvider, STTProviderType, TranscriptResult};

const SAMPLE_RATE: usize = 16_000;
const SILENCE_SAMPLES: usize = SAMPLE_RATE * 45 / 100; // 450 ms
const MAX_TURN_SAMPLES: usize = SAMPLE_RATE * 12;
const ENDPOINT: &str = "http://127.0.0.1:18765";

static START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

async fn health(client: &reqwest::Client) -> bool {
    client.get(format!("{ENDPOINT}/health"))
        .timeout(Duration::from_secs(1))
        .send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

async fn ensure_worker(client: &reqwest::Client) -> Result<(), String> {
    let _guard = START_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if health(client).await {
        crate::timing::record("gpu_worker_reused", serde_json::json!({}));
        return Ok(());
    }

    let started_ms = crate::timing::now_ms();
    let script = std::env::temp_dir().join("nexq_gpu_whisper_worker.py");
    std::fs::write(&script, include_str!("gpu_whisper_worker.py"))
        .map_err(|e| {
            crate::timing::record("gpu_worker_error", serde_json::json!({"operation":"write_script","error_kind":"io_error"}));
            format!("Cannot write GPU Whisper worker: {e}")
        })?;
    let mut command = Command::new("python");
    command.arg(&script).arg(std::process::id().to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| {
        crate::timing::record("gpu_worker_error", serde_json::json!({"operation":"spawn","error_kind":"io_error"}));
        format!("Cannot start Python GPU Whisper: {e}")
    })?;
    crate::timing::record("gpu_worker_spawned", serde_json::json!({"worker_pid":child.id()}));
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                // Only structured, allowlisted metadata is retained. Never raw stderr.
                crate::timing::record_worker_line(&line);
            }
        });
    }

    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if health(client).await {
            crate::timing::record("gpu_worker_available", serde_json::json!({"startup_ms":crate::timing::now_ms().saturating_sub(started_ms)}));
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            crate::timing::record("gpu_worker_error", serde_json::json!({
                "operation":"startup","error_kind":"worker_exited","status":status.code(),
                "startup_ms":crate::timing::now_ms().saturating_sub(started_ms)
            }));
            return Err("GPU Whisper worker exited during startup. Check the local diagnostics for the failure category.".into());
        }
    }
    crate::timing::record("gpu_worker_error", serde_json::json!({"operation":"startup","error_kind":"not_ready","timeout":true,
        "startup_ms":crate::timing::now_ms().saturating_sub(started_ms)}));
    Err("GPU Whisper worker did not start. Check Python, faster-whisper, CUDA libraries, and the cached Large v3 model.".into())
}

pub struct GpuWhisperSTT {
    language: String,
    client: reqwest::Client,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    buffer: Vec<i16>,
    has_speech: bool,
    voiced_samples: usize,
    silence_samples: usize,
    rms_threshold: f64,
    min_voiced_samples: usize,
    sequence: u64,
    is_streaming: bool,
    party_role: String,
    last_speech_ms: u64,
}

impl GpuWhisperSTT {
    pub fn new(party_role: &str) -> Self {
        let is_mic = party_role == "You";
        Self {
            language: "en-US".into(),
            client: reqwest::Client::new(),
            result_tx: None,
            buffer: Vec::new(),
            has_speech: false,
            voiced_samples: 0,
            silence_samples: 0,
            rms_threshold: if is_mic { 250.0 } else { 180.0 },
            min_voiced_samples: if is_mic { SAMPLE_RATE / 2 } else { SAMPLE_RATE / 5 },
            sequence: 0,
            is_streaming: false,
            party_role: party_role.to_string(),
            last_speech_ms: 0,
        }
    }

    fn send_turn(&mut self) {
        if !self.has_speech || self.voiced_samples < self.min_voiced_samples
            || self.buffer.len() < SAMPLE_RATE / 3 {
            self.buffer.clear();
            self.has_speech = false;
            self.voiced_samples = 0;
            self.silence_samples = 0;
            return;
        }
        let samples = std::mem::take(&mut self.buffer);
        self.has_speech = false;
        self.voiced_samples = 0;
        self.silence_samples = 0;
        self.sequence += 1;
        let segment_id = format!("gpu_{}", self.sequence);
        let timestamp_ms = SystemTime::now().duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64).unwrap_or(0);
        let client = self.client.clone();
        let tx = match self.result_tx.as_ref() { Some(tx) => tx.clone(), None => return };
        let language = self.language.clone();
        let party = self.party_role.clone();
        let speech_end_ms = self.last_speech_ms;
        crate::timing::record("stt_submit", serde_json::json!({
            "party": party, "turn": segment_id, "speech_end_ms": speech_end_ms,
            "samples": samples.len()
        }));
        tokio::spawn(async move {
            let mut body = Vec::with_capacity(samples.len() * 2);
            for sample in samples { body.extend_from_slice(&sample.to_le_bytes()); }
            let response = client.post(format!("{ENDPOINT}/transcribe"))
                .timeout(Duration::from_secs(15)).body(body).send().await;
            match response {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(json) => {
                            let text = json["text"].as_str().unwrap_or("").trim();
                            crate::timing::record("stt_final", serde_json::json!({
                                "party": party, "turn": segment_id, "nonempty": !text.is_empty(),
                                "queue_ms":json["diagnostics"]["queue_ms"].as_u64(),
                                "decode_ms":json["diagnostics"]["decode_ms"].as_u64(),
                                "speech_detected":json["diagnostics"]["speech_detected"].as_bool(),
                                "segments_accepted":json["diagnostics"]["segments_accepted"].as_u64(),
                                "segments_rejected":json["diagnostics"]["segments_rejected"].as_u64()
                            }));
                            if !text.is_empty() {
                                let _ = tx.send(TranscriptResult {
                                    text: text.to_string(),
                                    is_final: true,
                                    confidence: 0.95,
                                    timestamp_ms,
                                    speaker: None,
                                    language: Some(language),
                                    segment_id: Some(segment_id),
                                }).await;
                            }
                        }
                        Err(e) => {
                            crate::timing::record("stt_error", serde_json::json!({"party":party,"turn":segment_id,"error_kind":"response_parse"}));
                            log::warn!("GPU Whisper response parse failed: {e}");
                        },
                    }
                }
                Ok(resp) => {
                    crate::timing::record("stt_error", serde_json::json!({"party":party,"turn":segment_id,"error_kind":"http_status","status":resp.status().as_u16()}));
                    log::warn!("GPU Whisper worker returned {}", resp.status());
                },
                Err(e) => {
                    crate::timing::record("stt_error", serde_json::json!({"party":party,"turn":segment_id,"error_kind":if e.is_timeout() {"request_timeout"} else if e.is_connect() {"connection"} else {"request"},"timeout":e.is_timeout()}));
                    log::warn!("GPU Whisper request failed: {e}");
                },
            }
        });
    }
}

#[async_trait]
impl STTProvider for GpuWhisperSTT {
    fn provider_name(&self) -> &str { "Local GPU Whisper" }
    fn provider_type(&self) -> STTProviderType { STTProviderType::GpuWhisper }

    async fn start_stream(&mut self, tx: mpsc::Sender<TranscriptResult>)
        -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        ensure_worker(&self.client).await?;
        self.result_tx = Some(tx);
        self.buffer.clear();
        self.has_speech = false;
        self.voiced_samples = 0;
        self.silence_samples = 0;
        self.sequence = 0;
        self.is_streaming = true;
        Ok(())
    }

    async fn feed_audio(&mut self, chunk: AudioChunk)
        -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || chunk.pcm_data.is_empty() { return Ok(()); }
        let rms = (chunk.pcm_data.iter().map(|&s| (s as f64).powi(2)).sum::<f64>()
            / chunk.pcm_data.len() as f64).sqrt();
        if rms > self.rms_threshold {
            self.last_speech_ms = crate::timing::now_ms();
            self.has_speech = true;
            self.voiced_samples += chunk.pcm_data.len();
            self.silence_samples = 0;
        }
        else if self.has_speech { self.silence_samples += chunk.pcm_data.len(); }
        if self.has_speech { self.buffer.extend_from_slice(&chunk.pcm_data); }
        if self.has_speech && (self.silence_samples >= SILENCE_SAMPLES
            || self.buffer.len() >= MAX_TURN_SAMPLES) { self.send_turn(); }
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.has_speech { self.send_turn(); }
        self.is_streaming = false;
        self.result_tx = None;
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(health(&self.client).await)
    }

    fn set_language(&mut self, language: &str) { self.language = language.to_string(); }
}
