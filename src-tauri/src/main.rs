// Windows links a Rust binary as a CONSOLE application unless told otherwise,
// and then opens a console for it — the empty black terminal window that
// appeared beside NexTerm when the portable build was run. Tauri's own
// template carries this line; this project lost it.
//
// Kept for debug builds so `cargo run` and `tauri dev` still have somewhere to
// print: without a console there, every println! and eprintln! in the backend
// would go nowhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(warnings)]

pub mod commands;
pub mod fs;
pub mod menu;
pub mod models;
pub mod pty;

use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub pty_manager: Arc<pty::PtyManager>,
    pub fs_watcher: Arc<fs::FsWatcherManager>,
    pub workspace: Arc<fs::Workspace>,
}

fn main() {
    let pty_manager = Arc::new(pty::PtyManager::new());
    let fs_watcher = Arc::new(fs::FsWatcherManager::new());
    let workspace = Arc::new(fs::Workspace::new());

    let state = AppState {
        pty_manager,
        fs_watcher,
        workspace,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state)
        .setup(|app| {
            // No folder is open at launch; `fs_pick_root` starts watching the
            // one the user opens.
            let app_state = app.state::<AppState>();
            if let Some(root) = app_state.workspace.root() {
                let _ = app_state
                    .fs_watcher
                    .start_watching(app.handle().clone(), &root.to_string_lossy());
            }

            // macOS always has a menu bar at the top of the screen, so the
            // native menu is the right place for it there, and app-specific
            // items are forwarded to the webview by id.
            //
            // Off macOS the window is frameless (see tauri.windows.conf.json)
            // and the app draws one compact title row containing its own menu,
            // VS Code style. A native menu there would add a second row and
            // re-introduce the accelerator collisions `terminal_safe` exists
            // to avoid, so there isn't one.
            #[cfg(target_os = "macos")]
            {
                let menu = menu::build(app.handle())?;
                app.set_menu(menu)?;
                app.on_menu_event(|handle, event| {
                    menu::forward_to_webview(handle, event.id().as_ref());
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_retain_only,
            commands::pty::pty_list_sessions,
            commands::fs::fs_get_root,
            commands::fs::fs_pick_root,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename_path,
            commands::fs::fs_delete_path,
            commands::system::system_get_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexterm application");
}

/// The attribute that keeps Windows from opening a console beside the app.
///
/// Checked as source text because there is nothing to check at runtime: the
/// subsystem is decided by the linker, `cargo test` always runs with a console
/// attached, and on macOS and Linux the attribute does nothing at all. So
/// deleting it breaks only Windows, only in release builds, and nothing else
/// here would notice — which is how it went missing in the first place, and
/// why the portable build shipped with an empty black terminal window next to
/// it.
#[cfg(test)]
mod windows_subsystem_tests {
    #[test]
    fn release_builds_do_not_get_a_console_window() {
        let main_rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("main.rs"),
        )
        .expect("main.rs is readable");

        let attribute = main_rs
            .lines()
            .find(|line| line.contains("windows_subsystem"))
            .unwrap_or_else(|| {
                panic!(
                    "main.rs has no `windows_subsystem` attribute — a release build on Windows \
                     will open an empty console window beside the app"
                )
            });

        assert!(
            attribute.contains("windows_subsystem = \"windows\""),
            "the subsystem must be `windows`, not a console: {attribute}"
        );
        assert!(
            attribute.contains("not(debug_assertions)"),
            "keep it to release builds so `tauri dev` still has somewhere to print: {attribute}"
        );
        assert!(
            attribute.trim_start().starts_with("#!["),
            "it has to be an inner attribute on the crate root: {attribute}"
        );
    }
}
