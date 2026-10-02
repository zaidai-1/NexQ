//! Local GPU Whisper provider. Sends complete speech turns to a persistent
//! Faster Whisper worker on loopback; audio never leaves this PC.

use async_trait::async_trait;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
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
    if health(client).await { return Ok(()); }

    let script = std::env::temp_dir().join("nexq_gpu_whisper_worker.py");
    std::fs::write(&script, include_str!("gpu_whisper_worker.py"))
        .map_err(|e| format!("Cannot write GPU Whisper worker: {e}"))?;
    let mut command = Command::new("python");
    command.arg(&script).arg(std::process::id().to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.spawn().map_err(|e| format!("Cannot start Python GPU Whisper: {e}"))?;

    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if health(client).await { return Ok(()); }
    }
    Err("GPU Whisper worker did not start. Check Python, faster-whisper, CUDA libraries, and the cached Large v3 model.".into())
}

pub struct GpuWhisperSTT {
    language: String,
    client: reqwest::Client,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    start_time: Option<Instant>,
    buffer: Vec<i16>,
    has_speech: bool,
    silence_samples: usize,
    sequence: u64,
    is_streaming: bool,
}

impl GpuWhisperSTT {
    pub fn new() -> Self {
        Self {
            language: "en-US".into(),
            client: reqwest::Client::new(),
            result_tx: None,
            start_time: None,
            buffer: Vec::new(),
            has_speech: false,
            silence_samples: 0,
            sequence: 0,
            is_streaming: false,
        }
    }

    fn send_turn(&mut self) {
        if !self.has_speech || self.buffer.len() < SAMPLE_RATE / 3 {
            self.buffer.clear();
            self.has_speech = false;
            self.silence_samples = 0;
            return;
        }
        let samples = std::mem::take(&mut self.buffer);
        self.has_speech = false;
        self.silence_samples = 0;
        self.sequence += 1;
        let segment_id = format!("gpu_{}", self.sequence);
        let timestamp_ms = self.start_time.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
        let client = self.client.clone();
        let tx = match self.result_tx.as_ref() { Some(tx) => tx.clone(), None => return };
        let language = self.language.clone();
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
                        Err(e) => log::warn!("GPU Whisper response parse failed: {e}"),
                    }
                }
                Ok(resp) => log::warn!("GPU Whisper worker returned {}", resp.status()),
                Err(e) => log::warn!("GPU Whisper request failed: {e}"),
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
        self.start_time = Some(Instant::now());
        self.buffer.clear();
        self.has_speech = false;
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
        if rms > 180.0 { self.has_speech = true; self.silence_samples = 0; }
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
