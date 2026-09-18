use crate::models::SystemInfo;
use crate::pty::shells::{self, ShellProfile};
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
        os_build: os_build(),
    })
}

/// The shells this machine actually has, for the profile picker.
///
/// Found rather than assumed: the Settings window used to offer a fixed list
/// per platform, which promised "PowerShell 7" on boxes without it and never
/// mentioned Git Bash or WSL. An empty list is a legitimate answer — the caller
/// still has "Default".
#[tauri::command(rename_all = "snake_case")]
pub fn system_list_shells() -> Result<Vec<ShellProfile>, String> {
    Ok(shells::list())
}

/// The Windows build number, as the registry records it (e.g. 19045).
#[cfg(windows)]
fn os_build() -> Option<u32> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok()?;
    let build: String = key.get_value("CurrentBuildNumber").ok()?;
    build.trim().parse().ok()
}

#[cfg(not(windows))]
fn os_build() -> Option<u32> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn reports_the_windows_build_this_machine_runs() {
        let build = os_build().expect("CurrentBuildNumber is readable on every Windows install");
        // Windows 10 RTM was 10240; nothing older runs WebView2.
        assert!(build >= 10240, "implausible Windows build {build}");
    }
}

/// Re-register the native menu with the accelerators the user has bound.
///
/// The menu is built once at startup from `menu::spec`, so a shortcut rebound
/// in Settings changed what the key did while the menu went on printing the
/// old chord beside it — the same "the label and the handler disagree" bug
/// this app has already shipped twice, just in the other direction.
///
/// macOS only: it is the only platform where a native menu is installed (see
/// `main.rs`). Elsewhere the app draws its own menu from the same data the
/// keybindings come from, so there is nothing to synchronise.
#[tauri::command(rename_all = "snake_case")]
pub fn menu_set_accelerators(
    app: tauri::AppHandle,
    accelerators: std::collections::HashMap<String, Option<String>>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = crate::menu::build_with(&app, &accelerators)
            .map_err(|e| format!("could not rebuild the menu: {e}"))?;
        app.set_menu(menu).map_err(|e| format!("could not install the menu: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, accelerators);
    }
    Ok(())
}
