//! Saved scrollback: what each terminal printed, kept on disk so that the
//! session restored at the next start shows it again (stage 6). The page
//! makes and reads the files' text (src/lib/scrollbackSnapshot.js); this
//! module only keeps them, through the `scrollback_*` commands
//! (commands/scrollback.rs).
//!
//! **Where.** `scrollback` in the app's LOCAL data folder
//! (`app_local_data_dir`): `%LOCALAPPDATA%\com.nexterm.ide` on Windows, never
//! the roaming `%APPDATA%`, because a roaming profile is copied to a server
//! and back at every sign-out and sign-in, and up to TOTAL_MAX_BYTES of
//! terminal output has no business travelling with it. On macOS and Linux it
//! is what Tauri gives (`~/Library/Application Support/com.nexterm.ide`,
//! `$XDG_DATA_HOME/com.nexterm.ide`). On unix the folder is made 0700 and
//! every file 0600: the output holds whatever `env` or `cat .env` printed,
//! and the page masks only the secrets that look like secrets. On macOS the
//! folder is kept out of Time Machine when it is made
//! (`exclude_from_backups`): a backup would keep every terminal's output long
//! after Clear Saved Scrollback, or the setting turned off, deleted it here.
//!
//! **Opaque text.** The page writes the whole file, its header included, and
//! checks all of it when it reads it back: the header, and every escape
//! sequence, before any of it reaches a terminal. Nothing here parses it.
//! What is checked here is what keeps a file from being a way into anything
//! else: its name, its folder, its size, that it is UTF-8.
//!
//! **Names are not paths.** A file is only ever named after a tab id of one
//! of two shapes (`is_tab_id`) — `tab-term-` and a counter, or the
//! `tab-term-<ms>-<n>` of the builds before v0.1.2, which a layout restored
//! ever since still carries — and its path is built here, in this folder.
//! Anything else is refused before the disk is touched: `..`, a separator,
//! NUL, a digit of another script, an overlong id.
//!
//! **Links.** The app data folder's own entry and `scrollback` are each
//! looked at themselves (`symlink_metadata`) before anything in them is, and
//! either being a link (on Windows any reparse point, a junction included)
//! refuses every command: through one, a write, a delete or a sweep would act
//! on some other folder. A saved file that is a link is not read either, and
//! that check holds whatever happens meanwhile: it is asked of the open
//! handle (`read_small_file`). The folders' check does not: it is a look and
//! then a use by path, and a link swapped in between the two is followed —
//! std has no `openat`. Only someone who can rename entries in the user's own
//! app data folder can swap one in, which is the user's own programs (they
//! reach the files directly anyway) or root; nobody else can write there. So
//! the gap is described here rather than closed with descriptor-relative
//! calls on unix and a second scheme on Windows. The folders above the app's
//! own are the user's profile, and are not this module's to judge.
//!
//! **A write replaces the whole file or nothing — short of a power cut.** The
//! text goes to a temporary file beside it and is renamed over the old one,
//! so the app crashing, being killed or running out of disk mid-write leaves
//! the previous save, never half of one. It is not flushed to the disk first:
//! a terminal that prints slowly is saved every second or so, and on macOS a
//! flush (`sync_all`) is an F_FULLFSYNC of the drive's own cache, every time.
//! So after a power cut or a kernel panic a file may be empty or hold
//! garbage, and the page skips it — its first line and header are checked —
//! and that terminal comes back without its old output. A write that fails
//! removes its temporary file; one left by a crash is swept at the next start
//! (`retain_only`).
//!
//! **Caps.** MAX_FILE_BYTES a file, refused on write and not read past; and
//! TOTAL_MAX_BYTES in all, enforced after every write by deleting the least
//! recently written files first, never the one just written.
//!
//! **One at a time.** Every operation holds LOCK from its first look at the
//! folder to its last change, so a delete or a sweep from one IPC call never
//! lands between another's temporary file and its rename.
//!
//! **One NexTerm at a time.** Two copies of the app running at once would
//! share the folder (on Windows, starting the program twice gives two): the
//! second one's start would delete the first's files, since `retain_only`
//! keeps only the tabs it restored itself, and their saves of the same tab
//! would overwrite each other's. So the first to use the folder locks
//! INSTANCE_LOCK beside it (`File::try_lock`: flock on unix, LockFileEx on
//! Windows) and keeps it locked for as long as it runs (`claim`). The system
//! lets the lock go when the process ends, crashed or not.
//!
//! What a process finds at its first use is its answer for as long as it
//! runs. A copy refused the lock is refused every command after, with
//! ANOTHER_INSTANCE, and a read says nothing is saved — even once the first
//! copy has quit. Taking the folder over then would be worse than having
//! none: the saves refused meanwhile are never made again, its quiet tabs
//! would leave the first copy's files under the same tab ids, and the next
//! start would show one terminal's output in another. A lock file that cannot
//! be used (a link, no regular file, an open that fails) is the same: refused
//! for good, and logged once, when that is found.
//!
//! **A read never stops a start.** Whatever is wrong with a saved file — a
//! link, no regular file, too large, not UTF-8, unreadable — the read says
//! "nothing saved" and logs why. Only a name that is not a tab id, which only
//! a bug in the page sends, is an error.

use std::fs::{self, Metadata};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use parking_lot::Mutex;

use crate::fs::{read_small_file, SmallFileError};

/// The folder, in the app's local data folder, that holds the files.
pub const DIR: &str = "scrollback";

/// What a tab id is followed by to name its file.
pub const EXTENSION: &str = ".scrollback";

/// The most one file may hold: 2 MiB of UTF-8, its header included — the
/// page serializes a terminal in time proportional to it, on every save.
/// Mirrors `MAX_FILE_BYTES` in src/lib/scrollbackSnapshot.js, which cuts the
/// oldest lines to fit, and the browser mock's in src/lib/ipc.js.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// The most all of the files may hold together: 50 MiB, two dozen terminals
/// at the per-file cap. Mirrored by the browser mock.
pub const TOTAL_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The file, beside the folder, that the running NexTerm keeping the folder
/// holds locked (`claim`). Not in the folder: nothing there is any sweep's.
const INSTANCE_LOCK: &str = ".scrollback.lock";

/// Why every command is refused, for as long as this process runs, when
/// another running NexTerm held the folder's lock at this one's first use.
/// One sentence, always the same: the page may tell it apart by its start,
/// "Another NexTerm is using the saved scrollback".
pub const ANOTHER_INSTANCE: &str =
    "Another NexTerm is using the saved scrollback; this one saves and restores none until it is started again";

/// What every tab id starts with (src/stores/terminalStore.js, `makeTabId`).
const ID_PREFIX: &str = "tab-term-";

/// The most digits a tab id has after its prefix: a counter that would need
/// a billion terminals opened to grow past it.
const MAX_ID_DIGITS: usize = 9;

/// The builds before v0.1.2 made ids as `tab-term-<Date.now()>-<n>` (13
/// digits until the year 2286) with `n` the tab count from 1, and a restore
/// keeps a saved id as it is — so a layout from then still has them.
const LEGACY_MS_DIGITS: usize = 13;
const LEGACY_INDEX_DIGITS: usize = 4;

/// Held by every operation for all of it. See the module's doc.
static LOCK: Mutex<()> = Mutex::new(());

/// What this process found at its first `claim` of each app data folder —
/// one in the app, one a test — and keeps as its answer until it ends.
static CLAIMS: Mutex<Vec<(PathBuf, Claim)>> = Mutex::new(Vec::new());

/// A folder's answer for the life of the process.
enum Claim {
    /// Ours: INSTANCE_LOCK held open, and so locked, until the process ends.
    Kept { _held: fs::File },
    /// Not ours, and never will be: why, as every command is told.
    Refused(String),
}

/// How many lines this module has logged about each app data folder (`log`)
/// — one entry in the app, one a test — so that the tests can tell "once"
/// from "every time".
static LOGGED: Mutex<Vec<(PathBuf, u64)>> = Mutex::new(Vec::new());

/// Log `line` about the scrollback in `base`, and count it.
fn log(base: &Path, line: &str) {
    eprintln!("[NexTerm] {line}");
    let mut logged = LOGGED.lock();
    match logged.iter_mut().find(|(folder, _)| folder == base) {
        Some((_, count)) => *count += 1,
        None => logged.push((base.to_path_buf(), 1)),
    }
}

/// Makes each temporary file's name its own within this process.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Whether `id` is a terminal tab's id, and so may name a file:
/// `^tab-term-[1-9][0-9]{0,8}$`, or the old `^tab-term-[1-9][0-9]{12}-[1-9][0-9]{0,3}$`
/// (see `LEGACY_MS_DIGITS`). Looked at byte by byte: every byte after the
/// prefix is an ASCII digit or that one hyphen, so a digit of another script
/// (which `char::is_numeric` would let through), a separator, a dot or a NUL
/// is not.
pub fn is_tab_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix(ID_PREFIX) else {
        return false;
    };
    // One to `max` ASCII digits, the first not a zero.
    let number = |digits: &[u8], max: usize| {
        (1..=max).contains(&digits.len()) && digits[0] != b'0' && digits.iter().all(u8::is_ascii_digit)
    };
    let rest = rest.as_bytes();
    match rest.iter().position(|&b| b == b'-') {
        None => number(rest, MAX_ID_DIGITS),
        Some(dash) => {
            rest[..dash].len() == LEGACY_MS_DIGITS
                && number(&rest[..dash], LEGACY_MS_DIGITS)
                && number(&rest[dash + 1..], LEGACY_INDEX_DIGITS)
        }
    }
}

/// The file name for `tab_id`, or the refusal every command gives.
fn file_name(tab_id: &str) -> Result<String, String> {
    if is_tab_id(tab_id) {
        Ok(format!("{tab_id}{EXTENSION}"))
    } else {
        Err(format!("Not a terminal tab's id: {}", shown(tab_id)))
    }
}

/// `text` for a message: quoted with its control characters escaped, and
/// cut short. It came from the page, and could be anything of any length.
fn shown(text: &str) -> String {
    const MOST: usize = 40;
    let cut: String = text.chars().take(MOST).collect();
    if cut.len() < text.len() {
        format!("{cut:?}\u{2026}")
    } else {
        format!("{cut:?}")
    }
}

/// The tab id a name in the folder is the saved file of, if it is one.
fn saved_id(name: &str) -> Option<&str> {
    name.strip_suffix(EXTENSION).filter(|id| is_tab_id(id))
}

/// Whether `name` is one of this module's temporary files:
/// `.<tab id>.scrollback.<pid>-<n>.tmp` (`new_temp`). Only these are ever
/// swept as temporary; any other `.tmp` in the folder is not ours.
fn is_our_temp(name: &str) -> bool {
    let Some(inner) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")) else {
        return false;
    };
    let Some((id, unique)) = inner.split_once(".scrollback.") else {
        return false;
    };
    is_tab_id(id) && !unique.is_empty() && unique.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Whether the entry `meta` describes — from `symlink_metadata`, never
/// followed — is one that is not looked through: a symbolic link, and on
/// Windows any reparse point at all. The local app data folder is not one a
/// sync client keeps, so unlike `fs::project_commands` no cloud placeholder
/// is let through; a junction or a mount point is a link to anywhere.
fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// The folder in `base` (the app's local data folder) when it is there, or
/// `None` when it, or `base`, is not: nothing has been saved. Each of the
/// two is looked at itself and refused when it is a link or not a folder.
fn existing_folder(base: &Path) -> Result<Option<PathBuf>, String> {
    if !is_folder(base, Make::Never)? {
        return Ok(None);
    }
    let dir = base.join(DIR);
    Ok(is_folder(&dir, Make::Never)?.then_some(dir))
}

/// The folder in `base`, made when it is not there yet — `base` with its
/// parents as any folder, the folder itself for the owner alone — and made
/// the owner's alone again (unix) if something loosened it.
fn made_folder(base: &Path) -> Result<PathBuf, String> {
    is_folder(base, Make::Plain)?;
    let dir = base.join(DIR);
    is_folder(&dir, Make::Private)?;
    Ok(dir)
}

/// Whether, and how, `is_folder` makes a folder that is not there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Make {
    Never,
    /// With its parents, as the platform makes any folder: the app's data
    /// folder, which holds more than this.
    Plain,
    /// This folder alone, its parent there already, for the owner alone.
    Private,
}

/// Whether `path` is a folder, looked at itself, never through a link: false
/// when nothing is there and `make` is `Never`; refused when it is a link or
/// not a folder.
fn is_folder(path: &Path, make: Make) -> Result<bool, String> {
    let looked_at = |e: std::io::Error| format!("{} could not be looked at: {e}", path.display());
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound && make == Make::Never => return Ok(false),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            make_folder(path, make).map_err(|e| format!("{} could not be made: {e}", path.display()))?;
            // Looked at again rather than trusted: something else may have
            // put a link there first (AlreadyExists is taken as made).
            fs::symlink_metadata(path).map_err(looked_at)?
        }
        Err(e) => return Err(looked_at(e)),
    };
    if is_link(&meta) {
        return Err(format!("{} is a link \u{2014} NexTerm keeps no scrollback through it", path.display()));
    }
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    #[cfg(unix)]
    if make == Make::Private {
        keep_private(path, &meta)?;
    }
    Ok(true)
}

fn make_folder(path: &Path, make: Make) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    if make == Make::Private {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
    } else {
        builder.recursive(true);
    }
    match builder.create(path) {
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
        Ok(()) => {
            #[cfg(target_os = "macos")]
            if make == Make::Private {
                if let Err(why) = exclude_from_backups(path) {
                    eprintln!("[NexTerm] The saved scrollback could not be kept out of Time Machine: {why}");
                }
            }
            Ok(())
        }
    }
}

/// Keep `folder` out of Time Machine, the documented way: NSURL's
/// `NSURLIsExcludedFromBackupKey`, which marks the folder itself — it stays
/// excluded wherever it moves — rather than adding its path to Time
/// Machine's own list, which needs an administrator. Best effort: a folder
/// that could not be marked is used all the same.
#[cfg(target_os = "macos")]
fn exclude_from_backups(folder: &Path) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    // From a blocking-pool thread, which has no pool of its own for what
    // Foundation autoreleases.
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&folder.to_string_lossy()));
        let yes = NSNumber::numberWithBool(true);
        let value: &AnyObject = &yes;
        // SAFETY: the key's value is documented to be an NSNumber holding a
        // BOOL, which `value` is; the key is Foundation's own constant.
        unsafe { url.setResourceValue_forKey_error(Some(value), NSURLIsExcludedFromBackupKey) }
            .map_err(|e| e.localizedDescription().to_string())
    })
}

/// The folder for the owner alone again, when anything else may reach it.
/// After it was looked at itself, so a link put there would have been
/// refused already.
#[cfg(unix)]
fn keep_private(path: &Path, meta: &Metadata) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o077 == 0 {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("{} could not be made private: {e}", path.display()))
}

/// Whether this process is the one running NexTerm that keeps the
/// scrollback in `base` (see the module's doc). Called once the folder is
/// there and has been looked at. The first call decides, and every later one
/// is a look at CLAIMS: kept for good, or refused for good.
fn claim(base: &Path) -> Result<(), String> {
    let mut claims = CLAIMS.lock();
    if let Some((_, answer)) = claims.iter().find(|(folder, _)| folder == base) {
        return match answer {
            Claim::Kept { .. } => Ok(()),
            Claim::Refused(why) => Err(why.clone()),
        };
    }
    let answer = match lock_instance(base) {
        Ok(file) => Claim::Kept { _held: file },
        Err(why) => {
            // Said once, here, for the life of the process: every command
            // after is refused without a word (`read` included), and the
            // page stops asking after a few refusals in a row.
            log(base, &format!("No scrollback is saved or restored until NexTerm is started again: {why}"));
            Claim::Refused(why)
        }
    };
    let result = match &answer {
        Claim::Kept { .. } => Ok(()),
        Claim::Refused(why) => Err(why.clone()),
    };
    claims.push((base.to_path_buf(), answer));
    result
}

/// INSTANCE_LOCK in `base`, opened — never through a link — and locked, or
/// why not: ANOTHER_INSTANCE when another process holds it.
fn lock_instance(base: &Path) -> Result<fs::File, String> {
    let path = base.join(INSTANCE_LOCK);
    if fs::symlink_metadata(&path).is_ok_and(|meta| is_link(&meta)) {
        return Err(format!("{} is a link \u{2014} NexTerm does not follow it", path.display()));
    }
    let failed = |e: std::io::Error| format!("{} could not be locked: {e}", path.display());
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(failed)?;
    if !file.metadata().map_err(failed)?.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => Err(ANOTHER_INSTANCE.to_string()),
        Err(fs::TryLockError::Error(e)) => Err(failed(e)),
    }
}

/// Save `content` as `tab_id`'s scrollback in `base`, the app's local data
/// folder, replacing what was saved before; then keep the folder under
/// TOTAL_MAX_BYTES.
///
/// Refused, with nothing changed, for a name that is not a tab id and for
/// more than MAX_FILE_BYTES — String's length is its UTF-8 bytes, which is
/// what the file holds.
pub fn write(base: &Path, tab_id: &str, content: &str) -> Result<(), String> {
    write_within(base, tab_id, content, TOTAL_MAX_BYTES)
}

/// `write`, with the total cap handed in so that the tests need not write
/// 50 MiB to reach it.
fn write_within(base: &Path, tab_id: &str, content: &str, total_max: u64) -> Result<(), String> {
    let name = file_name(tab_id)?;
    let size = content.len() as u64;
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "The scrollback of {tab_id} is {size} bytes; at most {MAX_FILE_BYTES} are saved"
        ));
    }
    let _one_at_a_time = LOCK.lock();
    let dir = made_folder(base)?;
    claim(base)?;
    let temp = write_temp(&dir, tab_id, content.as_bytes())?;
    // std::fs::rename replaces `to` when it is there, on every platform (its
    // documentation's first line). On unix that is rename(2), atomic. On
    // Windows it is SetFileInformationByHandle(FileRenameInfoEx) with
    // FILE_RENAME_FLAG_REPLACE_IF_EXISTS where the volume has it, else
    // MoveFileExW with MOVEFILE_REPLACE_EXISTING: the old file is replaced,
    // not refused. It does fail while another program holds the old one open
    // without FILE_SHARE_DELETE (a scanner, briefly); this write then fails,
    // the old save stays, and the page's next save tries again.
    if let Err(e) = fs::rename(&temp, dir.join(&name)) {
        let _ = fs::remove_file(&temp);
        return Err(format!("The scrollback of {tab_id} could not be saved: {e}"));
    }
    keep_under(&dir, &name, total_max);
    Ok(())
}

/// `bytes` in a new temporary file in `dir`, removed again when anything
/// fails. Written, not flushed to the disk: see the module's doc for why, and
/// for what a power cut can then leave.
fn write_temp(dir: &Path, tab_id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let (temp, mut file) = new_temp(dir, tab_id)?;
    let written = file.write_all(bytes);
    // Closed before the rename: Windows renames an open file only when every
    // handle on it allows it.
    drop(file);
    match written {
        Ok(()) => Ok(temp),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(format!("The scrollback of {tab_id} could not be saved: {e}"))
        }
    }
}

/// A new, empty file in `dir` that nothing else has: `create_new`, so a name
/// that is taken — a leftover of an earlier run with the same process id —
/// is passed over rather than written through, link or not. On unix for the
/// owner alone, which the rename keeps.
fn new_temp(dir: &Path, tab_id: &str) -> Result<(PathBuf, fs::File), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    for _ in 0..100 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{tab_id}{EXTENSION}.{}-{n}.tmp", std::process::id()));
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("The scrollback of {tab_id} could not be saved: {e}")),
        }
    }
    Err(format!("The scrollback of {tab_id} could not be saved: no free temporary name"))
}

/// Delete the least recently written files in `dir` until all of them come
/// to `total_max` or less — never `written`, the one just saved, even when it
/// alone is over: it is the newest output there is.
///
/// Only regular files named as ours count, and only those go. A file that
/// cannot be deleted is logged and passed over: the write it follows has
/// succeeded, and the next one tries again.
fn keep_under(dir: &Path, written: &str, total_max: u64) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("[NexTerm] Could not look through the saved scrollback to keep it under its cap: {e}");
            return;
        }
    };
    let mut total: u64 = 0;
    let mut others: Vec<(SystemTime, String, u64)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if saved_id(name).is_none() {
            continue;
        }
        // The entry itself: `DirEntry::metadata` does not follow a link
        // (lstat on unix, the directory listing's own data on Windows).
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        total = total.saturating_add(meta.len());
        if name != written {
            let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            others.push((at, name.to_string(), meta.len()));
        }
    }
    if total <= total_max {
        return;
    }
    // Oldest first; the name only orders two written in the same instant.
    others.sort();
    for (_, name, len) in others {
        if total <= total_max {
            break;
        }
        match fs::remove_file(dir.join(&name)) {
            Ok(()) => total = total.saturating_sub(len),
            Err(e) if e.kind() == ErrorKind::NotFound => total = total.saturating_sub(len),
            Err(e) => eprintln!("[NexTerm] Could not delete {name} to keep the saved scrollback under its cap: {e}"),
        }
    }
}

/// `tab_id`'s saved scrollback in `base`, or `None` when there is none to
/// restore. See the module's doc: nothing about the file is an error.
pub fn read(base: &Path, tab_id: &str) -> Result<Option<String>, String> {
    let name = file_name(tab_id)?;
    let _one_at_a_time = LOCK.lock();
    let dir = match existing_folder(base) {
        Ok(Some(dir)) => dir,
        Ok(None) => return Ok(None),
        Err(why) => {
            not_restored(base, tab_id, &why);
            return Ok(None);
        }
    };
    // Refused for good: `claim` said why when it found out, once, and a
    // line per tab at every start would say it again for nothing.
    if claim(base).is_err() {
        return Ok(None);
    }
    let path = dir.join(&name);
    match look_at(&path) {
        Look::Missing => return Ok(None),
        Look::Refused(why) => {
            not_restored(base, tab_id, &why);
            return Ok(None);
        }
        Look::File => {}
    }
    match read_saved(&path) {
        Ok(text) => Ok(text),
        Err(why) => {
            not_restored(base, tab_id, &why);
            Ok(None)
        }
    }
}

/// What a saved file's own entry is, looked at before it is opened.
#[derive(Debug, PartialEq, Eq)]
enum Look {
    Missing,
    File,
    Refused(String),
}

/// The entry at `path` itself: missing, a regular file, or something not to
/// be opened — a link (any reparse point on Windows, which `read_saved`'s
/// open would not tell from a file), a folder, a FIFO, a device.
fn look_at(path: &Path) -> Look {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => Look::Missing,
        Err(e) => Look::Refused(format!("it could not be looked at: {e}")),
        Ok(meta) if is_link(&meta) => Look::Refused("it is a link".to_string()),
        Ok(meta) if !meta.is_file() => Look::Refused("it is not a regular file".to_string()),
        Ok(_) => Look::File,
    }
}

/// The text of the saved file at `path`, `None` when it has gone since it
/// was looked at, or why it is not read. Opened not following a link, and
/// asked of the open handle, never of the path (`read_small_file`): a file
/// swapped for a link or a FIFO after `look_at` is refused all the same, and
/// one that grows while it is read is read no further than the cap.
fn read_saved(path: &Path) -> Result<Option<String>, String> {
    let bytes = match read_small_file(path, false, MAX_FILE_BYTES) {
        Ok(bytes) => bytes,
        Err(SmallFileError::NotFound) => return Ok(None),
        Err(SmallFileError::NotAFile) => return Err("it is not a regular file".to_string()),
        Err(SmallFileError::TooLarge) => return Err(format!("it is larger than {MAX_FILE_BYTES} bytes")),
        Err(SmallFileError::Io(e)) => return Err(format!("it could not be read: {e}")),
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "it is not UTF-8 text".to_string())
}

fn not_restored(base: &Path, tab_id: &str, why: &str) {
    log(base, &format!("The saved scrollback of {tab_id} is not restored: {why}"));
}

/// Delete `tab_id`'s saved scrollback in `base`. Nothing saved is fine.
pub fn delete(base: &Path, tab_id: &str) -> Result<(), String> {
    let name = file_name(tab_id)?;
    let _one_at_a_time = LOCK.lock();
    let Some(dir) = existing_folder(base)? else {
        return Ok(());
    };
    claim(base)?;
    remove_ours(&dir.join(&name))
        .map(drop)
        .map_err(|e| format!("The saved scrollback of {tab_id} could not be deleted: {e}"))
}

/// Delete every saved file in `base` but those of `keep`, and every
/// temporary file a crash left. An id in `keep` that is not a tab id names
/// nothing, and is passed over. How many went.
///
/// What the page calls at its start with the tabs it restored: anything else
/// is a terminal that is gone.
pub fn retain_only(base: &Path, keep: &[String]) -> Result<u32, String> {
    let _one_at_a_time = LOCK.lock();
    let Some(dir) = existing_folder(base)? else {
        return Ok(0);
    };
    claim(base)?;
    sweep(&dir, |name| match saved_id(name) {
        Some(id) => !keep.iter().any(|kept| kept == id),
        None => is_our_temp(name),
    })
}

/// Delete every saved file in `base`, and every temporary file. How many
/// went.
pub fn clear(base: &Path) -> Result<u32, String> {
    let _one_at_a_time = LOCK.lock();
    let Some(dir) = existing_folder(base)? else {
        return Ok(0);
    };
    claim(base)?;
    sweep(&dir, |name| saved_id(name).is_some() || is_our_temp(name))
}

/// Remove each entry of `dir` whose name `doomed` picks — only ever one
/// named as ours; anything else in the folder is somebody else's. Every one
/// is tried; the first failure is the answer, with how many went.
fn sweep(dir: &Path, doomed: impl Fn(&str) -> bool) -> Result<u32, String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("The saved scrollback could not be looked through: {e}"))?;
    let mut removed: u32 = 0;
    let mut failed: Option<String> = None;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                failed.get_or_insert_with(|| format!("the folder could not be read: {e}"));
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !doomed(name) {
            continue;
        }
        match remove_ours(&dir.join(name)) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(e) => {
                failed.get_or_insert_with(|| format!("{name} could not be deleted: {e}"));
            }
        }
    }
    match failed {
        None => Ok(removed),
        Some(why) => Err(format!("The saved scrollback was not all deleted ({removed} were): {why}")),
    }
}

/// Remove the entry at `path`, which bears one of our names: a file, or a
/// link as a link, never what it leads to. A real folder is left alone —
/// none is made here, so it is not ours. Whether anything went.
fn remove_ours(path: &Path) -> std::io::Result<bool> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let removed = if is_folder_link(&meta) {
        // Windows files a link to a folder (a directory symlink, a junction)
        // as a folder: DeleteFileW refuses it, and RemoveDirectoryW removes
        // the link and leaves the folder it leads to alone.
        fs::remove_dir(path)
    } else if meta.is_dir() {
        return Ok(false);
    } else {
        fs::remove_file(path)
    };
    match removed {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// A link Windows files as a folder: a directory symlink or a junction.
#[cfg(windows)]
fn is_folder_link(meta: &Metadata) -> bool {
    use std::os::windows::fs::FileTypeExt;
    meta.file_type().is_symlink_dir()
}

/// Unix has no such thing: a link to a folder is one entry like any other.
#[cfg(not(windows))]
fn is_folder_link(_: &Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A folder of its own for one test, removed when the test ends, however
    /// it ends. cargo runs tests in parallel, so every test has its own tag.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("nexterm-scrollback-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dunce::canonicalize(&dir).unwrap())
        }

        /// The app's local data folder, as Tauri would hand it in: not made
        /// yet, as on a first start.
        fn base(&self) -> PathBuf {
            self.0.join("com.nexterm.ide")
        }

        /// The folder the files are kept in.
        fn folder(&self) -> PathBuf {
            self.base().join(DIR)
        }
    }

    /// Forget `base`'s claim, and let go of its lock: the tests' folders are
    /// removed when each ends, which Windows refuses while a file in them is
    /// open.
    fn release(base: &Path) {
        CLAIMS.lock().retain(|(folder, _)| folder != base);
        LOGGED.lock().retain(|(folder, _)| folder != base);
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            release(&self.base());
            // Does not follow the links a test made: std removes each as a link.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The names in `dir`, sorted.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn temps_in(dir: &Path) -> Vec<String> {
        names_in(dir).into_iter().filter(|name| name.ends_with(".tmp")).collect()
    }

    fn set_written_at(path: &Path, at: SystemTime) {
        fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    }

    /// The good, and everything a page could send that is not.
    #[test]
    fn only_a_terminal_tab_id_names_a_file() {
        for good in [
            "tab-term-1",
            "tab-term-9",
            "tab-term-10",
            "tab-term-100",
            "tab-term-900000000",
            "tab-term-999999999",
            // The ids of builds before v0.1.2, which a restored layout keeps.
            "tab-term-1696512345678-2",
            "tab-term-1726000000000-1",
            "tab-term-9999999999999-9999",
        ] {
            assert!(is_tab_id(good), "{good}");
            assert_eq!(file_name(good).unwrap(), format!("{good}.scrollback"));
        }
        let overlong = format!("tab-term-{}", "9".repeat(10));
        let huge = format!("tab-term-1{}", "/..".repeat(10_000));
        let bad: Vec<&str> = vec![
            "",
            "tab-term-",
            "tab-term-0",
            "tab-term-01",
            "tab-term-007",
            &overlong,
            "tab-term-1234567890",
            "tab-term-1/../x",
            "tab-term-1/..",
            "tab-term-1\\..\\x",
            "../tab-term-1",
            "/tab-term-1",
            "tab-term-1/",
            "tab-term-\u{0661}",   // ARABIC-INDIC DIGIT ONE
            "tab-term-1\u{0661}",
            "tab-term-\u{ff11}",   // FULLWIDTH DIGIT ONE
            "tab-term-\u{00b9}",   // SUPERSCRIPT ONE
            "tab-term-\u{1d7cf}",  // MATHEMATICAL BOLD DIGIT ONE
            "tab-term-1\0",
            "\0tab-term-1",
            "tab-term-\01",
            "tab-term-1 ",
            " tab-term-1",
            "tab-term-1\n",
            "tab-term-1\r",
            "TAB-TERM-1",
            "Tab-term-1",
            "tab-term-+1",
            "tab-term--1",
            "tab-term-1.5",
            "tab-term-1e3",
            "tab-term-0x1",
            "tab-term-1.scrollback",
            "tab-term-1-2",
            "tab-term-169651234567-2",
            "tab-term-16965123456789-2",
            "tab-term-0696512345678-2",
            "tab-term-1696512345678-0",
            "tab-term-1696512345678-02",
            "tab-term-1696512345678-12345",
            "tab-term-1696512345678-",
            "tab-term-1696512345678--2",
            "tab-term-1696512345678-2-3",
            "tab-term--1696512345678",
            "tab-term-1696512345678-\u{0662}",
            "tab-term-1:stream",
            "group-1",
            "pane-1",
            &huge,
        ];
        for id in bad {
            assert!(!is_tab_id(id), "{id:?}");
            let refusal = file_name(id).unwrap_err();
            assert!(refusal.starts_with("Not a terminal tab's id: "), "{refusal}");
            assert!(refusal.chars().count() < 100, "an id from the page is shown cut short: {refusal}");
            assert!(!refusal.contains('\0') && !refusal.contains('\n'), "and escaped: {refusal:?}");
        }
    }

    /// A name that is not a tab id is refused by every command before the
    /// disk is touched: no folder is made, nothing is read or deleted.
    #[test]
    fn every_command_refuses_a_name_that_is_not_a_tab_id_before_touching_the_disk() {
        let scratch = Scratch::new("badname");
        let base = scratch.base();
        for id in ["../tab-term-1", "tab-term-0", "tab-term-1/../../x", "tab-term-\u{0661}"] {
            assert!(write(&base, id, "x").is_err(), "{id:?}");
            assert!(read(&base, id).is_err(), "{id:?}");
            assert!(delete(&base, id).is_err(), "{id:?}");
        }
        assert!(!base.exists(), "nothing was made");
    }

    #[test]
    fn what_is_written_is_read_back() {
        let scratch = Scratch::new("roundtrip");
        let base = scratch.base();
        assert_eq!(read(&base, "tab-term-1").unwrap(), None, "nothing saved yet");
        assert!(!base.exists(), "a read makes nothing");

        let text = "NEXTERM-SCROLLBACK 1\n{\"tabId\":\"tab-term-1\"}\n\u{1b}[1;38;2;1;2;3mbold\u{1b}[0m \u{d55c}\u{ae00} \u{1f600}\u{200d}\u{1f525}\r\nnext";
        write(&base, "tab-term-1", text).unwrap();
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some(text));
        assert_eq!(fs::read(scratch.folder().join("tab-term-1.scrollback")).unwrap(), text.as_bytes(), "the bytes, as they are");

        write(&base, "tab-term-2", "").unwrap();
        assert_eq!(read(&base, "tab-term-2").unwrap().as_deref(), Some(""), "an empty file is a file");
        assert_eq!(read(&base, "tab-term-3").unwrap(), None, "another tab's is not");
        assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback", "tab-term-2.scrollback"]);
    }

    /// The old file is replaced whole, and no temporary file is left —
    /// neither after a write, nor after one refused, nor after one whose
    /// rename failed.
    #[test]
    fn a_write_replaces_the_whole_file_and_leaves_no_temporary_behind() {
        let scratch = Scratch::new("atomic");
        let base = scratch.base();
        write(&base, "tab-term-1", &"old ".repeat(1000)).unwrap();
        write(&base, "tab-term-1", "new").unwrap();
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some("new"), "nothing of the longer old text is left");
        assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback"]);

        let over = "x".repeat(MAX_FILE_BYTES as usize + 1);
        assert!(write(&base, "tab-term-1", &over).is_err());
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some("new"), "a refused write changes nothing");
        assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback"]);

        // The name taken by a folder: the temporary file is written, and its
        // rename fails.
        fs::create_dir(scratch.folder().join("tab-term-2.scrollback")).unwrap();
        let failed = write(&base, "tab-term-2", "text").unwrap_err();
        assert!(failed.starts_with("The scrollback of tab-term-2 could not be saved: "), "{failed}");
        assert_eq!(temps_in(&scratch.folder()), Vec::<String>::new(), "the failed write's temporary file is gone");
        assert!(scratch.folder().join("tab-term-2.scrollback").is_dir(), "and the folder is left as it was");
    }

    /// 2 MiB of UTF-8 exactly is saved and read; a byte more is not, counted
    /// in bytes, not characters.
    #[test]
    fn a_file_may_hold_2_mib_of_utf8_and_no_more() {
        assert_eq!(MAX_FILE_BYTES, 2_097_152);
        let scratch = Scratch::new("filecap");
        let base = scratch.base();
        let at_cap = "a".repeat(MAX_FILE_BYTES as usize);
        write(&base, "tab-term-1", &at_cap).unwrap();
        assert_eq!(read(&base, "tab-term-1").unwrap().map(|text| text.len() as u64), Some(MAX_FILE_BYTES));

        let refused = write(&base, "tab-term-1", &"a".repeat(MAX_FILE_BYTES as usize + 1)).unwrap_err();
        assert_eq!(refused, "The scrollback of tab-term-1 is 2097153 bytes; at most 2097152 are saved");
        // 699 051 characters, three bytes each: 2 097 153 bytes.
        let hangul = "\u{d55c}".repeat(699_051);
        assert!((hangul.chars().count() as u64) < MAX_FILE_BYTES);
        assert!(write(&base, "tab-term-1", &hangul).is_err(), "fewer characters than the cap, more bytes");
        let fits = format!("{}aa", "\u{d55c}".repeat(699_050));
        assert_eq!(fits.len() as u64, MAX_FILE_BYTES);
        write(&base, "tab-term-1", &fits).unwrap();
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some(fits.as_str()));
    }

    /// Over the total, the least recently written go first — by the time
    /// each was last written, not by name or by when it was made — and the
    /// one just written never does, even when it alone is over. Only our
    /// own files count, and only they go.
    #[test]
    fn over_the_total_the_least_recently_written_go_first_never_the_one_just_written() {
        let scratch = Scratch::new("totalcap");
        let base = scratch.base();
        let hundred = "x".repeat(100);
        for id in ["tab-term-1", "tab-term-2", "tab-term-3", "tab-term-4"] {
            write(&base, id, &hundred).unwrap();
        }
        let folder = scratch.folder();
        fs::write(folder.join("notes.txt"), "y".repeat(10_000)).unwrap();
        fs::write(folder.join("tab-term-01.scrollback"), "y".repeat(10_000)).unwrap();
        let t0 = SystemTime::now() - Duration::from_secs(3600);
        set_written_at(&folder.join("tab-term-3.scrollback"), t0);
        set_written_at(&folder.join("tab-term-1.scrollback"), t0 + Duration::from_secs(10));
        set_written_at(&folder.join("tab-term-4.scrollback"), t0 + Duration::from_secs(20));
        set_written_at(&folder.join("tab-term-2.scrollback"), t0 + Duration::from_secs(30));
        set_written_at(&folder.join("notes.txt"), t0 - Duration::from_secs(3600));
        set_written_at(&folder.join("tab-term-01.scrollback"), t0 - Duration::from_secs(3600));

        // 500 bytes of ours against 350: the two oldest go, 3 and then 1.
        write_within(&base, "tab-term-5", &hundred, 350).unwrap();
        let ours = |names: Vec<String>| -> Vec<String> { names.into_iter().filter(|n| saved_id(n).is_some()).collect() };
        assert_eq!(ours(names_in(&folder)), ["tab-term-2.scrollback", "tab-term-4.scrollback", "tab-term-5.scrollback"]);

        // 600 against 350: 4, 2 and 5 (just written by the last call) go.
        write_within(&base, "tab-term-6", &"x".repeat(300), 350).unwrap();
        assert_eq!(ours(names_in(&folder)), ["tab-term-6.scrollback"]);

        // Alone over the cap: everything else goes, and it stays.
        write_within(&base, "tab-term-7", &"x".repeat(400), 350).unwrap();
        assert_eq!(ours(names_in(&folder)), ["tab-term-7.scrollback"]);
        assert_eq!(read(&base, "tab-term-7").unwrap().map(|t| t.len()), Some(400));

        // Rewritten, a file counts from its last write: 8 was the oldest of
        // the three, and after it is written again 9 and 7 are.
        write_within(&base, "tab-term-8", &hundred, 10_000).unwrap();
        write_within(&base, "tab-term-9", &hundred, 10_000).unwrap();
        set_written_at(&folder.join("tab-term-8.scrollback"), t0);
        set_written_at(&folder.join("tab-term-9.scrollback"), t0 + Duration::from_secs(1));
        set_written_at(&folder.join("tab-term-7.scrollback"), t0 + Duration::from_secs(2));
        write_within(&base, "tab-term-8", &hundred, 10_000).unwrap();
        // 700 against 500: 9, then 7.
        write_within(&base, "tab-term-10", &hundred, 500).unwrap();
        assert_eq!(ours(names_in(&folder)), ["tab-term-10.scrollback", "tab-term-8.scrollback"]);

        assert!(folder.join("notes.txt").is_file(), "a file not ours is never counted or deleted");
        assert!(folder.join("tab-term-01.scrollback").is_file(), "nor is one only named like ours");
        assert_eq!(TOTAL_MAX_BYTES, 52_428_800);
    }

    /// Whatever is wrong with a saved file, the read says "nothing saved".
    #[test]
    fn a_file_too_large_not_utf8_or_not_a_file_is_not_read() {
        let scratch = Scratch::new("refusals");
        let base = scratch.base();
        write(&base, "tab-term-1", "made the folder").unwrap();
        let folder = scratch.folder();

        fs::write(folder.join("tab-term-2.scrollback"), vec![b'a'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let before = logged(&base);
        assert_eq!(read(&base, "tab-term-2").unwrap(), None, "a byte over the cap");
        assert_eq!(read(&base, "tab-term-2").unwrap(), None);
        assert_eq!(logged(&base), before + 2, "a file not restored is said each time it is read: that is about one tab, not the folder");
        fs::write(folder.join("tab-term-2.scrollback"), vec![b'a'; MAX_FILE_BYTES as usize]).unwrap();
        assert!(read(&base, "tab-term-2").unwrap().is_some(), "premise: at the cap it is read");

        // A stray byte; UTF-16 with its mark; a surrogate spelled in UTF-8;
        // a sequence cut short at the end.
        for bytes in [&b"ok\xff"[..], b"\xff\xfeo\x00k\x00", b"\xed\xa0\x80", b"ok\xe2\x82"] {
            fs::write(folder.join("tab-term-3.scrollback"), bytes).unwrap();
            assert_eq!(read(&base, "tab-term-3").unwrap(), None, "{bytes:?}");
        }

        fs::create_dir(folder.join("tab-term-4.scrollback")).unwrap();
        assert_eq!(read(&base, "tab-term-4").unwrap(), None, "a folder named like a file");
        assert_eq!(look_at(&folder.join("tab-term-4.scrollback")), Look::Refused("it is not a regular file".into()));
        assert_eq!(read_saved(&folder.join("tab-term-4.scrollback")), Err("it is not a regular file".into()), "the open alone refuses it too");

        assert_eq!(read(&base, "tab-term-5").unwrap(), None, "missing");
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some("made the folder"), "and the good one still is");
    }

    /// A FIFO would hold an ordinary open until something wrote to it. The
    /// read runs on a thread with a deadline, so a wait fails here.
    #[cfg(unix)]
    #[test]
    fn a_fifo_named_like_a_file_is_not_read_and_does_not_hold_the_read() {
        use std::os::unix::ffi::OsStrExt;
        let scratch = Scratch::new("fifo");
        let base = scratch.base();
        write(&base, "tab-term-1", "x").unwrap();
        let fifo = scratch.folder().join("tab-term-2.scrollback");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "premise: a FIFO");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send((read(&base, "tab-term-2"), read_saved(&fifo)));
        });
        let (through_read, opened) = rx.recv_timeout(Duration::from_secs(5)).expect("the read is waiting on the FIFO");
        assert_eq!(through_read, Ok(None));
        assert_eq!(opened, Err("it is not a regular file".into()), "the open alone does not wait on it either");
    }

    /// A saved file that is a link is not read, wherever it leads — and each
    /// of the two looks refuses it alone: the one before the open, and the
    /// open itself, which is what stops a file swapped for a link between
    /// the two.
    #[cfg(unix)]
    #[test]
    fn a_saved_file_that_is_a_link_is_not_read() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("filelink");
        let base = scratch.base();
        write(&base, "tab-term-1", "x").unwrap();
        let secret = scratch.0.join("secret.txt");
        fs::write(&secret, "NEXTERM-SCROLLBACK 1\nsomebody else's").unwrap();
        let link = scratch.folder().join("tab-term-2.scrollback");
        for target in [secret.clone(), PathBuf::from("../../secret.txt"), scratch.0.join("missing")] {
            let _ = fs::remove_file(&link);
            symlink(&target, &link).unwrap();
            assert_eq!(read(&base, "tab-term-2").unwrap(), None, "-> {}", target.display());
            assert_eq!(look_at(&link), Look::Refused("it is a link".into()));
            assert_eq!(read_saved(&link), Err("it is not a regular file".into()), "O_NOFOLLOW refuses it as well");
        }
        assert!(fs::read_to_string(&link).is_err(), "premise: the last one leads nowhere");
        fs::remove_file(&link).unwrap();
        symlink(&secret, &link).unwrap();
        assert!(fs::read_to_string(&link).is_ok(), "premise: through the link there is a file");
        assert_eq!(read(&base, "tab-term-2").unwrap(), None);
    }

    /// The folder, or the app data folder above it, being a link refuses
    /// every command: nothing is read, written, deleted or swept through it.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_a_link_is_refused_by_every_command() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("dirlink");
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("tab-term-1.scrollback"), "somebody else's").unwrap();
        fs::write(elsewhere.join("tab-term-2.scrollback"), "somebody else's").unwrap();
        let untouched = |why: &str| {
            assert_eq!(names_in(&elsewhere), ["tab-term-1.scrollback", "tab-term-2.scrollback"], "{why}");
            assert_eq!(fs::read_to_string(elsewhere.join("tab-term-1.scrollback")).unwrap(), "somebody else's", "{why}");
        };

        // `scrollback` itself a link.
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        symlink(&elsewhere, base.join(DIR)).unwrap();
        assert_eq!(fs::read_to_string(base.join(DIR).join("tab-term-1.scrollback")).unwrap(), "somebody else's", "premise");
        assert_eq!(read(&base, "tab-term-1").unwrap(), None);
        let refusal = write(&base, "tab-term-1", "mine").unwrap_err();
        assert!(refusal.contains("is a link"), "{refusal}");
        assert!(delete(&base, "tab-term-1").is_err());
        assert!(retain_only(&base, &[]).is_err());
        assert!(clear(&base).is_err());
        untouched("through scrollback");

        // The app data folder a link, `scrollback` a real folder in what it
        // leads to.
        let real_base = scratch.0.join("real-base");
        fs::create_dir_all(&real_base).unwrap();
        fs::rename(&elsewhere, real_base.join(DIR)).unwrap();
        let linked_base = scratch.0.join("linked-base");
        symlink(&real_base, &linked_base).unwrap();
        assert_eq!(fs::read_to_string(linked_base.join(DIR).join("tab-term-1.scrollback")).unwrap(), "somebody else's", "premise");
        assert_eq!(read(&linked_base, "tab-term-1").unwrap(), None);
        assert!(write(&linked_base, "tab-term-1", "mine").is_err());
        assert!(delete(&linked_base, "tab-term-1").is_err());
        assert!(retain_only(&linked_base, &[]).is_err());
        assert!(clear(&linked_base).is_err());
        fs::rename(real_base.join(DIR), &elsewhere).unwrap();
        untouched("through the app data folder");

        // A file where the folder should be.
        let file_base = scratch.0.join("file-base");
        fs::create_dir_all(&file_base).unwrap();
        fs::write(file_base.join(DIR), "a file").unwrap();
        assert_eq!(read(&file_base, "tab-term-1").unwrap(), None);
        assert!(write(&file_base, "tab-term-1", "mine").unwrap_err().contains("is not a folder"));
    }

    /// Windows: a junction needs no privilege to make, and is a link to std.
    #[cfg(windows)]
    #[test]
    fn a_folder_that_is_a_junction_is_refused() {
        let scratch = Scratch::new("junction");
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("tab-term-1.scrollback"), "somebody else's").unwrap();
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        junction::create(&elsewhere, base.join(DIR)).unwrap();
        assert!(fs::read(base.join(DIR).join("tab-term-1.scrollback")).is_ok(), "premise: through the junction there is a file");
        assert_eq!(read(&base, "tab-term-1").unwrap(), None);
        assert!(write(&base, "tab-term-1", "mine").is_err());
        assert!(clear(&base).is_err());
        assert_eq!(fs::read_to_string(elsewhere.join("tab-term-1.scrollback")).unwrap(), "somebody else's");
    }

    #[test]
    fn delete_removes_one_tabs_file_and_nothing_saved_is_fine() {
        let scratch = Scratch::new("delete");
        let base = scratch.base();
        delete(&base, "tab-term-1").unwrap();
        assert!(!base.exists(), "a delete makes nothing");
        write(&base, "tab-term-1", "one").unwrap();
        write(&base, "tab-term-2", "two").unwrap();
        delete(&base, "tab-term-1").unwrap();
        assert_eq!(read(&base, "tab-term-1").unwrap(), None);
        assert_eq!(read(&base, "tab-term-2").unwrap().as_deref(), Some("two"));
        delete(&base, "tab-term-1").unwrap();
        fs::create_dir(scratch.folder().join("tab-term-3.scrollback")).unwrap();
        delete(&base, "tab-term-3").unwrap();
        assert!(scratch.folder().join("tab-term-3.scrollback").is_dir(), "a folder is not ours, and is left");
        assert_eq!(names_in(&scratch.folder()), ["tab-term-2.scrollback", "tab-term-3.scrollback"]);
    }

    /// A link with our name is removed as a link; what it leads to stays.
    #[cfg(unix)]
    #[test]
    fn a_link_with_our_name_is_deleted_as_a_link() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("deletelink");
        let base = scratch.base();
        write(&base, "tab-term-1", "x").unwrap();
        let target = scratch.0.join("target.txt");
        fs::write(&target, "kept").unwrap();
        symlink(&target, scratch.folder().join("tab-term-2.scrollback")).unwrap();
        symlink(&target, scratch.folder().join("tab-term-3.scrollback")).unwrap();
        delete(&base, "tab-term-2").unwrap();
        assert_eq!(retain_only(&base, &["tab-term-1".to_string()]).unwrap(), 1);
        assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback"]);
        assert_eq!(fs::read_to_string(&target).unwrap(), "kept");
    }

    /// At the start the page keeps the tabs it restored: every other saved
    /// file goes, and every temporary file a crash left. Nothing that is not
    /// named as ours is touched.
    #[test]
    fn retain_only_keeps_the_listed_tabs_and_removes_every_other_file_of_ours() {
        let scratch = Scratch::new("retain");
        let base = scratch.base();
        assert_eq!(retain_only(&base, &[]).unwrap(), 0, "nothing saved yet");
        assert!(!base.exists(), "and nothing made");
        for id in ["tab-term-1", "tab-term-2", "tab-term-3", "tab-term-4"] {
            write(&base, id, id).unwrap();
        }
        let folder = scratch.folder();
        let ours = [".tab-term-2.scrollback.123-0.tmp", ".tab-term-9.scrollback.77-3.tmp"];
        let foreign = [
            "notes.txt",
            "tab-term-01.scrollback",
            "tab-term-1.scrollback.bak",
            "tab-term-1.scrollback.tmp",
            ".hidden.tmp",
            "x.tmp",
            ".tab-term-1.scrollback.tmp",
            ".tab-term-1.scrollback.x.tmp",
            ".tab-term-0.scrollback.1-1.tmp",
            "TAB-TERM-5.scrollback",
        ];
        for name in ours.iter().chain(foreign.iter()) {
            fs::write(folder.join(name), "z").unwrap();
        }
        fs::create_dir(folder.join("tab-term-6.scrollback")).unwrap();
        for name in ours {
            assert!(is_our_temp(name), "{name}");
        }
        for name in foreign {
            assert!(!is_our_temp(name) && saved_id(name).is_none(), "{name}");
        }

        let keep: Vec<String> = ["tab-term-1", "tab-term-3", "../tab-term-2", "tab-term-2/", "", "tab-term-04", "notes.txt"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(retain_only(&base, &keep).unwrap(), 4, "2 and 4, and the two temporary files");
        let mut expected: Vec<String> = foreign.iter().map(|s| s.to_string()).collect();
        expected.extend(["tab-term-1.scrollback", "tab-term-3.scrollback", "tab-term-6.scrollback"].map(String::from));
        expected.sort();
        assert_eq!(names_in(&folder), expected);
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some("tab-term-1"));
        assert_eq!(read(&base, "tab-term-3").unwrap().as_deref(), Some("tab-term-3"));
        assert_eq!(retain_only(&base, &keep).unwrap(), 0, "again: nothing more to do");
    }

    #[test]
    fn clear_removes_every_file_of_ours_and_nothing_else() {
        let scratch = Scratch::new("clear");
        let base = scratch.base();
        assert_eq!(clear(&base).unwrap(), 0);
        write(&base, "tab-term-1", "1").unwrap();
        write(&base, "tab-term-2", "2").unwrap();
        let folder = scratch.folder();
        fs::write(folder.join(".tab-term-7.scrollback.5-5.tmp"), "z").unwrap();
        fs::write(folder.join("notes.txt"), "z").unwrap();
        assert_eq!(clear(&base).unwrap(), 3);
        assert_eq!(names_in(&folder), ["notes.txt"]);
        assert_eq!(clear(&base).unwrap(), 0);
    }

    /// The folder is the owner's alone, made so, kept so, and so is every
    /// file in it, a replaced one included.
    #[cfg(unix)]
    #[test]
    fn the_folder_and_its_files_are_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777;
        let scratch = Scratch::new("private");
        let base = scratch.base();
        write(&base, "tab-term-1", "x").unwrap();
        let folder = scratch.folder();
        let file = folder.join("tab-term-1.scrollback");
        assert_eq!(mode(&folder), 0o700);
        assert_eq!(mode(&file), 0o600);

        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        write(&base, "tab-term-1", "y").unwrap();
        assert_eq!(mode(&folder), 0o700, "a loosened folder is made private again");
        assert_eq!(mode(&file), 0o600, "the replacement is the owner's alone");

        // Made for the owner alone, not made open and closed a moment later:
        // nothing else may open it in between.
        let fresh = scratch.0.join("fresh");
        make_folder(&fresh, Make::Private).unwrap();
        assert_eq!(mode(&fresh), 0o700);
    }

    /// A sweep at a start (or a delete) from one IPC call and a write from
    /// another never meet halfway: without the lock, the sweep takes the
    /// write's temporary file for one a crash left, and the write's rename
    /// fails.
    #[test]
    fn a_sweep_never_lands_in_the_middle_of_a_write() {
        let scratch = Scratch::new("concurrent");
        let base = scratch.base();
        write(&base, "tab-term-1", "first").unwrap();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sweeper = {
            let (base, done) = (base.clone(), done.clone());
            std::thread::spawn(move || {
                let keep = vec!["tab-term-1".to_string()];
                let mut sweeps = 0u32;
                while !done.load(Ordering::SeqCst) {
                    retain_only(&base, &keep).unwrap();
                    sweeps += 1;
                }
                sweeps
            })
        };
        let content = "z".repeat(64 * 1024);
        let failures: Vec<String> = (0..40).filter_map(|_| write(&base, "tab-term-1", &content).err()).collect();
        done.store(true, Ordering::SeqCst);
        let sweeps = sweeper.join().unwrap();
        assert!(sweeps > 0, "premise: the sweeps ran alongside");
        assert_eq!(failures, Vec::<String>::new());
        assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback"]);
        assert_eq!(read(&base, "tab-term-1").unwrap().map(|t| t.len()), Some(content.len()));
    }

    /// A write is not flushed to the disk (see the module's doc): on macOS
    /// every flush is an F_FULLFSYNC, paid by each save of a terminal that
    /// prints slowly. Nothing runs that a test could time reliably, so the
    /// module's own code is read back for the calls.
    #[test]
    fn a_write_is_not_flushed_to_the_disk() {
        let src = include_str!("scrollback.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").or_else(|| src.find("#[cfg(test)]\r\nmod tests")).expect("the tests")];
        let code: String = code.lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for call in [concat!(".sync", "_all("), concat!(".sync", "_data(")] {
            assert!(!code.contains(call), "{call} is back in a write");
        }
    }

    /// How many lines have been logged about `base`.
    fn logged(base: &Path) -> u64 {
        LOGGED.lock().iter().find(|(folder, _)| folder == base).map_or(0, |(_, count)| *count)
    }

    fn lock_file_in(base: &Path) -> fs::File {
        fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(base.join(INSTANCE_LOCK)).unwrap()
    }

    /// While another running NexTerm holds the folder's lock at this one's
    /// first use, every command is refused with one sentence the page can
    /// tell apart, and a read says nothing is saved: its start must not sweep
    /// away the other's files, nor its saves overwrite them. And it stays so
    /// once the other quits — this one never takes the folder over — with
    /// the refusal logged once.
    #[test]
    fn a_nexterm_refused_the_folder_at_first_use_is_refused_until_it_ends() {
        assert!(ANOTHER_INSTANCE.starts_with("Another NexTerm is using the saved scrollback"));
        let scratch = Scratch::new("instance");
        let base = scratch.base();
        // The other: it made the folder, saved a tab, and holds the lock.
        fs::create_dir_all(base.join(DIR)).unwrap();
        fs::write(base.join(DIR).join("tab-term-1.scrollback"), "the other's").unwrap();
        let other = lock_file_in(&base);
        other.try_lock().expect("premise: nobody holds it yet");
        assert_eq!(logged(&base), 0, "premise");

        let refused_everything = |when: &str| {
            assert_eq!(write(&base, "tab-term-1", "mine").unwrap_err(), ANOTHER_INSTANCE, "{when}");
            assert_eq!(write(&base, "tab-term-2", "mine").unwrap_err(), ANOTHER_INSTANCE, "{when}");
            assert_eq!(read(&base, "tab-term-1").unwrap(), None, "{when}: the other's file is not restored here");
            for tab in ["tab-term-2", "tab-term-3", "tab-term-4", "tab-term-5"] {
                assert_eq!(read(&base, tab).unwrap(), None, "{when}: a start reads every tab it restores");
            }
            assert_eq!(delete(&base, "tab-term-1").unwrap_err(), ANOTHER_INSTANCE, "{when}");
            assert_eq!(retain_only(&base, &[]).unwrap_err(), ANOTHER_INSTANCE, "{when}: its start must not sweep the other's files");
            assert_eq!(clear(&base).unwrap_err(), ANOTHER_INSTANCE, "{when}");
            assert_eq!(names_in(&scratch.folder()), ["tab-term-1.scrollback"], "{when}: nothing written, deleted or left behind");
            assert_eq!(fs::read_to_string(scratch.folder().join("tab-term-1.scrollback")).unwrap(), "the other's", "{when}");
        };
        refused_everything("while the other runs");

        // The other quits.
        drop(other);
        refused_everything("after the other quit");
        let now_free = lock_file_in(&base);
        assert!(now_free.try_lock().is_ok(), "it never took the lock: a copy started now gets it");
        drop(now_free);
        assert_eq!(logged(&base), 1, "one line, when it was found: no command after it says anything, reads included");
    }

    /// The first NexTerm to use the folder keeps it for as long as it runs:
    /// a copy started later is the one refused.
    #[test]
    fn the_first_nexterm_to_use_the_folder_keeps_it_for_good() {
        let scratch = Scratch::new("kept");
        let base = scratch.base();
        write(&base, "tab-term-1", "mine").unwrap();
        assert!(matches!(lock_file_in(&base).try_lock(), Err(fs::TryLockError::WouldBlock)), "the lock is held");
        assert_eq!(read(&base, "tab-term-1").unwrap().as_deref(), Some("mine"));
        assert!(matches!(lock_file_in(&base).try_lock(), Err(fs::TryLockError::WouldBlock)), "and still held");
        assert!(!names_in(&scratch.folder()).iter().any(|name| name.contains("lock")), "the lock file is not in the folder");
    }

    /// A lock file that is a link is not followed, and refuses the folder for
    /// good — even once it is a plain file again — logged once.
    #[cfg(unix)]
    #[test]
    fn a_lock_file_that_is_a_link_refuses_the_folder_for_good() {
        let scratch = Scratch::new("locklink");
        let base = scratch.base();
        fs::create_dir_all(base.join(DIR)).unwrap();
        let target = scratch.0.join("elsewhere.lock");
        fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, base.join(INSTANCE_LOCK)).unwrap();
        assert_eq!(logged(&base), 0, "premise");
        let said = format!("{} is a link \u{2014} NexTerm does not follow it", base.join(INSTANCE_LOCK).display());
        assert_eq!(write(&base, "tab-term-1", "x").unwrap_err(), said);
        for tab in ["tab-term-1", "tab-term-2", "tab-term-3"] {
            assert_eq!(read(&base, tab).unwrap(), None);
        }
        assert_eq!(names_in(&scratch.folder()), Vec::<String>::new());
        assert!(fs::File::open(&target).unwrap().try_lock().is_ok(), "the link's target was not locked through it");

        fs::remove_file(base.join(INSTANCE_LOCK)).unwrap();
        fs::write(base.join(INSTANCE_LOCK), "").unwrap();
        assert_eq!(write(&base, "tab-term-1", "x").unwrap_err(), said, "refused for the life of the process");
        assert_eq!(retain_only(&base, &[]).unwrap_err(), said);
        assert_eq!(read(&base, "tab-term-1").unwrap(), None);
        assert_eq!(logged(&base), 1, "one line, when it was found: no command after it says anything, reads included");
    }

    /// macOS: the folder is made excluded from Time Machine — the mark on
    /// the folder itself, read back through a URL of its own (an NSURL keeps
    /// what it read, so the one that set it would say so either way).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_folder_is_kept_out_of_time_machine() {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
        let excluded = |path: &Path| -> bool {
            objc2::rc::autoreleasepool(|_| {
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                let mut value: Option<Retained<AnyObject>> = None;
                // SAFETY: the key's value is an NSNumber, read as one below.
                unsafe { url.getResourceValue_forKey_error(&mut value, NSURLIsExcludedFromBackupKey) }.unwrap();
                value.and_then(|v| v.downcast::<NSNumber>().ok()).is_some_and(|n| n.boolValue())
            })
        };
        let scratch = Scratch::new("timemachine");
        let base = scratch.base();
        write(&base, "tab-term-1", "x").unwrap();
        assert!(excluded(&scratch.folder()), "the folder it made");
        assert!(!excluded(&base), "only that folder: the app data folder holds more than this");
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        assert!(!excluded(&elsewhere), "premise: a folder is not excluded by being made here");
    }
}
