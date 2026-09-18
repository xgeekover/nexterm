use crate::fs;
use crate::models::FileNode;
use crate::AppState;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Resolve a webview-supplied path against the open folder, refusing anything
/// that escapes it (`..`, absolute paths, symlinks) — and everything while no
/// folder is open.
fn confined(state: &State<AppState>, path: &str) -> Result<String, String> {
    Ok(state.workspace.confine(path)?.to_string_lossy().to_string())
}

/// Whether `path` is the open folder itself.
fn is_root(state: &State<AppState>, path: &str) -> bool {
    state
        .workspace
        .root()
        .is_some_and(|root| root.to_string_lossy() == path)
}

/// Search the open folder's files.
///
/// Confined by construction: the walk starts at the workspace root, so there
/// is no webview-supplied path to confine in the first place. Every cap lives
/// in `fs::search` and what was cut comes back in `truncated` rather than
/// being dropped quietly.
#[tauri::command(rename_all = "snake_case")]
pub fn fs_search(
    state: State<AppState>,
    query: String,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    regex: Option<bool>,
) -> Result<fs::search::SearchResults, String> {
    let root = fs::search::root_of(state.workspace.root())?;
    fs::search::search(
        &root,
        &query,
        fs::search::SearchOptions {
            case_sensitive: case_sensitive.unwrap_or(false),
            whole_word: whole_word.unwrap_or(false),
            regex: regex.unwrap_or(false),
        },
    )
}

/// The open folder, or `null` until one has been opened.
#[tauri::command(rename_all = "snake_case")]
pub fn fs_get_root(state: State<AppState>) -> Result<Option<String>, String> {
    Ok(state
        .workspace
        .root()
        .map(|root| root.to_string_lossy().to_string()))
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

/// Rename or move a path. Both ends are confined, so this cannot be used to
/// lift a file out of the workspace or pull one in.
#[tauri::command(rename_all = "snake_case")]
pub fn fs_rename_path(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let from_abs = confined(&state, &from)?;
    let to_abs = confined(&state, &to)?;
    if is_root(&state, &from_abs) || is_root(&state, &to_abs) {
        return Err("Refusing to rename the workspace root".to_string());
    }
    fs::rename_path(&from_abs, &to_abs)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fs_delete_path(
    state: State<AppState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let target = confined(&state, &path)?;
    // Never allow the root itself to be deleted through the IPC surface.
    if is_root(&state, &target) {
        return Err("Refusing to delete the workspace root".to_string());
    }
    fs::delete_path(&target, recursive.unwrap_or(false))
}
