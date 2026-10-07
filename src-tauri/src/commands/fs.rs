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
fn is_root_of(workspace: &fs::Workspace, path: &std::path::Path) -> bool {
    workspace.root().is_some_and(|root| root == path)
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
    open_root(&state.workspace, &path, |root| {
        state.fs_watcher.start_watching(app.clone(), &root.to_string_lossy())
    })
    .map(Some)
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
    open_root(&state.workspace, std::path::Path::new(&path), |root| {
        state.fs_watcher.start_watching(app.clone(), &root.to_string_lossy())
    })
}

/// Make `path` the open folder, and `watch` it.
///
/// The folder is open once `set_root` says so: every path is confined to it
/// from then on, and it is written down for the next launch. A watcher that
/// then failed to start used to fail the command as well, so the frontend
/// kept showing the folder it had while the backend refused every file of
/// it as outside the workspace. On Linux that is a folder holding one the
/// user cannot read (EACCES), or more folders than inotify may watch
/// (ENOSPC). The folder opens regardless and only does not refresh by
/// itself, which is what startup already does with a watcher that fails
/// (main.rs).
fn open_root(
    workspace: &fs::Workspace,
    path: &std::path::Path,
    watch: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<String, String> {
    let root = workspace.set_root(path)?;
    if let Err(e) = watch(&root) {
        eprintln!(
            "[NexTerm] {} is open, but changes made outside the app will not show until it is refreshed: {e}",
            root.display()
        );
    }
    Ok(root.to_string_lossy().to_string())
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
    write_in(&state.workspace, &path, &content)
}

fn write_in(workspace: &fs::Workspace, path: &str, content: &str) -> Result<(), String> {
    fs::write_file(&workspace.confine(path)?.to_string_lossy(), content)
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_create_file(state: State<AppState>, path: String) -> Result<(), String> {
    create_in(&state.workspace, &path)
}

fn create_in(workspace: &fs::Workspace, path: &str) -> Result<(), String> {
    fs::create_file(&workspace.confine(path)?.to_string_lossy())
}

#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_create_dir(state: State<AppState>, path: String) -> Result<(), String> {
    fs::create_dir(&confined(&state, &path)?)
}

/// Rename or move a path. Both ends are confined, so this cannot be used to
/// lift a file out of the workspace or pull one in.
///
/// Both are confined as entries (`confine_entry`): renaming a link renames
/// the link, and a new name that differs only in case or Unicode
/// normalization reaches `rename_path` as typed rather than as the spelling
/// already on disk.
#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_rename_path(state: State<AppState>, from: String, to: String) -> Result<(), String> {
    rename_in(&state.workspace, &from, &to)
}

fn rename_in(workspace: &fs::Workspace, from: &str, to: &str) -> Result<(), String> {
    let from_abs = workspace.confine_entry(from)?;
    let to_abs = workspace.confine_entry(to)?;
    if is_root_of(workspace, &from_abs) || is_root_of(workspace, &to_abs) {
        return Err("Refusing to rename the workspace root".to_string());
    }
    fs::rename_path(&from_abs.to_string_lossy(), &to_abs.to_string_lossy())
}

/// Delete a file, a folder or a link. Confined as an entry, so deleting a
/// link removes the link — including one that leads out of the open folder —
/// and never what it leads to.
#[tauri::command(async, rename_all = "snake_case")]
pub fn fs_delete_path(
    state: State<AppState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    delete_in(&state.workspace, &path, recursive.unwrap_or(false))
}

fn delete_in(workspace: &fs::Workspace, path: &str, recursive: bool) -> Result<(), String> {
    let target = workspace.confine_entry(path)?;
    // Never allow the root itself to be deleted through the IPC surface.
    if is_root_of(workspace, &target) {
        return Err("Refusing to delete the workspace root".to_string());
    }
    fs::delete_path(&target.to_string_lossy(), recursive)
}

/// Copy a file or a folder to a new name — the Explorer's paste. `from` is
/// confined like a read, so a link is copied as what it points at; `to` is
/// confined as the new entry, and an existing one is refused before anything
/// is written. `fs::copy_path` has the rest.
///
/// Not `#[tauri::command(async)]` like its neighbours. That attribute takes a
/// body off the event-loop thread but runs it on one of the async runtime's
/// worker threads (tauri's `respond_async_serialized` hands it to
/// `tokio::spawn`), which every other async command shares. A stat or a
/// read is over before that matters; a copy takes as long as the folder is
/// big, so it goes to the blocking pool, which grows for this.
#[tauri::command(rename_all = "snake_case")]
pub async fn fs_copy_path(state: State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let workspace = state.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || copy_in(&workspace, &from, &to))
        .await
        .map_err(|e| format!("The copy stopped unexpectedly: {e}"))?
}

fn copy_in(workspace: &fs::Workspace, from: &str, to: &str) -> Result<(), String> {
    let from_abs = workspace.confine(from)?;
    let to_abs = workspace.confine_entry(to)?;
    fs::copy_path(&from_abs, &to_abs)
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
        "fs_copy_path",
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

    /// `async` in the attribute moves a body onto the async runtime's worker
    /// threads, not the blocking pool. A copy runs for as long as the folder
    /// is big, so `fs_copy_path` hands it to the blocking pool itself, and
    /// turning it into an attribute-`async` command would quietly undo that.
    #[test]
    fn the_copy_runs_on_the_blocking_pool() {
        let src = source();
        // By line, so a checkout with CRLF endings reads the same, and from a
        // line that starts with the signature, so this test's own text is
        // never taken for it.
        let body: Vec<&str> = src
            .lines()
            .skip_while(|line| !line.starts_with("pub async fn fs_copy_path"))
            .take_while(|line| line.trim_end() != "}")
            .collect();
        assert!(!body.is_empty(), "fs_copy_path is gone, or no longer an async fn");
        assert!(
            body.iter().any(|line| line.contains("spawn_blocking")),
            "fs_copy_path must run the copy through spawn_blocking:\n{}",
            body.join("\n")
        );
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

/// Delete, rename, copy, save and New File as the commands run them —
/// confinement included — on real folders.
///
/// The functions in `crate::fs` were tested on their own, with paths handed
/// straight to them. That missed the ways confinement used to change what
/// they were given: a link was resolved to the file it points at before
/// `delete_path` ever saw it, a new name was resolved to the existing
/// entry's spelling before `rename_path` saw it, and a link to nothing was
/// passed to `write_file` as a name still free.
#[cfg(test)]
mod entry_tests {
    use super::{copy_in, create_in, delete_in, rename_in, write_in};
    use crate::fs::Workspace;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Bytes that are not UTF-8. The paste `fs_copy_path` replaces decoded
    /// every file as text and stopped at the first of these.
    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00];

    /// A folder of its own, opened as the workspace. Sharing one fixed path
    /// between tests is what made the shell-integration suite flaky under
    /// cargo's parallel harness.
    fn open_folder(tag: &str) -> (Workspace, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nexterm-entry-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let workspace = Workspace::new();
        let root = workspace.set_root(&dir).unwrap();
        (workspace, root)
    }

    /// A folder beside the workspace, holding one file the tests must never
    /// be able to reach.
    fn outside_folder(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-entry-outside-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        // The spelling `Workspace` uses: no `\\?\` on Windows.
        dunce::canonicalize(&dir).unwrap()
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// The names a folder lists, exactly as stored: an NFC and an NFD
    /// spelling of one name are different strings here.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// Every entry under `dir` by relative path, with a file's bytes, a link's
    /// target, or nothing more for a folder — enough to tell a copy from its
    /// original by anything but timestamps.
    fn tree_of(dir: &Path) -> Vec<(PathBuf, String)> {
        let mut found = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let kind = entry.file_type().unwrap();
                let what = if kind.is_symlink() {
                    format!("link to {}", fs::read_link(&path).unwrap().display())
                } else if kind.is_dir() {
                    pending.push(path.clone());
                    "folder".to_string()
                } else {
                    format!("file {:?}", fs::read(&path).unwrap())
                };
                found.push((path.strip_prefix(dir).unwrap().to_path_buf(), what));
            }
        }
        found.sort();
        found
    }

    fn write_at(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[cfg(unix)]
    fn is_link(path: &Path) -> bool {
        path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink())
    }

    #[cfg(unix)]
    fn link(target: impl AsRef<Path>, at: &Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    /// `AGENTS.md -> CLAUDE.md`, the usual agent-docs layout. Deleting
    /// AGENTS.md used to delete CLAUDE.md and leave AGENTS.md dangling.
    #[cfg(unix)]
    #[test]
    fn deleting_a_link_to_a_file_deletes_the_link_and_not_the_file() {
        let (workspace, root) = open_folder("del-file-link");
        fs::write(root.join("CLAUDE.md"), "the real notes").unwrap();
        link("CLAUDE.md", &root.join("AGENTS.md"));

        delete_in(&workspace, &s(&root.join("AGENTS.md")), false).unwrap();

        assert!(root.join("AGENTS.md").symlink_metadata().is_err(), "the link is still there");
        assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "the real notes");
        let _ = fs::remove_dir_all(&root);
    }

    /// The Explorer shows a link to a folder as a folder and so asks for a
    /// recursive delete. That used to be `remove_dir_all` on the real tree.
    #[cfg(unix)]
    #[test]
    fn deleting_a_link_to_a_folder_never_touches_the_folder() {
        let (workspace, root) = open_folder("del-dir-link");
        let real = root.join("packages").join("shared");
        fs::create_dir_all(real.join("sub")).unwrap();
        fs::write(real.join("a.txt"), "a").unwrap();
        fs::write(real.join("sub").join("b.txt"), "b").unwrap();

        for (name, recursive) in [("shared", true), ("shared-too", false)] {
            link(Path::new("packages").join("shared"), &root.join(name));
            delete_in(&workspace, name, recursive)
                .unwrap_or_else(|e| panic!("deleting the link {name} (recursive: {recursive}): {e}"));
            assert!(root.join(name).symlink_metadata().is_err(), "the link {name} is still there");
            assert_eq!(fs::read_to_string(real.join("a.txt")).unwrap(), "a", "after deleting {name}");
            assert_eq!(fs::read_to_string(real.join("sub").join("b.txt")).unwrap(), "b", "after deleting {name}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// `exists()` follows the link, so a link whose target is gone used to
    /// be reported missing and could not be deleted at all.
    #[cfg(unix)]
    #[test]
    fn a_dangling_link_can_be_deleted() {
        let (workspace, root) = open_folder("del-dangling");
        link("no-such-file", &root.join("dangling"));

        delete_in(&workspace, "dangling", false).unwrap();

        assert!(root.join("dangling").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// The link is inside the folder even when what it points at is not, so
    /// deleting it is allowed — and must leave what it points at alone.
    #[cfg(unix)]
    #[test]
    fn a_link_that_leads_out_of_the_folder_can_be_deleted_and_what_it_leads_to_stays() {
        let (workspace, root) = open_folder("del-out-link");
        let outside = outside_folder("del-out-link");
        link(&outside, &root.join("ext"));

        delete_in(&workspace, "ext", true).unwrap();

        assert!(root.join("ext").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "secret");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /// Only the last component is taken as named. A link earlier in the path
    /// is still resolved, so it is still no way out of the folder.
    #[cfg(unix)]
    #[test]
    fn a_folder_link_that_leads_out_is_still_no_way_out() {
        let (workspace, root) = open_folder("out-parent");
        let outside = outside_folder("out-parent");
        link(&outside, &root.join("ext"));
        fs::write(root.join("mine.txt"), "mine").unwrap();

        assert!(delete_in(&workspace, "ext/secret.txt", false).is_err(), "delete through it");
        assert!(rename_in(&workspace, "ext/secret.txt", "stolen.txt").is_err(), "rename out through it");
        assert!(rename_in(&workspace, "mine.txt", "ext/mine.txt").is_err(), "rename in through it");
        assert!(copy_in(&workspace, "ext/secret.txt", "stolen.txt").is_err(), "copy out through it");
        assert!(copy_in(&workspace, "ext", "stolen").is_err(), "copy what it leads to");
        assert!(copy_in(&workspace, "mine.txt", "ext/mine.txt").is_err(), "copy in through it");

        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "secret");
        assert!(outside.join("mine.txt").symlink_metadata().is_err());
        assert!(root.join("stolen.txt").symlink_metadata().is_err());
        assert!(root.join("stolen").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(root.join("mine.txt")).unwrap(), "mine");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn dot_dot_is_still_no_way_out() {
        let (workspace, root) = open_folder("dotdot");
        let outside = outside_folder("dotdot");
        fs::create_dir_all(root.join("inner")).unwrap();
        fs::write(root.join("mine.txt"), "mine").unwrap();
        let escape = format!("../{}/secret.txt", outside.file_name().unwrap().to_string_lossy());

        assert!(delete_in(&workspace, &escape, false).is_err());
        assert!(delete_in(&workspace, &format!("inner/../{escape}"), false).is_err());
        assert!(rename_in(&workspace, &escape, "stolen.txt").is_err());
        assert!(rename_in(&workspace, "mine.txt", "../nexterm-entry-escaped.txt").is_err());
        assert!(copy_in(&workspace, &escape, "stolen.txt").is_err());
        assert!(copy_in(&workspace, "mine.txt", "../nexterm-entry-escaped.txt").is_err());
        assert!(copy_in(&workspace, "mine.txt", &s(&outside.join("mine.txt"))).is_err());

        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "secret");
        assert!(root.parent().unwrap().join("nexterm-entry-escaped.txt").symlink_metadata().is_err());
        assert!(outside.join("mine.txt").symlink_metadata().is_err());
        assert!(root.join("stolen.txt").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn the_open_folder_itself_is_still_refused() {
        let (workspace, root) = open_folder("root-itself");
        fs::create_dir_all(root.join("inner")).unwrap();

        for spelling in [s(&root), String::new(), ".".to_string(), "inner/..".to_string()] {
            let err = delete_in(&workspace, &spelling, true).unwrap_err();
            assert!(err.contains("workspace root"), "delete {spelling:?}: {err}");
            let err = rename_in(&workspace, &spelling, "elsewhere").unwrap_err();
            assert!(err.contains("workspace root"), "rename {spelling:?}: {err}");
        }
        assert!(root.join("inner").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    /// Renaming AGENTS.md used to rename CLAUDE.md, leaving AGENTS.md
    /// dangling under its old name.
    #[cfg(unix)]
    #[test]
    fn renaming_a_link_renames_the_link() {
        let (workspace, root) = open_folder("ren-link");
        fs::write(root.join("CLAUDE.md"), "notes").unwrap();
        link("CLAUDE.md", &root.join("AGENTS.md"));

        rename_in(&workspace, &s(&root.join("AGENTS.md")), &s(&root.join("AGENT.md"))).unwrap();

        assert!(is_link(&root.join("AGENT.md")), "the link itself moved");
        assert_eq!(fs::read_link(root.join("AGENT.md")).unwrap(), Path::new("CLAUDE.md"));
        assert!(root.join("AGENTS.md").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "notes");
        let _ = fs::remove_dir_all(&root);
    }

    /// Cut and paste is a rename into another folder; it used to move the
    /// folder the link points at.
    #[cfg(unix)]
    #[test]
    fn moving_a_link_to_a_folder_moves_the_link() {
        let (workspace, root) = open_folder("mv-dir-link");
        let real = root.join("packages").join("shared");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("a.txt"), "a").unwrap();
        fs::create_dir_all(root.join("dest")).unwrap();
        link(&real, &root.join("shared"));

        rename_in(&workspace, "shared", "dest/shared").unwrap();

        assert!(is_link(&root.join("dest").join("shared")), "the link moved");
        assert!(root.join("shared").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(real.join("a.txt")).unwrap(), "a", "the folder stayed where it was");
        let _ = fs::remove_dir_all(&root);
    }

    /// A link and the file it points at are two entries. Comparing them by
    /// where they lead calls them one, and a rename of one onto the other's
    /// name then replaces the file with the link.
    #[cfg(unix)]
    #[test]
    fn a_link_and_the_file_it_points_at_never_rename_onto_each_other() {
        let (workspace, root) = open_folder("ren-onto-target");
        fs::write(root.join("CLAUDE.md"), "notes").unwrap();
        link("CLAUDE.md", &root.join("AGENTS.md"));

        let err = rename_in(&workspace, "AGENTS.md", "CLAUDE.md").unwrap_err();
        assert!(err.contains("already exists"), "link onto its file: {err}");
        let err = rename_in(&workspace, "CLAUDE.md", "AGENTS.md").unwrap_err();
        assert!(err.contains("already exists"), "file onto its link: {err}");

        assert!(root.join("CLAUDE.md").symlink_metadata().unwrap().is_file());
        assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "notes");
        assert!(is_link(&root.join("AGENTS.md")));
        let _ = fs::remove_dir_all(&root);
    }

    /// The new name used to be resolved to the existing entry's spelling, so
    /// the rename was `rename(x, x)`: it succeeded and changed nothing.
    #[test]
    fn a_case_only_rename_changes_the_name() {
        let (workspace, root) = open_folder("ren-case");
        fs::write(root.join("Readme.md"), "readme").unwrap();

        rename_in(&workspace, &s(&root.join("Readme.md")), &s(&root.join("README.md"))).unwrap();

        assert_eq!(names_in(&root), vec!["README.md"]);
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "readme");
        let _ = fs::remove_dir_all(&root);
    }

    /// macOS folds the precomposed and decomposed spellings of 한 into one
    /// name, the same way it folds case.
    #[test]
    fn a_normalization_only_rename_changes_the_name() {
        let (workspace, root) = open_folder("ren-nfd");
        let nfc = "\u{d55c}.txt";
        let nfd = "\u{1112}\u{1161}\u{11ab}.txt";
        fs::write(root.join(nfc), "korean").unwrap();

        rename_in(&workspace, nfc, nfd).unwrap();

        assert_eq!(names_in(&root), vec![nfd.to_string()]);
        assert_eq!(fs::read_to_string(root.join(nfd)).unwrap(), "korean");
        let _ = fs::remove_dir_all(&root);
    }

    /// Keeping the new name as typed must not let it land on a DIFFERENT
    /// entry the folder files under that name.
    #[test]
    fn a_rename_onto_another_entry_spelled_in_another_case_is_refused() {
        let (workspace, root) = open_folder("ren-case-other");
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        let folds_case = root.join("B.TXT").symlink_metadata().is_ok();

        let result = rename_in(&workspace, "a.txt", "B.TXT");

        if folds_case {
            let err = result.unwrap_err();
            assert!(err.contains("already exists"), "{err}");
            assert_eq!(names_in(&root), vec!["a.txt", "b.txt"]);
            assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "b");
        } else {
            // On a volume that tells case apart, B.TXT is simply a new name.
            result.unwrap();
            assert_eq!(names_in(&root), vec!["B.TXT", "b.txt"]);
        }
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "b");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_case_only_rename_of_a_link_renames_the_link() {
        let (workspace, root) = open_folder("ren-link-case");
        fs::write(root.join("target.txt"), "target").unwrap();
        link("target.txt", &root.join("Link"));

        rename_in(&workspace, "Link", "LINK").unwrap();

        assert_eq!(names_in(&root), vec!["LINK", "target.txt"]);
        assert!(is_link(&root.join("LINK")));
        assert_eq!(fs::read_to_string(root.join("target.txt")).unwrap(), "target");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copying_a_file_copies_its_bytes() {
        let (workspace, root) = open_folder("copy-file");
        fs::write(root.join("logo.png"), PNG).unwrap();

        copy_in(&workspace, "logo.png", "logo copy.png").unwrap();

        assert_eq!(fs::read(root.join("logo copy.png")).unwrap(), PNG);
        assert_eq!(fs::read(root.join("logo.png")).unwrap(), PNG, "the original stays");

        // The old paste wrote the text out afresh, so a script lost its
        // executable bit.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
            fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
            copy_in(&workspace, "run.sh", "run copy.sh").unwrap();
            let mode = fs::metadata(root.join("run copy.sh")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// Everything the Explorer hides, deeper than it lists, binary files
    /// included.
    #[test]
    fn copying_a_folder_copies_everything_in_it() {
        let (workspace, root) = open_folder("copy-folder");
        let proj = root.join("proj");
        for (rel, bytes) in [
            ("top.txt", b"top".as_slice()),
            (".git/config", b"[core]"),
            ("node_modules/pkg/index.js", b"module.exports = 1"),
            ("target/debug/app", b"\x7fELF\x02\x01"),
            ("dist/bundle.js", b"bundle"),
            (".agents/notes.md", b"notes"),
            ("a/b/c/d/e/f/g/deep.txt", b"deep"),
            ("assets/logo.png", PNG),
        ] {
            write_at(&proj.join(rel), bytes);
        }
        fs::create_dir_all(proj.join("empty")).unwrap();

        copy_in(&workspace, &s(&proj), &s(&root.join("proj copy"))).unwrap();

        let copied = tree_of(&root.join("proj copy"));
        assert_eq!(copied, tree_of(&proj));
        assert!(copied.iter().any(|(rel, _)| rel == Path::new("empty")), "an empty folder too");
        let _ = fs::remove_dir_all(&root);
    }

    /// Checked before anything is written: a paste can neither overwrite a
    /// file nor merge into a folder.
    #[test]
    fn a_copy_never_lands_on_something_already_there() {
        let (workspace, root) = open_folder("copy-taken");
        fs::write(root.join("a.txt"), "new").unwrap();
        fs::write(root.join("b.txt"), "KEEP").unwrap();
        write_at(&root.join("src").join("a.txt"), b"src");
        write_at(&root.join("dest").join("keep.txt"), b"KEEP");

        let err = copy_in(&workspace, "a.txt", "b.txt").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        let err = copy_in(&workspace, "src", "dest").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        if root.join("B.TXT").symlink_metadata().is_ok() {
            let err = copy_in(&workspace, "a.txt", "B.TXT").unwrap_err();
            assert!(err.contains("already exists"), "B.TXT is b.txt on this volume: {err}");
        }

        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "KEEP");
        assert_eq!(names_in(&root.join("dest")), vec!["keep.txt"], "nothing merged in");
        assert_eq!(fs::read_to_string(root.join("dest").join("keep.txt")).unwrap(), "KEEP");
        let _ = fs::remove_dir_all(&root);
    }

    /// A dangling link is a name already taken; writing through it would
    /// create whatever it points at.
    #[cfg(unix)]
    #[test]
    fn a_copy_never_lands_on_a_dangling_link() {
        let (workspace, root) = open_folder("copy-dangling");
        fs::write(root.join("a.txt"), "a").unwrap();
        link("made-through-the-link.txt", &root.join("taken"));

        let err = copy_in(&workspace, "a.txt", "taken").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(root.join("made-through-the-link.txt").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// A link whose target does not exist was taken for a name that does not
    /// exist yet: confinement let it through, and a save or a New File wrote
    /// through it — creating whatever it pointed at, outside the open folder
    /// as easily as in it.
    #[cfg(unix)]
    #[test]
    fn nothing_is_written_through_a_broken_link() {
        let (workspace, root) = open_folder("write-broken");
        let outside = outside_folder("write-broken");
        let planted = outside.join("planted.txt");
        link(&planted, &root.join("out"));
        link("missing.txt", &root.join("in"));
        link(outside.join("no-such-folder"), &root.join("gone"));

        for name in ["out", "in"] {
            assert!(write_in(&workspace, name, "x").is_err(), "saved through the link {name}");
            assert!(create_in(&workspace, name).is_err(), "created through the link {name}");
        }
        assert!(write_in(&workspace, "gone/new.txt", "x").is_err(), "saved below a link to no folder");

        assert!(planted.symlink_metadata().is_err(), "a file was made outside the folder");
        assert!(root.join("missing.txt").symlink_metadata().is_err(), "the link's target was made");
        assert!(is_link(&root.join("out")) && is_link(&root.join("in")), "the links themselves stay");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /// Save and New File on plain files, on every platform: a New File over
    /// a file that is there refuses and leaves it as it was.
    #[test]
    fn a_save_and_a_new_file_land_in_the_folder_and_never_empty_a_file() {
        let (workspace, root) = open_folder("write-plain");

        create_in(&workspace, "notes/new.txt").unwrap();
        write_in(&workspace, "notes/new.txt", "saved").unwrap();
        let err = create_in(&workspace, "notes/new.txt").unwrap_err();

        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(root.join("notes").join("new.txt")).unwrap(), "saved");
        assert!(write_in(&workspace, "../nexterm-write-escaped.txt", "x").is_err());
        assert!(create_in(&workspace, "../nexterm-write-escaped.txt").is_err());
        assert!(root.parent().unwrap().join("nexterm-write-escaped.txt").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// A link that leads to a file in the folder is saved through, as a link
    /// opened in the editor should be; only one that leads nowhere is refused.
    #[cfg(unix)]
    #[test]
    fn a_link_to_a_file_in_the_folder_is_still_saved_through() {
        let (workspace, root) = open_folder("write-link");
        fs::write(root.join("CLAUDE.md"), "old").unwrap();
        link("CLAUDE.md", &root.join("AGENTS.md"));

        write_in(&workspace, "AGENTS.md", "new").unwrap();

        assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "new");
        assert!(is_link(&root.join("AGENTS.md")));
        let err = create_in(&workspace, "AGENTS.md").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_copy_needs_a_source_and_a_folder_to_land_in() {
        let (workspace, root) = open_folder("copy-missing");
        fs::write(root.join("a.txt"), "a").unwrap();

        let err = copy_in(&workspace, "nope.txt", "copy.txt").unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        // A folder deleted since the Explorer looked must not come back.
        assert!(copy_in(&workspace, "a.txt", "gone/a.txt").is_err());
        assert!(root.join("gone").symlink_metadata().is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_is_never_copied_into_itself() {
        let (workspace, root) = open_folder("copy-into-self");
        write_at(&root.join("proj").join("a.txt"), b"a");
        fs::create_dir_all(root.join("proj").join("sub")).unwrap();
        let before = tree_of(&root);

        for to in ["proj/proj copy", "proj/sub/proj copy"] {
            let err = copy_in(&workspace, "proj", to).unwrap_err();
            assert!(err.contains("inside itself"), "{to}: {err}");
        }
        let err = copy_in(&workspace, "", "proj/everything").unwrap_err();
        assert!(err.contains("inside itself"), "the open folder into one of its own: {err}");

        assert_eq!(tree_of(&root), before, "nothing was written");
        let _ = fs::remove_dir_all(&root);
    }

    /// A link the copy starts from is read through, as opening it would be.
    #[cfg(unix)]
    #[test]
    fn copying_a_link_copies_what_it_points_at() {
        let (workspace, root) = open_folder("copy-link-itself");
        fs::write(root.join("CLAUDE.md"), "notes").unwrap();
        link("CLAUDE.md", &root.join("AGENTS.md"));
        write_at(&root.join("packages").join("shared").join("a.txt"), b"a");
        link(Path::new("packages").join("shared"), &root.join("shared"));

        copy_in(&workspace, "AGENTS.md", "AGENTS copy.md").unwrap();
        copy_in(&workspace, "shared", "shared copy").unwrap();

        assert!(!is_link(&root.join("AGENTS copy.md")));
        assert_eq!(fs::read_to_string(root.join("AGENTS copy.md")).unwrap(), "notes");
        assert!(!is_link(&root.join("shared copy")));
        assert_eq!(fs::read_to_string(root.join("shared copy").join("a.txt")).unwrap(), "a");
        let _ = fs::remove_dir_all(&root);
    }

    /// Inside a copied folder links are copied as links: a loop does not copy
    /// forever, and a link out of the folder does not copy what is out there.
    #[cfg(unix)]
    #[test]
    fn links_inside_a_copied_folder_are_copied_as_links() {
        let (workspace, root) = open_folder("copy-links");
        let outside = outside_folder("copy-links");
        let proj = root.join("proj");
        write_at(&proj.join("CLAUDE.md"), b"notes");
        link("CLAUDE.md", &proj.join("AGENTS.md"));
        fs::create_dir_all(proj.join("docs")).unwrap();
        link(".", &proj.join("docs").join("loop"));
        link("..", &proj.join("docs").join("up"));
        link(&outside, &proj.join("ext"));
        link("nowhere", &proj.join("dangling"));

        copy_in(&workspace, "proj", "proj copy").unwrap();

        let copy = root.join("proj copy");
        assert_eq!(tree_of(&copy), tree_of(&proj), "the same shape, links as links");
        assert_eq!(
            copy.join("AGENTS.md").canonicalize().unwrap(),
            copy.join("CLAUDE.md").canonicalize().unwrap(),
            "a relative link points within the copy"
        );
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "secret");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_that_fails_part_way_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        let (workspace, root) = open_folder("copy-fails");
        let proj = root.join("proj");
        write_at(&proj.join("a").join("fine.txt"), b"fine");
        write_at(&proj.join("locked.txt"), b"locked");
        fs::set_permissions(proj.join("locked.txt"), fs::Permissions::from_mode(0o000)).unwrap();

        // root reads anything, so there is nothing to fail on there.
        if fs::read(proj.join("locked.txt")).is_err() {
            let err = copy_in(&workspace, "proj", "proj copy").unwrap_err();
            assert!(err.contains("locked.txt"), "{err}");
            assert!(root.join("proj copy").symlink_metadata().is_err(), "the partial copy was left");
        }

        fs::set_permissions(proj.join("locked.txt"), fs::Permissions::from_mode(0o644)).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// A FIFO has no bytes of its own and opening one waits for a writer, so
    /// a copy that tried would hang the paste for good. The copy runs on a
    /// thread with a deadline, so that comes out as a failure rather than a
    /// suite that never finishes.
    #[cfg(unix)]
    #[test]
    fn a_fifo_in_a_copied_folder_is_left_out_and_never_waited_on() {
        use std::os::unix::ffi::OsStrExt;
        let (workspace, root) = open_folder("copy-fifo");
        write_at(&root.join("proj").join("a.txt"), b"a");
        let fifo = std::ffi::CString::new(root.join("proj").join("pipe").as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0, "premise: a FIFO to copy past");

        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(copy_in(&workspace, "proj", "proj copy"));
        });
        let copied = finished
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("the copy is still waiting on the FIFO");

        copied.unwrap();
        assert_eq!(names_in(&root.join("proj copy")), vec!["a.txt"]);
        let _ = fs::remove_dir_all(&root);
    }
}

/// Opening a folder, as `fs_pick_root` and `fs_set_root` both do it, with the
/// watcher stood in for: a real one only fails where the OS says no.
#[cfg(test)]
mod open_root_tests {
    use super::open_root;
    use crate::fs::Workspace;
    use std::path::{Path, PathBuf};

    fn folder(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-open-root-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    /// On Linux the watcher fails on a folder with an unreadable folder in
    /// it (EACCES) or more folders than inotify may watch (ENOSPC). By then
    /// the folder was open — and written down for the next launch — and the
    /// command failed anyway: the frontend kept the folder it had while the
    /// backend had moved on, refusing every file still shown as outside the
    /// workspace.
    #[test]
    fn a_folder_that_cannot_be_watched_still_opens() {
        let workspace = Workspace::new();
        let before = folder("unwatched-before");
        let after = folder("unwatched-after");
        workspace.set_root(&before).unwrap();

        let opened = open_root(&workspace, &after, |_| Err("Failed to watch path: no space left on device".into()))
            .expect("the folder opens, unwatched");

        assert_eq!(Path::new(&opened), after);
        assert_eq!(workspace.root(), Some(after.clone()), "backend and frontend agree on the folder");
        let _ = std::fs::remove_dir_all(&before);
        let _ = std::fs::remove_dir_all(&after);
    }

    #[test]
    fn a_folder_that_cannot_be_opened_is_neither_watched_nor_opened() {
        let workspace = Workspace::new();
        let before = folder("unopened");
        workspace.set_root(&before).unwrap();

        let mut watched = false;
        let result = open_root(&workspace, &before.join("gone"), |_| {
            watched = true;
            Ok(())
        });

        assert!(result.is_err());
        assert!(!watched);
        assert_eq!(workspace.root(), Some(before.clone()), "the folder already open stays open");
        let _ = std::fs::remove_dir_all(&before);
    }
}
