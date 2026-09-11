use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::models::FsChangePayload;

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
