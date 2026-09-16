use tauri::{AppHandle, State};

use crate::models::PtySessionInfo;
use crate::AppState;

/// The webview never chooses the shell binary and can only start a session
/// inside the open folder; see `Workspace::spawn_dir` for where it starts
/// otherwise. The chosen directory comes back as `PtySessionInfo::cwd`.
///
/// `async` here does not make the body asynchronous — it tells Tauri to run
/// this command off the IPC thread. Spawning forks a shell and writes the
/// shell-integration rc files, which is not work to do on the thread that
/// paints the window.
#[tauri::command(rename_all = "snake_case", async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    // `shell` is a well-known name ("cmd", "powershell", "pwsh", "zsh", …) or a
    // path; empty or absent means the platform default.
    shell: Option<String>,
) -> Result<PtySessionInfo, String> {
    let cwd = state
        .workspace
        .spawn_dir(cwd.as_deref())
        .to_string_lossy()
        .to_string();
    state.pty_manager.spawn(app, cols, rows, Some(cwd), shell)
}

/// Stays synchronous on purpose: the manager hands the bytes to the session's
/// writer thread and returns, so there is nothing here to block on.
#[tauri::command(rename_all = "snake_case")]
pub fn pty_write(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&session_id, &data)
}

/// Reap sessions the frontend does not claim — see `PtyManager::retain_only`.
/// Async because killing a shell waits for the child in 50ms steps and a
/// reload can leave several behind.
#[tauri::command(rename_all = "snake_case", async)]
pub fn pty_retain_only(state: State<AppState>, session_ids: Vec<String>) -> Result<usize, String> {
    Ok(state.pty_manager.retain_only(&session_ids))
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

/// Also off the IPC thread: portable-pty's `kill` waits for the child in 50ms
/// steps, and closing a group kills its terminals one after another.
#[tauri::command(rename_all = "snake_case", async)]
pub fn pty_kill(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.pty_manager.kill(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_list_sessions(state: State<AppState>) -> Result<Vec<PtySessionInfo>, String> {
    Ok(state.pty_manager.list_sessions())
}
