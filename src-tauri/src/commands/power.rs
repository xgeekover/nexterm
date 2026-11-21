//! Keeping the computer awake while a coding agent works (src/power.rs).
//! Off until the page turns it on.

use crate::power::{self, Support};

/// Hold the computer awake (`on`), or let it sleep again. `Ok(true)` while
/// held; turning it on twice holds it once. Where it is unsupported, `on`
/// holds nothing and answers `Ok(false)`. An error is a hold that failed —
/// the helper would not start, or Windows refused.
#[tauri::command(rename_all = "snake_case")]
pub fn power_set_keep_awake(on: bool) -> Result<bool, String> {
    power::set_keep_awake(on)
}

/// `{ supported, method }`: whether keep-awake works here, and how.
#[tauri::command(rename_all = "snake_case")]
pub fn power_keep_awake_support() -> Support {
    power::support()
}
