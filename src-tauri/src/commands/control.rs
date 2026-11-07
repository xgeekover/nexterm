//! The control API's commands (src/control/, which says what each setting
//! does and how the page is asked).
//!
//! `control_reply` is the page's answer to a `control-request` event; one for
//! an id nobody is waiting for (answered already, too late, never asked) is
//! ignored. `control_set_settings` is the page's three switches, sent at its
//! start — before its first shell, so that "off" holds from the first
//! terminal — and whenever the user changes one; it answers whether the API
//! is listening, and why not when it should be.
//!
//! `control_reply` is synchronous: a map lookup. `control_set_settings`
//! waits, when it turns the API off, until the listener and every
//! connection are gone — so that nothing is answered once the page has been
//! told it is off — and that is a wait on the async runtime, not on the
//! thread that paints the window.

use serde_json::Value;
use tauri::State;

use crate::control::{Settings, Status};
use crate::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn control_reply(state: State<AppState>, id: u64, ok: bool, result: Option<Value>, error: Option<Value>) {
    state.control.reply(id, ok, result, error);
}

#[tauri::command(rename_all = "snake_case")]
pub async fn control_set_settings(
    state: State<'_, AppState>,
    enabled: bool,
    type_and_read: bool,
    other_terminals: bool,
) -> Result<Status, String> {
    Ok(state.control.apply(Settings { enabled, type_and_read, other_terminals }).await)
}
