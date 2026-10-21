use tauri::{command, AppHandle, Manager};

/// Apply capture exclusion to both the overlay and the launcher/history window.
///
/// When enabled, the overlay window is excluded from screen captures and recordings
/// using the Windows API `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`.
///
/// Capture applications must honor Windows display affinity; this cannot
/// guarantee exclusion from every recording or screen-sharing implementation.
#[command]
pub async fn set_stealth_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    protect_windows(&app, enabled)
}

pub fn protect_windows(app: &AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowDisplayAffinity, SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
        };

        for label in ["overlay", "launcher"] {
        let window = app.get_webview_window(label)
            .ok_or_else(|| format!("{label} window not found"))?;
        // In Tauri 2, hwnd() is a direct method on WebviewWindow.
        let hwnd_raw = window
            .hwnd()
            .map_err(|e| format!("Failed to get window handle: {}", e))?;

        let hwnd = HWND(hwnd_raw.0 as *mut _);

        // WDA_EXCLUDEFROMCAPTURE = 0x00000011 (Windows 10 v2004+)
        // WDA_NONE = 0x00000000
        let affinity = if enabled {
            WINDOW_DISPLAY_AFFINITY(0x00000011)
        } else {
            WINDOW_DISPLAY_AFFINITY(0x00000000)
        };

        unsafe {
            SetWindowDisplayAffinity(hwnd, affinity)
                .map_err(|e| format!("Failed to protect {label} from capture: {e}"))?;
            let mut actual = 0u32;
            GetWindowDisplayAffinity(hwnd, &mut actual)
                .map_err(|e| format!("Failed to verify capture protection for {label}: {e}"))?;
            if actual != affinity.0 {
                return Err(format!("Capture protection was not applied to {label}"));
            }
        }
        }

        log::info!(
            "Stealth mode {}: overlay window {} from capture",
            if enabled { "enabled" } else { "disabled" },
            if enabled { "excluded" } else { "included" }
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        if enabled {
            log::warn!("Stealth mode is only supported on Windows");
            return Err("Stealth mode is only supported on Windows".to_string());
        }
    }

    Ok(())
}
