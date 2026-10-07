use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::models::FsChangePayload;

use super::SKIPPED_FOLDERS;

/// True when any path component is a folder we never show (node_modules, .git,
/// target, …) — a build or install touches thousands of files there and none
/// of them should make the explorer refresh.
pub fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        SKIPPED_FOLDERS.contains(&name.as_ref()) || name == ".DS_Store"
    })
}

/// `is_ignored` for the part of `path` below `root`, the open folder.
///
/// The open folder can itself sit inside a folder the Explorer hides — a
/// dependency opened from `node_modules` to read it, a `dist` build, a
/// project somewhere under a `target` — and then every path in it has that
/// name in it. Asked about the whole path, search cut its walk at the open
/// folder and found nothing, and the watcher dropped every change, while the
/// Explorer, which looks at names one level at a time, listed the files. Only
/// the names below the open folder say whether something there is hidden. A
/// path that is not under `root` at all is judged whole, as before.
pub fn is_ignored_below(root: &Path, path: &Path) -> bool {
    is_ignored(path.strip_prefix(root).unwrap_or(path))
}

pub struct FsWatcherManager {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl Default for FsWatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FsWatcherManager {
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
        }
    }

    pub fn start_watching(&self, app_handle: AppHandle, path: &str) -> Result<(), String> {
        self.watch(Path::new(path), move |payload| {
            let _ = app_handle.emit("fs-change", &payload);
        })
    }

    /// Watch `root` in place of whatever was watched before, handing each
    /// change to `report`. `start_watching` is this with `report` emitting
    /// `fs-change`; tests hand it a channel.
    ///
    /// The previous watcher goes first, whether or not this one starts: the
    /// folder it watched is no longer open. Only a watcher that started used
    /// to replace it, so a folder that could not be watched left the last
    /// one reporting changes to a folder nobody had open any more.
    pub fn watch(
        &self,
        root: &Path,
        report: impl Fn(FsChangePayload) + Send + 'static,
    ) -> Result<(), String> {
        // Taken out under the lock, dropped outside it: stopping a watcher
        // waits for its thread.
        let previous = self.watcher.lock().take();
        drop(previous);

        let watched = root.to_path_buf();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    for payload in changes(&watched, event) {
                        report(payload);
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        // A folder that is not there is an error like any other, not an Ok
        // that watches nothing.
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path '{}': {e}", root.display()))?;
        *self.watcher.lock() = Some(watcher);
        Ok(())
    }
}

/// What one event from the watcher of `root` tells the frontend: a change
/// for each path it names that is not somewhere the Explorer hides.
fn changes(root: &Path, event: Event) -> Vec<FsChangePayload> {
    let kind = match event.kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "delete",
        _ => "other",
    };
    event
        .paths
        .into_iter()
        .filter(|p| !is_ignored_below(root, p))
        .map(|p| FsChangePayload {
            path: p.to_string_lossy().to_string(),
            kind: kind.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ignores_build_and_vcs_folders_anywhere_in_the_path() {
        assert!(is_ignored(Path::new("/w/app/node_modules/react/index.js")));
        assert!(is_ignored(Path::new("/w/app/.git/index")));
        assert!(is_ignored(Path::new("/w/app/src-tauri/target/debug/x")));
        assert!(is_ignored(Path::new("/w/app/dist/index.html")));
        assert!(is_ignored(Path::new("/w/app/.DS_Store")));
    }

    #[test]
    fn keeps_source_files() {
        assert!(!is_ignored(Path::new("/w/app/src/App.jsx")));
        assert!(!is_ignored(Path::new("/w/app/package.json")));
        assert!(!is_ignored(Path::new("/w/app/targets.md"))); // not the `target` folder
    }

    fn created(paths: &[&str]) -> Event {
        paths.iter().fold(
            Event::new(EventKind::Create(notify::event::CreateKind::File)),
            |event, p| event.add_path(PathBuf::from(p)),
        )
    }

    fn reported(root: &str, event: Event) -> Vec<String> {
        changes(Path::new(root), event).into_iter().map(|c| c.path).collect()
    }

    /// A dependency opened from `node_modules` to read it, or a `dist`
    /// build: every path in the folder has the hidden name in it, and every
    /// change in it used to be dropped.
    #[test]
    fn a_folder_opened_inside_a_hidden_one_reports_its_changes() {
        for root in ["/w/app/node_modules/lib", "/w/app/dist", "/w/target/checkout", "/w/.git/x", "/w/.agents/a"] {
            let file = format!("{root}/src/index.js");
            assert_eq!(reported(root, created(&[&file])), vec![file.clone()], "opened {root}");
        }
    }

    /// Only the names below the open folder count, and those still do.
    #[test]
    fn what_is_hidden_below_the_open_folder_stays_hidden() {
        let root = "/w/app/node_modules/lib";
        let event = created(&[
            "/w/app/node_modules/lib/node_modules/dep/index.js",
            "/w/app/node_modules/lib/.git/index",
            "/w/app/node_modules/lib/src/.DS_Store",
            "/w/app/node_modules/lib/src/kept.js",
        ]);
        assert_eq!(reported(root, event), vec!["/w/app/node_modules/lib/src/kept.js"]);
        assert_eq!(
            reported("/w/app", created(&["/w/app/node_modules/react/index.js", "/w/app/src/App.jsx"])),
            vec!["/w/app/src/App.jsx"],
            "an ordinary project, as before"
        );
    }

    /// A folder of this test's own, in the spelling the watcher reports
    /// (macOS reports `/private/var/…` for a temp directory under `/var`).
    fn temp_folder(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-watch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    /// Wait for a change to a path ending in `name`.
    fn wait_for(changes: &std::sync::mpsc::Receiver<FsChangePayload>, name: &str) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match changes.recv_timeout(left) {
                Ok(change) if change.path.ends_with(name) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    /// The same, through a real watcher on a real folder.
    #[test]
    fn a_real_watch_on_a_folder_inside_node_modules_hears_a_change() {
        let base = temp_folder("in-node-modules");
        let root = base.join("node_modules").join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let manager = FsWatcherManager::new();
        let (tx, rx) = std::sync::mpsc::channel();
        manager
            .watch(&root, move |change| {
                let _ = tx.send(change);
            })
            .unwrap();

        std::fs::write(root.join("index.js"), "module.exports = 1").unwrap();

        assert!(wait_for(&rx, "index.js"), "no change reported for a file in the open folder");
        drop(manager);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Opening a folder replaces the watcher. One that could not be watched
    /// left the previous folder's watcher running, reporting changes to a
    /// folder that was no longer open; it also returned Ok for a folder that
    /// did not exist, watching nothing.
    ///
    /// The previous watcher holds the only sender of the channel it reports
    /// to, so the channel closing is the watcher being gone — checked that
    /// way rather than by writing a file and waiting for silence, which
    /// inotify can still race.
    #[test]
    fn a_folder_that_cannot_be_watched_stops_the_previous_watcher() {
        let before = temp_folder("previous");
        let manager = FsWatcherManager::new();
        let (tx, rx) = std::sync::mpsc::channel();
        manager
            .watch(&before, move |change| {
                let _ = tx.send(change);
            })
            .unwrap();
        std::fs::write(before.join("one.txt"), "1").unwrap();
        assert!(wait_for(&rx, "one.txt"), "premise: the first folder is watched");

        let err = manager.watch(&before.join("gone"), |_| {}).unwrap_err();
        assert!(err.contains("gone"), "the error names the folder: {err}");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("the previous folder is still being watched")
                }
            }
        }
        let _ = std::fs::remove_dir_all(&before);
    }
}
