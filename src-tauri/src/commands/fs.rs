use crate::fs;
use crate::models::FileNode;
use crate::AppState;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Resolve a webview-supplied path against the active workspace root,
/// refusing anything that escapes it (`..`, absolute paths, symlinks).
fn confined(state: &State<AppState>, path: &str) -> Result<String, String> {
    Ok(state.workspace.confine(path)?.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_get_root(state: State<AppState>) -> Result<String, String> {
    Ok(state.workspace.root().to_string_lossy().to_string())
}

/// Change the workspace root through a native folder picker. This is the only
/// way the root can move, so the webview cannot widen its own access.
#[tauri::command(rename_all = "snake_case")]
pub fn fs_pick_root(app: AppHandle, state: State<AppState>) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("Invalid folder selection: {e}"))?;
    let root = state.workspace.set_root(&path)?;
    let root_str = root.to_string_lossy().to_string();
    state.fs_watcher.start_watching(app.clone(), &root_str)?;
    Ok(Some(root_str))
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_read_dir(
    state: State<AppState>,
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    fs::read_dir_hierarchy(&confined(&state, &path)?, max_depth)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_read_file(state: State<AppState>, path: String) -> Result<String, String> {
    fs::read_file(&confined(&state, &path)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_write_file(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    fs::write_file(&confined(&state, &path)?, &content)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_create_file(state: State<AppState>, path: String) -> Result<(), String> {
    fs::create_file(&confined(&state, &path)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_create_dir(state: State<AppState>, path: String) -> Result<(), String> {
    fs::create_dir(&confined(&state, &path)?)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_delete_path(
    state: State<AppState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let target = confined(&state, &path)?;
    // Never allow the root itself to be deleted through the IPC surface.
    if target == state.workspace.root().to_string_lossy() {
        return Err("Refusing to delete the workspace root".to_string());
    }
    fs::delete_path(&target, recursive.unwrap_or(false))
}
