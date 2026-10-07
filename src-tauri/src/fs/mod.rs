pub mod git;
pub mod watcher;
pub mod search;
pub use watcher::FsWatcherManager;

use parking_lot::Mutex;
use std::borrow::Cow;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::models::FileNode;

pub const SKIPPED_FOLDERS: &[&str] = &[".git", "node_modules", "target", ".agents", "dist"];

/// `Path::canonicalize`, without the `\\?\` prefix Windows puts on the result.
///
/// That verbatim spelling went everywhere a path goes: the title bar showed
/// `\\?\D:\…`, and cmd.exe, handed it as a working directory, rejected it as a
/// UNC path and started in C:\Windows instead. `dunce` drops the prefix
/// whenever the plain path means the same thing, and is `canonicalize` itself
/// off Windows. Everything in this module canonicalizes through here — root
/// and candidate alike — so `starts_with(root)` compares like with like.
trait Canonical {
    fn canonical(&self) -> std::io::Result<PathBuf>;
}

impl Canonical for Path {
    fn canonical(&self) -> std::io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

/// A path in the filesystem's own spelling, or unchanged when it cannot be
/// resolved.
///
/// git prints its top level with forward slashes on Windows as well, while
/// everything the Explorer holds comes from `read_dir_hierarchy` in the
/// platform's own spelling. The two have to agree or every file goes
/// uncoloured, so the git side canonicalises through the same `dunce` the rest
/// of this module uses.
pub fn canonical_or(path: &Path) -> PathBuf {
    path.canonical().unwrap_or_else(|_| path.to_path_buf())
}

pub fn resolve_path(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed.is_empty() || trimmed == "." {
        return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    if let Some(stripped) = trimmed.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return PathBuf::from(home).join(stripped);
        }
    }
    PathBuf::from(trimmed)
}

pub fn read_dir_hierarchy(root_str: &str, max_depth: Option<usize>) -> Result<Vec<FileNode>, String> {
    let root = resolve_path(root_str);
    if !root.exists() {
        return Err(format!("Directory not found: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", root.display()));
    }

    let depth_limit = max_depth.unwrap_or(3);
    let mut listing = vec![canonical_or(&root)];
    read_dir_recursive(&root, 0, depth_limit, &mut listing)
}

/// `listing` holds where each folder from the top of this listing down to
/// `dir` really is, in the filesystem's own spelling.
///
/// A link to a folder is reported as a folder (`is_dir`), because that is
/// what it opens as and a linked `packages/shared` should show what is in it,
/// and as a link (`is_symlink`), because deleting or renaming it acts on the
/// link alone. It is walked like any folder unless it leads back to one of
/// the folders in `listing`: that would repeat the listing inside itself at
/// every level down to the depth limit, which the caller chooses.
fn read_dir_recursive(
    dir: &Path,
    current_depth: usize,
    max_depth: usize,
    listing: &mut Vec<PathBuf>,
) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory '{}': {e}", dir.display()))?;

    let mut nodes = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // `file_type` describes the entry itself; `is_dir` follows a link.
        let is_symlink = entry.file_type().is_ok_and(|t| t.is_symlink());
        let is_dir = path.is_dir();
        if is_dir && SKIPPED_FOLDERS.contains(&name.as_str()) {
            continue;
        }

        let id = path.to_string_lossy().to_string();
        let path_str = id.clone();

        if is_dir {
            let walk_to = if current_depth + 1 < max_depth {
                folder_to_walk(&path, &entry.file_name(), is_symlink, listing)
            } else {
                None
            };
            let children = match walk_to {
                Some(real) => {
                    listing.push(real);
                    let children = read_dir_recursive(&path, current_depth + 1, max_depth, listing);
                    listing.pop();
                    children.unwrap_or_default()
                }
                None => Vec::new(),
            };

            nodes.push(FileNode {
                id,
                name,
                path: path_str,
                is_dir: true,
                size: Some(0),
                children: Some(children),
                extension: None,
                is_symlink,
            });
        } else {
            let size = entry.metadata().ok().map(|m| m.len());
            let extension = path.extension().map(|e| e.to_string_lossy().to_string());

            nodes.push(FileNode {
                id,
                name,
                path: path_str,
                is_dir: false,
                size,
                children: None,
                extension,
                is_symlink,
            });
        }
    }

    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

/// Where the folder entry `name` in the last folder of `listing` really is,
/// or `None` when it is a link leading back to a folder `listing` is inside.
fn folder_to_walk(path: &Path, name: &OsStr, is_symlink: bool, listing: &[PathBuf]) -> Option<PathBuf> {
    if !is_symlink {
        // Not a link, so it is where its name says: no need to ask the disk.
        return listing.last().map(|parent| parent.join(name));
    }
    let target = path.canonical().ok()?;
    let loops_back = listing.iter().any(|open| open.starts_with(&target));
    (!loops_back).then_some(target)
}

/// The largest file `read_file` opens.
///
/// The editor holds a file whole: read into memory, serialized into the IPC
/// reply, handed to Monaco — and read again before every save, to see
/// whether it changed on disk. A 500 MB log clicked in the Explorer froze
/// the window or ran the webview out of memory, and the unsaved work in
/// every other tab went with it. Search stops at 2 MB
/// (`search::MAX_FILE_BYTES`); a file is worth opening well past that.
pub const MAX_OPEN_BYTES: u64 = 50 * 1024 * 1024;

/// How much of a file is looked at for a NUL before the rest is read.
const TEXT_SNIFF_BYTES: u64 = 8 * 1024;

/// A file's text. Refused without reading it when it is not a file or is
/// over `MAX_OPEN_BYTES`, after its first 8 KB when those hold a NUL, and
/// once read when it is not UTF-8.
///
/// Refusals start with fixed words the editor can tell apart: "File not
/// found", "File is too large to open" (with the size and the limit) and
/// "File is not UTF-8 text". NUL is valid UTF-8, so without the look at the
/// first bytes a binary file that happened to decode — or a UTF-16 one —
/// opened as a buffer of garbage that a save would write back; and every
/// other binary file was read whole before being refused.
pub fn read_file(path_str: &str) -> Result<String, String> {
    use std::io::Read;

    let path = resolve_path(path_str);
    let failed = |e: std::io::Error| format!("Failed to read file '{path_str}': {e}");
    let meta = fs::metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {path_str}"),
        _ => failed(e),
    })?;
    // A folder, a FIFO or a device. Opening a FIFO waits for a writer that
    // may never come, which held the command's thread for good.
    if !meta.is_file() {
        return Err(format!("Failed to read file '{path_str}': it is not a file"));
    }
    if meta.len() > MAX_OPEN_BYTES {
        return Err(too_large_to_open(path_str, meta.len()));
    }

    let file = fs::File::open(&path).map_err(failed)?;
    // Never more than the limit, even of a file that grows while it is read.
    let mut reader = file.take(MAX_OPEN_BYTES + 1);
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&mut reader).take(TEXT_SNIFF_BYTES).read_to_end(&mut bytes).map_err(failed)?;
    if bytes.contains(&0) {
        return Err(not_text(path_str));
    }
    reader.read_to_end(&mut bytes).map_err(failed)?;
    if bytes.len() as u64 > MAX_OPEN_BYTES {
        let now = reader.get_ref().metadata().map_or(bytes.len() as u64, |m| m.len());
        return Err(too_large_to_open(path_str, now));
    }
    String::from_utf8(bytes).map_err(|_| not_text(path_str))
}

fn too_large_to_open(path_str: &str, size: u64) -> String {
    const MB: u64 = 1024 * 1024;
    // Rounded up, so a file a byte over the limit does not read as at it.
    let shown = |bytes: u64| {
        let tenths = (u128::from(bytes) * 10).div_ceil(u128::from(MB));
        if tenths >= 10 * 1024 {
            format!("{:.1} GB", tenths as f64 / 10.0 / 1024.0)
        } else {
            format!("{}.{} MB", tenths / 10, tenths % 10)
        }
    };
    format!(
        "File is too large to open ({}; the limit is {} MB): {path_str}",
        shown(size),
        MAX_OPEN_BYTES / MB
    )
}

fn not_text(path_str: &str) -> String {
    format!("File is not UTF-8 text: {path_str}")
}

pub fn write_file(path_str: &str, content: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file '{path_str}': {e}"))
}

/// Create an empty file where nothing is: no file, no folder, and no link,
/// whether or not the link leads anywhere.
///
/// `create_new` asks exactly that of the OS, in one step: std documents it
/// as failing when anything is at the path, "also no (dangling) symlink", on
/// every platform. This used to check `exists()` and then write: `exists()`
/// follows a link, so a link to nothing was "not there" and the write made
/// its target; and a file that appeared between the two was emptied.
pub fn create_file(path_str: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(drop)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("File already exists: {path_str}"),
            _ => format!("Failed to create file '{path_str}': {e}"),
        })
}

pub fn create_dir(path_str: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory '{path_str}': {e}"))
}

/// Delete a file, a folder or a link.
///
/// `path` must name the entry itself — `Workspace::confine_entry` — not where
/// it leads. What kind of entry it is comes from `symlink_metadata`, which
/// does not follow a link: `exists()` and `is_dir()` do, so a dangling link
/// could not be deleted at all, and a link to a folder was taken for the
/// folder. A link is removed as a link whatever `recursive` says; the
/// Explorer shows a link to a folder as a folder and asks for a recursive
/// delete of it.
pub fn delete_path(path_str: &str, recursive: bool) -> Result<(), String> {
    let path = resolve_path(path_str);
    let file_type = path
        .symlink_metadata()
        .map_err(|_| format!("Path does not exist: {path_str}"))?
        .file_type();
    if file_type.is_symlink() {
        return remove_link(&path, file_type)
            .map_err(|e| format!("Failed to delete link '{path_str}': {e}"));
    }
    if file_type.is_dir() {
        if recursive {
            // Does not follow links inside the folder either: std removes
            // each one as a link.
            fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory recursively '{path_str}': {e}"))
        } else {
            fs::remove_dir(&path).map_err(|e| format!("Failed to delete directory '{path_str}': {e}"))
        }
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file '{path_str}': {e}"))
    }
}

/// Remove a link, never what it leads to.
///
/// On unix a link is one directory entry whatever it points at, and unlink
/// removes it. Windows files a link to a folder — a directory symlink or a
/// junction — as a directory: `DeleteFileW` refuses it, and `RemoveDirectoryW`
/// removes the link and leaves the folder it leads to alone.
fn remove_link(path: &Path, file_type: fs::FileType) -> std::io::Result<()> {
    if is_folder_link(file_type) {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

/// A link Windows files as a directory: a directory symlink or a junction.
#[cfg(windows)]
fn is_folder_link(file_type: fs::FileType) -> bool {
    use std::os::windows::fs::FileTypeExt;
    file_type.is_symlink_dir()
}

/// Unix has no such thing: a link to a folder is not a folder.
#[cfg(not(windows))]
fn is_folder_link(_: fs::FileType) -> bool {
    false
}

/// True when both paths name the same on-disk entry.
///
/// String comparison cannot answer this: on a case-insensitive volume (APFS
/// and NTFS by default) `Foo.txt` and `foo.txt` are one file, and macOS also
/// folds NFC and NFD spellings of the same name together. `canonicalize`
/// returns the filesystem's own spelling, so comparing those answers it — for
/// anything but a link, which `canonicalize` follows. Asked about a link and
/// the file it points at, it said "the same entry", and a rename of one onto
/// the other's name then replaced the file with the link. So a link is never
/// the same entry as something that is not a link, and two links are compared
/// as links.
fn is_same_entry(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (a.symlink_metadata(), b.symlink_metadata()) else {
        return false;
    };
    match (meta_a.file_type().is_symlink(), meta_b.file_type().is_symlink()) {
        (false, false) => matches!((a.canonical(), b.canonical()), (Ok(a), Ok(b)) if a == b),
        (true, true) => is_same_link(a, b, &meta_a, &meta_b),
        _ => false,
    }
}

/// Whether two links are one link spelled two ways: both in the same folder,
/// under two names that folder files as one entry.
fn is_same_link(a: &Path, b: &Path, meta_a: &fs::Metadata, meta_b: &fs::Metadata) -> bool {
    let (Some(name_a), Some(name_b)) = (a.file_name(), b.file_name()) else {
        return false;
    };
    let folder = match (a.parent().map(Path::canonical), b.parent().map(Path::canonical)) {
        (Some(Ok(x)), Some(Ok(y))) if x == y => x,
        _ => return false,
    };
    if name_a == name_b {
        return true;
    }
    // When the folder lists both names they are two entries — hard links to
    // one link, or a folder that tells case apart — whatever the test below
    // would say about them.
    let listed = fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name();
                    name == name_a || name == name_b
                })
                .count()
        })
        .unwrap_or(0);
    listed < 2 && names_one_entry(name_a, name_b, meta_a, meta_b)
}

/// The kernel has already looked both names up: two that led to one inode
/// are one entry.
#[cfg(unix)]
fn names_one_entry(_: &OsStr, _: &OsStr, a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// std has no stable file id on Windows (`MetadataExt::file_index` is
/// nightly-only). NTFS folds case and nothing else, so two names in one
/// folder are one entry when they differ only in case. Only ASCII case is
/// counted: NTFS certainly folds that, and taking a name it would NOT fold for
/// the same entry is the mistake that overwrites a file, while missing one it
/// would fold only refuses a rename.
#[cfg(windows)]
fn names_one_entry(a: &OsStr, b: &OsStr, _: &fs::Metadata, _: &fs::Metadata) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Rename or move a path in one filesystem operation.
///
/// This exists because the obvious alternative — read, write to the new name,
/// delete the old — is wrong in ways that destroy data:
///
///   * it walks the tree, so anything the walk misses is deleted and never
///     copied;
///   * it decodes file contents, so a binary file aborts it half-way;
///   * and it decides "is this the same file?" with a string comparison, which
///     says `Foo.txt` and `foo.txt` differ when the filesystem says they do
///     not — so the write lands in the original and the delete then removes it.
///
/// `fs::rename` has none of those failure modes: it is atomic, it never looks
/// inside the entry, and the kernel resolves same-entry questions.
///
/// Both paths must name entries, not where they lead — `Workspace::
/// confine_entry`. Resolving a link here moves the file it points at, and
/// resolving the new name gives it the existing entry's spelling, so a
/// case-only rename becomes `rename(x, x)` and changes nothing.
pub fn rename_path(from_str: &str, to_str: &str) -> Result<(), String> {
    let from = resolve_path(from_str);
    let to = resolve_path(to_str);

    // `exists()` follows symlinks and so reports false for a broken one, which
    // would make a dangling link unrenameable. Ask about the link itself.
    if from.symlink_metadata().is_err() {
        return Err(format!("Path does not exist: {from_str}"));
    }

    let same = is_same_entry(&from, &to);

    // A pure case or Unicode-normalization change resolves to the same entry;
    // that is a rename to allow, not a collision to refuse.
    if to.symlink_metadata().is_ok() && !same {
        return Err(already_exists(&to));
    }

    // `rename` reports this as a bare EINVAL; say what actually happened.
    let from_is_dir = from
        .symlink_metadata()
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if from_is_dir && !same && to.starts_with(&from) {
        return Err(format!("Cannot move '{from_str}' inside itself"));
    }

    if let Some(parent) = to.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }

    fs::rename(&from, &to)
        .map_err(|e| format!("Failed to rename '{from_str}' to '{to_str}': {e}"))
}

/// Copy a file or a folder to a name nothing has yet: the Explorer's paste.
///
/// `from` is where the source leads (`Workspace::confine`), so a link is
/// copied as what it points at, the way reading it would be. `to` names the
/// new entry (`Workspace::confine_entry`) and must not exist — as a file, a
/// folder or a dangling link — which is checked before anything is written,
/// so a paste can neither overwrite a file nor merge into a folder. Its
/// folder must exist as well: creating that would bring back a folder deleted
/// since the Explorer last looked.
///
/// A file is copied as bytes, permissions included, by `fs::copy`. A folder
/// is copied with everything in it — nothing hidden the way the Explorer
/// hides `.git` or `node_modules`, and nothing decoded, so a PNG is a file
/// like any other. The paste this replaces walked the Explorer's listing and
/// copied each file as text: it left those folders out, and the first binary
/// file stopped it with half the copy written.
///
/// Links inside the folder are copied as links (`copy_link`) and never
/// followed. Following one that leads to a folder above it would copy the
/// tree into itself again at every level, as deep as the system lets a path
/// go, and one that leads out of the open folder would copy what is out there
/// in. A relative link keeps its
/// spelling, so one pointing within the folder points within the copy.
/// Sockets, FIFOs and devices are left out: they have no bytes of their own,
/// and opening a FIFO waits for a writer that may never come. The one a
/// project realistically holds is git's fsmonitor socket in `.git`, which
/// means nothing without the daemon that made it.
///
/// A folder copy that fails part-way is removed again, so a paste either
/// happens or leaves nothing behind.
pub fn copy_path(from: &Path, to: &Path) -> Result<(), String> {
    let source = from
        .metadata()
        .map_err(|_| format!("Path does not exist: {}", from.display()))?;
    if to.symlink_metadata().is_ok() {
        return Err(already_exists(to));
    }
    if !to.parent().is_some_and(Path::is_dir) {
        return Err(format!("Cannot copy to '{}': its folder does not exist", to.display()));
    }

    if source.is_dir() {
        if to.starts_with(from) {
            return Err(format!("Cannot copy '{}' inside itself", from.display()));
        }
        copy_folder(from, to)
    } else if source.is_file() {
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy '{}' to '{}': {e}", from.display(), to.display()))
    } else {
        Err(format!("Cannot copy '{}': it is not a file or a folder", from.display()))
    }
}

fn already_exists(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    format!("A file or folder named '{name}' already exists")
}

/// `copy_path` for a folder: create `to`, fill it, and remove it again if
/// filling it fails. `to` did not exist before (`copy_path` checked, and
/// `create_dir` would refuse one that appeared since), so everything under it
/// is this copy's own; `remove_dir_all` removes the links it meets as links,
/// so the clean-up never reaches past the copy either.
fn copy_folder(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir(to).map_err(|e| format!("Failed to create '{}': {e}", to.display()))?;
    let Err(error) = fill_folder(from, to) else {
        return Ok(());
    };
    match fs::remove_dir_all(to) {
        Ok(()) => Err(error),
        Err(e) => Err(format!("{error} (and the partial copy at '{}' could not be removed: {e})", to.display())),
    }
}

fn fill_folder(from: &Path, to: &Path) -> Result<(), String> {
    // Folders still to copy, as (source, copy). A list rather than recursion:
    // a deep tree would be a deep stack, on a blocking-pool thread with a
    // small one.
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((source, copy)) = pending.pop() {
        let unreadable = |e: std::io::Error| format!("Failed to read '{}': {e}", source.display());
        for entry in fs::read_dir(&source).map_err(unreadable)? {
            let entry = entry.map_err(unreadable)?;
            let (from_entry, to_entry) = (entry.path(), copy.join(entry.file_name()));
            // The entry itself: a link is not followed.
            let file_type = entry.file_type().map_err(unreadable)?;
            if file_type.is_symlink() {
                copy_link(&from_entry, &to_entry, file_type)
                    .map_err(|e| format!("Failed to copy the link '{}': {e}", from_entry.display()))?;
            } else if file_type.is_dir() {
                fs::create_dir(&to_entry)
                    .map_err(|e| format!("Failed to create '{}': {e}", to_entry.display()))?;
                pending.push((from_entry, to_entry));
            } else if file_type.is_file() {
                fs::copy(&from_entry, &to_entry)
                    .map_err(|e| format!("Failed to copy '{}': {e}", from_entry.display()))?;
            }
        }
    }
    Ok(())
}

/// Make `to` a link spelled exactly like the link `from`.
#[cfg(unix)]
fn copy_link(from: &Path, to: &Path, _: fs::FileType) -> std::io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

/// Windows makes a link to a folder and a link to a file differently, and
/// only in Developer Mode or for an administrator; without that the copy
/// fails and says why. A junction is copied as a directory symlink to the
/// same folder — std can read a junction but not make one.
#[cfg(windows)]
fn copy_link(from: &Path, to: &Path, file_type: fs::FileType) -> std::io::Result<()> {
    /// ERROR_PRIVILEGE_NOT_HELD
    const NO_PRIVILEGE: i32 = 1314;
    let target = fs::read_link(from)?;
    let made = if is_folder_link(file_type) {
        std::os::windows::fs::symlink_dir(target, to)
    } else {
        std::os::windows::fs::symlink_file(target, to)
    };
    made.map_err(|e| match e.raw_os_error() {
        Some(NO_PRIVILEGE) => std::io::Error::new(
            e.kind(),
            format!("{e}; Windows creates links only in Developer Mode or for an administrator"),
        ),
        _ => e,
    })
}


// ---------------------------------------------------------------------------
// Workspace root confinement
//
// Every fs_* command resolves its path through `Workspace::confine` — or
// `confine_entry`, when it acts on the entry itself — which rejects anything
// that escapes the active root. The root itself can only be changed by
// `fs_pick_root`, which goes through a native folder dialog, so the webview
// cannot widen its own access by calling a command.
// ---------------------------------------------------------------------------

/// The file inside the app config directory that remembers the open folder,
/// next to the window-state plugin's `.window-state.json`. One line, one path.
pub const OPEN_FOLDER_FILE: &str = ".open-folder";

pub struct Workspace {
    /// `None` until a folder is opened or `restore_root` brings back the one
    /// from last time. NexTerm never adopts whatever directory it was launched
    /// from — which in development was src-tauri and in an install the program
    /// folder — but it does reopen the folder the user last chose, as VS Code
    /// does.
    root: Mutex<Option<PathBuf>>,
    /// Where to write the root so the next launch can find it. `None` until
    /// `restore_root` names it, which makes remembering a no-op in tests and
    /// before setup has run, rather than a guess at the path.
    store: Mutex<Option<PathBuf>>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
            store: Mutex::new(None),
        }
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.root.lock().clone()
    }

    pub fn set_root(&self, candidate: &Path) -> Result<PathBuf, String> {
        let canonical = candidate
            .canonical()
            .map_err(|e| format!("Cannot open '{}': {e}", candidate.display()))?;
        if !canonical.is_dir() {
            return Err(format!("Not a directory: {}", canonical.display()));
        }
        *self.root.lock() = Some(canonical.clone());
        self.remember(&canonical);
        Ok(canonical)
    }

    /// Name the file that remembers the open folder, and adopt whatever it
    /// holds. Returns the folder that came back, if any.
    ///
    /// This has to run before the webview loads. The frontend asks the backend
    /// for the root — `fs_get_root` — twice during startup: once to draw the
    /// explorer, and once in the terminal store's `bootstrap`, which then hands
    /// each saved terminal's directory to `pty_spawn`. With no root, every one
    /// of those directories is refused by `confine` and the terminal starts in
    /// the home directory instead, so a restored session lost every cwd it had.
    ///
    /// A folder that has since been moved or deleted simply does not come back:
    /// `set_root` canonicalises and refuses anything that is not a directory.
    pub fn restore_root(&self, store: PathBuf) -> Option<PathBuf> {
        *self.store.lock() = Some(store.clone());
        let remembered = fs::read_to_string(&store).ok()?;
        let remembered = remembered.trim();
        if remembered.is_empty() {
            return None;
        }
        self.set_root(Path::new(remembered)).ok()
    }

    /// Write the open folder down for the next launch.
    ///
    /// Best-effort on purpose: a read-only or missing config directory must not
    /// stop the user opening a folder, so a failure here is reported and
    /// dropped rather than turned into an error `set_root` would return.
    fn remember(&self, root: &Path) {
        let Some(store) = self.store.lock().clone() else {
            return;
        };
        if let Some(parent) = store.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::write(&store, root.to_string_lossy().as_bytes()) {
            eprintln!("[NexTerm] Could not remember the open folder: {e}");
        }
    }

    /// With no folder open there is nothing to confine a path to, so every
    /// path is refused.
    pub fn confine(&self, path_str: &str) -> Result<PathBuf, String> {
        let root = self.root().ok_or_else(|| "No folder is open".to_string())?;
        confine_to(&root, path_str)
    }

    /// `confine`, for an operation on the entry the path names rather than on
    /// what it leads to — see `confine_entry_to`.
    pub fn confine_entry(&self, path_str: &str) -> Result<PathBuf, String> {
        let root = self.root().ok_or_else(|| "No folder is open".to_string())?;
        confine_entry_to(&root, path_str)
    }

    /// Where a new terminal starts: the requested directory when it is one,
    /// else the open folder, else — no folder open — the home directory, which
    /// is where VS Code starts one too.
    pub fn spawn_dir(&self, requested: Option<&str>) -> PathBuf {
        requested
            .and_then(|path| self.start_dir(path))
            .or_else(|| self.root())
            .unwrap_or_else(home_dir)
    }

    /// Whether a terminal asked to start in `requested` would start there
    /// rather than fall back — what the Settings check (`fs_dir_exists`)
    /// reports about a path the user has typed.
    ///
    /// It is `start_dir` and nothing more, so the check cannot drift from the
    /// spawn; `fs_dir_exists` tells how it did while it had logic of its own.
    pub fn can_start_in(&self, requested: &str) -> bool {
        self.start_dir(requested).is_some()
    }

    /// The requested directory, if a terminal can start there.
    ///
    /// This is the one path into the backend that is NOT confined to the open
    /// folder, and deliberately so. Confinement stops the webview reading and
    /// writing files outside the folder the user chose — that boundary is real
    /// and every `fs_*` command still goes through `confine`. A shell is not
    /// that: the moment one exists the user can `cd` anywhere and run anything,
    /// so refusing its STARTING directory defends nothing.
    ///
    /// What it did do is lose people's sessions. A terminal saved in
    /// `C:\Windows\System32` came back at the workspace root, because the saved
    /// directory was outside the folder and got refused; the tab then took the
    /// directory it actually got, and the write-behind saved that over the
    /// real one. Restoring a session is the common case for a directory
    /// outside the open folder, not an exotic one.
    ///
    /// A relative path still means "inside the open folder" — that is the only
    /// thing it can mean — so it keeps going through `confine`.
    fn start_dir(&self, requested: &str) -> Option<PathBuf> {
        let trimmed = requested.trim();
        // A directory on another machine is nowhere to start: starting a
        // shell there, or only resolving the path to see whether it is a
        // directory, connects to the host and signs in with the user's
        // credentials (see `is_network_path`). What asks for one is a
        // directory a shell reported (OSC 7, which anything a program prints
        // can fake), saved with a session or live, or the setting.
        if trimmed.is_empty() || is_network_path(trimmed) {
            return None;
        }
        let path = Path::new(trimmed);
        let resolved = if path.is_absolute() {
            path.canonical().ok()?
        } else {
            self.confine(trimmed).ok()?
        };
        resolved.is_dir().then_some(resolved)
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Does `path` name another machine, or a device rather than a file?
///
/// Decided by spelling alone, the same on every platform: what matters is
/// what the path means to Windows, which opens `\\host\share\x` by
/// connecting to the host and signing in with the user's credentials. Two
/// separators first, of either kind (`\\host`, `//host`, `/\host`) — which
/// is also how the device namespaces `\\.\` and `\\?\` begin — or `\??\`,
/// the NT spelling that reaches the same shares. Only the verbatim spelling
/// of a local drive, `\\?\C:\…`, is local. The frontend's `isNetworkPath`
/// (src/lib/terminalLinks.js) draws the same line.
pub fn is_network_path(path: &str) -> bool {
    let separator = |byte: &u8| *byte == b'\\' || *byte == b'/';
    match without_verbatim_prefix(path).as_bytes() {
        [first, second, ..] if separator(first) && separator(second) => true,
        [first, b'?', b'?', fourth, ..] if separator(first) && separator(fourth) => true,
        _ => false,
    }
}

/// `path` without a verbatim prefix that a plainer spelling means the same
/// as: `\\?\UNC\host\share` is `\\host\share`, `\\?\C:\x` is `C:\x`.
fn without_verbatim_prefix(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    let Some(rest) = path.strip_prefix(r"\\?\") else {
        return Cow::Borrowed(path);
    };
    match rest.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => Cow::Borrowed(rest),
        _ => Cow::Borrowed(path),
    }
}

/// Whether confining `asked`, spelled out in full as `spelled`, would have to
/// reach another machine to find out where it leads.
///
/// A network or device path is refused unless the open folder is itself on
/// another machine and the path is inside it: that is the one host the user
/// has chosen to reach, by opening the folder, and every file in such a
/// folder has a path like this. Inside is judged by name, case and all,
/// with the verbatim `\\?\UNC\` spelled plain — the backend hands such a
/// folder out as `\\?\UNC\host\share\…`.
fn on_another_machine(root: &Path, asked: &str, spelled: &Path) -> bool {
    let spelled = spelled.to_string_lossy();
    if !is_network_path(asked) && !is_network_path(&spelled) {
        return false;
    }
    let root = root.to_string_lossy();
    !(is_network_path(&root) && names_of(&spelled).starts_with(&names_of(&root)))
}

/// The names in a path, split at either separator.
fn names_of(path: &str) -> Vec<String> {
    without_verbatim_prefix(path)
        .split(['\\', '/'])
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// Resolve a webview-supplied path to what it leads to, refusing anything
/// outside `root`. This is the confinement for reading and writing: a link
/// inside the folder is followed to its file, as opening a file through a
/// link should be, and one that leads out of the folder is refused.
pub fn confine_to(root: &Path, path_str: &str) -> Result<PathBuf, String> {
    match spelled_in(root, path_str)? {
        None => Ok(root.to_path_buf()),
        Some(path) => resolve_inside(root, &path, path_str),
    }
}

/// Resolve a webview-supplied path to the entry it names, refusing anything
/// outside `root`: the confinement for acting on an entry itself — delete,
/// rename, move, the destination of a copy.
///
/// Only the folder the entry sits in is resolved; its own name is kept as
/// given. `confine_to` resolves the whole path, and an entry operation handed
/// that acts on the wrong thing. A link resolves to what it points at, so
/// deleting `AGENTS.md -> CLAUDE.md` deleted CLAUDE.md, and deleting a link to
/// a folder deleted the folder's whole tree. A new name resolves to the
/// spelling of the entry it folds onto, so renaming `Readme.md` to
/// `README.md` asked for `rename(Readme.md, Readme.md)`.
///
/// The folder goes through exactly what `confine_to` does, so a `..` or a
/// folder link that leads out of the root is refused the same way. The name
/// is a single component after `..` has been worked out, so on its own it
/// leads nowhere but that folder.
pub fn confine_entry_to(root: &Path, path_str: &str) -> Result<PathBuf, String> {
    let Some(path) = spelled_in(root, path_str)? else {
        return Ok(root.to_path_buf());
    };
    // The open folder itself, spelled the way the backend hands it out. Every
    // caller refuses to act on it, and says so, rather than calling it outside.
    if path == root {
        return Ok(path);
    }
    match (path.parent(), path.file_name()) {
        (Some(folder), Some(name)) => Ok(resolve_inside(root, folder, path_str)?.join(name)),
        // `/` or `C:\`: no folder above it and no name of its own.
        _ => resolve_inside(root, &path, path_str),
    }
}

/// The path the webview named, made absolute against `root`, with `.` and
/// `..` worked out by spelling alone. `None` for a blank path or `.`, which
/// both mean the open folder.
///
/// Refused here, before anything touches the filesystem, when finding out
/// where it leads would mean asking another machine (`on_another_machine`).
/// The check after `canonicalize` came too late for that: canonicalizing
/// `\\host\share\x` is what makes Windows connect to the host.
fn spelled_in(root: &Path, path_str: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = path_str.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(None);
    }

    let expanded = match trimmed.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(trimmed),
    };
    let joined = if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    };
    let spelled = lexical_normalize(&joined);
    if on_another_machine(root, trimmed, &spelled) {
        return Err(format!("Path is on another machine or a device: {path_str}"));
    }
    Ok(Some(spelled))
}

/// `path` with every link in it resolved, refused unless that lands inside
/// `root`.
///
/// A link that cannot be followed — to something that does not exist, or
/// round in a loop — is refused wherever it is in the path. It used to be
/// taken for a name that does not exist yet and kept as it was, and a save
/// or a New File then wrote through it, making its target wherever it
/// pointed, outside the open folder as easily as in it.
fn resolve_inside(root: &Path, path: &Path, path_str: &str) -> Result<PathBuf, String> {
    // Canonicalize the deepest part that exists so a symlink cannot point out
    // of the root; segments that do not exist yet are re-appended afterwards.
    let mut cursor = path;
    let mut pending: Vec<OsString> = Vec::new();
    let resolved = loop {
        match cursor.canonical() {
            Ok(canonical) => break canonical,
            Err(_) if cursor.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) => {
                return Err(format!(
                    "Path goes through a broken link ({}): {path_str}",
                    cursor.display()
                ));
            }
            Err(_) => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("Invalid path: {path_str}"))?
                    .to_os_string();
                pending.push(name);
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("Invalid path: {path_str}"))?;
            }
        }
    };

    let mut final_path = resolved;
    for segment in pending.iter().rev() {
        final_path.push(segment);
    }

    if !final_path.starts_with(root) {
        return Err(format!(
            "Path is outside the workspace root ({}): {path_str}",
            root.display()
        ));
    }
    Ok(final_path)
}

#[cfg(test)]
mod confine_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-confine-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("inner/file.txt"), "ok").unwrap();
        dir.canonical().unwrap()
    }

    #[test]
    fn accepts_paths_inside_root() {
        let root = temp_root("inside");
        let p = confine_to(&root, &root.join("inner/file.txt").to_string_lossy()).unwrap();
        assert!(p.starts_with(&root));
        let rel = confine_to(&root, "inner/file.txt").unwrap();
        assert_eq!(rel, root.join("inner/file.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_not_yet_existing_paths_inside_root() {
        let root = temp_root("new");
        let p = confine_to(&root, "inner/new-dir/new-file.txt").unwrap();
        assert_eq!(p, root.join("inner/new-dir/new-file.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_dot_dot_escape() {
        let root = temp_root("dotdot");
        assert!(confine_to(&root, "../../etc/passwd").is_err());
        assert!(confine_to(&root, "inner/../../outside").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows opens `\\host\share\x` by connecting to the host and signing
    /// in with the user's credentials (NTLM), and canonicalizing a path
    /// opens it — so confinement reached the host before it ever compared
    /// the path with the open folder. Each of these is refused for what it
    /// is, by its spelling, before anything touches the filesystem: on
    /// Windows any of them reaching `canonicalize` would contact a host.
    #[test]
    fn a_path_on_another_machine_is_refused_before_it_is_looked_up() {
        let root = temp_root("network");
        for path in [
            r"\\host\share\x.txt",
            "//host/share/x.txt",
            r"/\host\share\x.txt",
            r"\\?\UNC\host\share\x.txt",
            r"\\.\pipe\x",
            r"\??\UNC\host\share\x.txt",
            "/??/UNC/host/share/x.txt",
            r"\\?\GLOBALROOT\Device\Mup\host\share\x.txt",
            r"  \\host\share\x.txt",
        ] {
            for (what, result) in [("confine_to", confine_to(&root, path)), ("confine_entry_to", confine_entry_to(&root, path))] {
                let err = result.expect_err(&format!("{what} let {path:?} through"));
                assert!(err.contains("another machine"), "{what} {path:?}: {err}");
            }
        }
        // Local paths, in the spellings Windows allows, are still judged by
        // where they lead.
        assert_eq!(confine_to(&root, "inner/file.txt").unwrap(), root.join("inner/file.txt"));
        assert!(confine_to(&root, "/etc/passwd").unwrap_err().contains("outside the workspace root"));
        let _ = fs::remove_dir_all(&root);
    }

    /// The same table as LK-27 in tests/adversarial/terminal_links.test.js,
    /// which holds the frontend's `isNetworkPath` to it, and a few more.
    #[test]
    fn what_counts_as_another_machine_is_decided_by_spelling() {
        for path in [
            r"\\h\s",
            "//h/s",
            r"\/h/s",
            r"/\h\s",
            r"\\?\UNC\h\s",
            r"\\.\pipe\p",
            r"\??\C:\x",
            "/??/x",
            r"\\.\C:\x",
            r"\\?\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\x",
            r"\\?\GLOBALROOT\Device\Mup\h\s",
        ] {
            assert!(is_network_path(path), "{path}");
        }
        for path in [r"C:\x", "C:/x", "/x", r"\x", r"x\\y", r"\\?\C:\x", r"\\?\c:\x", "src/a.py", "", r"\?\x"] {
            assert!(!is_network_path(path), "{path}");
        }
    }

    /// A folder opened from a share — picked in the dialog, or a mapped
    /// drive, which canonicalizes to the share — is reached the way the user
    /// chose to reach it. Only paths inside it get past the spelling check;
    /// the same share elsewhere, or another host, still does not.
    #[test]
    fn inside_a_folder_on_a_share_only_that_folder_is_reachable() {
        for root in [r"\\?\UNC\nas\share\proj", "//nas/share/proj"] {
            let root = Path::new(root);
            let reaches = |path: &str| on_another_machine(root, path, Path::new(path));
            for inside in [r"\\nas\share\proj", r"\\nas\share\proj\src\a.js", r"\\?\UNC\nas\share\proj\a.js", "//nas/share/proj/a.js"] {
                assert!(!reaches(inside), "{} refused {inside}", root.display());
            }
            for outside in [
                r"\\nas\share\other\a.js",
                r"\\nas\share\project\a.js",
                r"\\nas\share",
                r"\\evil\share\proj\a.js",
                r"\\NAS\share\proj\a.js",
                r"\\.\pipe\proj",
            ] {
                assert!(reaches(outside), "{} let {outside} through", root.display());
            }
        }
        // With a folder on this machine open, every one of them is refused.
        let local = Path::new("/w/proj");
        assert!(on_another_machine(local, r"\\nas\share\proj\a.js", Path::new(r"\\nas\share\proj\a.js")));
        assert!(!on_another_machine(local, "src/a.js", &local.join("src/a.js")));
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let root = temp_root("abs");
        assert!(confine_to(&root, "/etc/passwd").is_err());
        assert!(confine_to(&root, "~/.ssh/id_rsa").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows' own canonicalize answers `\\?\D:\…`, which cmd.exe refuses as a
    /// working directory and the title bar printed as-is.
    #[test]
    fn paths_handed_out_carry_no_verbatim_prefix() {
        let root = temp_root("verbatim");
        let workspace = Workspace::new();
        let set = workspace.set_root(&root).unwrap();
        let confined = workspace.confine("inner/file.txt").unwrap();
        for path in [&root, &set, &confined] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "verbatim path handed out: {}",
                path.display()
            );
        }
        assert!(confined.starts_with(&set), "{} is not under {}", confined.display(), set.display());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_workspace_has_no_folder_and_confines_nothing() {
        let workspace = Workspace::new();
        assert!(
            workspace.root().is_none(),
            "NexTerm must not adopt the directory it was launched from"
        );
        let err = workspace.confine("Cargo.toml").unwrap_err();
        assert!(err.contains("No folder"), "unexpected error: {err}");
        assert!(workspace.confine(&std::env::temp_dir().to_string_lossy()).is_err());
    }

    #[test]
    fn terminals_start_in_the_requested_directory_else_the_open_folder_else_home() {
        let workspace = Workspace::new();
        assert_eq!(workspace.spawn_dir(None), home_dir(), "nothing asked for, no folder open");

        // With no folder open at all, a directory that was asked for is still
        // honoured — restoring a session is exactly that case.
        let temp = std::env::temp_dir().canonical().unwrap();
        assert_eq!(workspace.spawn_dir(Some(&temp.to_string_lossy())), temp);
        assert_eq!(
            workspace.spawn_dir(Some(&temp.join("nexterm-not-a-real-dir").to_string_lossy())),
            home_dir(),
            "a directory that is not there falls back"
        );

        let root = workspace.set_root(&temp_root("spawn")).unwrap();
        assert_eq!(workspace.spawn_dir(None), root);
        assert_eq!(workspace.spawn_dir(Some("inner")), root.join("inner"));
        assert_eq!(
            workspace.spawn_dir(Some("inner/file.txt")),
            root,
            "a file is not somewhere to start"
        );
        assert_eq!(
            workspace.spawn_dir(Some(&temp.to_string_lossy())),
            temp,
            "outside the open folder is still somewhere a terminal may start"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// Loosening where a TERMINAL may start must not loosen what the webview
    /// can read and write. `fs_*` still goes through `confine`.
    #[test]
    fn a_terminal_may_start_outside_the_folder_but_files_there_stay_out_of_reach() {
        let root = temp_root("outside-root");
        let elsewhere = temp_root("outside-elsewhere");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        assert_eq!(
            workspace.spawn_dir(Some(&elsewhere.to_string_lossy())),
            elsewhere,
            "a terminal saved outside the folder comes back where it was"
        );
        assert!(
            workspace.confine(&elsewhere.to_string_lossy()).is_err(),
            "but the files there are still refused"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    // The Settings check for a custom directory (`fs_dir_exists`) asks
    // `can_start_in`, and a new terminal asks `spawn_dir`. Each case below
    // puts the check's answer next to where a terminal really starts, for
    // every kind of path the field can be given.

    #[test]
    fn a_relative_path_means_inside_the_open_folder() {
        let root = temp_root("check-relative");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        // `inner` is under the open folder and not beside the tests, so
        // reading it against the working directory would have said no.
        assert!(!Path::new("inner").exists(), "premise: no ./inner where the tests run");
        assert!(workspace.can_start_in("inner"), "the check says yes");
        assert_eq!(workspace.spawn_dir(Some("inner")), root.join("inner"), "and a terminal starts there");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_path_never_means_the_process_working_directory() {
        // cargo runs a crate's tests from the crate root, where `src` is. The
        // app runs from wherever it was launched; neither is the open folder.
        assert!(Path::new("src").is_dir(), "premise: the tests run from the crate root");
        let root = temp_root("check-cwd");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        assert!(!workspace.can_start_in("src"), "src is beside the tests, not in the open folder");
        assert_eq!(workspace.spawn_dir(Some("src")), root, "and a terminal would fall back");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absolute_directory_outside_the_open_folder_is_somewhere_to_start() {
        let root = temp_root("check-absolute-root");
        let elsewhere = temp_root("check-absolute-elsewhere");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        let path = elsewhere.to_string_lossy();
        assert!(workspace.can_start_in(&path), "outside the folder is not refused");
        assert_eq!(workspace.spawn_dir(Some(&path)), elsewhere, "and a terminal starts there");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    /// `confine` reads a blank path as the open folder itself. `start_dir`
    /// does not, and neither may the check.
    #[test]
    fn a_blank_path_is_nowhere_to_start_even_with_a_folder_open() {
        let root = temp_root("check-blank");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        for blank in ["", " ", "\t", " \n "] {
            assert!(!workspace.can_start_in(blank), "{blank:?} passed the check");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_is_nowhere_to_start() {
        let root = temp_root("check-file");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        let file = root.join("inner").join("file.txt");
        assert!(file.is_file(), "premise: the file is there");
        let path = file.to_string_lossy();
        assert!(!workspace.can_start_in(&path), "an absolute path to a file");
        assert_eq!(workspace.spawn_dir(Some(&path)), root, "a terminal falls back");
        assert!(!workspace.can_start_in("inner/file.txt"), "nor a relative one");

        let _ = fs::remove_dir_all(&root);
    }

    /// Found in review: Enter after a shell exited started the new one in the
    /// directory the old one last reported, and a program can report one on
    /// another machine. Refused before anything resolves it — on Unix `//dir`
    /// is `/dir`, which is there, so the refusal is what is seen here.
    #[test]
    fn a_directory_on_another_machine_is_nowhere_to_start() {
        let root = temp_root("check-network");
        let elsewhere = temp_root("check-network-elsewhere");
        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();

        let plain = elsewhere.to_string_lossy().to_string();
        assert!(workspace.can_start_in(&plain), "premise: the directory itself is somewhere to start");
        let doubled = format!("//{}", plain.trim_start_matches(['/', '\\']));
        for path in [doubled, r"\\host\share".to_string(), r"\\?\UNC\host\share".to_string()] {
            assert!(!workspace.can_start_in(&path), "{path} passed the check");
            assert_eq!(workspace.spawn_dir(Some(&path)), root, "{path}: a terminal falls back");
        }

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    /// With no folder open a relative path has nothing to be relative to, so
    /// a terminal asked for one starts at home — and the check has to say so
    /// rather than find the path beside the process.
    #[test]
    fn with_no_folder_open_a_relative_path_is_nowhere_to_start() {
        assert!(Path::new("src").is_dir(), "premise: the tests run from the crate root");
        let workspace = Workspace::new();

        for relative in ["src", "."] {
            assert!(!workspace.can_start_in(relative), "{relative:?} passed with no folder open");
            assert_eq!(workspace.spawn_dir(Some(relative)), home_dir(), "{relative:?} falls back home");
        }

        // An absolute path still passes: restoring a session with no folder
        // open is exactly that case.
        let temp = std::env::temp_dir().canonical().unwrap();
        assert!(workspace.can_start_in(&temp.to_string_lossy()));
    }

    fn temp_store(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-open-folder-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join(OPEN_FOLDER_FILE)
    }

    #[test]
    fn the_open_folder_is_remembered_and_comes_back_next_launch() {
        let root = temp_root("remember");
        let store = temp_store("remember");

        // First launch: nothing is remembered yet, then the user opens a folder.
        let first = Workspace::new();
        assert_eq!(first.restore_root(store.clone()), None, "nothing to restore yet");
        first.set_root(&root).unwrap();

        // Next launch reads the same file and reopens it, with nobody asking.
        let second = Workspace::new();
        assert_eq!(second.restore_root(store.clone()), Some(root.clone()));
        assert_eq!(second.root(), Some(root.clone()));

        let _ = fs::remove_dir_all(store.parent().unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_remembered_folder_that_has_gone_is_not_reopened() {
        let root = temp_root("gone");
        let store = temp_store("gone");
        let first = Workspace::new();
        first.restore_root(store.clone());
        first.set_root(&root).unwrap();
        let _ = fs::remove_dir_all(&root);

        let second = Workspace::new();
        assert_eq!(
            second.restore_root(store.clone()),
            None,
            "a folder that has been deleted must not come back"
        );
        assert!(second.root().is_none(), "and must not leave a half-open workspace");

        let _ = fs::remove_dir_all(store.parent().unwrap());
    }

    /// What the remembered folder is still for once `spawn_dir` honours a
    /// directory on its own: a terminal that has no saved directory — a new
    /// one, or one whose folder has gone — falls back to the open folder, and
    /// that has to be the folder from last time rather than nothing.
    #[test]
    fn a_restored_root_is_what_a_terminal_without_one_falls_back_to() {
        let root = temp_root("restored-spawn");
        let store = temp_store("restored-spawn");
        let saved_cwd = root.join("inner").to_string_lossy().to_string();

        let opener = Workspace::new();
        opener.restore_root(store.clone());
        opener.set_root(&root).unwrap();

        // What used to happen on every relaunch: no root, so nothing to fall
        // back to but the home directory.
        let forgetful = Workspace::new();
        assert_eq!(forgetful.spawn_dir(None), home_dir());

        // What happens now.
        let relaunched = Workspace::new();
        relaunched.restore_root(store.clone());
        assert_eq!(relaunched.spawn_dir(None), root);
        assert_eq!(relaunched.spawn_dir(Some(&saved_cwd)), root.join("inner"));

        let _ = fs::remove_dir_all(store.parent().unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = temp_root("symlink");
        let outside = std::env::temp_dir().join(format!("nexterm-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(confine_to(&root, "link/secret").is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_file_crud_operations() {
        let temp_dir = std::env::temp_dir().join(format!("nexterm_test_crud_{}", uuid::Uuid::new_v4().simple()));
        let dir_str = temp_dir.to_string_lossy().to_string();

        // Create dir
        assert!(create_dir(&dir_str).is_ok());

        // Create file
        let file_path = temp_dir.join("test.txt");
        let file_str = file_path.to_string_lossy().to_string();
        assert!(create_file(&file_str).is_ok());
        assert!(create_file(&file_str).is_err(), "Duplicate creation should fail");

        // Write & Read
        assert!(write_file(&file_str, "hello world").is_ok());
        let content = read_file(&file_str).unwrap();
        assert_eq!(content, "hello world");

        // Delete file
        assert!(delete_path(&file_str, false).is_ok());
        assert!(read_file(&file_str).is_err(), "Deleted file should not exist");

        // Delete dir
        assert!(delete_path(&dir_str, true).is_ok());
        assert!(!temp_dir.exists());
    }

    /// New File checked `exists()`, which follows a link, and then wrote: a
    /// link to nothing was "not there", and the write made its target. And a
    /// file that appeared between the check and the write was emptied.
    #[cfg(unix)]
    #[test]
    fn creating_a_file_never_follows_a_link_or_empties_a_file() {
        let dir = scratch("create-new");
        std::os::unix::fs::symlink(dir.join("target.txt"), dir.join("link")).unwrap();
        fs::write(dir.join("kept.txt"), "keep me").unwrap();

        let err = create_file(&dir.join("link").to_string_lossy()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(dir.join("target.txt").symlink_metadata().is_err(), "the link's target was made");

        let err = create_file(&dir.join("kept.txt").to_string_lossy()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(dir.join("kept.txt")).unwrap(), "keep me");

        create_file(&dir.join("sub").join("new.txt").to_string_lossy()).unwrap();
        assert_eq!(fs::read(dir.join("sub").join("new.txt")).unwrap(), b"", "a new file, and its folder");
        let _ = fs::remove_dir_all(&dir);
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-read-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 500 MB log clicked in the Explorer was read whole, sent whole over
    /// IPC and handed whole to Monaco, which froze the window or ran the
    /// webview out of memory. The size is checked before anything is read.
    #[test]
    fn a_file_too_large_to_open_is_refused_with_its_size_and_the_limit() {
        assert_eq!(MAX_OPEN_BYTES, 50 * 1024 * 1024, "the sizes below are written for 50 MB");
        let err = too_large_to_open("x", 3 * 1024 * 1024 * 1024);
        assert!(err.contains("(3.0 GB; the limit is 50 MB)"), "{err}");

        let dir = scratch("too-large");
        let big = dir.join("big.log");
        // Sparse: only the size is checked, so nothing has to be written.
        fs::File::create(&big).unwrap().set_len(120 * 1024 * 1024).unwrap();
        let just_over = dir.join("just-over.log");
        fs::File::create(&just_over).unwrap().set_len(50 * 1024 * 1024 + 1).unwrap();
        let at_limit = dir.join("at-limit.log");
        fs::File::create(&at_limit).unwrap().set_len(50 * 1024 * 1024).unwrap();

        let err = read_file(&big.to_string_lossy()).unwrap_err();
        assert!(err.starts_with("File is too large to open"), "{err}");
        assert!(err.contains("120.0 MB") && err.contains("the limit is 50 MB"), "{err}");

        let err = read_file(&just_over.to_string_lossy()).unwrap_err();
        assert!(err.starts_with("File is too large to open"), "{err}");
        assert!(err.contains("50.1 MB"), "a byte over still reads as over: {err}");

        // Exactly at the limit is still opened: NUL bytes are not text, so
        // this one is refused as that, after its size has passed.
        let err = read_file(&at_limit.to_string_lossy()).unwrap_err();
        assert!(!err.contains("too large"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// NUL bytes are valid UTF-8, so a PNG whose bytes happened to decode —
    /// or a UTF-16 file — opened as a buffer of garbage that saving would
    /// then write back. A NUL in the first bytes says it is not text.
    #[test]
    fn a_file_that_is_not_text_is_refused_as_such() {
        let dir = scratch("binary");
        let cases: [(&str, &[u8]); 3] = [
            ("nul.bin", b"a\0b"),
            ("utf16.txt", b"h\0e\0l\0l\0o\0"),
            ("latin1.txt", b"caf\xe9"),
        ];
        for (name, bytes) in cases {
            fs::write(dir.join(name), bytes).unwrap();
            let err = read_file(&dir.join(name).to_string_lossy()).unwrap_err();
            assert!(err.starts_with("File is not UTF-8 text"), "{name}: {err}");
        }
        fs::write(dir.join("ok.txt"), "한글 and ✅\n").unwrap();
        assert_eq!(read_file(&dir.join("ok.txt").to_string_lossy()).unwrap(), "한글 and ✅\n");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Opening a FIFO waits for a writer that may never come: a click on one
    /// held a worker thread for good and the tab never opened. The read runs
    /// on a thread with a deadline, so that is a failure here, not a hang.
    #[cfg(unix)]
    #[test]
    fn something_that_is_not_a_file_is_refused_without_waiting_on_it() {
        use std::os::unix::ffi::OsStrExt;
        let dir = scratch("fifo");
        let fifo = dir.join("pipe");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0, "premise: a FIFO to open");

        let path = fifo.to_string_lossy().to_string();
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(read_file(&path));
        });
        let read = finished
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("the read is still waiting on the FIFO");
        assert!(read.unwrap_err().contains("not a file"));

        let err = read_file(&dir.to_string_lossy()).unwrap_err();
        assert!(err.contains("not a file"), "a folder: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_dir_hierarchy_and_skips() {
        let temp_dir = std::env::temp_dir().join(format!("nexterm_test_tree_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(temp_dir.join("src")).unwrap();
        fs::create_dir_all(temp_dir.join(".git")).unwrap();
        fs::create_dir_all(temp_dir.join("node_modules")).unwrap();
        fs::create_dir_all(temp_dir.join("target")).unwrap();
        fs::create_dir_all(temp_dir.join(".agents")).unwrap();
        fs::create_dir_all(temp_dir.join("dist")).unwrap();

        fs::write(temp_dir.join("package.json"), "{}").unwrap();
        fs::write(temp_dir.join("src/App.jsx"), "export default function App() {}").unwrap();
        fs::write(temp_dir.join(".git/config"), "secret").unwrap();

        let nodes = read_dir_hierarchy(&temp_dir.to_string_lossy(), Some(3)).unwrap();

        let names: Vec<String> = nodes.iter().map(|n| n.name.clone()).collect();
        assert!(names.contains(&"src".to_string()), "src dir must be included");
        assert!(names.contains(&"package.json".to_string()), "package.json must be included");

        // Ensure skipped folders are not present
        assert!(!names.contains(&".git".to_string()), ".git must be skipped");
        assert!(!names.contains(&"node_modules".to_string()), "node_modules must be skipped");
        assert!(!names.contains(&"target".to_string()), "target must be skipped");
        assert!(!names.contains(&".agents".to_string()), ".agents must be skipped");
        assert!(!names.contains(&"dist".to_string()), "dist must be skipped");

        // Ensure directories come before files
        let first_is_dir = nodes[0].is_dir;
        assert!(first_is_dir, "Directories must sort before files");

        let src_node = nodes.iter().find(|n| n.name == "src").unwrap();
        assert!(src_node.children.is_some());
        let src_children = src_node.children.as_ref().unwrap();
        assert_eq!(src_children.len(), 1);
        assert_eq!(src_children[0].name, "App.jsx");

        // Cleanup
        let _ = fs::remove_dir_all(&temp_dir);
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    /// Each test gets its own directory. Sharing one fixed path between tests
    /// is what made the shell-integration suite flaky under cargo's parallel
    /// harness; do not repeat it here.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("nexterm-rename-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonical().unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn case_only_rename_keeps_the_file() {
        let root = temp_root("case");
        let from = root.join("Foo.txt");
        let to = root.join("foo.txt");
        fs::write(&from, "important data").unwrap();

        rename_path(&s(&from), &s(&to)).unwrap();

        // On a case-insensitive volume these are one entry, on a
        // case-sensitive one they are two; either way the bytes must survive
        // and the directory must still hold exactly one file.
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "rename lost the file: {names:?}");
        assert_eq!(fs::read_to_string(root.join(&names[0])).unwrap(), "important data");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unicode_normalization_rename_keeps_the_file() {
        let root = temp_root("nfc");
        let nfc = root.join("\u{d55c}.txt"); // 한 as one precomposed code point
        let nfd = root.join("\u{1112}\u{1161}\u{11ab}.txt"); // the same syllable, decomposed
        fs::write(&nfc, "korean").unwrap();

        rename_path(&s(&nfc), &s(&nfd)).unwrap();

        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "rename lost the file: {names:?}");
        assert_eq!(fs::read_to_string(root.join(&names[0])).unwrap(), "korean");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn directory_rename_keeps_every_descendant() {
        let root = temp_root("dir");
        let proj = root.join("proj");
        // Depth 3, plus one folder the directory listing deliberately hides.
        fs::create_dir_all(proj.join("src/nested/deeper")).unwrap();
        fs::create_dir_all(proj.join(".git")).unwrap();
        fs::write(proj.join("top.txt"), "top").unwrap();
        fs::write(proj.join("src/a.js"), "a").unwrap();
        fs::write(proj.join("src/nested/b.js"), "b").unwrap();
        fs::write(proj.join("src/nested/deeper/c.js"), "c").unwrap();
        fs::write(proj.join(".git/config"), "cfg").unwrap();
        // A byte sequence that is not valid UTF-8: a copy that decodes file
        // contents aborts here, a rename never looks inside.
        fs::write(proj.join("logo.png"), [0x89u8, 0x50, 0x4e, 0x47, 0xff, 0xfe]).unwrap();

        let dest = root.join("proj2");
        rename_path(&s(&proj), &s(&dest)).unwrap();

        assert!(!proj.exists(), "source directory still present");
        assert_eq!(fs::read_to_string(dest.join("top.txt")).unwrap(), "top");
        assert_eq!(fs::read_to_string(dest.join("src/a.js")).unwrap(), "a");
        assert_eq!(fs::read_to_string(dest.join("src/nested/b.js")).unwrap(), "b");
        assert_eq!(fs::read_to_string(dest.join("src/nested/deeper/c.js")).unwrap(), "c");
        assert_eq!(fs::read_to_string(dest.join(".git/config")).unwrap(), "cfg");
        assert_eq!(fs::read(dest.join("logo.png")).unwrap(), vec![0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_overwrite_an_existing_entry() {
        let root = temp_root("collide");
        fs::write(root.join("keep.txt"), "KEEP ME").unwrap();
        fs::write(root.join("other.txt"), "other").unwrap();

        let err = rename_path(&s(&root.join("other.txt")), &s(&root.join("keep.txt")))
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "KEEP ME");
        assert_eq!(fs::read_to_string(root.join("other.txt")).unwrap(), "other");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_move_a_directory_into_itself() {
        let root = temp_root("selfmove");
        let dir = root.join("outer");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("inside.txt"), "still here").unwrap();

        let err = rename_path(&s(&dir), &s(&dir.join("child"))).unwrap_err();
        assert!(err.contains("inside itself"), "{err}");
        assert_eq!(fs::read_to_string(dir.join("inside.txt")).unwrap(), "still here");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_is_an_error_and_a_dangling_link_is_not() {
        let root = temp_root("missing");
        assert!(rename_path(&s(&root.join("nope.txt")), &s(&root.join("x.txt"))).is_err());

        #[cfg(unix)]
        {
            // A broken symlink is a real directory entry; renaming it must
            // move the link, not report it missing.
            std::os::unix::fs::symlink(root.join("no-such-target"), root.join("link")).unwrap();
            rename_path(&s(&root.join("link")), &s(&root.join("link2"))).unwrap();
            assert!(root.join("link2").symlink_metadata().is_ok());
            assert!(root.join("link").symlink_metadata().is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }
}

/// The contract the file explorer is built on, checked against a real
/// filesystem on whatever platform this runs.
///
/// The explorer rendered EMPTY on Windows for two releases: it re-derived the
/// root's children with `path.startsWith(root + '/')`, which compares
/// `C:\Users\me\project\src` against `C:\Users\me\project/` and is false for
/// every entry. Nothing caught it, because the Rust tests ran only on ubuntu
/// and the JS tests fed themselves hand-written paths — neither half was wrong
/// on its own, and nothing checked them against each other.
///
/// These cases read a directory tree that really exists and assert the three
/// properties the UI depends on: it nests, its paths use this platform's
/// separator, and every child really is a child of the parent it hangs off.
/// The listing is then written out for the JS half to pick up — see
/// `tests/adversarial/backend_tree_contract.test.js` — so both sides are
/// checked against the same bytes, produced by the same filesystem.
#[cfg(test)]
mod explorer_contract_tests {
    use super::*;

    fn build_tree(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nexterm_contract_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("components")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap(); // must be skipped
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("src").join("index.js"), "//").unwrap();
        fs::write(root.join("src").join("components").join("App.jsx"), "//").unwrap();
        fs::write(root.join("tests").join("app.test.js"), "//").unwrap();
        root
    }

    fn child<'a>(nodes: &'a [FileNode], name: &str) -> &'a FileNode {
        nodes.iter().find(|n| n.name == name).unwrap_or_else(|| {
            panic!(
                "no entry named {name} in {:?}",
                nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
            )
        })
    }

    #[test]
    fn the_root_listing_is_never_empty_and_nests_its_children() {
        let root = build_tree("nest");
        let nodes = read_dir_hierarchy(&root.to_string_lossy(), Some(5)).unwrap();

        // The bug, stated as an assertion: the explorer must be handed
        // something to draw.
        assert!(!nodes.is_empty(), "the root listing must not be empty");

        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["src", "tests", "package.json"], "directories first, then by name");
        assert!(!names.contains(&"node_modules"), "build folders stay hidden");

        // Nested, not flattened: `src` carries its own entries, and one of
        // those carries its own in turn.
        let src = child(&nodes, "src");
        assert!(src.is_dir);
        let src_children = src.children.as_ref().expect("a directory reports its children");
        let components = child(src_children, "components");
        let deep = components.children.as_ref().expect("nested directories nest too");
        assert_eq!(deep.len(), 1);
        assert_eq!(deep[0].name, "App.jsx");

        assert!(child(&nodes, "package.json").children.is_none(), "a file has no children");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn every_path_uses_this_platform_separator_and_sits_under_its_parent() {
        let root = build_tree("sep");
        let nodes = read_dir_hierarchy(&root.to_string_lossy(), Some(5)).unwrap();
        let sep = std::path::MAIN_SEPARATOR;

        /// Check each node against the parent that produced it — the exact
        /// relationship the explorer's `isDirectChild` has to agree with.
        fn walk(parent: &str, nodes: &[FileNode], sep: char) {
            for node in nodes {
                assert!(node.path.starts_with(parent), "{} is not under {}", node.path, parent);
                let rest = &node.path[parent.len()..];
                assert_eq!(
                    rest.chars().next(),
                    Some(sep),
                    "{} must join its parent with {sep:?}",
                    node.path
                );
                assert!(!rest[1..].contains(sep), "{} is not a DIRECT child of {}", node.path, parent);
                assert!(node.path.ends_with(&node.name), "a node's path ends with its name");
                if let Some(children) = node.children.as_ref() {
                    walk(&node.path, children, sep);
                }
            }
        }
        walk(root.to_string_lossy().as_ref(), &nodes, sep);

        let _ = fs::remove_dir_all(&root);
    }

    /// What the Explorer is told about links: a link to a folder still opens
    /// as a folder and shows what is in it, under the link's own path, and
    /// every link says it is one, so a delete of it can be worded for a link.
    #[cfg(unix)]
    #[test]
    fn links_are_reported_as_links_and_a_folder_link_still_opens_as_a_folder() {
        let root = build_tree("links");
        std::os::unix::fs::symlink("src", root.join("shared")).unwrap();
        std::os::unix::fs::symlink("package.json", root.join("alias.json")).unwrap();
        std::os::unix::fs::symlink("gone", root.join("dangling")).unwrap();
        let nodes = read_dir_hierarchy(&root.to_string_lossy(), Some(5)).unwrap();

        let shared = child(&nodes, "shared");
        assert!(shared.is_dir && shared.is_symlink);
        let inside = shared.children.as_ref().expect("a folder link lists its folder");
        let index = child(inside, "index.js");
        assert_eq!(Path::new(&index.path), root.join("shared").join("index.js"), "under the link's own path");
        assert!(!index.is_symlink, "what is inside a linked folder is not itself a link");

        let alias = child(&nodes, "alias.json");
        assert!(!alias.is_dir && alias.is_symlink);
        let dangling = child(&nodes, "dangling");
        assert!(!dangling.is_dir && dangling.is_symlink, "a link to nothing is still listed, as a link");

        let src = child(&nodes, "src");
        assert!(src.is_dir && !src.is_symlink, "the real folder is not a link");
        assert!(!child(&nodes, "package.json").is_symlink);

        let _ = fs::remove_dir_all(&root);
    }

    /// A link back up the tree used to be followed for as many levels as the
    /// caller asked for, repeating the whole listing under it at every level.
    #[cfg(unix)]
    #[test]
    fn a_link_back_up_the_tree_is_listed_but_not_followed() {
        let root = build_tree("loop");
        std::os::unix::fs::symlink(".", root.join("here")).unwrap();
        std::os::unix::fs::symlink("..", root.join("src").join("up")).unwrap();
        let nodes = read_dir_hierarchy(&root.to_string_lossy(), Some(5)).unwrap();

        let here = child(&nodes, "here");
        assert!(here.is_dir, "a link to a folder still shows as a folder");
        assert_eq!(here.children.as_ref().map(Vec::len), Some(0), "but the loop is not walked");

        let src = child(&nodes, "src");
        let up = child(src.children.as_ref().unwrap(), "up");
        assert!(up.is_dir);
        assert_eq!(up.children.as_ref().map(Vec::len), Some(0), "nor one two levels down");

        let _ = fs::remove_dir_all(&root);
    }

    /// Write the real payload out for the JS half of this contract to read.
    /// Runs on every platform, so on the Windows job the file the JS suite
    /// picks up was produced by a Windows filesystem.
    #[test]
    fn dump_a_real_listing_for_the_frontend_contract_test() {
        let root = build_tree("dump");
        let nodes = read_dir_hierarchy(&root.to_string_lossy(), Some(5)).unwrap();

        let payload = serde_json::json!({
            "platform": std::env::consts::OS,
            "separator": std::path::MAIN_SEPARATOR.to_string(),
            "root": root.to_string_lossy(),
            "nodes": nodes,
        });

        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests")
            .join("fixtures");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("backend-tree.json"), serde_json::to_string_pretty(&payload).unwrap())
            .unwrap();

        let _ = fs::remove_dir_all(&root);
    }
}
