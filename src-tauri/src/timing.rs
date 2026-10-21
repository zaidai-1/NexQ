//! Opt-in local latency trace. Set NEXQ_TIMING_LOG to a JSONL file for a test.
//! No transcript, answer content, credentials, or network telemetry is recorded.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};

static OUTPUT: OnceLock<Option<Mutex<File>>> = OnceLock::new();

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn record(stage: &str, fields: Value) {
    let output = OUTPUT.get_or_init(|| {
        let path = std::env::var_os("NEXQ_TIMING_LOG")?;
        OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new)
    });
    if let Some(output) = output {
        if let Ok(mut file) = output.lock() {
            let _ = writeln!(file, "{}", json!({"stage": stage, "at_ms": now_ms(), "fields": fields}));
        }
    }
}

#[tauri::command]
pub fn record_answer_render(milestone: String, window: tauri::WebviewWindow) {
    if milestone == "first_text" || milestone == "first_sentence" {
        record("answer_rendered", json!({"milestone": milestone, "window": window.label()}));
    }
}
