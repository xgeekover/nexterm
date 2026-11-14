//! The agent session history's commands (src/agent_history.rs, which says
//! what is kept where, what is refused and what happens to a file that
//! cannot be read). Each is the module's function on the app's local data
//! folder, nothing more: the webview hands an entry or a key, never a path.
//!
//! Every one runs on the blocking pool, as the saved scrollback's do
//! (commands/scrollback.rs): each reads and may write a file, and may wait
//! up to two seconds for another NexTerm to let go of the history's lock.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::agent_history::{self, Entry};

/// The app's local data folder — never the roaming one; see src/agent_history.rs.
fn local_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("There is no local app data folder to keep the agent session history in: {e}"))
}

async fn on_the_blocking_pool<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("The agent session history stopped unexpectedly: {e}"))
}

/// Every entry, newest first — kinds this build does not know included, for
/// the page to leave out. Makes the file when it is not there; moves one that
/// cannot be read aside and starts again.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_history_list(app: AppHandle) -> Result<Vec<Entry>, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || agent_history::list(&base)).await?
}

/// Record `entry` — `{kind, sessionId, cwd, title, startedAt, lastUsedAt,
/// endedAt, endReason}` — merged into the entry with its key, and with the
/// provisional entry `replaces` names, if any. The entry as kept, its `key`
/// included.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_history_upsert(app: AppHandle, entry: Value, replaces: Option<String>) -> Result<Entry, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || agent_history::upsert(&base, &entry, replaces.as_deref())).await?
}

/// Delete the entry under `key`. Whether there was one.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_history_remove(app: AppHandle, key: String) -> Result<bool, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || agent_history::remove(&base, &key)).await?
}

/// Empty the history. How many entries went.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_history_clear(app: AppHandle) -> Result<u32, String> {
    let base = local_data(&app)?;
    on_the_blocking_pool(move || agent_history::clear(&base)).await?
}
