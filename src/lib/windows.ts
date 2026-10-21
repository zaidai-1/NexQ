/**
 * Window switching helpers for the two-window Tauri layout.
 *
 * Keeping show/hide/focus in one place prevents the React view state from
 * drifting away from the actual native windows.
 */
async function protectWindowsBeforeShowing(): Promise<void> {
  if (navigator.userAgent.includes("Windows")) {
    const { setStealthMode } = await import("./ipc");
    // Fail before showing when Windows refuses capture exclusion.
    try {
      await setStealthMode(true);
    } catch (error) {
      const { showToast } = await import('../stores/toastStore');
      showToast('Capture protection could not be verified. NexQ was not shown. Share only the intended application window.', 'error');
      throw error;
    }
  }
}

export async function showLauncherWindow(): Promise<void> {
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const launcher = await WebviewWindow.getByLabel("launcher");

  if (launcher) {
    await protectWindowsBeforeShowing();
    await launcher.show().catch(() => {});
    await launcher.unminimize().catch(() => {});
    await launcher.setFocus().catch(() => {});
  }

  if (current.label === "overlay") {
    await current.hide().catch(() => {});
  }
}

export async function showOverlayWindow(): Promise<void> {
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const overlay = await WebviewWindow.getByLabel("overlay");

  if (overlay) {
    await protectWindowsBeforeShowing();
    await overlay.show().catch(() => {});
    await overlay.unminimize().catch(() => {});
    await overlay.setFocus().catch(() => {});
  }

  if (current.label === "launcher") {
    await current.hide().catch(() => {});
  }
}
