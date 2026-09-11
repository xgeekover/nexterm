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
        let app_handle_clone = app_handle.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let kind = match event.kind {
                        EventKind::Create(_) => "create",
                        EventKind::Modify(_) => "modify",
                        EventKind::Remove(_) => "delete",
                        _ => "other",
                    };
                    for p in event.paths {
                        if is_ignored(&p) {
                            continue;
                        }
                        let payload = FsChangePayload {
                            path: p.to_string_lossy().to_string(),
                            kind: kind.to_string(),
                        };
                        let _ = app_handle_clone.emit("fs-change", &payload);
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        let watch_path = Path::new(path);
        if watch_path.exists() {
            watcher
                .watch(watch_path, RecursiveMode::Recursive)
                .map_err(|e| format!("Failed to watch path '{path}': {e}"))?;
            *self.watcher.lock() = Some(watcher);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
