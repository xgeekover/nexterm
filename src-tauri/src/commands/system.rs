use crate::models::SystemInfo;
use crate::pty::PtyManager;

#[tauri::command(rename_all = "snake_case")]
pub fn system_get_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let default_shell = PtyManager::default_shell();
    let home_dir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string());

    Ok(SystemInfo {
        os: if os == "macos" || os == "darwin" {
            "macos".to_string()
        } else {
            os
        },
        default_shell,
        home_dir,
        arch: Some(arch),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        tauri_version: Some("2.11.5".to_string()),
        rust_version: Some("1.97.1".to_string()),
    })
}
