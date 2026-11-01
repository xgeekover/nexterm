//! The open folder's own commands: `.nexterm/commands.json`, read for the
//! command palette (`project_commands_read`).
//!
//! **Somebody else's text, on its way to the user's shell.** A cloned
//! repository wrote this file, so reading it must not be a way to make
//! NexTerm reach another machine, wait on anything or hold much. It is read
//! the way `fs::git` reads a `HEAD` — `fs::read_small_file`: an open that does
//! not wait, the open handle asked whether it is a regular file, at most
//! MAX_BYTES — and only after the open folder has been judged to be on this
//! machine (`fs::refused`).
//!
//! **A folder on another computer or a mapped network drive is not read at
//! all.** The read is nobody's click: it runs when the folder opens, on every
//! change under `.nexterm` and every time the palette opens. On Windows a look
//! at `\\host\share` signs in with the user's credentials, and one at a
//! disconnected mapped drive reconnects it and hangs while it does
//! (`fs::drive`).
//!
//! **No link is followed.** `.nexterm` and the file are each looked at
//! themselves (`symlink_metadata`) before anything is opened, and either one
//! being a link — on Windows any reparse point but a cloud-sync placeholder,
//! a junction included (`reparse_tag_allowed`) — refuses the read with the
//! reason. A repository can carry a link to anywhere, `\\host\share` among
//! them; refusing is the one answer that does not depend on where it leads.
//!
//! **Nothing here says what the commands are.** The webview checks every one
//! and asks before any of them runs. What leaves here is the text and the
//! SHA-256 of the bytes on disk: trust is kept against that hash, so a
//! `git pull` that changes one byte asks again. Collision-resistant on
//! purpose: whoever wrote the file wrote both versions.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::fs::{is_network_path, read_small_file, refused, reveal, QuietDriveErrors, SmallFileError};

/// The folder, in the open folder, that holds NexTerm's files for it.
pub const DIR: &str = ".nexterm";

/// The commands file in `DIR`.
pub const FILE: &str = "commands.json";

/// The most of `FILE` that is read: 256 KB. Two hundred commands at their
/// longest fit several times over; a file bigger than this is not one a
/// person wrote for a palette, and the webview parses all of what it gets.
pub const MAX_BYTES: u64 = 256 * 1024;

/// What `project_commands_read` answers, as the webview reads it: `status`
/// says which, and only that answer's fields are there.
///
/// Every answer about a folder names it in `root`, spelled as `fs_get_root`
/// spells it: the folder whose file this is. The webview asks, and the folder
/// can change before the answer arrives — opening another folder moves the
/// backend's first and the webview's after — so an answer it pairs with the
/// folder it thinks is open could be one folder's hash recorded as another's
/// trust. It drops an answer whose `root` is not the folder it asked about.
/// Only "no folder is open" has none.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ProjectCommandsFile {
    /// No folder is open (`root` absent), or it holds no
    /// `.nexterm/commands.json`.
    None {
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    /// Not read, on purpose: the folder is on another machine, or the file or
    /// its folder is a link. `reason` is a sentence the webview shows as is.
    Refused { root: String, reason: String },
    /// There, but not to be read: not a folder, not a regular file, too
    /// large, not UTF-8, or the disk said no. `reason` is shown as is.
    Error { root: String, reason: String },
    /// The file's text, a leading byte-order mark dropped, and the SHA-256 of
    /// its bytes on disk — mark and all — in lowercase hex.
    Ok { root: String, text: String, sha256: String },
}

/// What `look_in` found in a folder: a `ProjectCommandsFile` without the
/// folder, which `read_in` adds.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Found {
    None,
    Refused { reason: String },
    Error { reason: String },
    Ok { text: String, sha256: String },
}

const OFF_MACHINE: &str = "This folder is on another computer or a network drive \u{2014} its commands are not read.";
const UNPLACED: &str = "NexTerm cannot tell where this folder is \u{2014} its commands are not read.";
const DIR_NOT_A_FOLDER: &str = "`.nexterm` is not a folder.";
const NOT_A_FILE: &str = "`.nexterm/commands.json` is not a regular file.";
const TOO_LARGE: &str = "`.nexterm/commands.json` is larger than 256 KB.";
const NOT_UTF8: &str = "`.nexterm/commands.json` is not UTF-8 text.";
#[cfg_attr(not(windows), allow(dead_code))]
const NOT_DOWNLOADED: &str =
    "`.nexterm/commands.json` is online-only \u{2014} open it once so that it is downloaded to this computer.";

/// The open folder's `.nexterm/commands.json`, or why not. `root` is the open
/// folder (`Workspace::root`, canonical), `None` with no folder open.
pub fn read(root: Option<&Path>) -> ProjectCommandsFile {
    read_in(root, &crate::fs::on_a_network_drive)
}

/// `read`, with the mapped-drive check handed in so that the suites can say a
/// drive is one.
fn read_in(root: Option<&Path>, network_drive: &dyn Fn(&str) -> bool) -> ProjectCommandsFile {
    let Some(root) = root else {
        return ProjectCommandsFile::None { root: None };
    };
    // As `fs_get_root` hands the folder out, so that the webview can compare.
    let named = root.to_string_lossy().into_owned();
    match look_in(root, network_drive) {
        Found::None => ProjectCommandsFile::None { root: Some(named) },
        Found::Refused { reason } => ProjectCommandsFile::Refused { root: named, reason },
        Found::Error { reason } => ProjectCommandsFile::Error { root: named, reason },
        Found::Ok { text, sha256 } => ProjectCommandsFile::Ok { root: named, text, sha256 },
    }
}

/// What the open folder `root` holds.
///
/// In this order, each step before anything below it is touched: the folder
/// judged (`fs::refused` — its spelling, its drive, the links in its path);
/// `.nexterm` looked at itself, never through; the file looked at itself;
/// only then opened, not following a link, and read to at most MAX_BYTES.
fn look_in(root: &Path, network_drive: &dyn Fn(&str) -> bool) -> Found {
    // Before anything is looked at — `refused` already reads the links in the
    // folder's path: a folder on a card reader whose card is gone fails
    // quietly, with no "insert a disk" box.
    let _quiet = QuietDriveErrors::new();
    if refused(root, network_drive) {
        return refusal(not_read_because(root));
    }

    let dir = root.join(DIR);
    match std::fs::symlink_metadata(&dir) {
        Err(err) if err.kind() == ErrorKind::NotFound => return Found::None,
        Err(err) => return failure(format!("`{DIR}` could not be looked at: {err}.")),
        Ok(meta) => {
            match not_followed(&dir, &meta) {
                Ok(Some(kind)) => return refusal(format!("`{DIR}` is {kind} \u{2014} NexTerm does not follow it.")),
                Ok(None) => {}
                Err(err) => return failure(format!("`{DIR}` could not be looked at: {err}.")),
            }
            if !meta.is_dir() {
                return failure(DIR_NOT_A_FOLDER);
            }
        }
    }

    // A FIFO or a device is refused here, before it is opened at all; one
    // swapped in after this look is refused by the open handle
    // (`read_small_file`), which does not wait on it either.
    let file = dir.join(FILE);
    match std::fs::symlink_metadata(&file) {
        Err(err) if err.kind() == ErrorKind::NotFound => return Found::None,
        Err(err) => return failure(format!("`{DIR}/{FILE}` could not be looked at: {err}.")),
        Ok(meta) => {
            match not_followed(&file, &meta) {
                Ok(Some(kind)) => return refusal(format!("`{DIR}/{FILE}` is {kind} \u{2014} NexTerm does not follow it.")),
                Ok(None) => {}
                Err(err) => return failure(format!("`{DIR}/{FILE}` could not be looked at: {err}.")),
            }
            if !meta.is_file() {
                return failure(NOT_A_FILE);
            }
            // A placeholder whose data is still in the cloud. Reading it here
            // would either have the sync client download it — from a read
            // nobody asked for, which waits as long as the network takes — or,
            // opened as a reparse point, not reach its data at all. Opening the
            // file in the editor downloads it, and from then on it is read.
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if data_not_here(meta.file_attributes()) {
                    return failure(NOT_DOWNLOADED);
                }
            }
        }
    }

    let bytes = match read_small_file(&file, false, MAX_BYTES) {
        Ok(bytes) => bytes,
        // Gone between the look and the open: as if it had never been there.
        Err(SmallFileError::NotFound) => return Found::None,
        Err(SmallFileError::NotAFile) => return failure(NOT_A_FILE),
        Err(SmallFileError::TooLarge) => return failure(TOO_LARGE),
        Err(SmallFileError::Io(err)) => return failure(format!("`{DIR}/{FILE}` could not be read: {err}.")),
    };
    let Ok(mut text) = String::from_utf8(bytes) else {
        return failure(NOT_UTF8);
    };
    // Of the bytes on disk — the text before anything is taken off it — not
    // of the text handed on: trust is in the file, and a byte-order mark
    // added or taken away is a change to it.
    let sha256 = hex(&Sha256::digest(text.as_bytes()));
    // JSON has no byte-order mark, and an editor on Windows may well write
    // one; only one is the mark, any after it is text.
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Found::Ok { text, sha256 }
}

/// Whether `path`, whose own metadata (`symlink_metadata`) is `meta`, is
/// something that is not looked through, and what to call it: a symbolic
/// link anywhere, and on Windows any reparse point but a cloud-sync
/// placeholder (`reparse_tag_allowed`).
///
/// std's `is_symlink` is true on Windows for the reparse points that name
/// another path — symbolic links, junctions, volume mount points, WSL's
/// links — and those are "a link". Any other reparse point is asked its tag,
/// since the attribute alone does not say what it is. An error is only
/// possible there: the tag could not be read.
fn not_followed(path: &Path, meta: &Metadata) -> std::io::Result<Option<&'static str>> {
    if meta.file_type().is_symlink() {
        return Ok(Some("a link"));
    }
    if reparse_point_refused(path, meta)? {
        return Ok(Some("a reparse point"));
    }
    Ok(None)
}

#[cfg(windows)]
fn reparse_point_refused(path: &Path, meta: &Metadata) -> std::io::Result<bool> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(false);
    }
    Ok(!reparse_tag_allowed(reparse_tag_of(path)?))
}

/// No reparse points off Windows.
#[cfg(not(windows))]
fn reparse_point_refused(_: &Path, _: &Metadata) -> std::io::Result<bool> {
    Ok(false)
}

/// `IO_REPARSE_TAG_CLOUD`, and the bits `IO_REPARSE_TAG_CLOUD_MASK` that
/// `IO_REPARSE_TAG_CLOUD_1` … `_F` set on top of it (winnt.h). Written out
/// here rather than taken from `windows_sys`, whose feature for them this
/// crate does not otherwise need, and so that the rule is compiled — and
/// tested — on every platform.
const CLOUD_TAG: u32 = 0x9000_001A;
const CLOUD_TAG_VARIANTS: u32 = 0x0000_F000;

/// Whether a reparse point with this tag may be looked at and read through:
/// only a Cloud Files placeholder — `IO_REPARSE_TAG_CLOUD` and `_CLOUD_1` …
/// `_CLOUD_F`, which OneDrive, iCloud for Windows and Dropbox put on every
/// file and folder they sync.
///
/// Those have to be let through: Windows 10 and 11 move Documents and the
/// Desktop into OneDrive by default, so a project there has one on
/// `.nexterm` and on the file, and refusing them refused the folder's
/// commands for good. They can be: what such a placeholder leads to is the
/// user's own sync client, for the user's own account — not a path, and not a
/// server the repository chose. Everything else stays refused, known or not:
/// a name surrogate (a symbolic link, a junction or mount point, a WSL link)
/// names a path anywhere, `\\host\share` included; DFS sends the open to a
/// server; an app execution alias names a program; and a tag nobody here has
/// looked at is not taken on trust. An allow-list, so a new kind is refused
/// until someone decides otherwise.
#[cfg_attr(not(windows), allow(dead_code))]
fn reparse_tag_allowed(tag: u32) -> bool {
    tag & !CLOUD_TAG_VARIANTS == CLOUD_TAG
}

/// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `_RECALL_ON_OPEN` and `_OFFLINE`
/// (winnt.h): what is in the file is not on this disk, and reading it fetches
/// it — a placeholder's data still in the cloud, a file moved to slower
/// storage. Written out to be tested everywhere; a Windows test holds them to
/// `windows_sys`.
const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
const RECALL_ON_OPEN: u32 = 0x0004_0000;
const OFFLINE: u32 = 0x0000_1000;

/// Whether a file with these attributes keeps its data somewhere else.
#[cfg_attr(not(windows), allow(dead_code))]
fn data_not_here(attributes: u32) -> bool {
    attributes & (RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE) != 0
}

/// The reparse tag of `path` itself — never followed — or 0 when it is no
/// reparse point. Asked of a handle opened the way std's `symlink_metadata`
/// opens one: no access asked for, `FILE_FLAG_OPEN_REPARSE_POINT` so that
/// nothing is followed and no placeholder is downloaded, and backup semantics
/// so that a folder opens too.
#[cfg(windows)]
fn reparse_tag_of(path: &Path) -> std::io::Result<u32> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = FILE_ATTRIBUTE_TAG_INFO { FileAttributes: 0, ReparseTag: 0 };
    // SAFETY: `info` is a FILE_ATTRIBUTE_TAG_INFO of the size passed, and it
    // and the handle outlive the call.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { info.ReparseTag } else { 0 })
}

/// Why the open folder is not read, once `fs::refused` has said so: it is on
/// another machine — spelled so, on a mapped network drive, or through a link
/// to either — or, never for a folder `Workspace::set_root` made canonical,
/// spelled so that nothing can be told about it (not absolute, too long, a
/// device).
fn not_read_because(root: &Path) -> &'static str {
    let spelled = root.to_string_lossy();
    if !is_network_path(&spelled) && reveal::refusal(&spelled, cfg!(windows)).is_some() {
        UNPLACED
    } else {
        OFF_MACHINE
    }
}

fn refusal(reason: impl Into<String>) -> Found {
    Found::Refused { reason: reason.into() }
}

fn failure(reason: impl Into<String>) -> Found {
    Found::Error { reason: reason.into() }
}

/// `bytes` in lowercase hex, two digits each.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A folder of its own for one test, canonical — as an open folder is —
    /// and fresh: cargo runs tests in parallel.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-projcmd-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    /// A scratch folder holding `.nexterm/commands.json` with these bytes.
    fn holding(tag: &str, bytes: &[u8]) -> PathBuf {
        let base = scratch(tag);
        fs::create_dir_all(base.join(DIR)).unwrap();
        fs::write(base.join(DIR).join(FILE), bytes).unwrap();
        base
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// No drive is a network drive.
    fn local(_: &str) -> bool {
        false
    }

    /// What is found in `root`, no drive being a network one. The folder the
    /// answer names is added on top (`read_in`), and tested on its own.
    fn read_local(root: &Path) -> Found {
        look_in(root, &local)
    }

    fn ok(text: &str, sha256: &str) -> Found {
        Found::Ok { text: text.to_string(), sha256: sha256.to_string() }
    }

    fn refused_for(reason: &str) -> Found {
        Found::Refused { reason: reason.to_string() }
    }

    fn error(reason: &str) -> Found {
        Found::Error { reason: reason.to_string() }
    }

    /// SHA-256 of `{}`.
    const EMPTY_OBJECT: &str = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

    const OFF_MACHINE_SAID: &str =
        "This folder is on another computer or a network drive \u{2014} its commands are not read.";
    const DIR_LINK_SAID: &str = "`.nexterm` is a link \u{2014} NexTerm does not follow it.";
    const FILE_LINK_SAID: &str = "`.nexterm/commands.json` is a link \u{2014} NexTerm does not follow it.";

    /// The webview reads `status` and the fields of that answer, and nothing
    /// else is there.
    #[test]
    fn the_answers_are_written_as_the_webview_reads_them() {
        let json = |answer: ProjectCommandsFile| serde_json::to_string(&answer).unwrap();
        let root = || "/w/proj".to_string();
        assert_eq!(json(ProjectCommandsFile::None { root: None }), r#"{"status":"none"}"#);
        assert_eq!(json(ProjectCommandsFile::None { root: Some(root()) }), r#"{"status":"none","root":"/w/proj"}"#);
        assert_eq!(
            json(ProjectCommandsFile::Refused { root: root(), reason: "why".into() }),
            r#"{"status":"refused","root":"/w/proj","reason":"why"}"#
        );
        assert_eq!(
            json(ProjectCommandsFile::Error { root: root(), reason: "why".into() }),
            r#"{"status":"error","root":"/w/proj","reason":"why"}"#
        );
        assert_eq!(
            json(ProjectCommandsFile::Ok { root: root(), text: "{}".into(), sha256: "ab".into() }),
            r#"{"status":"ok","root":"/w/proj","text":"{}","sha256":"ab"}"#
        );
    }

    /// Every reparse tag the Windows SDK names (winnt.h, as `windows_sys`
    /// lists them), and some that are none: only the sixteen Cloud Files
    /// tags are let through.
    #[test]
    fn only_a_cloud_files_placeholder_is_let_through() {
        let cloud: Vec<u32> = (0..16).map(|variant| 0x9000_001A | (variant << 12)).collect();
        assert_eq!(cloud.first(), Some(&0x9000_001A), "IO_REPARSE_TAG_CLOUD");
        assert_eq!(cloud.last(), Some(&0x9000_F01A), "IO_REPARSE_TAG_CLOUD_F");
        for tag in &cloud {
            assert!(reparse_tag_allowed(*tag), "{tag:#010x}");
        }
        let refused = [
            (0xA000_000C, "SYMLINK"),
            (0xA000_0003, "MOUNT_POINT (a junction)"),
            (0xA000_001D, "LX_SYMLINK (WSL)"),
            (0xA000_0019, "GLOBAL_REPARSE"),
            (0xA000_0022, "PROJFS_TOMBSTONE"),
            (0xA000_0027, "WCI_LINK"),
            (0xA000_1027, "WCI_LINK_1"),
            (0xA000_001F, "WCI_TOMBSTONE"),
            (0xA000_0028, "DATALESS_CIM"),
            (0x8000_000A, "DFS"),
            (0x8000_0012, "DFSR"),
            (0x8000_001B, "APPEXECLINK"),
            (0x8000_0021, "ONEDRIVE (before Cloud Files)"),
            (0x8000_0023, "AF_UNIX"),
            (0x8000_0024, "LX_FIFO"),
            (0x8000_0013, "DEDUP"),
            (0x8000_0017, "WOF"),
            (0x8000_0014, "NFS"),
            (0x8000_0009, "CSV"),
            (0x8000_0015, "FILE_PLACEHOLDER"),
            (0x8000_001E, "STORAGE_SYNC"),
            (0x8000_0020, "UNHANDLED"),
            (0x8000_0018, "WCI"),
            (0x9000_1018, "WCI_1"),
            (0x9000_001C, "PROJFS (the cloud tag's high bits, another kind)"),
            (0xC000_0004, "HSM"),
            (0x8000_0006, "HSM2"),
            (0x8000_0007, "SIS"),
            (0x8000_0008, "WIM"),
            (0x0000_0000, "RESERVED_ZERO, or no tag at all"),
            (0x0000_0001, "RESERVED_ONE"),
            (0x0000_0002, "RESERVED_TWO"),
            (0x0000_F000, "CLOUD_MASK alone"),
            (0x9000_001B, "one past CLOUD"),
            (0x9001_001A, "CLOUD with a bit above the variants"),
            (0x9000_011A, "CLOUD with a bit below the variants"),
            (0x9000_003A, "CLOUD with a bit in its own number"),
            (0xB000_001A, "CLOUD made a name surrogate"),
            (0x1000_001A, "CLOUD without the Microsoft bit"),
            (0x8000_001A, "CLOUD without its own high bit"),
            (0xFFFF_FFFF, "every bit"),
        ];
        for (tag, name) in refused {
            assert!(!reparse_tag_allowed(tag), "{name} ({tag:#010x}) was let through");
        }
    }

    /// A placeholder whose data is not on this disk is not read: reading it
    /// fetches it. One that is — pinned, or only marked — is.
    #[test]
    fn a_file_whose_data_is_elsewhere_is_not_read() {
        for (attributes, elsewhere) in [
            (0, false),
            (0x0000_0020 | 0x0000_0400, false), // ARCHIVE | REPARSE_POINT: a placeholder that is here
            (0x0008_0000, false),               // PINNED: always kept on this device
            (0x0010_0000, false),               // UNPINNED: may be freed later, here now
            (RECALL_ON_DATA_ACCESS, true),
            (RECALL_ON_DATA_ACCESS | 0x0000_0400 | 0x0010_0000, true),
            (RECALL_ON_OPEN, true),
            (OFFLINE, true),
        ] {
            assert_eq!(data_not_here(attributes), elsewhere, "{attributes:#010x}");
        }
        assert_eq!((RECALL_ON_DATA_ACCESS, RECALL_ON_OPEN, OFFLINE), (0x40_0000, 0x4_0000, 0x1000));
    }

    /// Windows: the constants written out here are the SDK's, and the tag is
    /// read off the entry itself — a junction's, not its target's.
    #[cfg(windows)]
    #[test]
    fn the_windows_constants_and_the_tag_read_are_the_sdks() {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
        };
        assert_eq!(RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS);
        assert_eq!(RECALL_ON_OPEN, FILE_ATTRIBUTE_RECALL_ON_OPEN);
        assert_eq!(OFFLINE, FILE_ATTRIBUTE_OFFLINE);
        let base = scratch("tag");
        let target = base.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(FILE), "{}").unwrap();
        junction::create(&target, base.join("junction")).unwrap();
        assert_eq!(reparse_tag_of(&base.join("junction")).unwrap(), 0xA000_0003, "IO_REPARSE_TAG_MOUNT_POINT");
        assert_eq!(reparse_tag_of(&target).unwrap(), 0, "a plain folder");
        assert_eq!(reparse_tag_of(&target.join(FILE)).unwrap(), 0, "a plain file");
        let refused_here = |path: &Path| reparse_point_refused(path, &fs::symlink_metadata(path).unwrap()).unwrap();
        assert!(refused_here(&base.join("junction")), "a junction's tag is not a cloud placeholder's");
        assert!(!refused_here(&target), "no reparse point, nothing to refuse");
        let _ = fs::remove_dir_all(&base);
    }

    /// Every answer about a folder names it, as `fs_get_root` spells it; only
    /// "no folder is open" names none. The webview drops an answer for a
    /// folder it did not ask about.
    #[test]
    fn every_answer_about_a_folder_names_it() {
        let base = scratch("named");
        let root = s(&base);
        assert_eq!(read_in(Some(&base), &local), ProjectCommandsFile::None { root: Some(root.clone()) }, "no file");
        fs::create_dir_all(base.join(DIR)).unwrap();
        fs::write(base.join(DIR).join(FILE), "{}").unwrap();
        assert_eq!(
            read_in(Some(&base), &local),
            ProjectCommandsFile::Ok { root: root.clone(), text: "{}".into(), sha256: EMPTY_OBJECT.into() }
        );
        fs::write(base.join(DIR).join(FILE), b"\xff").unwrap();
        assert_eq!(
            read_in(Some(&base), &local),
            ProjectCommandsFile::Error { root: root.clone(), reason: "`.nexterm/commands.json` is not UTF-8 text.".into() }
        );
        let on_drive = |path: &str| path == root;
        assert_eq!(
            read_in(Some(&base), &on_drive),
            ProjectCommandsFile::Refused { root: root.clone(), reason: OFF_MACHINE_SAID.into() },
            "refused, before anything in it was looked at, still about this folder"
        );
        // The folder as it was handed in — not resolved, not tidied — which
        // is the one `fs_get_root` reports: the open folder is canonical.
        let other = base.join(DIR);
        assert_eq!(read_in(Some(&other), &local), ProjectCommandsFile::None { root: Some(s(&other)) });
        let workspace = crate::fs::Workspace::new();
        workspace.set_root(&base).unwrap();
        let open = workspace.root().unwrap();
        assert_eq!(open.to_string_lossy(), root.as_str(), "premise: the scratch folder is canonical, as an open one is");
        match read(Some(&open)) {
            ProjectCommandsFile::Error { root: named, .. } => assert_eq!(named, open.to_string_lossy().to_string()),
            other => panic!("{other:?}"),
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// The webview reads the file again when `fs-change` names something
    /// under `.nexterm`, so the watcher must not hide that folder the way it
    /// hides `.git` and `node_modules`.
    #[test]
    fn the_watcher_reports_changes_under_nexterm() {
        let root = Path::new("/w/proj");
        assert!(!crate::fs::watcher::is_ignored_below(root, &root.join(DIR)));
        assert!(!crate::fs::watcher::is_ignored_below(root, &root.join(DIR).join(FILE)));
    }

    /// With no folder open there is nothing to read, and no drive to ask
    /// about.
    #[test]
    fn no_folder_open_is_none() {
        let never = |path: &str| -> bool { panic!("asked about {path} with no folder open") };
        assert_eq!(read_in(None, &never), ProjectCommandsFile::None { root: None });
        assert_eq!(read(None), ProjectCommandsFile::None { root: None });
    }

    #[test]
    fn a_folder_without_the_file_is_none() {
        let base = scratch("none");
        assert_eq!(read_local(&base), Found::None, "no .nexterm");
        fs::create_dir_all(base.join(DIR)).unwrap();
        assert_eq!(read_local(&base), Found::None, ".nexterm without commands.json");
        fs::write(base.join(DIR).join("other.json"), "{}").unwrap();
        assert_eq!(read_local(&base), Found::None, "only another file there");
        let gone = base.join("gone");
        assert_eq!(read_local(&gone), Found::None, "an open folder that has since been removed");
        let _ = fs::remove_dir_all(&base);
    }

    /// The text as it is, and the hash of its bytes against known vectors —
    /// the same digests `sha256sum` prints. Nothing in it is parsed here.
    #[test]
    fn the_file_is_read_with_the_hash_of_its_bytes() {
        let cases: [(&[u8], &str, &str); 4] = [
            (b"{}", "{}", EMPTY_OBJECT),
            (b"", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            (b"abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            (
                "\u{1f600} \u{d55c}\u{ae00} \u{e9}".as_bytes(),
                "\u{1f600} \u{d55c}\u{ae00} \u{e9}",
                "adc7a00284d64b87ec0613cf7b25f68dd1530bdf674cb4efda4fc6f756deaeb8",
            ),
        ];
        let base = holding("ok", b"");
        for (bytes, text, sha256) in cases {
            fs::write(base.join(DIR).join(FILE), bytes).unwrap();
            assert_eq!(read_local(&base), ok(text, sha256), "{text:?}");
        }
        // Through the app's own drive check, on this machine's own disk.
        fs::write(base.join(DIR).join(FILE), b"{}").unwrap();
        assert_eq!(
            read(Some(&base)),
            ProjectCommandsFile::Ok { root: s(&base), text: "{}".into(), sha256: EMPTY_OBJECT.into() }
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// One byte-order mark is dropped from the text and kept in the hash: the
    /// hash is of the file, and adding or removing the mark changes it.
    #[test]
    fn a_byte_order_mark_is_dropped_from_the_text_but_not_from_the_hash() {
        let base = holding("bom", b"\xef\xbb\xbf{}");
        assert_eq!(
            read_local(&base),
            ok("{}", "aa25e978046d680ef8740d837e6de5bc1e2a2dc6089dbda1012544b538d53f65")
        );
        fs::write(base.join(DIR).join(FILE), b"\xef\xbb\xbf\xef\xbb\xbf{}").unwrap();
        assert_eq!(
            read_local(&base),
            ok("\u{feff}{}", "4f9d81b2dff7fd7f64fecdfdc6d0292ed97f903d46a3fd2a51260eab4655eaa8"),
            "only the first one is the mark"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn text_that_is_not_utf8_is_an_error() {
        let base = holding("utf8", b"");
        // A stray byte; UTF-16 with its own mark, as Notepad once saved; and
        // a surrogate spelled in UTF-8 (CESU-8), which UTF-8 does not allow.
        for bytes in [&b"{\xff}"[..], b"\xff\xfe{\x00}\x00", b"\"\xed\xa0\x80\"", b"\xef\xbb\xbf\xc3"] {
            fs::write(base.join(DIR).join(FILE), bytes).unwrap();
            assert_eq!(read_local(&base), error("`.nexterm/commands.json` is not UTF-8 text."), "{bytes:?}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 256 KB exactly is read; one byte more is not, and neither is far more.
    #[test]
    fn the_file_may_be_256_kb_and_no_more() {
        assert_eq!(MAX_BYTES, 262_144);
        let base = holding("cap", &vec![b' '; MAX_BYTES as usize]);
        match read_local(&base) {
            Found::Ok { text, sha256 } => {
                assert_eq!(text.len() as u64, MAX_BYTES);
                assert_eq!(sha256, "4faefc17489e430dbbf53d9bda451d56f07a1bd65bef805d73057e2575cf79ea");
            }
            other => panic!("256 KB exactly was not read: {other:?}"),
        }
        let too_large = error("`.nexterm/commands.json` is larger than 256 KB.");
        for size in [MAX_BYTES + 1, 4 * MAX_BYTES] {
            fs::write(base.join(DIR).join(FILE), vec![b' '; size as usize]).unwrap();
            assert_eq!(read_local(&base), too_large, "{size} bytes");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_nexterm_that_is_not_a_folder_is_an_error() {
        let base = scratch("dirfile");
        fs::write(base.join(DIR), "{}").unwrap();
        assert_eq!(read_local(&base), error("`.nexterm` is not a folder."));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_commands_json_that_is_a_folder_is_an_error() {
        let base = scratch("filedir");
        fs::create_dir_all(base.join(DIR).join(FILE)).unwrap();
        assert_eq!(read_local(&base), error("`.nexterm/commands.json` is not a regular file."));
        let _ = fs::remove_dir_all(&base);
    }

    /// A FIFO would hold an ordinary open until something wrote to it — and
    /// the read runs on every change under `.nexterm`. The read runs on a
    /// thread with a deadline, so a wait is a failure here, not a hang.
    #[cfg(unix)]
    #[test]
    fn a_fifo_is_an_error_and_does_not_hold_the_read() {
        let base = scratch("fifo");
        fs::create_dir_all(base.join(DIR)).unwrap();
        let fifo = std::ffi::CString::new(s(&base.join(DIR).join(FILE))).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0, "premise: a FIFO");
        let root = base.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(look_in(&root, &local));
        });
        let answer = rx.recv_timeout(std::time::Duration::from_secs(5));
        let _ = fs::remove_dir_all(&base);
        assert_eq!(
            answer.expect("the read returned rather than waiting on the FIFO"),
            error("`.nexterm/commands.json` is not a regular file.")
        );
    }

    /// A socket is no regular file either — and it shows that the file is
    /// looked at before anything opens it: opening a socket fails (ENXIO,
    /// EOPNOTSUPP), which would have come back as a read error, not this.
    #[cfg(unix)]
    #[test]
    fn a_socket_is_not_a_regular_file_and_is_not_opened() {
        let base = scratch("socket");
        fs::create_dir_all(base.join(DIR)).unwrap();
        let file = base.join(DIR).join(FILE);
        // Bound where its path is short — a socket's path holds about a
        // hundred bytes — and moved into place on the same disk.
        let short = std::env::temp_dir().join(format!("nxs-{}", std::process::id()));
        let _ = fs::remove_file(&short);
        let listener = std::os::unix::net::UnixListener::bind(&short).unwrap();
        fs::rename(&short, &file).unwrap();
        assert!(fs::File::open(&file).is_err(), "premise: a socket cannot be opened");
        let answer = read_local(&base);
        drop(listener);
        let _ = fs::remove_dir_all(&base);
        assert_eq!(answer, error("`.nexterm/commands.json` is not a regular file."));
    }

    /// Wherever it leads — into the folder itself, out of it, to another
    /// machine, nowhere — a link is not followed.
    #[cfg(unix)]
    #[test]
    fn a_commands_json_that_is_a_link_is_refused_wherever_it_leads() {
        use std::os::unix::fs::symlink;
        let base = holding("filelink", b"{}");
        assert_eq!(read_local(&base), ok("{}", EMPTY_OBJECT), "premise");
        let file = base.join(DIR).join(FILE);
        fs::rename(&file, base.join("real.json")).unwrap();
        for target in [base.join("real.json"), PathBuf::from("../real.json"), PathBuf::from("/etc/hosts"), PathBuf::from("//host/share/x"), base.join("missing")] {
            let _ = fs::remove_file(&file);
            symlink(&target, &file).unwrap();
            assert_eq!(read_local(&base), refused_for(FILE_LINK_SAID), "commands.json -> {}", target.display());
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_nexterm_that_is_a_link_is_refused_wherever_it_leads() {
        use std::os::unix::fs::symlink;
        let base = holding("dirlink", b"{}");
        let elsewhere = base.join("elsewhere");
        fs::rename(base.join(DIR), &elsewhere).unwrap();
        assert_eq!(read_local(&base), Found::None, "premise: moved away");
        for target in [elsewhere.clone(), PathBuf::from("elsewhere"), PathBuf::from("/etc"), PathBuf::from("//host/share"), base.join("missing")] {
            let _ = fs::remove_file(base.join(DIR));
            symlink(&target, base.join(DIR)).unwrap();
            assert_eq!(read_local(&base), refused_for(DIR_LINK_SAID), ".nexterm -> {}", target.display());
        }
        assert!(fs::read(base.join(DIR).join(FILE)).is_err(), "premise: the last link leads nowhere");
        fs::remove_file(base.join(DIR)).unwrap();
        symlink(&elsewhere, base.join(DIR)).unwrap();
        assert!(fs::read(base.join(DIR).join(FILE)).is_ok(), "premise: through the link there is a file");
        assert_eq!(read_local(&base), refused_for(DIR_LINK_SAID));
        let _ = fs::remove_dir_all(&base);
    }

    /// Windows: a junction needs no privilege to make — `git clone` of an
    /// archive's contents or a script can leave one — and is a link to std.
    #[cfg(windows)]
    #[test]
    fn a_nexterm_that_is_a_junction_is_refused() {
        let base = scratch("junction");
        let elsewhere = base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join(FILE), "{}").unwrap();
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        junction::create(&elsewhere, root.join(DIR)).unwrap();
        assert!(fs::read(root.join(DIR).join(FILE)).is_ok(), "premise: through the junction there is a file");
        assert_eq!(read_local(&root), refused_for(DIR_LINK_SAID));
        let _ = fs::remove_dir_all(&base);
    }

    /// Windows: a symbolic link needs a privilege (or Developer Mode) to
    /// make; without it there is nothing to test.
    #[cfg(windows)]
    #[test]
    fn a_commands_json_that_is_a_symbolic_link_is_refused_on_windows() {
        let base = holding("winlink", b"{}");
        let file = base.join(DIR).join(FILE);
        fs::rename(&file, base.join("real.json")).unwrap();
        if let Err(err) = std::os::windows::fs::symlink_file(base.join("real.json"), &file) {
            let _ = fs::remove_dir_all(&base);
            eprintln!("no symbolic links without the privilege ({err}); skipping");
            return;
        }
        assert_eq!(read_local(&base), refused_for(FILE_LINK_SAID));
        let _ = fs::remove_dir_all(&base);
    }

    /// The folder is judged before anything in it is looked at: said to be on
    /// a network drive, it is refused whatever `.nexterm` holds — a readable
    /// file, nothing (which would have been "none"), a link (which would have
    /// been refused for being one). The drive is asked about the folder
    /// first, and about nothing in it.
    #[test]
    fn a_folder_on_a_network_drive_is_refused_before_anything_in_it_is_looked_at() {
        let base = holding("drive", b"{}");
        let root = s(&base);
        let on_drive = |path: &str| path == root;
        assert_eq!(read_local(&base), ok("{}", EMPTY_OBJECT), "premise");
        assert_eq!(look_in(&base, &on_drive), refused_for(OFF_MACHINE_SAID), "a readable file");

        let asked = std::cell::RefCell::new(Vec::new());
        let records = |path: &str| {
            asked.borrow_mut().push(path.to_string());
            false
        };
        assert_eq!(look_in(&base, &records), ok("{}", EMPTY_OBJECT));
        let asked = asked.into_inner();
        assert_eq!(asked.first(), Some(&root), "the folder is what the drive is asked about first: {asked:?}");
        let inside = base.join(DIR);
        assert!(
            asked.iter().all(|path| !Path::new(path).starts_with(&inside)),
            "only the folder's own drive is asked about: {asked:?}"
        );

        fs::remove_dir_all(base.join(DIR)).unwrap();
        assert_eq!(read_local(&base), Found::None, "premise");
        assert_eq!(look_in(&base, &on_drive), refused_for(OFF_MACHINE_SAID), "no .nexterm");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", base.join(DIR)).unwrap();
            assert_eq!(read_local(&base), refused_for(DIR_LINK_SAID), "premise");
            assert_eq!(look_in(&base, &on_drive), refused_for(OFF_MACHINE_SAID), ".nexterm a link");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Spelled as another machine, the folder is never looked at. On Unix
    /// `//…` is a LOCAL path, so a folder that exists is spelled that way too
    /// — had it been read, its file would have come back.
    #[test]
    fn a_folder_spelled_as_another_machine_is_refused() {
        let base = holding("spelled", b"{}");
        let mut asked: Vec<PathBuf> = [r"\\host\share\repo", "//host/share/repo", r"\\?\UNC\host\share\repo", r"\??\UNC\host\share\repo", r"\\wsl$\Ubuntu\home\me"]
            .iter()
            .map(PathBuf::from)
            .collect();
        if cfg!(unix) {
            let spelled = PathBuf::from(format!("/{}", s(&base)));
            assert!(fs::read(spelled.join(DIR).join(FILE)).is_ok(), "premise: {} is readable here", spelled.display());
            asked.push(spelled);
        }
        for root in &asked {
            assert_eq!(read_local(root), refused_for(OFF_MACHINE_SAID), "{}", root.display());
        }
        // Spelled so that nothing can be told about it — never so for a
        // folder `set_root` made canonical.
        let unplaced = refused_for("NexTerm cannot tell where this folder is \u{2014} its commands are not read.");
        assert_eq!(read_local(Path::new("relative/folder")), unplaced);
        assert_eq!(read_local(&base.join("x".repeat(crate::fs::reveal::MAX_KIND_PATH_BYTES))), unplaced);
        let _ = fs::remove_dir_all(&base);
    }

    /// A link in the folder's own path that leads to another machine, or
    /// onto a mapped network drive, is not followed to find out.
    #[cfg(unix)]
    #[test]
    fn a_folder_reached_through_a_link_off_the_machine_is_refused() {
        use std::os::unix::fs::symlink;
        let base = scratch("offlink");
        let real = base.join("real");
        fs::create_dir_all(real.join(DIR)).unwrap();
        fs::write(real.join(DIR).join(FILE), "{}").unwrap();
        symlink(format!("/{}", s(&real)), base.join("far")).unwrap();
        assert!(fs::read(base.join("far").join(DIR).join(FILE)).is_ok(), "premise: readable through the link");
        assert_eq!(read_local(&base.join("far")), refused_for(OFF_MACHINE_SAID), "a link spelled as another machine");

        let drive = base.join("drive");
        fs::create_dir_all(drive.join(DIR)).unwrap();
        fs::write(drive.join(DIR).join(FILE), "{}").unwrap();
        symlink(&drive, base.join("via")).unwrap();
        let mapped = s(&drive);
        let on_drive = move |path: &str| path.starts_with(&mapped);
        assert_eq!(look_in(&base.join("via"), &local), ok("{}", EMPTY_OBJECT), "premise");
        assert_eq!(look_in(&base.join("via"), &on_drive), refused_for(OFF_MACHINE_SAID), "a link onto the drive");
        let _ = fs::remove_dir_all(&base);
    }

    /// What the disk says when it says no is passed on, in so many words.
    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_be_read_says_why() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: plain call.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("running as root, which reads anything; skipping");
            return;
        }
        let base = holding("denied", b"{}");
        let dir = base.join(DIR);
        let file = dir.join(FILE);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = read_local(&base);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        let unsearchable = read_local(&base);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&base);

        let denied = std::io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(unreadable, error(&format!("`.nexterm/commands.json` could not be read: {denied}.")));
        assert_eq!(unsearchable, error(&format!("`.nexterm/commands.json` could not be looked at: {denied}.")));
    }
}
