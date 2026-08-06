#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    disable_dmabuf_on_nvidia();

    jterm_lib::run()
}

/// Work around WebKitGTK rendering nothing at all on NVIDIA's driver.
///
/// WebKitGTK's DMABUF renderer produces an empty window — correct size,
/// correct decorations, no content — on the proprietary NVIDIA driver.
/// Launched from a shell that happens to export
/// `WEBKIT_DISABLE_DMABUF_RENDERER` the app is fine, and launched from the
/// desktop menu it is a grey rectangle, which is a miserable thing to debug
/// because the binary is identical and only the environment differs.
///
/// So the app sets it for itself, rather than relying on a wrapper script or
/// an `Exec=env …` line in a desktop entry that only exists if this project's
/// own installer wrote it.
///
/// Two guards keep this from being a blunt instrument: an explicit setting
/// from the user always wins, and the fallback is only taken when the NVIDIA
/// driver is actually loaded. On hardware where the DMABUF path works it is
/// left alone, because it is the faster one.
#[cfg(target_os = "linux")]
fn disable_dmabuf_on_nvidia() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    if std::env::var_os(VAR).is_some() {
        return;
    }
    // Present exactly when the proprietary kernel module is loaded.
    if !std::path::Path::new("/dev/nvidiactl").exists() {
        return;
    }
    // Must happen before GTK or WebKit initialise, which is why it is here and
    // not in `run()`; at this point the process is still single-threaded.
    std::env::set_var(VAR, "1");
}
