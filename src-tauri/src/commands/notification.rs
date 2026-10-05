//! The desktop half of a notification a program in a terminal asked for.
//!
//! The terminal half — reading OSC 9, 99 and 777 off a program's output,
//! cleaning the text, rate-limiting it, and deciding whether the desktop is
//! where it goes at all (only while the window is in the background) — is
//! src/lib/programNotifications.js and `notifyFromProgram` in
//! src/stores/terminalStore.js. This only hands the result to the OS.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri_plugin_notification::{NotificationExt, PermissionState};

/// Whether this run has already asked the user for permission.
static ASKED: AtomicBool = AtomicBool::new(false);

/// Whether to ask for permission now: only while the OS has no answer yet,
/// and once per run — a question the user dismissed is not put to them again
/// with every notification after it.
///
/// On the desktop the plugin answers `Granted` without asking anything, and
/// the OS's own notification settings decide what is shown (as of
/// tauri-plugin-notification 2.4). The check stays, so a plugin that does
/// ask is asked once and its refusal respected.
fn ask_now(state: PermissionState, asked: &AtomicBool) -> bool {
    matches!(state, PermissionState::Prompt | PermissionState::PromptWithRationale)
        && !asked.swap(true, Ordering::SeqCst)
}

/// Show a desktop notification. `Ok(false)` when it is not allowed: refused
/// is an answer, not an error, and the entry in the app's bell stands either
/// way. An empty title leaves the plugin's own, the product name.
///
/// Async, as the plugin's own `notify` command is: it runs off the main
/// thread, and `show` hands the notification to the OS from a task of its own.
#[tauri::command(rename_all = "snake_case")]
pub async fn show_desktop_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    let notification = app.notification();
    let mut state = notification
        .permission_state()
        .map_err(|e| format!("could not read the notification permission: {e}"))?;
    if ask_now(state, &ASKED) {
        state = notification
            .request_permission()
            .map_err(|e| format!("could not ask for the notification permission: {e}"))?;
    }
    if state != PermissionState::Granted {
        return Ok(false);
    }

    let mut builder = notification.builder().body(body);
    if !title.trim().is_empty() {
        builder = builder.title(title);
    }
    builder
        .show()
        .map_err(|e| format!("could not show the notification: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_the_os_already_gave_is_never_asked_again() {
        for state in [PermissionState::Granted, PermissionState::Denied] {
            let asked = AtomicBool::new(false);
            assert!(!ask_now(state, &asked), "{state:?} is an answer");
            assert!(
                !asked.load(Ordering::SeqCst),
                "{state:?} must not use up the one question"
            );
        }
    }

    #[test]
    fn an_open_question_is_asked_once_per_run() {
        for state in [PermissionState::Prompt, PermissionState::PromptWithRationale] {
            let asked = AtomicBool::new(false);
            assert!(ask_now(state, &asked), "{state:?}: ask the first time");
            assert!(
                !ask_now(state, &asked),
                "{state:?}: a question the user dismissed is not asked again"
            );
        }
    }
}
