//! The window's progress on the Windows taskbar.
//!
//! The terminal half — reading ConEmu's OSC 9;4 off a program's output,
//! pacing it, and adding every terminal's bar up into one (error over
//! paused over normal over indeterminate, at the lowest amount) — is
//! src/lib/terminalProgress.js, driven by src/hooks/useAttention.js. This
//! only hands the result to the window, at most four times a second.
//!
//! Windows only. On macOS the first call of tao's `set_progress_bar` (0.35)
//! puts an image view of its own on the Dock tile — a static snapshot of the
//! icon in place of the one the system draws — and its Dock bar has no
//! indeterminate drawing, so it showed whatever amount it had last. On Linux
//! it needs libunity. Elsewhere the command takes the same arguments and
//! refuses the same ones, and touches nothing; the frontend does not call it
//! there at all.

use tauri::window::{ProgressBarState, ProgressBarStatus};

/// The status names the frontend sends, each to Tauri's own.
fn status_of(status: &str) -> Result<ProgressBarStatus, String> {
    match status {
        "none" => Ok(ProgressBarStatus::None),
        "normal" => Ok(ProgressBarStatus::Normal),
        "indeterminate" => Ok(ProgressBarStatus::Indeterminate),
        "paused" => Ok(ProgressBarStatus::Paused),
        "error" => Ok(ProgressBarStatus::Error),
        // Not echoed: the frontend sends one of the five, and anything else
        // is a mistake to report, not text to hand back.
        _ => Err("unknown taskbar progress status".to_string()),
    }
}

/// What the window is told for `status` and `progress`.
///
/// The amount is held at 100. None goes with "none" and "indeterminate",
/// whatever was sent: on Windows, an amount handed to an indeterminate bar
/// turns it back into a normal one (`SetProgressValue` after
/// `TBPF_INDETERMINATE`, in tao 0.35's `set_progress_bar`), and a bar that is
/// not there has nothing to measure.
fn state_of(status: &str, progress: Option<u64>) -> Result<ProgressBarState, String> {
    let status = status_of(status)?;
    let progress = match status {
        ProgressBarStatus::None | ProgressBarStatus::Indeterminate => None,
        _ => progress.map(|p| p.min(100)),
    };
    Ok(ProgressBarState {
        status: Some(status),
        progress,
    })
}

/// Show `status` — "none", "normal", "indeterminate", "paused" or "error" —
/// at `progress` percent on the taskbar for the window that asked, the only
/// one NexTerm has. An unknown status is refused, on every platform; only
/// Windows has a taskbar to show it on.
#[tauri::command(rename_all = "snake_case")]
pub fn set_taskbar_progress(
    window: tauri::Window,
    status: String,
    progress: Option<u64>,
) -> Result<(), String> {
    let state = state_of(&status, progress)?;
    apply(&window, state)
}

/// Hand the bar to the taskbar. tao creates the taskbar's COM object anew on
/// every call and unwraps it, which is one reason the frontend calls only
/// while a bar is really in use.
#[cfg(windows)]
fn apply(window: &tauri::Window, state: ProgressBarState) -> Result<(), String> {
    window
        .set_progress_bar(state)
        .map_err(|e| format!("could not set the taskbar progress: {e}"))
}

/// Nothing to show it on, and nothing touched — see the module's note on the
/// Dock.
#[cfg(not(windows))]
fn apply(_window: &tauri::Window, _state: ProgressBarState) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The status a state carries, by the frontend's name for it.
    fn name_of(state: &ProgressBarState) -> &'static str {
        match state.status {
            Some(ProgressBarStatus::None) => "none",
            Some(ProgressBarStatus::Normal) => "normal",
            Some(ProgressBarStatus::Indeterminate) => "indeterminate",
            Some(ProgressBarStatus::Paused) => "paused",
            Some(ProgressBarStatus::Error) => "error",
            None => "unset",
        }
    }

    #[test]
    fn every_status_the_frontend_sends_maps_to_its_own() {
        for name in ["none", "normal", "indeterminate", "paused", "error"] {
            let state = state_of(name, Some(40)).expect(name);
            assert_eq!(name_of(&state), name, "{name} must reach the window as itself");
        }
    }

    #[test]
    fn an_unknown_status_is_refused_without_echoing_it() {
        for name in ["", "Normal", "NONE", "warning", "progress", "normal ", "error\u{1b}]0;x\u{7}"] {
            let err = state_of(name, Some(10)).expect_err(name);
            assert_eq!(err, "unknown taskbar progress status");
        }
    }

    #[test]
    fn the_amount_is_held_at_100_and_kept_below_it() {
        assert_eq!(state_of("normal", Some(250)).unwrap().progress, Some(100));
        assert_eq!(state_of("error", Some(u64::MAX)).unwrap().progress, Some(100));
        assert_eq!(state_of("paused", Some(100)).unwrap().progress, Some(100));
        assert_eq!(state_of("normal", Some(37)).unwrap().progress, Some(37));
        assert_eq!(state_of("normal", Some(0)).unwrap().progress, Some(0));
        assert_eq!(state_of("error", None).unwrap().progress, None);
    }

    #[test]
    fn no_amount_for_a_bar_that_is_gone_or_indeterminate() {
        // Windows would turn an indeterminate bar normal on seeing one.
        assert_eq!(state_of("indeterminate", Some(50)).unwrap().progress, None);
        assert_eq!(state_of("none", Some(50)).unwrap().progress, None);
    }
}
