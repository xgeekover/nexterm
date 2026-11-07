//! The saved scrollback's commands (src/scrollback.rs, which says what is
//! kept where and what is refused). Each is the module's function on the
//! app's local data folder, nothing more: the webview names a tab, never a
//! path.
//!
//! Every one runs on the blocking pool. They touch the disk — a write is up
//! to 2 MiB, a sweep looks through the whole folder, and each one may wait
//! for another to let go of the module's lock — and on the event-loop thread
//! that would hold the window's painting for as long as it takes; on an
//! async worker it would hold one every other command shares (see
//! commands/fs.rs).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::scrollback;

/// The app's local data folder — never the roaming one; see src/scrollback.rs.
fn local_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("There is no local app data folder to keep scrollback in: {e}"))
}

async fn on_the_blocking_pool<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("The saved scrollback stopped unexpectedly: {e}"))
}

/// Save `content`, a terminal's whole file as the page makes it, as tab
/// `tab_id`'s scrollback, replacing the last save. Refused for an id that is
/// not `tab-term-<n>` and for more than 2 MiB of UTF-8; then the least
/// recently written files go until all of them are within 50 MiB.
#[tauri::command(rename_all = "snake_case")]
pub async fn scrollback_write(app: AppHandle, tab_id: String, content: String) -> Result<(), String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || scrollback::write(&base, &tab_id, &content)).await?
}

/// Tab `tab_id`'s saved scrollback, or `null` when there is none to restore —
/// also when the file is a link, not a regular file, over 2 MiB or not UTF-8
/// (logged). Only an id that is not `tab-term-<n>` is an error.
#[tauri::command(rename_all = "snake_case")]
pub async fn scrollback_read(app: AppHandle, tab_id: String) -> Result<Option<String>, String> {
    let base = match local_data(&app) {
        Ok(base) => base,
        Err(why) => {
            eprintln!("[NexTerm] No saved scrollback is restored: {why}");
            return Ok(None);
        }
    };
    on_the_blocking_pool(move || scrollback::read(&base, &tab_id)).await?
}

/// Delete tab `tab_id`'s saved scrollback. None saved is not an error.
#[tauri::command(rename_all = "snake_case")]
pub async fn scrollback_delete(app: AppHandle, tab_id: String) -> Result<(), String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || scrollback::delete(&base, &tab_id)).await?
}

/// Delete the saved scrollback of every tab but `tab_ids`, and every
/// temporary file a crash left; ids that are not `tab-term-<n>` name nothing.
/// How many files went.
#[tauri::command(rename_all = "snake_case")]
pub async fn scrollback_retain_only(app: AppHandle, tab_ids: Vec<String>) -> Result<u32, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || scrollback::retain_only(&base, &tab_ids)).await?
}

/// Delete all saved scrollback. How many files went.
#[tauri::command(rename_all = "snake_case")]
pub async fn scrollback_clear(app: AppHandle) -> Result<u32, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || scrollback::clear(&base)).await?
}
