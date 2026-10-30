//! One NexQ process per Windows user/session, including native and packaged launches.

use sha2::{Digest, Sha256};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Manager, Resource, Runtime};
use windows::{core::PCWSTR, Win32::{
    Foundation::{GetLastError, HANDLE, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0},
    Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
    System::Threading::{CreateEventW, CreateMutexW, GetCurrentProcess, OpenProcessToken,
        SetEvent, WaitForSingleObject, INFINITE},
}};

struct InstanceGuard {
    // A named mutex exists as long as its last handle remains open. There is
    // no thread ownership: the object itself is our atomic process lease.
    _mutex: OwnedHandle,
    activate: Arc<OwnedHandle>,
    listening: Arc<AtomicBool>,
}

impl Resource for InstanceGuard {}

fn owned(handle: HANDLE) -> OwnedHandle {
    // All callers pass a successful, newly returned kernel handle.
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn user_key() -> windows::core::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token = owned(token);
        let mut length = 0;
        let _ = GetTokenInformation(HANDLE(token.as_raw_handle()), TokenUser, None, 0, &mut length);
        // TOKEN_USER contains pointers, so keep the output pointer-aligned.
        let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        GetTokenInformation(HANDLE(token.as_raw_handle()), TokenUser,
            Some(buffer.as_mut_ptr().cast()), length, &mut length)?;
        let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
        let sid = std::slice::from_raw_parts(user.User.Sid.0.cast::<u8>(), GetLengthSid(user.User.Sid) as usize);
        Ok(format!("{:x}", Sha256::digest(sid)))
    }
}

impl InstanceGuard {
    fn acquire(name: &str) -> windows::core::Result<Option<Self>> {
        let event_name = wide(&format!("{name}.activate"));
        let mutex_name = wide(&format!("{name}.process"));
        unsafe {
            // Publish the event first. A second launch during startup can set
            // it before our listener exists; the auto-reset event retains it.
            let activate = owned(CreateEventW(None, false, false, PCWSTR(event_name.as_ptr()))?);
            let mutex = CreateMutexW(None, false, PCWSTR(mutex_name.as_ptr()))?;
            let already_exists = GetLastError() == ERROR_ALREADY_EXISTS;
            let mutex = owned(mutex);
            if already_exists {
                SetEvent(HANDLE(activate.as_raw_handle()))?;
                return Ok(None);
            }
            Ok(Some(Self {
                _mutex: mutex,
                activate: Arc::new(activate),
                listening: Arc::new(AtomicBool::new(true)),
            }))
        }
    }

    fn listen<R: Runtime>(&self, app: AppHandle<R>) {
        let event = self.activate.clone();
        let listening = self.listening.clone();
        std::thread::spawn(move || {
            while unsafe { WaitForSingleObject(HANDLE(event.as_raw_handle()), INFINITE) } == WAIT_OBJECT_0 {
                if !listening.load(Ordering::Acquire) { break; }
                let focus_app = app.clone();
                let _ = app.run_on_main_thread(move || focus_existing(&focus_app));
            }
        });
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.listening.store(false, Ordering::Release);
        // Wake the listener so it releases its event handle during exit/restart.
        unsafe { let _ = SetEvent(HANDLE(self.activate.as_raw_handle())); }
    }
}

fn focus_label(meeting_active: bool, overlay_visible: bool, overlay_exists: bool) -> &'static str {
    if overlay_exists && (meeting_active || overlay_visible) { "overlay" } else { "launcher" }
}

fn focus_existing<R: Runtime>(app: &AppHandle<R>) {
    let meeting_active = app.try_state::<crate::state::AppState>()
        .and_then(|state| state.tray_manager.try_lock().ok()
            .map(|manager| manager.as_ref().is_some_and(|manager| manager.meeting_active)))
        .unwrap_or(false);
    let overlay = app.get_webview_window("overlay");
    let label = focus_label(meeting_active,
        overlay.as_ref().is_some_and(|window| window.is_visible().unwrap_or(false)),
        overlay.is_some());
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()) {
            log::warn!("Could not restore existing {label} window: {error}");
        }
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("single-instance")
        .setup(|app, _| {
            let name = format!("Local\\com.nexq.app.{}", user_key()?);
            match InstanceGuard::acquire(&name)? {
                Some(guard) => {
                    log::info!("Single-instance lease acquired (pid={})", std::process::id());
                    guard.listen(app.clone());
                    // Resource cleanup releases the lease on normal exit and
                    // restart; a process crash closes kernel handles as well.
                    app.resources_table().add(guard);
                }
                None => {
                    log::info!("Another NexQ process owns this session; requested activation and exiting");
                    std::process::exit(0);
                }
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_focus_keeps_active_meeting() {
        assert_eq!(focus_label(true, false, true), "overlay");
        assert_eq!(focus_label(false, true, true), "overlay");
        assert_eq!(focus_label(false, false, true), "launcher");
        assert_eq!(focus_label(true, false, false), "launcher");
    }

    #[test]
    fn single_instance_relaunch_signals_existing_process_and_releases_on_exit() {
        let name = format!("Local\\NexQ.test.{}", uuid::Uuid::new_v4());
        let primary = InstanceGuard::acquire(&name).unwrap().expect("first process");
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "single_instance::tests::single_instance_child_probe", "--ignored", "--nocapture"])
            .env("NEXQ_SINGLE_INSTANCE_TEST_NAME", &name)
            .output().unwrap();
        assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stderr));
        assert!(String::from_utf8_lossy(&child.stdout).contains("SECONDARY_EXIT"));
        // The activation was sent before any listener started, covering startup.
        assert_eq!(unsafe { WaitForSingleObject(HANDLE(primary.activate.as_raw_handle()), 0) }, WAIT_OBJECT_0);
        drop(primary);
        assert!(InstanceGuard::acquire(&name).unwrap().is_some(), "lease should release");
    }

    #[test]
    #[ignore = "spawned by the cross-process single-instance test"]
    fn single_instance_child_probe() {
        let name = std::env::var("NEXQ_SINGLE_INSTANCE_TEST_NAME").expect("parent test name");
        assert!(InstanceGuard::acquire(&name).unwrap().is_none());
        println!("SECONDARY_EXIT");
    }
}
