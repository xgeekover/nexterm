//! Native application menu.
//!
//! The menu is described as data (`spec()`) and then materialised with muda
//! (`build()`). Keeping the description separate makes the structure and the
//! id contract with the frontend testable without a main thread — macOS only
//! lets menu items be created there, so the muda layer cannot run in tests.
//!
//! macOS routes ⌘C/⌘V/⌘A through the Edit menu, so a custom menu must keep
//! the predefined edit items or text fields stop working. App-specific items
//! are forwarded to the webview as a `menu` event carrying the item id; the
//! frontend maps ids to store actions (see `src/hooks/useMenuEvents.js`).

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const EVENT: &str = "menu";

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
    vec![
        Submenu {
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
        },
        Submenu {
            title: "File",
            items: vec![
                custom("open-folder", "Open Folder…", "CmdOrCtrl+Shift+O"),
                custom("new-terminal", "New Terminal", "Ctrl+Shift+`"),
                Sep,
                custom("save", "Save", "CmdOrCtrl+S"),
                Sep,
                P(CloseWindow),
            ],
        },
        Submenu {
            title: "Edit",
            items: vec![P(Undo), P(Redo), Sep, P(Cut), P(Copy), P(Paste), P(SelectAll)],
        },
        Submenu {
            title: "View",
            items: vec![
                custom("command-palette", "Command Palette…", "CmdOrCtrl+K"),
                custom("quick-open", "Go to File…", "CmdOrCtrl+P"),
                Sep,
                custom("toggle-sidebar", "Toggle Primary Side Bar", "CmdOrCtrl+B"),
                custom("toggle-panel", "Toggle Terminal Panel", "Ctrl+`"),
                custom("toggle-secondary", "Toggle AI Side Bar", "CmdOrCtrl+Alt+B"),
                Sep,
                custom("toggle-theme", "Toggle Light/Dark Theme", "CmdOrCtrl+Shift+T"),
                Sep,
                P(Fullscreen),
            ],
        },
        Submenu {
            title: "Terminal",
            items: vec![
                custom("split-right", "Split Right", "CmdOrCtrl+D"),
                custom("split-down", "Split Down", "CmdOrCtrl+Shift+D"),
                custom("close-pane", "Close Pane", "CmdOrCtrl+W"),
                Sep,
                custom("clear-terminal", "Clear Unpinned Blocks", "CmdOrCtrl+L"),
            ],
        },
        Submenu {
            title: "Window",
            items: vec![P(Minimize), P(Maximize)],
        },
    ]
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
        assert_eq!(titles, ["NexTerm", "File", "Edit", "View", "Terminal", "Window"]);
    }

    #[test]
    fn every_custom_id_is_unique_and_matches_the_frontend_contract() {
        let ids = custom_ids();
        let unique: HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "duplicate menu ids: {ids:?}");
        // Mirrors the `case` labels in src/hooks/useMenuEvents.js.
        let expected = [
            "preferences", "open-folder", "new-terminal", "save", "command-palette", "quick-open",
            "toggle-sidebar", "toggle-panel", "toggle-secondary", "toggle-theme",
            "split-right", "split-down", "close-pane", "clear-terminal",
        ];
        for e in expected {
            assert!(ids.contains(&e), "missing menu item id: {e}");
        }
        assert_eq!(ids.len(), expected.len(), "unexpected extra ids: {ids:?}");
    }

    #[test]
    fn edit_menu_keeps_the_clipboard_items_macos_needs() {
        let edit = spec().into_iter().find(|s| s.title == "Edit").expect("Edit submenu");
        for needed in [Predefined::Cut, Predefined::Copy, Predefined::Paste, Predefined::SelectAll] {
            assert!(edit.items.contains(&Item::Predefined(needed)), "Edit menu lacks {needed:?}");
        }
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
