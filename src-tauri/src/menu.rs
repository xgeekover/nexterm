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
//! menu instead, VS-Code-style. Either way the same 14 custom ids exist on
//! every platform (see `every_custom_id_is_unique_and_matches_the_frontend_contract`),
//! so the frontend's id-based event handling in `useMenuEvents.js` needs no
//! platform branching.

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
    Custom { id: &'static str, label: &'static str, accelerator: Option<&'static str> },
    Predefined(Predefined),
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submenu {
    pub title: &'static str,
    pub items: Vec<Item>,
}

fn custom(id: &'static str, label: &'static str, accelerator: &'static str) -> Item {
    Item::Custom { id, label, accelerator: Some(accelerator) }
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
                custom("save", "Save", "CmdOrCtrl+S"),
                Sep,
                P(CloseWindow),
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
                custom("save", "Save", "CmdOrCtrl+S"),
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
            custom("command-palette", "Command Palette…", "CmdOrCtrl+K"),
            custom("quick-open", "Go to File…", "CmdOrCtrl+P"),
            Sep,
            custom("toggle-sidebar", "Toggle Primary Side Bar", "CmdOrCtrl+B"),
            custom("toggle-panel", "Toggle Terminal Panel", "Ctrl+`"),
            custom("toggle-secondary", "Toggle AI Side Bar", "CmdOrCtrl+Alt+B"),
            Sep,
            P(Fullscreen),
        ],
    });
    submenus.push(Submenu {
        title: "Terminal",
        items: vec![
            custom("split-right", "Split Right", "CmdOrCtrl+D"),
            custom("split-down", "Split Down", "CmdOrCtrl+Shift+D"),
            custom("close-pane", "Close Pane", "CmdOrCtrl+W"),
            Sep,
            custom("clear-terminal", "Clear Unpinned Blocks", "CmdOrCtrl+L"),
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
            vec![P(Minimize), P(Maximize), P(CloseWindow)]
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
    let mut submenus = Vec::new();
    for sub in spec() {
        let mut b = SubmenuBuilder::new(app, sub.title);
        for item in sub.items {
            b = match item {
                Item::Separator => b.separator(),
                Item::Custom { id, label, accelerator } => {
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
        // Mirrors the `case` labels in src/hooks/useMenuEvents.js.
        let expected = [
            "preferences", "open-folder", "new-terminal", "save", "command-palette", "quick-open",
            "toggle-sidebar", "toggle-panel", "toggle-secondary",
            "split-right", "split-down", "close-pane", "clear-terminal",
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
    fn every_custom_item_has_an_accelerator() {
        for sub in spec() {
            for item in sub.items {
                if let Item::Custom { id, accelerator, .. } = item {
                    assert!(accelerator.is_some(), "{id} has no accelerator");
                }
            }
        }
    }
}
