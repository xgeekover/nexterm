// Windows links a Rust binary as a CONSOLE application unless told otherwise,
// and then opens a console for it — the empty black terminal window that
// appeared beside NexTerm when the portable build was run. Tauri's own
// template carries this line; this project lost it.
//
// Kept for debug builds so `cargo run` and `tauri dev` still have somewhere to
// print: without a console there, every println! and eprintln! in the backend
// would go nowhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(warnings)]

pub mod commands;
pub mod fs;
pub mod menu;
pub mod models;
pub mod pty;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub struct AppState {
    pub pty_manager: Arc<pty::PtyManager>,
    pub fs_watcher: Arc<fs::FsWatcherManager>,
    pub workspace: Arc<fs::Workspace>,
}

/// What the window-state plugin is allowed to remember: everything but the
/// window frame.
///
/// Whether the window has a native title bar is a design decision — macOS keeps
/// its traffic lights over the webview, every other platform is frameless and
/// the app draws its own title row — and there is no way for the user to change
/// it. So there is nothing to remember, and remembering it is actively harmful:
/// `restore_state` calls `set_decorations` with the saved value, and it does so
/// AFTER the window has been built from tauri.conf.json, so a stale entry
/// silently overrules the config.
///
/// That is not hypothetical. v0.1.0 and v0.1.1 shipped before
/// tauri.windows.conf.json existed, so on Windows they ran with the base
/// config's `decorations: true` and the plugin wrote `"decorated": true` into
/// %APPDATA%\com.nexterm.ide\.window-state.json. Every release since has asked
/// for `decorations: false` there and been overruled by that file — anyone who
/// ever ran 0.1.x got the native title bar stacked on top of the app's own one,
/// with a second set of minimise/maximise/close buttons, and no new version
/// could fix it because the file outlives the install.
///
/// Dropping the flag fixes those machines without touching the file: the value
/// is no longer read, so the config wins, and it is no longer written either.
fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::DECORATIONS
}

fn main() {
    let pty_manager = Arc::new(pty::PtyManager::new());
    let fs_watcher = Arc::new(fs::FsWatcherManager::new());
    let workspace = Arc::new(fs::Workspace::new());

    let state = AppState {
        pty_manager,
        fs_watcher,
        workspace,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .manage(state)
        .setup(|app| {
            let app_state = app.state::<AppState>();

            // Reopen the folder from last time, before the webview loads and
            // starts asking where things are. See `Workspace::restore_root`:
            // the terminal restore reads the root to decide where each saved
            // terminal may start, so a root that arrives late is a root that
            // arrives after every shell has already been spawned somewhere
            // else.
            match app.path().app_config_dir() {
                Ok(dir) => {
                    app_state
                        .workspace
                        .restore_root(dir.join(fs::OPEN_FOLDER_FILE));
                }
                Err(e) => {
                    eprintln!("[NexTerm] No config directory, so the open folder cannot be remembered: {e}");
                }
            }

            // Whatever came back is watched the same way `fs_pick_root` watches
            // a folder the user opens by hand.
            if let Some(root) = app_state.workspace.root() {
                let _ = app_state
                    .fs_watcher
                    .start_watching(app.handle().clone(), &root.to_string_lossy());
            }

            // macOS always has a menu bar at the top of the screen, so the
            // native menu is the right place for it there, and app-specific
            // items are forwarded to the webview by id.
            //
            // Off macOS the window is frameless (see tauri.windows.conf.json)
            // and the app draws one compact title row containing its own menu,
            // VS Code style. A native menu there would add a second row and
            // re-introduce the accelerator collisions `terminal_safe` exists
            // to avoid, so there isn't one.
            #[cfg(target_os = "macos")]
            {
                let menu = menu::build(app.handle())?;
                app.set_menu(menu)?;
                app.on_menu_event(|handle, event| {
                    menu::forward_to_webview(handle, event.id().as_ref());
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_retain_only,
            commands::pty::pty_list_sessions,
            commands::fs::fs_get_root,
            commands::fs::fs_dir_exists,
            commands::fs::fs_pick_root,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename_path,
            commands::fs::fs_delete_path,
            commands::fs::fs_set_root,
            commands::fs::git_status,
            commands::fs::fs_search,
            commands::system::system_get_info,
            commands::system::system_list_shells,
            commands::system::menu_set_accelerators,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexterm application");
}

/// The attribute that keeps Windows from opening a console beside the app.
///
/// This checks the SOURCE, not the binary, and cannot do otherwise: the
/// subsystem is decided by the linker, `cargo test` builds a test harness
/// rather than the app, and on macOS and Linux the attribute does nothing at
/// all. So it catches the attribute being deleted — which is how it went
/// missing in the first place, and why v0.2.2 shipped with an empty black
/// terminal window beside the app — but it would still pass if the attribute
/// were present and the link ignored it.
///
/// The binary itself is checked in CI, on the one machine where a Windows
/// binary exists: the "The app must not be a console application" step in
/// .github/workflows/build.yml reads the PE header of the built exe and
/// refuses anything but Subsystem=2. Verified against the shipped artifacts —
/// v0.2.2 reads 3 (WINDOWS_CUI) and v0.2.4 reads 2 (WINDOWS_GUI).
#[cfg(test)]
mod windows_subsystem_tests {
    #[test]
    fn the_source_still_asks_for_a_windowed_subsystem() {
        let main_rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("main.rs"),
        )
        .expect("main.rs is readable");

        let attribute = main_rs
            .lines()
            .find(|line| line.contains("windows_subsystem"))
            .unwrap_or_else(|| {
                panic!(
                    "main.rs has no `windows_subsystem` attribute — a release build on Windows \
                     will open an empty console window beside the app"
                )
            });

        assert!(
            attribute.contains("windows_subsystem = \"windows\""),
            "the subsystem must be `windows`, not a console: {attribute}"
        );
        assert!(
            attribute.contains("not(debug_assertions)"),
            "keep it to release builds so `tauri dev` still has somewhere to print: {attribute}"
        );
        assert!(
            attribute.trim_start().starts_with("#!["),
            "it has to be an inner attribute on the crate root: {attribute}"
        );
    }
}

/// The window frame is the app's decision, not remembered state.
///
/// See [`window_state_flags`]. This is the guard on the one flag that must stay
/// off: turning it back on would re-break every Windows machine that still has
/// `"decorated": true` sitting in its .window-state.json from 0.1.x, and the
/// symptom — two stacked title bars — only shows up on a machine with that
/// file, which is not this one and not CI.
#[cfg(test)]
mod window_state_tests {
    use super::window_state_flags;
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn decorations_are_never_restored() {
        assert!(
            !window_state_flags().contains(StateFlags::DECORATIONS),
            "the window-state plugin must not restore decorations — a saved \
             `decorated` overrules tauri.conf.json and puts the native title bar \
             back above the app's own one"
        );
    }

    #[test]
    fn everything_the_user_can_actually_change_is_still_remembered() {
        let flags = window_state_flags();
        for (name, flag) in [
            ("size", StateFlags::SIZE),
            ("position", StateFlags::POSITION),
            ("maximized", StateFlags::MAXIMIZED),
            ("visible", StateFlags::VISIBLE),
            ("fullscreen", StateFlags::FULLSCREEN),
        ] {
            assert!(
                flags.contains(flag),
                "dropping decorations must not drop {name} — reopening where you \
                 left off is the reason the plugin is here"
            );
        }
    }
}
