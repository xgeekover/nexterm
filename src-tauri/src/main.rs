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
            let app_state = app.state::<AppState>();
            let root = app_state.workspace.root();
            let _ = app_state
                .fs_watcher
                .start_watching(app.handle().clone(), &root.to_string_lossy());

            // Native menu; app-specific items are forwarded to the webview by id.
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|handle, event| {
                menu::forward_to_webview(handle, event.id().as_ref());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_list_sessions,
            commands::fs::fs_get_root,
            commands::fs::fs_pick_root,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_delete_path,
            commands::system::system_get_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexterm application");
}
