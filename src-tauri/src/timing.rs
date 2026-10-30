//! Local, content-free diagnostics for ordinary launches and controlled tests.
//! Default logs rotate at 2 MiB and retain eight sessions. An explicit
//! NEXQ_TIMING_LOG keeps the existing single-file test trace behavior.
//! Transcript, answer, audio, credentials, and exception messages are excluded.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};

const MAX_SESSION_BYTES: u64 = 2 * 1024 * 1024;
const RETAIN_SESSIONS: usize = 8;
const WORKER_PREFIX: &str = "NEXQ_DIAGNOSTIC ";
static OUTPUT: OnceLock<Option<Mutex<DiagnosticLog>>> = OnceLock::new();

struct DiagnosticLog {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    limit: Option<u64>,
}

impl DiagnosticLog {
    fn open(path: PathBuf, limit: Option<u64>) -> io::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self { path, file: Some(file), bytes, limit })
    }

    fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
        if self.limit.is_some_and(|limit| self.bytes + line.len() as u64 > limit) {
            // Close the handle before renaming on Windows. Keep one prior part.
            self.file.take();
            let backup = self.path.with_extension("jsonl.1");
            match std::fs::remove_file(&backup) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
            std::fs::rename(&self.path, &backup)?;
            self.file = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
            self.bytes = 0;
        }
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("diagnostic log unavailable"))?;
        file.write_all(line)?;
        self.bytes += line.len() as u64;
        Ok(())
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn default_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let root = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let root = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
    });
    root.map(|root| root.join("com.nexq.app").join("diagnostics"))
}

fn session_name(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl.1").or_else(|| name.strip_suffix(".jsonl"))?;
    let parts = stem.strip_prefix("timing-")?.split('-').collect::<Vec<_>>();
    (parts.len() == 2 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())))
        .then_some(stem)
}

fn prune_sessions(directory: &Path, current: &Path, retain: usize) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    let mut sessions = std::collections::BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(session) = session_name(name) else { continue };
        let path = entry.path();
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) { continue; }
        sessions.entry(session.to_string()).or_insert_with(Vec::new).push(path);
    }
    let excess = sessions.len().saturating_sub(retain);
    // Timestamp-prefixed names sort by creation time. Never prune unrelated files.
    for (_, files) in sessions.into_iter().take(excess) {
        for path in files {
            if path != current { let _ = std::fs::remove_file(path); }
        }
    }
}

fn open_output() -> Option<Mutex<DiagnosticLog>> {
    let explicit = std::env::var_os("NEXQ_TIMING_LOG").filter(|path| !path.is_empty());
    let (path, limit) = if let Some(path) = explicit {
        (PathBuf::from(path), None)
    } else {
        let directory = default_directory()?;
        std::fs::create_dir_all(&directory).ok()?;
        let path = directory.join(format!("timing-{}-{}.jsonl", now_ms(), std::process::id()));
        (path, Some(MAX_SESSION_BYTES))
    };
    let mut output = DiagnosticLog::open(path, limit).ok()?;
    if limit.is_some() {
        if let Some(parent) = output.path.parent() {
            prune_sessions(parent, &output.path, RETAIN_SESSIONS);
        }
    }
    let header = format!("{}\n", json!({"stage":"diagnostics_started", "at_ms":now_ms(),
        "pid":std::process::id(), "fields":{"schema":1,"version":env!("CARGO_PKG_VERSION")}}));
    let _ = output.write_line(header.as_bytes());
    Some(Mutex::new(output))
}

fn safe_fields(fields: Value) -> Value {
    let mut safe = serde_json::Map::new();
    if let Value::Object(fields) = fields {
        for (key, value) in fields {
            let allowed = match key.as_str() {
                "model" | "mode" | "party" | "turn" | "milestone" | "window" | "operation" | "error_kind" => {
                    value.as_str().is_some_and(|value| value.len() <= 128 && !value.chars().any(char::is_control))
                }
                "speech_end_ms" | "samples" | "generation_ms" | "chunks" | "status" | "worker_pid"
                | "startup_ms" | "queue_ms" | "decode_ms" | "segments_accepted" | "segments_rejected" => value.is_u64(),
                "nonempty" | "speech_detected" | "timeout" => value.is_boolean(),
                _ => false,
            };
            if allowed { safe.insert(key, value); }
        }
    }
    Value::Object(safe)
}

pub fn record(stage: &str, fields: Value) {
    let output = OUTPUT.get_or_init(open_output);
    if let Some(output) = output {
        if let Ok(mut file) = output.lock() {
            let line = format!("{}\n", json!({"stage":stage,"at_ms":now_ms(),
                "pid":std::process::id(),"fields":safe_fields(fields)}));
            let _ = file.write_line(line.as_bytes());
        }
    }
}

fn parse_worker_diagnostic(line: &str) -> Option<(String, Value)> {
    if line.len() > 4096 { return None; }
    let message: Value = serde_json::from_str(line.strip_prefix(WORKER_PREFIX)?).ok()?;
    let stage = message.get("stage")?.as_str()?;
    if !matches!(stage, "gpu_worker_starting" | "gpu_worker_model_fallback" | "gpu_worker_ready"
        | "gpu_worker_error" | "gpu_worker_transcription_error") { return None; }
    Some((stage.to_string(), safe_fields(message.get("fields").cloned().unwrap_or(Value::Null))))
}

/// Ignore raw Python stderr, which may contain paths or exception payloads.
pub fn record_worker_line(line: &str) {
    if let Some((stage, fields)) = parse_worker_diagnostic(line) { record(&stage, fields); }
}

#[tauri::command]
pub fn record_answer_render(milestone: String, window: tauri::WebviewWindow) {
    if milestone == "first_text" || milestone == "first_sentence" {
        record("answer_rendered", json!({"milestone": milestone, "window": window.label()}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("nexq-diagnostics-test-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rotates_at_limit_and_keeps_only_one_previous_part() {
        let directory = test_directory();
        let path = directory.join("timing-100-1.jsonl");
        let mut output = DiagnosticLog::open(path.clone(), Some(8)).unwrap();
        output.write_line(b"111\n").unwrap();
        output.write_line(b"222\n").unwrap();
        output.write_line(b"333\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"333\n");
        assert_eq!(std::fs::read(path.with_extension("jsonl.1")).unwrap(), b"111\n222\n");
        output.write_line(b"4444\n").unwrap();
        assert_eq!(std::fs::read(path.with_extension("jsonl.1")).unwrap(), b"333\n");
        drop(output);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prunes_old_sessions_and_their_rotations_without_touching_other_files() {
        let directory = test_directory();
        for name in ["timing-100-1.jsonl", "timing-100-1.jsonl.1", "timing-200-2.jsonl", "timing-300-3.jsonl", "notes.txt", "timing-secret.jsonl"] {
            std::fs::write(directory.join(name), b"test").unwrap();
        }
        let current = directory.join("timing-300-3.jsonl");
        prune_sessions(&directory, &current, 2);
        assert!(!directory.join("timing-100-1.jsonl").exists());
        assert!(!directory.join("timing-100-1.jsonl.1").exists());
        assert!(directory.join("timing-200-2.jsonl").exists());
        assert!(current.exists());
        assert!(directory.join("notes.txt").exists());
        assert!(directory.join("timing-secret.jsonl").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn discards_content_and_raw_worker_errors() {
        assert!(parse_worker_diagnostic("RuntimeError: private transcript").is_none());
        assert!(parse_worker_diagnostic("NEXQ_DIAGNOSTIC {\"stage\":\"private transcript\"}").is_none());
        let (_, fields) = parse_worker_diagnostic("NEXQ_DIAGNOSTIC {\"stage\":\"gpu_worker_transcription_error\",\"fields\":{\"error_kind\":\"RuntimeError\",\"operation\":\"decode\",\"text\":\"private transcript\",\"error\":\"private path\",\"queue_ms\":24}}").unwrap();
        assert_eq!(fields, json!({"error_kind":"RuntimeError","operation":"decode","queue_ms":24}));
        assert_eq!(safe_fields(json!({"prompt":"secret","audio":[1,2],"samples":16000,"decode_ms":"secret"})), json!({"samples":16000}));
    }
}
