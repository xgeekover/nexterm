use tauri::{AppHandle, State};

use crate::models::PtySessionInfo;
use crate::AppState;

/// The webview never chooses the shell binary and can only start a session
/// inside the workspace root; anything else falls back to the root itself.
#[tauri::command(rename_all = "snake_case")]
pub fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<PtySessionInfo, String> {
    let root = state.workspace.root();
    let cwd = cwd
        .as_deref()
        .and_then(|c| state.workspace.confine(c).ok())
        .filter(|p| p.is_dir())
        .unwrap_or(root)
        .to_string_lossy()
        .to_string();
    state.pty_manager.spawn(app, cols, rows, Some(cwd), None)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_write(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&session_id, &data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_resize(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&session_id, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_kill(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.pty_manager.kill(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_list_sessions(state: State<AppState>) -> Result<Vec<PtySessionInfo>, String> {
    Ok(state.pty_manager.list_sessions())
}
