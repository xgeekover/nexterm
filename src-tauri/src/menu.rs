//! Native application menu.
//!
//! The menu is described as data (`spec()`) and then materialised with muda
//! (`build()`). Keeping the description separate makes the structure and the
//! id contract with the frontend testable without a main thread — macOS only
//! lets menu items be created there, so the muda layer cannot run in tests.
//!
//! macOS routes ⌘C/⌘V/⌘A through the Edit menu, so a custom menu must keep
//! the predefined edit items there or text fields stop working. The same
//! items are deliberately absent everywhere else: their Ctrl accelerators
//! would be claimed by the window before the webview sees them, and Ctrl+C
//! has to reach the pty as SIGINT. App-specific items
//! are forwarded to the webview as a `menu` event carrying the item id; the
//! frontend maps ids to store actions (see `src/hooks/useMenuEvents.js`).
//!
//! The leading "app menu" (About/Services/Hide/…/Quit) is a macOS-only
//! convention — muda cannot build those items on other platforms, and
//! Windows/Linux apps don't have an app-named menu at all. There we fold the
//! items that would otherwise live there (Settings…, Quit) into the File
//! menu instead, VS-Code-style. The custom ids are the same on every
//! platform apart from `close-window`, which only macOS needs, and
//! every platform (see `every_custom_id_is_unique_and_matches_the_frontend_contract`),
//! so the frontend's id-based event handling in `useMenuEvents.js` needs no
//! platform branching.

use std::collections::HashMap;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const EVENT: &str = "menu";

// About/Services/Hide/HideOthers/ShowAll are only ever constructed in the
// macOS branch of `spec()` below; on other platforms they are legitimately
// unused variants of an otherwise-live enum.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// App-specific item; `id` is what the webview receives.
    ///
    /// The accelerator is owned rather than `&'static str` because it is no
    /// longer fixed at compile time: a user can rebind a shortcut in Settings,
    /// and the menu has to say what the key actually does now.
    Custom { id: &'static str, label: &'static str, accelerator: Option<String> },
    Predefined(Predefined),
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submenu {
    pub title: &'static str,
    pub items: Vec<Item>,
}

fn custom(id: &'static str, label: &'static str, accelerator: &str) -> Item {
    Item::Custom { id, label, accelerator: Some(accelerator.to_string()) }
}

/// A menu item whose accelerator would be a bare `Ctrl`+letter off macOS.
///
/// Those belong to the terminal, not to us. Windows resolves the window's
/// accelerator table before the webview gets the key, and GTK runs its accel
/// group before the focused widget, so registering `CmdOrCtrl+D` here takes
/// EOF away from every shell in the app — likewise Ctrl+K (kill line), Ctrl+W
/// (delete word), Ctrl+P (history), Ctrl+B (backward char) and Ctrl+S (XOFF).
///
/// On macOS the app modifier is ⌘, which collides with nothing in the pty, so
/// the accelerator is registered normally. Elsewhere the item is menu-only and
/// `useKeybindings.js` provides the shortcut — a webview-level listener, which
/// xterm's own capture handler correctly beats whenever a terminal has focus.
fn terminal_safe(id: &'static str, label: &'static str, mac_accelerator: &str) -> Item {
    #[cfg(target_os = "macos")]
    {
        Item::Custom { id, label, accelerator: Some(mac_accelerator.to_string()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = mac_accelerator;
        Item::Custom { id, label, accelerator: None }
    }
}

/// The whole menu bar, in order.
pub fn spec() -> Vec<Submenu> {
    use Item::{Predefined as P, Separator as Sep};
    use Predefined::*;

    let mut submenus = Vec::new();

    #[cfg(target_os = "macos")]
    {
        submenus.push(Submenu {
            title: "NexTerm",
            items: vec![
                P(About),
                Sep,
                custom("preferences", "Settings…", "CmdOrCtrl+,"),
                Sep,
                P(Services),
                Sep,
                P(Hide),
                P(HideOthers),
                P(ShowAll),
                Sep,
                P(Quit),
            ],
        });
        submenus.push(Submenu {
            title: "File",
            items: vec![
                custom("open-folder", "Open Folder…", "CmdOrCtrl+Shift+O"),
                custom("new-terminal", "New Terminal", "Ctrl+Shift+`"),
                Sep,
                terminal_safe("save", "Save", "CmdOrCtrl+S"),
                Sep,
                // Deliberately NOT `P(CloseWindow)`: muda gives that ⌘W on
                // macOS, and two items claiming one key equivalent means AppKit
                // drops the accelerator from the later one — Terminal ▸ Close
                // Pane ended up with no shortcut at all, and ⌘W closed the whole
                // window with every terminal in it. Terminal.app and iTerm put
                // ⌘W on the tab and ⌘⇧W on the window; so do we.
                custom("close-window", "Close Window", "CmdOrCtrl+Shift+W"),
            ],
        });
    }

    // Windows/Linux have no Apple-style app menu, so Settings… and Quit
    // (which live in the "NexTerm" menu on macOS) move into File instead —
    // the same layout VS Code and most native Windows/Linux apps use.
    #[cfg(not(target_os = "macos"))]
    {
        submenus.push(Submenu {
            title: "File",
            items: vec![
                custom("open-folder", "Open Folder…", "CmdOrCtrl+Shift+O"),
                custom("new-terminal", "New Terminal", "Ctrl+Shift+`"),
                terminal_safe("save", "Save", "CmdOrCtrl+S"),
                Sep,
                custom("preferences", "Settings…", "CmdOrCtrl+,"),
                Sep,
                P(Quit),
            ],
        });
    }

    // macOS routes ⌘C/⌘V/⌘A through the Edit menu — without these items the
    // shortcuts do nothing in the webview at all.
    //
    // Everywhere else the menu is actively harmful: muda gives these the
    // CmdOrCtrl accelerators, so Windows' TranslateAccelerator and GTK's
    // accel group both claim Ctrl+C before the webview sees it — and Ctrl+C
    // in a terminal has to reach the pty as SIGINT, or a runaway process
    // cannot be stopped from the keyboard. Ctrl+Z (Undo) is the same story.
    // WebView2 and WebKitGTK already handle the editing shortcuts natively.
    #[cfg(target_os = "macos")]
    submenus.push(Submenu {
        title: "Edit",
        items: vec![P(Undo), P(Redo), Sep, P(Cut), P(Copy), P(Paste), P(SelectAll)],
    });
    submenus.push(Submenu {
        title: "View",
        items: vec![
            terminal_safe("command-palette", "Command Palette…", "CmdOrCtrl+K"),
            terminal_safe("quick-open", "Go to File…", "CmdOrCtrl+P"),
            custom("search-in-files", "Search in Files…", "CmdOrCtrl+Shift+F"),
            Sep,
            terminal_safe("toggle-sidebar", "Toggle Primary Side Bar", "CmdOrCtrl+B"),
            custom("toggle-panel", "Toggle Terminal Panel", "Ctrl+`"),
            custom("toggle-secondary", "Toggle Terminals Side Bar", "CmdOrCtrl+Alt+B"),
            Sep,
            // Not `terminal_safe`: these are punctuation and a digit, not the
            // Ctrl+letter the shell turns into a control byte, so the window
            // may claim them on every platform.
            custom("zoom-in", "Zoom In", "CmdOrCtrl+="),
            custom("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
            custom("zoom-reset", "Reset Zoom", "CmdOrCtrl+0"),
            Sep,
            P(Fullscreen),
        ],
    });
    submenus.push(Submenu {
        title: "Terminal",
        items: vec![
            terminal_safe("split-right", "Split Right", "CmdOrCtrl+D"),
            custom("split-down", "Split Down", "CmdOrCtrl+Shift+D"),
            terminal_safe("close-pane", "Close Pane", "CmdOrCtrl+W"),
            Sep,
            terminal_safe("find-in-terminal", "Find…", "CmdOrCtrl+F"),
            terminal_safe("clear-terminal", "Clear Unpinned Blocks", "CmdOrCtrl+L"),
        ],
    });

    // `CloseWindow` lives in the macOS File menu (above); fold it into
    // Window on other platforms, which is where it conventionally lives.
    let window_items = {
        #[cfg(target_os = "macos")]
        {
            vec![P(Minimize), P(Maximize)]
        }
        #[cfg(not(target_os = "macos"))]
        {
            vec![P(Minimize), P(Maximize)]
        }
    };
    submenus.push(Submenu { title: "Window", items: window_items });

    submenus
}

/// Every app-specific item id, in menu order.
pub fn custom_ids() -> Vec<&'static str> {
    spec()
        .iter()
        .flat_map(|s| s.items.iter())
        .filter_map(|i| match i {
            Item::Custom { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with(app, &HashMap::new())
}

/// The menu, with the accelerators the user actually has bound.
///
/// `overrides` maps a menu item id to the accelerator it should show — or to
/// `None` for an item the user has unbound, which then appears in the menu
/// with no shortcut beside it rather than advertising one that no longer
/// works. Ids the map does not mention keep whatever `spec` gave them.
///
/// The frontend owns the keybindings (src/lib/keybindings.js), so it is the
/// frontend that sends these; see the `menu_set_accelerators` command.
pub fn build_with<R: Runtime>(
    app: &AppHandle<R>,
    overrides: &HashMap<String, Option<String>>,
) -> tauri::Result<Menu<R>> {
    let mut submenus = Vec::new();
    for sub in spec() {
        let mut b = SubmenuBuilder::new(app, sub.title);
        for item in sub.items {
            b = match item {
                Item::Separator => b.separator(),
                Item::Custom { id, label, accelerator } => {
                    let accelerator = match overrides.get(id) {
                        Some(chosen) => chosen.clone(),
                        None => accelerator,
                    };
                    let mut mi = MenuItemBuilder::with_id(id, label);
                    if let Some(acc) = accelerator {
                        mi = mi.accelerator(acc);
                    }
                    b.item(&mi.build(app)?)
                }
                Item::Predefined(kind) => match kind {
                    Predefined::About => b.about(None),
                    Predefined::Services => b.services(),
                    Predefined::Hide => b.hide(),
                    Predefined::HideOthers => b.hide_others(),
                    Predefined::ShowAll => b.show_all(),
                    Predefined::Quit => b.quit(),
                    Predefined::CloseWindow => b.close_window(),
                    Predefined::Undo => b.undo(),
                    Predefined::Redo => b.redo(),
                    Predefined::Cut => b.cut(),
                    Predefined::Copy => b.copy(),
                    Predefined::Paste => b.paste(),
                    Predefined::SelectAll => b.select_all(),
                    Predefined::Fullscreen => b.fullscreen(),
                    Predefined::Minimize => b.minimize(),
                    Predefined::Maximize => b.maximize(),
                },
            };
        }
        submenus.push(b.build()?);
    }
    let mut menu = MenuBuilder::new(app);
    for sub in &submenus {
        menu = menu.item(sub);
    }
    menu.build()
}

/// Forward every app-specific menu item to the webview by id.
pub fn forward_to_webview<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit(EVENT, id.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn menu_bar_has_the_expected_submenus_in_order() {
        let titles: Vec<&str> = spec().iter().map(|s| s.title).collect();
        #[cfg(target_os = "macos")]
        assert_eq!(titles, ["NexTerm", "File", "Edit", "View", "Terminal", "Window"]);
        // No Edit menu off macOS — see the module doc and `edit_menu_*` below.
        #[cfg(not(target_os = "macos"))]
        assert_eq!(titles, ["File", "View", "Terminal", "Window"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_the_native_app_menu_under_nexterm() {
        let nexterm = spec().into_iter().find(|s| s.title == "NexTerm").expect("NexTerm submenu");
        for needed in [
            Predefined::About,
            Predefined::Services,
            Predefined::Hide,
            Predefined::HideOthers,
            Predefined::ShowAll,
            Predefined::Quit,
        ] {
            assert!(nexterm.items.contains(&Item::Predefined(needed)), "NexTerm menu lacks {needed:?}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_file_menu_absorbs_settings_and_quit() {
        let file = spec().into_iter().find(|s| s.title == "File").expect("File submenu");
        assert!(file.items.contains(&custom("preferences", "Settings…", "CmdOrCtrl+,")));
        assert!(file.items.contains(&Item::Predefined(Predefined::Quit)));

        // macOS Apple-menu-only concepts must not appear anywhere off macOS.
        let all_items: Vec<Item> = spec().into_iter().flat_map(|s| s.items).collect();
        for mac_only in [
            Predefined::About,
            Predefined::Services,
            Predefined::Hide,
            Predefined::HideOthers,
            Predefined::ShowAll,
        ] {
            assert!(
                !all_items.contains(&Item::Predefined(mac_only)),
                "{mac_only:?} should not appear outside macOS"
            );
        }
    }

    #[test]
    fn every_custom_id_is_unique_and_matches_the_frontend_contract() {
        let ids = custom_ids();
        let unique: HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "duplicate menu ids: {ids:?}");
        // Mirrors `runMenuAction` in src/lib/menuActions.js, which both this
        // menu and the one the app draws off macOS dispatch through.
        #[cfg(target_os = "macos")]
        let expected = [
            "preferences", "open-folder", "new-terminal", "save", "command-palette", "quick-open",
            "search-in-files", "toggle-sidebar", "toggle-panel", "toggle-secondary",
            "zoom-in", "zoom-out", "zoom-reset",
            "split-right", "split-down", "close-pane", "find-in-terminal", "clear-terminal",
            "close-window",
        ];
        // Off macOS the window is closed from the app's own title bar, and
        // Quit lives in the File menu as a predefined item.
        #[cfg(not(target_os = "macos"))]
        let expected = [
            "preferences", "open-folder", "new-terminal", "save", "command-palette", "quick-open",
            "search-in-files", "toggle-sidebar", "toggle-panel", "toggle-secondary",
            "zoom-in", "zoom-out", "zoom-reset",
            "split-right", "split-down", "close-pane", "find-in-terminal", "clear-terminal",
        ];
        for e in expected {
            assert!(ids.contains(&e), "missing menu item id: {e}");
        }
        assert_eq!(ids.len(), expected.len(), "unexpected extra ids: {ids:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn edit_menu_keeps_the_clipboard_items_macos_needs() {
        let edit = spec().into_iter().find(|s| s.title == "Edit").expect("Edit submenu");
        for needed in [Predefined::Cut, Predefined::Copy, Predefined::Paste, Predefined::SelectAll] {
            assert!(edit.items.contains(&Item::Predefined(needed)), "Edit menu lacks {needed:?}");
        }
    }

    /// On Windows and Linux these carry Ctrl accelerators that the window's
    /// accelerator table claims before the webview — which would take Ctrl+C
    /// away from the terminal, leaving no way to interrupt a running command.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_edit_menu_off_macos_so_ctrl_c_reaches_the_terminal() {
        assert!(
            spec().into_iter().all(|s| s.title != "Edit"),
            "an Edit menu here would claim Ctrl+C before the pty sees it"
        );
    }

    #[test]
    fn every_custom_item_has_an_accelerator_unless_the_shell_needs_it() {
        // Off macOS these are reachable from the menu only; `useKeybindings.js`
        // provides the shortcut, where xterm can win it back when a terminal
        // has focus. See `terminal_safe`.
        #[cfg(not(target_os = "macos"))]
        let menu_only: &[&str] = &[
            "save",
            "command-palette",
            "quick-open",
            "toggle-sidebar",
            "split-right",
            "close-pane",
            // Ctrl+F is readline's forward-char. The item stays menu-only
            // here and `useKeybindings.js` claims the chord in the webview,
            // where xterm could still win it back if it had to.
            "find-in-terminal",
            "clear-terminal",
        ];
        #[cfg(target_os = "macos")]
        let menu_only: &[&str] = &[];

        for sub in spec() {
            for item in sub.items {
                if let Item::Custom { id, accelerator, .. } = item {
                    if menu_only.contains(&id) {
                        assert!(accelerator.is_none(), "{id} must stay menu-only here");
                    } else {
                        assert!(accelerator.is_some(), "{id} has no accelerator");
                    }
                }
            }
        }
    }

    /// Write this platform's accelerators out for the JS half to compare.
    ///
    /// The frontend computes the same strings from the keybindings
    /// (`src/lib/nativeMenu.js`) and sends them back through
    /// `menu_set_accelerators`. If the two disagree, the menu shows one key
    /// before the frontend connects and another after — so a test reads this
    /// file and checks them item by item, on whichever platform it ran on.
    #[test]
    fn dump_the_accelerators_for_the_frontend_contract_test() {
        let mut accelerators = serde_json::Map::new();
        for sub in spec() {
            for item in sub.items {
                if let Item::Custom { id, accelerator, .. } = item {
                    accelerators.insert(
                        id.to_string(),
                        match accelerator {
                            Some(a) => serde_json::Value::String(a),
                            None => serde_json::Value::Null,
                        },
                    );
                }
            }
        }
        let payload = serde_json::json!({
            "platform": std::env::consts::OS,
            "accelerators": accelerators,
        });

        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests")
            .join("fixtures");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("menu-accelerators.json"),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();
    }

    /// The invariant that matters on Windows and Linux: the window resolves
    /// its accelerator table before the webview sees the key, so a bare
    /// Ctrl+letter here is taken away from every shell in the app — and every
    /// one of those letters means something to readline (D is EOF, K kills to
    /// end of line, W deletes a word, P walks history, S is XOFF).
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_accelerator_claims_a_bare_ctrl_letter() {
        for sub in spec() {
            for item in sub.items {
                if let Item::Custom { id, accelerator: Some(accel), .. } = item {
                    let parts: Vec<&str> = accel.split('+').collect();
                    let bare_ctrl_letter = parts.len() == 2
                        && matches!(parts[0], "CmdOrCtrl" | "Ctrl")
                        && parts[1].len() == 1
                        && parts[1].chars().all(|c| c.is_ascii_alphabetic());
                    assert!(!bare_ctrl_letter, "{id} claims {accel}, which the shell needs");
                }
            }
        }
    }
}
