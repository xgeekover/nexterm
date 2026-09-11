#![deny(warnings)]

pub mod agent;
pub mod commands;
pub mod fs;
pub mod models;
pub mod pty;

use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub pty_manager: Arc<pty::PtyManager>,
    pub fs_watcher: Arc<fs::FsWatcherManager>,
    pub agent_runtime: Arc<agent::AgentRuntime>,
    pub workspace: Arc<fs::Workspace>,
}

fn main() {
    let pty_manager = Arc::new(pty::PtyManager::new());
    let fs_watcher = Arc::new(fs::FsWatcherManager::new());
    let agent_runtime = Arc::new(agent::AgentRuntime::new());
    let workspace = Arc::new(fs::Workspace::new());

    let state = AppState {
        pty_manager,
        fs_watcher,
        agent_runtime,
        workspace,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            let app_state = app.state::<AppState>();
            let root = app_state.workspace.root();
            let _ = app_state
                .fs_watcher
                .start_watching(app.handle().clone(), &root.to_string_lossy());
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
            commands::agent::agent_list,
            commands::agent::agent_create,
            commands::agent::agent_update_status,
            commands::agent::agent_get_logs,
            commands::agent::chat_send_message,
            commands::system::system_get_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexterm application");
}
