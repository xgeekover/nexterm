//! Names in a terminal's output, shown in the file manager.
//!
//! The webview finds the words in the output that could be a file or a folder
//! (`src/lib/outputPaths.js`) and, while Cmd/Ctrl is held, asks which of them
//! exist (`path_kinds`) — only those get an underline. A Cmd/Ctrl+click shows
//! one (`reveal_target`, then `show`): on macOS and Windows a folder opens in
//! the file manager, everywhere else and for anything else the item is
//! selected in its folder. Nothing here ever OPENS a file — opening runs it,
//! when it is an `.exe`, a script or an app — and nothing opens a folder by a
//! call that could run one (`show` says how, per platform).
//!
//! **Not confined to the open folder, on purpose.** `ls ~` prints names
//! outside it, and that is the use case; the shell in the same window can
//! list them anyway. What leaves here is whether a local path exists and is a
//! folder — nothing of what is in it.
//!
//! **Never another machine.** What a terminal prints is not trusted, and on
//! Windows only asking whether `\\host\share\x` exists connects to the host
//! and signs in with the user's credentials. A path spelled that way
//! (`is_network_path`), or one going through a link — or a chain of them —
//! that leads there (`link_leads_off_machine`), is answered without being
//! looked at. So, on Windows, is one on a mapped network drive (a
//! disconnected one is reconnected, and the call hangs while it is), a device
//! (`names_a_device`) and a shell-namespace folder (`names_a_shell_folder`).

use std::fs;
use std::path::{Path, PathBuf};

use crate::fs::{is_network_path, link_leads_off_machine};

/// Paths `path_kinds` answers in one call; the webview splits a row's
/// candidates into calls of this many (`MAX_KIND_PATHS` in
/// src/lib/outputPaths.js).
pub const MAX_KIND_PATHS: usize = 64;

/// Bytes a path asked about may run to. Longer is no path anyone printed.
pub const MAX_KIND_PATH_BYTES: usize = 4096;

/// Why `path` is not looked at at all, decided by its spelling alone — or
/// `None` when it may be. `windows` is whether the rules that only Windows
/// needs apply (`cfg!(windows)` in the app; either in the tests, which must
/// mean the same on every platform).
pub fn refusal(path: &str, windows: bool) -> Option<String> {
    if path.is_empty() || path.len() > MAX_KIND_PATH_BYTES {
        return Some("Not a path that can be shown".to_string());
    }
    if is_network_path(path) {
        return Some(format!("Path is on another machine or a device: {path}"));
    }
    if windows && (names_a_device(path) || names_a_shell_folder(path) || absolute_is_a_device(path)) {
        return Some(format!("Path is a device or a shell folder: {path}"));
    }
    if !Path::new(path).is_absolute() {
        return Some(format!("Not an absolute path: {path}"));
    }
    None
}

/// What a local path is: `"dir"`, `"file"` (anything else that exists), or
/// `None` — for a path that does not exist, and for one that is not looked at
/// at all (`refusal`, a link that leads off the machine, a network drive).
///
/// `fs::metadata` follows links, so a link to a folder is a folder — it opens
/// as one — and a broken link is nothing. Every link in the way is known to
/// stay on this machine by then.
pub fn path_kind(path: &str) -> Option<&'static str> {
    if refusal(path, cfg!(windows)).is_some() || on_a_network_drive(path) {
        return None;
    }
    let _quiet = os::QuietDriveErrors::new();
    let path = Path::new(path);
    if link_leads_off_machine(path) {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    Some(if meta.is_dir() { "dir" } else { "file" })
}

/// `path_kind` for each of `paths`, in order — refused whole for more than
/// MAX_KIND_PATHS.
pub fn path_kinds(paths: &[String]) -> Result<Vec<Option<&'static str>>, String> {
    if paths.len() > MAX_KIND_PATHS {
        return Err(format!(
            "At most {MAX_KIND_PATHS} paths can be asked about at once, not {}",
            paths.len()
        ));
    }
    Ok(paths.iter().map(|path| path_kind(path)).collect())
}

/// The names of a path, each as Windows reads it: what follows the first
/// `:` is an alternate data stream (`COM1::$DATA`, `lpt1:x`) and trailing
/// dots and spaces are dropped (`nul.`, `nul `). The drive (`C:`) reads as
/// `C`, which names nothing here.
fn names_as_windows_reads_them(path: &str) -> impl Iterator<Item = String> + '_ {
    path.split(['\\', '/']).map(|name| {
        let name = name.split(':').next().unwrap_or(name);
        name.trim_end_matches(['.', ' ']).to_string()
    })
}

/// Whether any name in a path is one of the devices Windows keeps in every
/// folder — `CON`, `NUL`, `AUX`, `PRN`, `COM1`… `LPT9` — with or without an
/// extension. `C:\project\nul` is the null device and `C:\project\com1` a
/// serial port, whatever folder they are spelled in (and `nul\.`, `nul\`,
/// `nul\x\..` all reach it), and a word in the output is looked at as soon as
/// it is asked about. Decided by spelling, so it means the same on every
/// platform; only Windows asks.
pub fn names_a_device(path: &str) -> bool {
    names_as_windows_reads_them(path).any(|name| {
        let stem = name.split('.').next().unwrap_or(&name).trim_end_matches(' ').to_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$") {
            return true;
        }
        let mut chars = stem.chars();
        let prefix: String = chars.by_ref().take(3).collect();
        let rest: Vec<char> = chars.collect();
        (prefix == "COM" || prefix == "LPT")
            && rest.len() == 1
            && (rest[0].is_ascii_digit() || matches!(rest[0], '¹' | '²' | '³'))
    })
}

/// Whether any name in a path ends in `.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`.
/// Explorer opens such a folder as the shell-namespace object the class id
/// names, not as a folder: a folder shortcut built that way navigates to its
/// target, which may be a share on another machine.
pub fn names_a_shell_folder(path: &str) -> bool {
    names_as_windows_reads_them(path).any(|name| {
        let Some(open) = name.rfind(".{") else {
            return false;
        };
        let id = &name[open + 1..];
        let bytes = id.as_bytes();
        bytes.len() == 38
            && bytes[0] == b'{'
            && bytes[37] == b'}'
            && bytes[1..37].iter().enumerate().all(|(i, b)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    *b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
    })
}

/// Whether Windows itself reads `path` as a device: `std::path::absolute` is
/// `GetFullPathNameW` there — spelling only, nothing touched — and turns
/// `C:\project\nul` into `\\.\nul`. Elsewhere it is the path made absolute,
/// which never starts like that.
fn absolute_is_a_device(path: &str) -> bool {
    std::path::absolute(path).map_or(true, |absolute| is_network_path(&absolute.to_string_lossy()))
}

/// Whether `path` is on a mapped network drive (Windows: `GetDriveTypeW` on
/// its drive's root, which reads the drive's type without reaching it).
fn on_a_network_drive(path: &str) -> bool {
    os::on_a_network_drive(path)
}

/// What showing a path in the file manager does with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealAction {
    /// Open the folder itself in the file manager (`show` says how).
    Open,
    /// Open the folder holding it, with it selected. Never opens the item.
    Reveal,
}

/// How to show something, by what it is and where. `os` is
/// `std::env::consts::OS`.
///
/// A file is revealed — selected in its folder — everywhere: opening one runs
/// it when it is a program. A folder opens on macOS and Windows, each by a
/// call that only ever shows a folder (`show`). On Linux and anything else a
/// folder is revealed too: the only way to "open" one there is the desktop's
/// default handler for it (`xdg-open`), which is whatever the user or an
/// installer registered.
pub fn reveal_action(is_dir: bool, os: &str) -> RevealAction {
    match (is_dir, os) {
        (true, "macos") | (true, "windows") => RevealAction::Open,
        _ => RevealAction::Reveal,
    }
}

/// The path `fs_reveal_path` shows, and how — refused, with the reason, for
/// anything `path_kind` would not look at and for a path that does not exist.
pub fn reveal_target(path: &str) -> Result<(PathBuf, RevealAction), String> {
    if let Some(reason) = refusal(path, cfg!(windows)) {
        return Err(reason);
    }
    if on_a_network_drive(path) {
        return Err(format!("Path is on a network drive: {path}"));
    }
    let _quiet = os::QuietDriveErrors::new();
    let given = Path::new(path);
    if link_leads_off_machine(given) {
        return Err(format!("Path goes through a link to another machine: {path}"));
    }
    let meta = fs::metadata(given).map_err(|e| format!("Cannot show '{path}': {e}"))?;
    Ok((given.to_path_buf(), reveal_action(meta.is_dir(), std::env::consts::OS)))
}

/// Show `target` in the file manager as `action` says. The OS call itself,
/// which no test can watch.
///
/// - Reveal: the opener plugin's `reveal_item_in_dir` — Finder's
///   `activateFileViewerSelectingURLs`, Explorer's
///   `SHOpenFolderAndSelectItems`, the desktop's FileManager1 `ShowItems`.
///   All three select the item in a window of its folder; none opens it.
/// - Open, macOS: `os::open_folder`. Not `open` (`open_path`): LaunchServices
///   decides what a folder is, and one with no extension and no Info.plist
///   but the bundle bit set is an application to it — `open` RAN one, and so
///   does rooting a Finder viewer at it, so a package is revealed instead.
/// - Open, Windows: `os::open_folder`. Not `open_path`: the `open` crate
///   checks again whether it is a folder and, for anything else, falls back to
///   `ShellExecuteExW` with the default verb — so a folder swapped for an
///   `.exe` between our check and that one is run.
pub fn show(target: &Path, action: RevealAction) -> Result<(), String> {
    match action {
        RevealAction::Reveal => tauri_plugin_opener::reveal_item_in_dir(target).map_err(|e| e.to_string()),
        RevealAction::Open => os::open_folder(target),
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::path::Path;

    /// Nothing to quiet: macOS asks no one to insert a disk.
    pub struct QuietDriveErrors;
    impl QuietDriveErrors {
        pub fn new() -> Self {
            QuietDriveErrors
        }
    }

    pub fn on_a_network_drive(_: &str) -> bool {
        false
    }

    /// Whether LaunchServices takes `dir` for a package — an app, a bundle —
    /// which is what decides whether showing it launches it: by its
    /// extension, or by the bundle bit in its Finder info, which no name
    /// shows. Asked of the folder itself, never of a link to it: for a link
    /// the answer is "no" and the package behind it launches all the same.
    pub fn is_package(dir: &Path) -> bool {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;
        let path = NSString::from_str(&dir.to_string_lossy());
        objc2::rc::autoreleasepool(|_| NSWorkspace::sharedWorkspace().isFilePackageAtPath(&path))
    }

    /// Where a folder is shown from, and how: the folder its links lead to,
    /// opened — or, when that is a package, revealed in its own folder.
    pub fn folder_shown_as(dir: &Path) -> Result<(std::path::PathBuf, super::RevealAction), String> {
        let real = dunce::canonicalize(dir).map_err(|e| e.to_string())?;
        let action = if is_package(&real) { super::RevealAction::Reveal } else { super::RevealAction::Open };
        Ok((real, action))
    }

    /// A Finder window showing `dir`: `selectFile:nil
    /// inFileViewerRootedAtPath:` on the folder its links lead to — unless
    /// that is a package, which is revealed (`activateFileViewerSelectingURLs`
    /// launches nothing). Measured on this machine with a folder made to
    /// look like an app (no extension, no Info.plist, the bundle bit,
    /// `Contents/MacOS/x` touching a marker file): rooting a viewer at it RAN
    /// it, directly and through a link; at a folder LaunchServices does not
    /// call a package — `conf.d`, `Contents/` inside an app, one with
    /// `PkgInfo` but no bundle bit — it opened a window and ran nothing.
    /// What is left is a race: a folder turned into a package between
    /// `is_package` and the call, by something already writing to it.
    ///
    /// NSWorkspace is not one of AppKit's main-thread-only classes
    /// (objc2-app-kit has no `MainThreadOnly` on it, and the opener plugin
    /// reveals from a worker thread the same way).
    pub fn open_folder(dir: &Path) -> Result<(), String> {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;
        let (real, action) = folder_shown_as(dir)?;
        if action == super::RevealAction::Reveal {
            return tauri_plugin_opener::reveal_item_in_dir(&real).map_err(|e| e.to_string());
        }
        let root = NSString::from_str(&real.to_string_lossy());
        let shown = objc2::rc::autoreleasepool(|_| {
            NSWorkspace::sharedWorkspace().selectFile_inFileViewerRootedAtPath(None, &root)
        });
        if shown {
            Ok(())
        } else {
            Err("Finder would not open the folder".to_string())
        }
    }
}

#[cfg(windows)]
mod os {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS};
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE;
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// While it lives, this thread shows no "insert a disk" box: an empty
    /// card reader or DVD drive named in the output fails its lookup quietly.
    pub struct QuietDriveErrors(u32);
    impl QuietDriveErrors {
        pub fn new() -> Self {
            let mut before = 0;
            // SAFETY: plain call; `before` outlives it.
            unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut before) };
            QuietDriveErrors(before)
        }
    }
    impl Drop for QuietDriveErrors {
        fn drop(&mut self) {
            // SAFETY: plain call; the old mode is optional.
            unsafe { SetThreadErrorMode(self.0, std::ptr::null_mut()) };
        }
    }

    /// `X:\…` (or `\\?\X:\…`) on a drive whose type is DRIVE_REMOTE.
    pub fn on_a_network_drive(path: &str) -> bool {
        let plain = path.strip_prefix(r"\\?\").unwrap_or(path);
        let bytes = plain.as_bytes();
        if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
            return false;
        }
        let root = wide(std::ffi::OsStr::new(&format!("{}:\\", bytes[0] as char)));
        // SAFETY: `root` is NUL-terminated and outlives the call.
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
    }

    /// Explorer showing `dir`, by `ShellExecuteExW` with the verb "explore".
    ///
    /// The verb is looked up on the item's own class, and only folders have
    /// "explore": had the folder been swapped for a program since it was
    /// checked, there is no such verb for it and the call fails
    /// (SE_ERR_NOASSOC) — it is never run, as it would be under the default
    /// verb. No error box (SEE_MASK_FLAG_NO_UI): the terminal says it failed.
    /// COM is initialised for the call, as ShellExecuteEx asks, and released
    /// after it (SEE_MASK_NOASYNC: done before it returns).
    pub fn open_folder(dir: &Path) -> Result<(), String> {
        let file = wide(dunce::simplified(dir).as_os_str());
        let verb = wide(std::ffi::OsStr::new("explore"));
        // SAFETY: COM on this thread for the call, balanced below.
        let com = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
        // SAFETY: all-zero is a valid SHELLEXECUTEINFOW (null pointers and
        // handles, zero counts); the strings outlive the call.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        // SAFETY: `info` is initialised as above.
        let ok = unsafe { ShellExecuteExW(&mut info) } != 0;
        let error = std::io::Error::last_os_error();
        if com >= 0 {
            // SAFETY: matches the successful CoInitializeEx above.
            unsafe { CoUninitialize() };
        }
        if ok {
            Ok(())
        } else {
            Err(format!("Explorer would not open the folder: {error}"))
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    use std::path::Path;

    pub struct QuietDriveErrors;
    impl QuietDriveErrors {
        pub fn new() -> Self {
            QuietDriveErrors
        }
    }

    pub fn on_a_network_drive(_: &str) -> bool {
        false
    }

    /// Never asked for (`reveal_action` reveals folders here); revealing is
    /// the answer that cannot run anything.
    pub fn open_folder(dir: &Path) -> Result<(), String> {
        tauri_plugin_opener::reveal_item_in_dir(dir).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test, canonical: cargo runs tests in
    /// parallel, and a shared one made them flaky elsewhere in this crate.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-reveal-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn kinds_of_a_file_a_folder_and_nothing() {
        let dir = scratch("kinds");
        fs::create_dir_all(dir.join("My Folder")).unwrap();
        fs::create_dir_all(dir.join("conf.d")).unwrap();
        fs::write(dir.join("report.txt"), "r").unwrap();
        fs::write(dir.join("보고서.txt"), "r").unwrap();
        let asked = vec![
            s(&dir.join("My Folder")),
            s(&dir.join("report.txt")),
            s(&dir.join("보고서.txt")),
            s(&dir.join("missing.txt")),
            s(&dir),
            s(&dir.join("conf.d")),
        ];
        assert_eq!(
            path_kinds(&asked).unwrap(),
            vec![Some("dir"), Some("file"), Some("file"), None, Some("dir"), Some("dir")]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The webview resolves every name before asking; a relative one here
    /// would be read against the process's directory, which is nobody's.
    #[test]
    fn only_absolute_paths_of_a_sane_length_are_looked_at() {
        let dir = scratch("absolute");
        fs::write(dir.join("a.txt"), "a").unwrap();
        let too_long = format!("{}/{}", s(&dir), "x".repeat(MAX_KIND_PATH_BYTES));
        let kinds = path_kinds(&["a.txt".to_string(), String::new(), too_long]).unwrap();
        assert_eq!(kinds, vec![None, None, None]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn more_paths_than_a_call_holds_are_refused_whole() {
        let dir = scratch("many");
        let one = s(&dir);
        assert_eq!(path_kinds(&vec![one.clone(); MAX_KIND_PATHS]).unwrap().len(), MAX_KIND_PATHS);
        let err = path_kinds(&vec![one; MAX_KIND_PATHS + 1]).unwrap_err();
        assert!(err.contains(&MAX_KIND_PATHS.to_string()), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Every spelling of another machine is answered by its spelling. On
    /// Unix `//…` is a LOCAL path, so a folder that exists is spelled that
    /// way there too: had it been looked at, it would have come back "dir".
    /// On Windows any of these looked at would contact a host.
    #[test]
    fn a_path_on_another_machine_is_answered_without_being_looked_at() {
        let dir = scratch("unc");
        let mut asked: Vec<String> = [
            r"\\host\share\x.txt",
            "//host/share/x.txt",
            r"\\?\UNC\host\share\x.txt",
            r"\??\UNC\host\share\x.txt",
            r"\\.\pipe\x",
        ]
        .iter()
        .map(|p| p.to_string())
        .collect();
        if cfg!(unix) {
            let spelled = format!("/{}", s(&dir));
            assert!(is_network_path(&spelled), "premise: {spelled} reads as another machine");
            assert!(Path::new(&spelled).is_dir(), "premise: {spelled} is a folder here");
            asked.push(spelled);
        }
        assert_eq!(path_kinds(&asked).unwrap(), vec![None; asked.len()]);
        for path in &asked {
            let err = reveal_target(path).unwrap_err();
            assert!(err.contains("another machine"), "{path}: {err}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_folder_is_a_folder_and_a_broken_one_is_nothing() {
        let dir = scratch("links");
        fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink("real", dir.join("alias")).unwrap();
        std::os::unix::fs::symlink("gone", dir.join("broken")).unwrap();
        let asked = vec![s(&dir.join("alias")), s(&dir.join("broken"))];
        assert_eq!(path_kinds(&asked).unwrap(), vec![Some("dir"), None]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// `via -> docs -> //<a folder that exists>`: followed, `metadata` would
    /// find a folder (`//…` is local on Unix), so `None` is the proof it was
    /// not followed. Showing it is refused for the same reason.
    #[cfg(unix)]
    #[test]
    fn a_link_chain_to_another_machine_is_answered_without_being_followed() {
        let dir = scratch("chain");
        let share = scratch("chain-share");
        fs::create_dir_all(share.join("inner")).unwrap();
        std::os::unix::fs::symlink(format!("/{}", s(&share)), dir.join("docs")).unwrap();
        std::os::unix::fs::symlink("docs", dir.join("via")).unwrap();
        let asked = vec![s(&dir.join("docs")), s(&dir.join("via")), s(&dir.join("via").join("inner"))];
        assert_eq!(path_kinds(&asked).unwrap(), vec![None, None, None]);
        let err = reveal_target(&asked[1]).unwrap_err();
        assert!(err.contains("link to another machine"), "{err}");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&share);
    }

    /// Found in review: `nul\.`, `nul\`, `nul\x\..`, `COM1::$DATA` and
    /// `lpt1:x` all reach a device and all got past a check of the last name
    /// as written.
    #[test]
    fn the_windows_devices_are_known_in_every_spelling() {
        for path in [
            r"C:\project\nul",
            r"C:\project\NUL.txt",
            r"C:\project\con",
            "C:/project/aux.log",
            r"C:\project\com1",
            r"C:\project\LPT9",
            r"C:\project\com¹",
            r"C:\project\CONOUT$",
            r"C:\project\nul ",
            r"C:\project\nul\.",
            r"C:\project\nul\",
            r"C:\project\nul\x\..",
            r"C:\project\COM1::$DATA",
            r"C:\project\lpt1:x",
            r"C:\project\nul.",
            r"C:\project\con .txt",
            "prn",
        ] {
            assert!(names_a_device(path), "{path}");
            assert!(refusal(path, true).is_some(), "{path}");
        }
        for path in [
            r"C:\project\console.log",
            r"C:\project\nullable",
            r"C:\project\com10",
            r"C:\connect",
            r"C:\project\com",
            r"C:\conf.d\x",
            r"C:\x\file:stream.txt",
        ] {
            assert!(!names_a_device(path), "{path}");
        }
    }

    #[test]
    fn a_shell_namespace_folder_is_refused_wherever_it_is_in_the_path() {
        for path in [
            r"C:\x\Fake.{645FF040-5081-101B-9F08-00AA002F954E}",
            r"C:\x\a.{645ff040-5081-101b-9f08-00aa002f954e}\inner\file.txt",
            r"C:\x\GodMode.{ED7BA470-8E54-465E-825C-99712043E01C}.",
        ] {
            assert!(names_a_shell_folder(path), "{path}");
            assert!(refusal(path, true).is_some(), "{path}");
        }
        for path in [r"C:\x\a.{bad}", r"C:\x\notes.{1234}", r"C:\x\{645FF040-5081-101B-9F08-00AA002F954E}", r"C:\x\plain.txt"] {
            assert!(!names_a_shell_folder(path), "{path}");
        }
        // The Windows rules are Windows': elsewhere such a name is a name.
        assert_eq!(refusal("/x/nul", false), None);
        assert_eq!(refusal("/x/Fake.{645FF040-5081-101B-9F08-00AA002F954E}", false), None);
    }

    #[test]
    fn a_folder_opens_on_macos_and_windows_and_is_revealed_elsewhere_and_a_file_always_is() {
        assert_eq!(reveal_action(true, "macos"), RevealAction::Open);
        assert_eq!(reveal_action(true, "windows"), RevealAction::Open);
        assert_eq!(reveal_action(true, "linux"), RevealAction::Reveal, "xdg-open is whatever was registered");
        assert_eq!(reveal_action(true, "freebsd"), RevealAction::Reveal);
        for os in ["macos", "windows", "linux"] {
            assert_eq!(reveal_action(false, os), RevealAction::Reveal, "{os}: a file is never opened");
        }
    }

    /// A dotted folder is a folder (`conf.d`, a version `3.12.10`): opening
    /// one no longer goes through anything that could run it, so there is
    /// no package rule left to reveal it by.
    #[test]
    fn showing_needs_a_local_absolute_path_that_exists() {
        let dir = scratch("target");
        for name in ["src", "conf.d", "3.12.10", "Tool.app"] {
            fs::create_dir_all(dir.join(name)).unwrap();
        }
        fs::write(dir.join("run.sh"), "#!/bin/sh\n").unwrap();
        let folder = reveal_action(true, std::env::consts::OS);
        for name in ["src", "conf.d", "3.12.10", "Tool.app"] {
            assert_eq!(reveal_target(&s(&dir.join(name))).unwrap(), (dir.join(name), folder), "{name}");
        }
        assert_eq!(reveal_target(&s(&dir.join("run.sh"))).unwrap(), (dir.join("run.sh"), RevealAction::Reveal));
        assert!(reveal_target(&s(&dir.join("missing"))).unwrap_err().contains("Cannot show"));
        assert!(reveal_target("src").unwrap_err().contains("Not an absolute path"));
        assert!(reveal_target("").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// macOS only: what LaunchServices calls a package — and so what a
    /// Finder viewer rooted at it would launch — is revealed, whatever it is
    /// called and however it is reached; any other folder opens, dotted or
    /// not. The bundle bit is set here as an attacker would: in the Finder
    /// info, where no name shows it (`kHasBundle`, byte 8 of 32).
    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_package_is_revealed_by_what_launchservices_says_not_by_its_name() {
        let dir = scratch("package");
        for name in ["plain", "conf.d", "Tool.app", "Hidden"] {
            fs::create_dir_all(dir.join(name).join("Contents").join("MacOS")).unwrap();
        }
        let mut finder_info = [0u8; 32];
        finder_info[8] = 0x20;
        let hidden = std::ffi::CString::new(s(&dir.join("Hidden"))).unwrap();
        let key = std::ffi::CString::new("com.apple.FinderInfo").unwrap();
        // SAFETY: NUL-terminated strings and a 32-byte buffer that outlive the call.
        let set = unsafe { libc::setxattr(hidden.as_ptr(), key.as_ptr(), finder_info.as_ptr().cast(), 32, 0, 0) };
        assert_eq!(set, 0, "premise: the bundle bit is set");
        std::os::unix::fs::symlink("Hidden", dir.join("innocent")).unwrap();

        assert!(!os::is_package(&dir.join("plain")));
        assert!(!os::is_package(&dir.join("conf.d")));
        assert!(os::is_package(&dir.join("Tool.app")), "by its extension");
        assert!(os::is_package(&dir.join("Hidden")), "by the bundle bit alone");
        assert!(!os::is_package(&dir.join("innocent")), "premise: asked of the link, LaunchServices says no");

        let shown = |name: &str| os::folder_shown_as(&dir.join(name)).unwrap();
        assert_eq!(shown("plain"), (dir.join("plain"), RevealAction::Open));
        assert_eq!(shown("conf.d"), (dir.join("conf.d"), RevealAction::Open));
        assert_eq!(shown("Tool.app"), (dir.join("Tool.app"), RevealAction::Reveal));
        assert_eq!(shown("Hidden"), (dir.join("Hidden"), RevealAction::Reveal));
        assert_eq!(shown("innocent"), (dir.join("Hidden"), RevealAction::Reveal), "through the link, decided on the folder");
        assert_eq!(shown("Hidden/Contents"), (dir.join("Hidden").join("Contents"), RevealAction::Open), "inside a package is a folder");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Windows only: the drive the system runs from is no network drive, and
    /// asking says so without an error box.
    #[cfg(windows)]
    #[test]
    fn the_system_drive_is_not_a_network_drive() {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        assert!(!on_a_network_drive(&format!(r"{drive}\Windows")));
        assert!(!on_a_network_drive(&format!(r"\\?\{drive}\Windows")));
        assert!(!on_a_network_drive("relative"));
    }
}
