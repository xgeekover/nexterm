//! Filesystem commands.
//!
//! **Every one of these that touches the disk or spawns a process is marked
//! `async`.** A plain `fn` command is `ExecutionContext::Blocking`, which
//! means it runs on the event-loop thread: while it works, the window does
//! not paint, does not scroll and does not answer. `#[tauri::command(async)]`
//! on a synchronous function moves it to the runtime's blocking pool instead,
//! which costs nothing and is the difference between a folder open that is
//! instant and one that looks like a crash.
//!
//! The commands that only read a `Mutex` in memory (`fs_get_root`) stay
//! blocking — dispatching those would be slower than doing them.

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

/// What git says about the open folder, or `null` when it has nothing to say.
///
/// Null covers three cases that are all the same to the UI: no folder open,
/// the folder is not a repository, and `git` is not installed. None of them is
/// worth an error over a status bar decoration.
#[tauri::command(async, rename_all = "snake_case")]
pub fn git_status(state: State<AppState>) -> Result<Option<fs::git::GitStatus>, String> {
    Ok(state.workspace.root().and_then(|root| fs::git::status_of(&root)))
}

/// Search the open folder's files.
///
/// Confined by construction: the walk starts at the workspace root, so there
/// is no webview-supplied path to confine in the first place. Every cap lives
/// in `fs::search` and what was cut comes back in `truncated` rather than
/// being dropped quietly.
#[tauri::command(async, rename_all = "snake_case")]
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

/// Whether a terminal asked to start in `path` would start there — the one
/// question the Settings field for a custom directory needs answered. It goes
/// through `Workspace::can_start_in`, which asks `start_dir`: the same
/// function `spawn_dir` asks for every new terminal, so the check and the
/// spawn cannot disagree.
///
/// They did in v0.6.0, when this called `Path::is_dir` on its own. That reads
/// a relative path against the process's working directory — `/` when the
/// Finder starts the app, the program folder on Windows — while the spawn
/// reads it inside the open folder. `src` was reported missing although a
/// terminal would have opened in `<open folder>/src`, and `Users` passed
/// although the terminal would have fallen back.
///
/// So it is exactly as confined as `spawn_dir`. An absolute path is not
/// confined at all: a shell can `cd` anywhere the moment it exists, so its
/// starting directory guards nothing, and refusing one here would refuse the
/// very paths this exists to check. A relative path means inside the open
/// folder, and with no folder open it means nothing, so the answer is `false`.
///
/// It reveals whether a directory exists and nothing about its contents; the
/// webview can already ask `pty_spawn` to run any executable, so this is not
/// a boundary that was holding anything.
#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_dir_exists(state: State<AppState>, path: String) -> bool {
    state.workspace.can_start_in(&path)
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
///
/// `async`, and the picker is the CALLBACK form, for one reason: a plain
/// `fn` command runs in `ExecutionContext::Blocking`, which is the event-loop
/// thread, and `blocking_pick_folder` documents itself as *"a blocking
/// operation, and should NOT be used when running on the main thread"*. It
/// held that thread for as long as the dialog was open, so the whole window
/// stopped painting and stopped answering the moment the user asked to open a
/// folder. macOS hid it — `NSOpenPanel` keeps pumping the event loop while it
/// is modal — and Windows did not.
///
/// `pick_folder` hands the choice back on whatever thread the dialog lives on,
/// so the result comes through a channel instead and nothing blocks anywhere.
#[tauri::command(rename_all = "snake_case")]
pub async fn fs_pick_root(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        // The receiver is only dropped if the command was cancelled, and then
        // there is nobody left to tell.
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.map_err(|_| "Folder picker closed unexpectedly".to_string())? else {
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

/// Open a folder the user has opened before, without a dialog.
///
/// Same validation as the picker: `set_root` canonicalises and refuses
/// anything that is not a directory, so a recent entry whose folder has been
/// moved or deleted comes back as an error the UI can act on rather than a
/// half-open workspace. This is the only way in besides the dialog, and it
/// still goes through the one function that decides what a root may be.
#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_set_root(app: AppHandle, state: State<AppState>, path: String) -> Result<String, String> {
    let root = state.workspace.set_root(std::path::Path::new(&path))?;
    let root_str = root.to_string_lossy().to_string();
    state.fs_watcher.start_watching(app.clone(), &root_str)?;
    Ok(root_str)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_read_dir(
    state: State<AppState>,
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    fs::read_dir_hierarchy(&confined(&state, &path)?, max_depth)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_read_file(state: State<AppState>, path: String) -> Result<String, String> {
    fs::read_file(&confined(&state, &path)?)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_write_file(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    fs::write_file(&confined(&state, &path)?, &content)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_create_file(state: State<AppState>, path: String) -> Result<(), String> {
    fs::create_file(&confined(&state, &path)?)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_create_dir(state: State<AppState>, path: String) -> Result<(), String> {
    fs::create_dir(&confined(&state, &path)?)
}

/// Rename or move a path. Both ends are confined, so this cannot be used to
/// lift a file out of the workspace or pull one in.
#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_rename_path(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    let from_abs = confined(&state, &from)?;
    let to_abs = confined(&state, &to)?;
    if is_root(&state, &from_abs) || is_root(&state, &to_abs) {
        return Err("Refusing to rename the workspace root".to_string());
    }
    fs::rename_path(&from_abs, &to_abs)
}

#[tauri::command(async, rename_all = "snake_case")]
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


/// The dispatch these commands are compiled with, which nothing at runtime
/// can observe.
///
/// A command that reads the disk from the event-loop thread does not fail, it
/// just freezes the window for as long as it takes — so there is no assertion
/// to make from inside a running app, and CI would never notice. What decides
/// it is one word in an attribute, and that word is what this reads back.
#[cfg(test)]
mod dispatch_tests {
    /// Commands that touch the disk or spawn a process, and so must never run
    /// on the event-loop thread.
    const MUST_BE_ASYNC: &[&str] = &[
        "git_status",
        "fs_search",
        "fs_read_dir",
        "fs_read_file",
        "fs_write_file",
        "fs_create_file",
        "fs_create_dir",
        "fs_rename_path",
        "fs_delete_path",
        "fs_set_root",
        "fs_pick_root",
        "fs_dir_exists",
    ];

    fn source() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("commands")
                .join("fs.rs"),
        )
        .expect("commands/fs.rs is readable")
    }

    /// Every `#[tauri::command…]` in the file, as (attribute line, fn name,
    /// runs-off-the-event-loop-thread).
    ///
    /// There are two ways to get off that thread and both count: `async` in
    /// the attribute, which moves a synchronous body to the blocking pool, and
    /// a genuinely `async fn`, whose asyncness the macro detects by itself.
    fn commands(src: &str) -> Vec<(String, String, bool)> {
        let lines: Vec<&str> = src.lines().collect();
        let mut found = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("#[tauri::command") {
                continue;
            }
            let signature = lines[i + 1..]
                .iter()
                .find(|l| l.contains("fn "))
                .unwrap_or_else(|| panic!("no fn after the attribute on line {}", i + 1));
            let name = signature
                .split("fn ")
                .nth(1)
                .and_then(|rest| rest.split(['(', '<']).next())
                .expect("a command has a name")
                .trim()
                .to_string();
            let off_thread =
                line.contains("async") || signature.contains("async fn");
            found.push((line.trim().to_string(), name, off_thread));
        }
        found
    }

    #[test]
    fn nothing_that_touches_the_disk_runs_on_the_event_loop_thread() {
        let src = source();
        let found = commands(&src);
        assert!(!found.is_empty(), "no commands found — did the file move?");

        for name in MUST_BE_ASYNC {
            let (attribute, _, off_thread) = found
                .iter()
                .find(|(_, n, _)| n == name)
                .unwrap_or_else(|| panic!("{name} is gone from commands/fs.rs"));
            assert!(
                *off_thread,
                "{name} would run on the event-loop thread and freeze the window \
                 for as long as it takes: {attribute}"
            );
        }
    }

    /// A new command is async until someone has thought about it, not after.
    #[test]
    fn every_command_here_is_accounted_for() {
        const MAY_BE_BLOCKING: &[&str] = &["fs_get_root"];
        for (_, name, off_thread) in commands(&source()) {
            if off_thread || MAY_BE_BLOCKING.contains(&name.as_str()) {
                continue;
            }
            panic!(
                "{name} is neither async nor listed as cheap enough to run on the \
                 event-loop thread. If it only reads memory, add it to \
                 MAY_BE_BLOCKING; otherwise mark it `#[tauri::command(async, …)]`."
            );
        }
    }

    /// v0.5.2 and earlier used the dialog plugin's blocking picker from a
    /// blocking command. The plugin's own documentation says not to: "This is
    /// a blocking operation, and should *NOT* be used when running on the main
    /// thread." It held the event loop for as long as the dialog was open.
    ///
    /// Comments are stripped before the check, or this one would trip it.
    #[test]
    fn the_folder_picker_is_never_the_blocking_one() {
        let src = source();
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains(concat!("blocking_", "pick_folder")),
            "use the callback form `pick_folder(|picked| …)`; the blocking one \
             freezes the window while the dialog is open"
        );
        assert!(
            src.contains("pub async fn fs_pick_root"),
            "fs_pick_root has to be async to await the picker's answer"
        );
    }
}
