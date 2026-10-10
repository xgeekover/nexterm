//! The Explorer's delete, to the Trash — the Recycle Bin on Windows — rather
//! than for good (VS Code's `files.enableTrash`, the `filesEnableTrash`
//! setting). `fs_delete_path` with `trash: true` comes here, after the same
//! confinement as a permanent delete (`commands::fs::entry_to_delete`).
//!
//! The `trash` crate does the moving, and how it does it is the point:
//!
//! - It resolves only the folder an entry is in and keeps the entry's own name
//!   (`canonicalize_paths`), so on macOS a link goes to the Trash as a link
//!   and what it points at stays. Checked with NSFileManager on scratch APFS
//!   and FAT32 volumes (2026-10-10): a link to a folder, one to a file, one to
//!   nothing and a folder named `\..` each went as themselves.
//! - Everywhere else a link is never handed to the system at all, but
//!   removed as a link (`LINKS_GO_TO_BIN`, which says why).
//! - macOS: `NSFileManager trashItemAtURL`, chosen below
//!   (`DeleteMethod::NsFileManager`). The crate's default asks Finder through
//!   AppleScript, which needs the Automation permission (a system prompt the
//!   first time) and plays Finder's sound. A volume with no trash makes
//!   NSFileManager fail; it never deletes instead.
//! - Windows: `IFileOperation::DeleteItem` with
//!   `FOF_NO_UI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING` (trash 5.2.9,
//!   `src/windows.rs`). FOF_NO_UI includes FOF_NOCONFIRMATION — "Yes to All"
//!   — so wherever the shell would not recycle it deletes PERMANENTLY, without
//!   a word: a drive with no Recycle Bin (a network or mapped drive, a USB
//!   stick, a CD, a RAM disk, a `subst` drive, one whose Recycle Bin is turned
//!   off) and an item bigger than the Recycle Bin can hold — Total Commander
//!   lost 160 GB that way until it read the bin's size from the registry
//!   first (its forum, t=80734). "Is it still there?" after the move cannot
//!   tell: the entry is gone either way. So all of it is decided BEFORE the
//!   shell is asked anything (`recycle_bin::takes`), and anything that cannot
//!   be found out counts as "no"; the Explorer then asks about a permanent
//!   delete.
//! - Linux and the BSDs: the freedesktop.org trash — the home trash, or the
//!   volume's own `.Trash-$uid` (copied to the home trash when that cannot
//!   be made).
//!
//! Every failure of the move itself begins "Not moved to the Trash: " (or
//! "…Recycle Bin: "), so the Explorer can tell it from every other refusal
//! — outside the folder, on another machine, already gone — and offer a
//! permanent delete for it, and only for it (`trashFailureReason` in
//! src/components/explorer/treeRows.js). And after a move that reports
//! success the entry must be gone from where it was, or that is a failure
//! too.
//!
//! The crate runs on a thread of its own. On Windows it initializes COM for
//! the calling thread and panics when that thread already has COM in another
//! mode, and it unwraps `CoCreateInstance`: a new thread has no COM state, and
//! a panic there is a failure to report, not a command that never answers.

use std::fmt::Display;
use std::fs;
use std::path::Path;

/// What the bin is called on this platform, as the Explorer names it.
pub const BIN: &str = if cfg!(windows) { "Recycle Bin" } else { "Trash" };

/// What a drive without a Recycle Bin is refused with, ahead of the reason.
pub const NO_RECYCLE_BIN: &str = "No Recycle Bin on this drive";

/// A failure of the move: "Not moved to the Trash: <reason>".
pub fn not_moved(reason: impl Display) -> String {
    format!("Not moved to the {BIN}: {reason}")
}

/// Whether a link goes to the bin as the link it is here, or is removed as
/// a link instead and never handed to the system.
///
/// macOS takes a link as itself (checked; see above). Windows and Linux are
/// not trusted with one:
///
/// - Windows: whether the Recycle Bin can take an entry is decided from the
///   volume its path is on, and `GetVolumePathNameW` follows "the entire
///   chain" of links to answer — an `E:\proj\cache` junction (a USB stick,
///   no bin) into C: would be judged as C:, and the shell then deletes it
///   permanently. Nor is it certain what the shell does to what a link
///   leads to.
/// - Linux: trash 5.2.9 loops for ever moving a link to a folder across
///   devices (freedesktop.rs: a placeholder file is made where the item
///   goes, `create_dir_all` then finds it there, AlreadyExists, `continue`).
///
/// Nor is a link removed instead, when the Trash was asked for: the
/// question said the entry could be restored, and a removed link cannot. The
/// Explorer asks about a link as a link on these platforms
/// (`deletesToTrash`), so a link reaches the Trash path only when it was
/// listed as something else — a folder that has become a junction since —
/// and then the move fails (`LINK_NOT_MOVED`) and the Explorer asks about a
/// permanent delete, which removes it as a link: what it points at stays.
pub const LINKS_GO_TO_BIN: bool = cfg!(target_os = "macos");

/// Why a link is not moved to the bin where `LINKS_GO_TO_BIN` is false. The
/// Explorer reads its first words (`It is a link`) to ask about the link as
/// a link.
pub fn link_not_moved() -> String {
    format!("It is a link — a link is removed, not moved to the {BIN}")
}

/// Move `path` — the entry itself, already confined — to the bin by `mover`:
/// `move_to_bin` in the app, a stand-in in the tests. A link is the link, as
/// `symlink_metadata` sees it (a junction and a directory symlink included),
/// and goes as `LINKS_GO_TO_BIN` says.
pub fn trash_path(path: &Path, recursive: bool, mover: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    trash_entry(path, recursive, mover, LINKS_GO_TO_BIN)
}

/// `trash_path`, with the platform's rule about links handed in, so the
/// suites can hold both rules on any platform.
///
/// What `delete_path` refuses is refused here too: an entry that is not
/// there, and a folder with something in it when the delete was not asked to
/// take its contents.
pub fn trash_entry(
    path: &Path,
    recursive: bool,
    mover: impl FnOnce(&Path) -> Result<(), String>,
    links_go_to_bin: bool,
) -> Result<(), String> {
    let shown = path.to_string_lossy();
    let file_type = path
        .symlink_metadata()
        .map_err(|_| format!("Path does not exist: {shown}"))?
        .file_type();
    if file_type.is_symlink() && !links_go_to_bin {
        // Never handed to the system, and not removed either: see
        // `LINKS_GO_TO_BIN`. Nothing is touched.
        return Err(not_moved(link_not_moved()));
    }
    if file_type.is_dir() && !recursive && fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(format!("Failed to delete directory '{shown}': it is not empty"));
    }
    mover(path)?;
    // The bin said it took the entry. It has to be gone from here for that to
    // be true; a move that left it behind is a move that did not happen.
    if path.symlink_metadata().is_ok() {
        return Err(not_moved(format!("'{shown}' is still there")));
    }
    Ok(())
}

/// Move `path` to this platform's bin — refused first, on Windows, unless
/// the Recycle Bin is certain to take it (`recycle_bin::takes`).
pub fn move_to_bin(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if let Err(why) = os::recycle_bin_for(path) {
        return Err(not_moved(why));
    }
    let owned = path.to_path_buf();
    std::thread::Builder::new()
        .name("nexterm-trash".into())
        .spawn(move || system_trash(&owned))
        .map_err(|e| not_moved(format!("could not start: {e}")))?
        .join()
        .unwrap_or_else(|_| Err(not_moved("the system's trash call failed")))
}

fn system_trash(path: &Path) -> Result<(), String> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut context = ::trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use ::trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|e| not_moved(describe(&e)))
}

/// The crate's error in words; its `Display` is its `Debug`.
fn describe(error: &::trash::Error) -> String {
    match error {
        ::trash::Error::Os { description, .. } | ::trash::Error::Unknown { description } => description.clone(),
        ::trash::Error::TargetedRoot => "it is the root of a drive".to_string(),
        ::trash::Error::CouldNotAccess { target } => format!("{target} could not be reached"),
        ::trash::Error::CanonicalizePath { original } => format!("{} could not be resolved", original.display()),
        other => format!("{other:?}"),
    }
}

/// Whether Windows' Recycle Bin will take an entry — decided from facts, so
/// it is the same function, and tested, on every platform. Only Windows asks
/// it (`os::recycle_bin_for`, which gathers the facts).
pub mod recycle_bin {
    #![cfg_attr(not(windows), allow(dead_code))]

    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::NO_RECYCLE_BIN;

    /// The drive types `GetDriveTypeW` answers with, written out here;
    /// checked against windows-sys's own constants on Windows. UNKNOWN and
    /// NO_ROOT_DIR are named for the tests: `takes` reads every type it does
    /// not name as one it cannot tell.
    pub mod drive {
        #![allow(dead_code)]
        pub const UNKNOWN: u32 = 0;
        pub const NO_ROOT_DIR: u32 = 1;
        pub const REMOVABLE: u32 = 2;
        pub const FIXED: u32 = 3;
        pub const REMOTE: u32 = 4;
        pub const CDROM: u32 = 5;
        pub const RAMDISK: u32 = 6;
    }

    /// The share of a volume Windows gives its Recycle Bin when nothing says
    /// otherwise — taken low on purpose: a bin thought smaller than it is
    /// costs a question, one thought bigger costs the files.
    pub const DEFAULT_PERCENT: u32 = 5;

    /// How full the bin may be made by one item: past this share of what it
    /// holds, the item is not given to it.
    pub const MARGIN_PERCENT: u64 = 90;

    /// Everything `takes` decides from.
    #[derive(Clone, Debug)]
    pub struct Facts {
        /// `GetDriveTypeW` of the folder the entry's volume is mounted at.
        pub kind: u32,
        /// Whether that folder is a volume's own mount point. A drive letter
        /// made by `subst` is not: it is a folder of another drive, reported
        /// as that drive's type, and Explorer deletes from it permanently.
        pub own_volume: bool,
        /// Whether the Recycle Bin is turned off — for the volume ("Don't move
        /// files to the Recycle Bin" in its Properties), for the known folder
        /// the entry is in, or for every drive by policy. None when that could
        /// not be read.
        pub turned_off: Option<bool>,
        /// How much the Recycle Bin can hold for this entry, in bytes (see
        /// `capacity`). None when that could not be found out.
        pub capacity: Option<u64>,
        /// What the entry takes on disk, as the bin counts it
        /// (`size_on_disk`), or why it could not be measured.
        pub size: Result<u64, String>,
    }

    /// Whether the Recycle Bin will take the entry: `Ok`, or the reason it
    /// will not, which the Explorer shows with its question about a
    /// permanent delete.
    ///
    /// Only a fixed drive that is a volume of its own, with its Recycle Bin
    /// known to be on, room in it known, and the entry measured at no more
    /// than MARGIN_PERCENT of that room, takes it. Every answer that could
    /// not be found out counts as no: being asked about a permanent delete
    /// that would not have been is a click, and the opposite mistake is a
    /// folder gone for good.
    pub fn takes(facts: &Facts) -> Result<(), String> {
        let no_bin = |why: &str| Err(format!("{NO_RECYCLE_BIN} — {why}"));
        match facts.kind {
            drive::FIXED => {}
            drive::REMOTE => return no_bin("it is a network drive"),
            drive::REMOVABLE => return no_bin("it is a removable drive"),
            drive::CDROM => return no_bin("it is a CD or DVD drive"),
            drive::RAMDISK => return no_bin("it is a RAM disk"),
            _ => return no_bin("what kind of drive it is could not be told"),
        }
        if !facts.own_volume {
            return no_bin("it is a folder of another drive, as a drive made by subst is");
        }
        match facts.turned_off {
            Some(false) => {}
            Some(true) => return no_bin("its Recycle Bin is turned off"),
            None => return no_bin("whether its Recycle Bin is on could not be read"),
        }
        let Some(capacity) = facts.capacity else {
            return Err("How much the Recycle Bin can hold could not be read".to_string());
        };
        let size = match &facts.size {
            Ok(size) => *size,
            Err(why) => return Err(why.clone()),
        };
        if u128::from(size) * 100 > u128::from(capacity) * u128::from(MARGIN_PERCENT) {
            return Err(format!(
                "Too big for the Recycle Bin — {} on disk, and the Recycle Bin holds {}",
                shown(size),
                shown(capacity)
            ));
        }
        Ok(())
    }

    /// How much the Recycle Bin holds, in bytes: the volume's own setting
    /// (`MaxCapacity`, in MB) when there is one, else `percent` (the old
    /// global setting, `Percent`), else DEFAULT_PERCENT — and never more than
    /// the "Maximum allowed Recycle Bin size" policy's share, when that is
    /// set. None when the answer needs the volume's sizes and they are not
    /// known.
    ///
    /// A share is taken of the SMALLER of the volume's size and its free
    /// space: accounts of Windows' default disagree on which of the two its
    /// 5% is of, and a guess bigger than the real bin is the one mistake
    /// that loses files.
    pub fn capacity(
        max_capacity_mb: Option<u32>,
        percent: Option<u32>,
        policy_percent: Option<u32>,
        volume_total: Option<u64>,
        volume_free: Option<u64>,
    ) -> Option<u64> {
        let base = match (volume_total, volume_free) {
            (Some(total), Some(free)) => Some(total.min(free)),
            _ => None,
        };
        let share = |p: u32| base.map(|of| (u128::from(of) * u128::from(p.min(100)) / 100) as u64);
        let own = match (max_capacity_mb, percent) {
            (Some(mb), _) => Some(u64::from(mb).saturating_mul(1024 * 1024)),
            (None, Some(p)) => share(p),
            (None, None) => share(DEFAULT_PERCENT),
        }?;
        match policy_percent {
            Some(p) => share(p).map(|cap| own.min(cap)),
            None => Some(own),
        }
    }

    /// A registry value as read: `Ok(None)` when the key or the value is not
    /// there, `Ok(Some(v))` its value, `Err` when it is there and could not
    /// be read (access denied, another type).
    pub type Setting = Result<Option<u32>, ()>;

    /// Whether the bin is turned off, by `NukeOnDelete` as read. Not there is
    /// Windows' own default — on: a volume NexTerm alone has ever deleted on
    /// has no key at all, and must not be asked about a permanent delete
    /// every time for that. There and unreadable is not known — and then the
    /// bin is taken to be off (`takes`).
    pub fn turned_off_by(nuke_on_delete: Setting) -> Option<bool> {
        match nuke_on_delete {
            Ok(value) => Some(value.is_some_and(|v| v != 0)),
            Err(()) => None,
        }
    }

    /// `capacity`, from the settings as read: one not there falls back as
    /// `capacity` says; one there and unreadable makes the room unknown.
    pub fn room(
        max_capacity_mb: Setting,
        percent: Setting,
        policy_percent: Setting,
        volume_total: Option<u64>,
        volume_free: Option<u64>,
    ) -> Option<u64> {
        capacity(max_capacity_mb.ok()?, percent.ok()?, policy_percent.ok()?, volume_total, volume_free)
    }

    /// How far `size_on_disk` goes before it gives up, and says which.
    pub struct WalkLimits {
        pub entries: u64,
        pub time: Duration,
    }

    impl Default for WalkLimits {
        fn default() -> Self {
            WalkLimits { entries: 500_000, time: Duration::from_secs(5) }
        }
    }

    /// The least a file is counted as taking: 4 KiB, NTFS's cluster on most
    /// volumes. A volume with bigger clusters (exFAT, ReFS, a big NTFS
    /// volume — 64 KiB and more) counts its own.
    pub const MIN_CLUSTER: u64 = 4096;

    /// What `path` takes on disk, every file rounded up to a whole cluster of
    /// `cluster` bytes (never less than MIN_CLUSTER): the entry and, for a
    /// folder, everything in it. Links are counted as themselves and never
    /// followed (`symlink_metadata`), so nothing outside the entry is
    /// measured, and no loop of links goes round for ever.
    ///
    /// An error when anything in it cannot be read, or when the walk passes
    /// `limits` — saying which. Entries are counted as they are found, so a
    /// folder of millions is given up on at the limit, not after listing all
    /// of it. A size not known is never taken for a small one.
    pub fn size_on_disk(path: &Path, cluster: u64, limits: &WalkLimits) -> Result<u64, String> {
        measure(path, cluster, limits, &mut |dir: &Path| {
            Ok(Box::new(fs::read_dir(dir)?.map(|entry| entry.map(|e| e.path()))) as Listing)
        })
    }

    /// A folder's entries, one at a time, as `measure` pulls them.
    type Listing = Box<dyn Iterator<Item = std::io::Result<PathBuf>>>;

    /// `size_on_disk`, with the folder listing handed in — so the suites can
    /// see how much of a listing the walk pulls before it gives up.
    fn measure(
        path: &Path,
        cluster: u64,
        limits: &WalkLimits,
        list: &mut dyn FnMut(&Path) -> std::io::Result<Listing>,
    ) -> Result<u64, String> {
        let cluster = cluster.max(MIN_CLUSTER);
        let started = Instant::now();
        let too_many = || {
            format!(
                "It holds more than {} files and folders — too many to be sure the Recycle Bin can hold it",
                limits.entries
            )
        };
        let too_long = || {
            format!(
                "Measuring it took more than {} seconds — too long to be sure the Recycle Bin can hold it",
                limits.time.as_secs()
            )
        };
        let unreadable = |at: &Path, e: std::io::Error| format!("'{}' could not be measured: {e}", at.display());
        let mut pending: Vec<PathBuf> = vec![path.to_path_buf()];
        let mut total: u64 = 0;
        let mut found: u64 = 1;
        if found > limits.entries {
            return Err(too_many());
        }
        while let Some(next) = pending.pop() {
            if started.elapsed() >= limits.time {
                return Err(too_long());
            }
            let meta = fs::symlink_metadata(&next).map_err(|e| unreadable(&next, e))?;
            total = total.saturating_add(meta.len().div_ceil(cluster).saturating_mul(cluster));
            if meta.file_type().is_dir() {
                for entry in list(&next).map_err(|e| unreadable(&next, e))? {
                    let entry = entry.map_err(|e| unreadable(&next, e))?;
                    found += 1;
                    if found > limits.entries {
                        return Err(too_many());
                    }
                    if started.elapsed() >= limits.time {
                        return Err(too_long());
                    }
                    pending.push(entry);
                }
            }
        }
        Ok(total)
    }

    /// `bytes` as a person reads a size.
    pub fn shown(bytes: u64) -> String {
        const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
        let mut value = bytes as f64;
        let mut unit = 0;
        while value >= 1024.0 && unit < UNITS.len() - 1 {
            value /= 1024.0;
            unit += 1;
        }
        if unit == 0 {
            format!("{bytes} bytes")
        } else {
            format!("{value:.1} {}", UNITS[unit])
        }
    }

    /// `path` without the verbatim prefix: `\\?\UNC\host\share` is
    /// `\\host\share`, `\\?\C:\x` is `C:\x`.
    fn without_verbatim(path: &str) -> String {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }

    /// Whether `path` is `folder` or inside it, as Windows compares paths:
    /// case aside, either separator, a trailing one ignored, and the
    /// verbatim `\\?\` prefix spelled plain.
    pub fn under_folder(folder: &str, path: &str) -> bool {
        let plain = |p: &str| without_verbatim(&p.replace('/', "\\")).trim_end_matches('\\').to_lowercase();
        let (folder, path) = (plain(folder), plain(path));
        !folder.is_empty() && (path == folder || path.starts_with(&format!("{folder}\\")))
    }

    /// The `KnownFolder` key whose folder holds `entry`, the deepest when
    /// several do. Each candidate is `(key, folder)`, the folder resolved as
    /// the entry's own path is (links followed, 8.3 names long, no verbatim
    /// prefix) — or None when it could not be: the known folder is not there
    /// any more, and nothing deleted now can be in it. Such a key is skipped,
    /// never a reason to refuse every delete on the machine.
    pub fn known_folder_key(entry: &str, candidates: &[(String, Option<String>)]) -> Option<String> {
        candidates
            .iter()
            .filter_map(|(key, folder)| folder.as_ref().map(|folder| (key, folder)))
            .filter(|(_, folder)| under_folder(folder, entry))
            .max_by_key(|(_, folder)| without_verbatim(folder).trim_end_matches(['\\', '/']).len())
            .map(|(key, _)| key.clone())
    }

    /// A GUID in its registry spelling, `{6D809377-6AF0-444B-8957-A3773F02200E}`,
    /// as the number windows-sys's `GUID::from_u128` takes. None for anything
    /// else.
    pub fn parse_guid(text: &str) -> Option<u128> {
        let inner = text.strip_prefix('{')?.strip_suffix('}')?;
        let groups: Vec<&str> = inner.split('-').collect();
        let lengths: Vec<usize> = groups.iter().map(|g| g.len()).collect();
        if lengths != [8, 4, 4, 4, 12] || !groups.iter().all(|g| g.chars().all(|c| c.is_ascii_hexdigit())) {
            return None;
        }
        u128::from_str_radix(&groups.concat(), 16).ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const MB: u64 = 1024 * 1024;
        const GB: u64 = 1024 * MB;

        fn facts() -> Facts {
            Facts { kind: drive::FIXED, own_volume: true, turned_off: Some(false), capacity: Some(10 * GB), size: Ok(GB) }
        }

        #[test]
        fn a_fixed_volume_of_its_own_with_its_bin_on_and_room_takes_it() {
            assert_eq!(takes(&facts()), Ok(()));
        }

        #[test]
        fn a_drive_with_no_recycle_bin_never_takes_it() {
            for (kind, why) in [
                (drive::REMOTE, "network"),
                (drive::REMOVABLE, "removable"),
                (drive::CDROM, "CD"),
                (drive::RAMDISK, "RAM disk"),
                (drive::UNKNOWN, "could not be told"),
                (drive::NO_ROOT_DIR, "could not be told"),
                (77, "could not be told"),
            ] {
                let refused = takes(&Facts { kind, ..facts() }).unwrap_err();
                assert!(refused.starts_with(NO_RECYCLE_BIN) && refused.contains(why), "drive type {kind}: {refused}");
            }
            let subst = takes(&Facts { own_volume: false, ..facts() }).unwrap_err();
            assert!(subst.contains("subst"), "{subst}");
            let off = takes(&Facts { turned_off: Some(true), ..facts() }).unwrap_err();
            assert!(off.contains("turned off"), "{off}");
        }

        /// Review B5: a setting that could not be read used to count as "on".
        #[test]
        fn what_could_not_be_read_counts_as_no() {
            let unread = takes(&Facts { turned_off: None, ..facts() }).unwrap_err();
            assert!(unread.contains("could not be read"), "{unread}");
            let no_room = takes(&Facts { capacity: None, ..facts() }).unwrap_err();
            assert!(no_room.contains("could not be read"), "{no_room}");
            let unmeasured = takes(&Facts { size: Err("It could not be measured".into()), ..facts() }).unwrap_err();
            assert_eq!(unmeasured, "It could not be measured");
        }

        /// Review B1: an item bigger than the bin is deleted for good by a
        /// shell told not to ask. Past 90% of the room, it is not given.
        #[test]
        fn an_item_too_big_for_the_bin_is_never_given_to_it() {
            let room = 10 * GB;
            assert_eq!(takes(&Facts { size: Ok(room * 9 / 10), ..facts() }), Ok(()));
            let big = takes(&Facts { size: Ok(room * 9 / 10 + 1), ..facts() }).unwrap_err();
            assert!(big.starts_with("Too big for the Recycle Bin") && big.contains("10.0 GB"), "{big}");
            assert!(takes(&Facts { size: Ok(160 * GB), ..facts() }).is_err(), "Total Commander's 160 GB");
            // The drive is said first: a network drive is a network drive
            // whatever else could or could not be read.
            let both = takes(&Facts { kind: drive::REMOTE, turned_off: None, capacity: None, size: Ok(u64::MAX), own_volume: false }).unwrap_err();
            assert!(both.contains("network"), "{both}");
        }

        #[test]
        fn the_room_is_the_volume_setting_else_a_share_never_past_the_policy() {
            let (total, free) = (Some(200 * GB), Some(200 * GB));
            assert_eq!(capacity(Some(1024), None, None, total, free), Some(GB), "MaxCapacity, in MB");
            assert_eq!(capacity(None, None, None, total, free), Some(10 * GB), "5% when nothing says");
            assert_eq!(capacity(None, Some(10), None, total, free), Some(20 * GB), "the global Percent");
            assert_eq!(capacity(Some(50 * 1024), None, Some(10), total, free), Some(20 * GB), "the policy caps it");
            assert_eq!(capacity(Some(1024), None, Some(10), total, free), Some(GB), "a cap above the setting changes nothing");
            assert_eq!(capacity(None, None, None, None, None), None, "a share of an unknown volume is unknown");
            assert_eq!(capacity(Some(1024), None, Some(10), None, None), None, "and so is a cap of one");
            assert_eq!(capacity(Some(1024), None, None, None, None), Some(GB), "MaxCapacity needs no volume size");
            assert_eq!(capacity(None, Some(250), None, Some(MB), Some(MB)), Some(MB), "a share is never past the whole");
        }

        /// Second review, B5: whether Windows' 5% is of the drive or of its
        /// free space, accounts disagree — the guess is the smaller.
        #[test]
        fn a_share_is_of_the_smaller_of_the_volume_and_its_free_space() {
            assert_eq!(capacity(None, None, None, Some(200 * GB), Some(20 * GB)), Some(GB));
            assert_eq!(capacity(None, None, None, Some(20 * GB), Some(200 * GB)), Some(GB));
            assert_eq!(capacity(None, None, Some(10), Some(200 * GB), Some(20 * GB)), Some(GB), "the policy's share too");
            assert_eq!(capacity(None, None, None, Some(200 * GB), None), None, "free space not known: not known");
        }

        /// Second review, B5: a setting not there is Windows' default — the
        /// bin on, a share of the volume; one there and unreadable is not
        /// known, and counts as no bin.
        #[test]
        fn a_setting_not_there_is_windows_default_and_one_unreadable_is_unknown() {
            assert_eq!(turned_off_by(Ok(None)), Some(false), "no key, no value: on");
            assert_eq!(turned_off_by(Ok(Some(0))), Some(false));
            assert_eq!(turned_off_by(Ok(Some(1))), Some(true));
            assert_eq!(turned_off_by(Err(())), None);
            let (total, free) = (Some(200 * GB), Some(100 * GB));
            assert_eq!(room(Ok(None), Ok(None), Ok(None), total, free), Some(5 * GB), "5% of the free space");
            assert_eq!(room(Ok(Some(2048)), Ok(None), Ok(None), total, free), Some(2 * GB));
            assert_eq!(room(Err(()), Ok(None), Ok(None), total, free), None);
            assert_eq!(room(Ok(None), Ok(None), Err(()), total, free), None, "a policy that cannot be read");
            let fresh = Facts { turned_off: turned_off_by(Ok(None)), capacity: room(Ok(None), Ok(None), Ok(None), total, free), ..facts() };
            assert_eq!(takes(&fresh), Ok(()), "a volume with no key at all takes it");
            let unread = Facts { turned_off: turned_off_by(Err(())), ..facts() };
            assert!(takes(&unread).is_err());
        }

        fn scratch(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("nexterm-bin-size-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn a_folder_is_measured_in_clusters_with_everything_in_it() {
            let dir = scratch("sum");
            fs::create_dir_all(dir.join("sub")).unwrap();
            fs::write(dir.join("one.txt"), b"x").unwrap();
            fs::write(dir.join("sub").join("big.bin"), vec![0u8; 5000]).unwrap();
            let folders = fs::symlink_metadata(&dir).unwrap().len().div_ceil(MIN_CLUSTER) * MIN_CLUSTER
                + fs::symlink_metadata(dir.join("sub")).unwrap().len().div_ceil(MIN_CLUSTER) * MIN_CLUSTER;
            let size = size_on_disk(&dir, MIN_CLUSTER, &WalkLimits::default()).unwrap();
            assert_eq!(size, folders + MIN_CLUSTER + 2 * MIN_CLUSTER, "1 byte is a cluster, 5000 bytes two");
            let _ = fs::remove_dir_all(&dir);
        }

        #[cfg(unix)]
        #[test]
        fn a_link_is_measured_as_itself_and_never_followed() {
            let dir = scratch("link");
            let outside = scratch("link-outside");
            fs::write(outside.join("huge.bin"), vec![0u8; 4 * 1024 * 1024]).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("to-folder")).unwrap();
            std::os::unix::fs::symlink(dir.join("."), dir.join("loop")).unwrap();
            let size = size_on_disk(&dir, MIN_CLUSTER, &WalkLimits::default()).unwrap();
            assert!(size < 1024 * 1024, "measured what the link leads to: {size}");
            let _ = fs::remove_dir_all(&dir);
            let _ = fs::remove_dir_all(&outside);
        }

        #[test]
        fn a_walk_past_its_limits_says_which_and_is_never_a_size() {
            let dir = scratch("limits");
            for i in 0..5 {
                fs::write(dir.join(format!("{i}.txt")), b"x").unwrap();
            }
            let many = size_on_disk(&dir, MIN_CLUSTER, &WalkLimits { entries: 3, time: Duration::from_secs(60) }).unwrap_err();
            assert!(many.contains("more than 3 files and folders"), "{many}");
            let slow = size_on_disk(&dir, MIN_CLUSTER, &WalkLimits { entries: 1000, time: Duration::ZERO }).unwrap_err();
            assert!(slow.contains("seconds"), "{slow}");
            let gone = size_on_disk(&dir.join("not-there"), MIN_CLUSTER, &WalkLimits::default()).unwrap_err();
            assert!(gone.contains("could not be measured"), "{gone}");
            let _ = fs::remove_dir_all(&dir);
        }

        /// Second review, N4: on a volume of 64 KiB clusters (exFAT, ReFS, a
        /// big NTFS volume) a 1-byte file takes 64 KiB, and counted as 4 KiB
        /// the measure fell short of what the bin would need.
        #[test]
        fn a_file_is_counted_in_the_volumes_own_clusters_never_less_than_4_kib() {
            let dir = scratch("clusters");
            let file = dir.join("one.txt");
            fs::write(&file, b"x").unwrap();
            assert_eq!(size_on_disk(&file, 64 * 1024, &WalkLimits::default()).unwrap(), 64 * 1024);
            assert_eq!(size_on_disk(&file, 512, &WalkLimits::default()).unwrap(), MIN_CLUSTER, "never under 4 KiB");
            fs::write(&file, vec![0u8; 70 * 1024]).unwrap();
            assert_eq!(size_on_disk(&file, 64 * 1024, &WalkLimits::default()).unwrap(), 128 * 1024);
            let _ = fs::remove_dir_all(&dir);
        }

        /// Second review, N3: entries were counted as they were taken off the
        /// stack, so one folder of millions was listed whole before the limit
        /// was looked at. They are counted as they are found.
        #[test]
        fn a_huge_folder_is_given_up_on_at_the_limit_not_after_listing_it() {
            let dir = scratch("huge");
            let pulled = std::rc::Rc::new(std::cell::Cell::new(0u64));
            let counter = pulled.clone();
            let mut list = |_: &Path| -> std::io::Result<Listing> {
                let counter = counter.clone();
                Ok(Box::new((0..1_000_000u64).map(move |i| {
                    counter.set(counter.get() + 1);
                    Ok(PathBuf::from(format!("/nexterm-not-there/{i}")))
                })))
            };
            let err = measure(&dir, MIN_CLUSTER, &WalkLimits { entries: 10, time: Duration::from_secs(60) }, &mut list).unwrap_err();
            assert!(err.contains("more than 10 files and folders"), "{err}");
            assert!(pulled.get() <= 10, "listed {} entries before giving up", pulled.get());
            let _ = fs::remove_dir_all(&dir);
        }

        #[cfg(unix)]
        #[test]
        fn a_folder_that_cannot_be_read_is_not_measured() {
            use std::os::unix::fs::PermissionsExt;
            let dir = scratch("unreadable");
            let locked = dir.join("locked");
            fs::create_dir_all(&locked).unwrap();
            fs::write(locked.join("a.txt"), b"a").unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
            // Root reads it anyway; there is nothing to check then.
            if fs::read_dir(&locked).is_err() {
                let err = size_on_disk(&dir, MIN_CLUSTER, &WalkLimits::default()).unwrap_err();
                assert!(err.contains("could not be measured"), "{err}");
            }
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            let _ = fs::remove_dir_all(&dir);
        }

        /// Second review, N5: the known folder's path and the entry's are
        /// compared as resolved, the verbatim prefix spelled plain; a key
        /// whose folder cannot be resolved is skipped, never a reason to
        /// refuse every delete.
        #[test]
        fn a_known_folder_key_is_the_deepest_resolved_folder_holding_the_entry() {
            let key = |k: &str, folder: Option<&str>| (k.to_string(), folder.map(str::to_string));
            let candidates = vec![
                key("Docs", Some(r"\\?\C:\Users\me\Documents")),
                key("Stale", None),
                key("Projects", Some(r"C:\Users\me\Documents\Projects")),
                key("Share", Some(r"\\?\UNC\host\share\me")),
            ];
            assert_eq!(known_folder_key(r"C:\Users\me\Documents\a.txt", &candidates).as_deref(), Some("Docs"));
            assert_eq!(known_folder_key(r"C:\Users\me\Documents\Projects\x", &candidates).as_deref(), Some("Projects"));
            assert_eq!(known_folder_key(r"\\host\share\me\b.txt", &candidates).as_deref(), Some("Share"));
            assert_eq!(known_folder_key(r"D:\elsewhere\c.txt", &candidates), None);
            assert_eq!(known_folder_key(r"C:\a.txt", &[key("Stale", None)]), None, "a stale key is skipped");
            // And Windows resolves each known folder before asking.
            let src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("fs").join("trash.rs")).unwrap();
            // Split so this line is not what is found.
            let body = &src[src.find(concat!("fn settings_", "key(guid")).expect("settings_key")..];
            let body = &body[..body.find("\n    }\n").or_else(|| body.find("\r\n    }\r\n")).expect("its end")];
            assert!(
                body.contains(".and_then(|folder| dunce::canonicalize(folder).ok())"),
                "each known folder is resolved as the entry's path was"
            );
            assert!(body.contains("known_folder_key(&path.to_string_lossy(), &candidates)"));
        }

        #[test]
        fn a_known_folder_holds_what_is_under_it_as_windows_compares() {
            assert!(under_folder(r"C:\Users\me\Documents", r"c:\users\ME\documents\notes.txt"));
            assert!(under_folder(r"\\?\C:\Users\me\Documents", r"C:\Users\me\Documents\notes.txt"));
            assert!(under_folder(r"C:\Users\me\Documents", r"\\?\C:\Users\me\Documents\notes.txt"));
            assert!(under_folder(r"C:\Users\me\Documents\", r"C:\Users\me\Documents"));
            assert!(under_folder(r"\\host\share\docs", "//host/share/docs/a"));
            assert!(!under_folder(r"C:\Users\me\Documents", r"C:\Users\me\Documents2\a"));
            assert!(!under_folder("", r"C:\a"));
        }

        #[test]
        fn a_guid_is_read_in_its_registry_spelling() {
            assert_eq!(
                parse_guid("{6D809377-6AF0-444B-8957-A3773F02200E}"),
                Some(0x6D809377_6AF0_444B_8957_A3773F02200E)
            );
            for bad in ["6D809377-6AF0-444B-8957-A3773F02200E", "{6D809377-6AF0-444B-8957-A3773F02200}", "{6D809377-6AF0-444B-8957-A3773F02200G}", "{}"] {
                assert_eq!(parse_guid(bad), None, "{bad}");
            }
        }

        #[cfg(windows)]
        #[test]
        fn the_drive_types_are_windows_own() {
            use windows_sys::Win32::System::WindowsProgramming as w;
            assert_eq!(
                [drive::UNKNOWN, drive::NO_ROOT_DIR, drive::REMOVABLE, drive::FIXED, drive::REMOTE, drive::CDROM, drive::RAMDISK],
                [w::DRIVE_UNKNOWN, w::DRIVE_NO_ROOT_DIR, w::DRIVE_REMOVABLE, w::DRIVE_FIXED, w::DRIVE_REMOTE, w::DRIVE_CDROM, w::DRIVE_RAMDISK]
            );
        }
    }
}

#[cfg(windows)]
mod os {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::core::{GUID, PWSTR};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetVolumeNameForVolumeMountPointW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::{RegKey, HKEY};

    use super::recycle_bin::{known_folder_key, parse_guid, room, size_on_disk, takes, turned_off_by, Facts, WalkLimits};

    const BIT_BUCKET: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket";
    const POLICIES: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// `buffer` up to its first NUL, NUL kept.
    fn terminated(mut buffer: Vec<u16>) -> Option<Vec<u16>> {
        let end = buffer.iter().position(|&c| c == 0)?;
        buffer.truncate(end + 1);
        Some(buffer)
    }

    /// The folder `path`'s volume is mounted at — `C:\`, a folder a drive is
    /// mounted in, `\\host\share\` — NUL-terminated. Asked of a folder, never
    /// of a link: this follows every link in the path to answer.
    fn mount_point(path: &Path) -> Option<Vec<u16>> {
        let name = wide(path.as_os_str());
        // Never longer than the path itself, plus a closing separator.
        let mut buffer = vec![0u16; name.len().max(260) + 2];
        // SAFETY: `name` is NUL-terminated, `buffer` is as long as we say.
        let ok = unsafe { GetVolumePathNameW(name.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) } != 0;
        if ok {
            terminated(buffer)
        } else {
            None
        }
    }

    /// The volume's GUID, `{…}`, when `mount` is a volume's own mount point.
    fn volume_guid(mount: &[u16]) -> Option<String> {
        // `\\?\Volume{GUID}\` is 49 characters and a NUL.
        let mut buffer = vec![0u16; 64];
        // SAFETY: `mount` is NUL-terminated, `buffer` is as long as we say.
        let ok = unsafe { GetVolumeNameForVolumeMountPointW(mount.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) } != 0;
        if !ok {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0)?;
        let name = String::from_utf16(&buffer[..end]).ok()?;
        let start = name.find('{')?;
        let stop = start + name[start..].find('}')?;
        Some(name[start..=stop].to_string())
    }

    /// The volume's size and its free space, in bytes.
    fn volume_space(mount: &[u16]) -> Option<(u64, u64)> {
        let (mut total, mut free) = (0u64, 0u64);
        // SAFETY: `mount` is NUL-terminated; the output not wanted is null.
        let ok = unsafe { GetDiskFreeSpaceExW(mount.as_ptr(), std::ptr::null_mut(), &mut total, &mut free) } != 0;
        (ok && total > 0).then_some((total, free))
    }

    /// The volume's cluster: what one file takes at least.
    fn cluster_size(mount: &[u16]) -> Option<u64> {
        let (mut sectors, mut bytes, mut free, mut clusters) = (0u32, 0u32, 0u32, 0u32);
        // SAFETY: `mount` is NUL-terminated; the four outputs outlive the call.
        let ok = unsafe { GetDiskFreeSpaceW(mount.as_ptr(), &mut sectors, &mut bytes, &mut free, &mut clusters) } != 0;
        let cluster = u64::from(sectors) * u64::from(bytes);
        (ok && cluster > 0).then_some(cluster)
    }

    /// Where a known folder (`FOLDERID_…`) is now — it may have been moved.
    fn known_folder(id: u128) -> Option<String> {
        let id = GUID::from_u128(id);
        let mut out: PWSTR = std::ptr::null_mut();
        // SAFETY: `id` and `out` outlive the call; no token, no flags.
        let hr = unsafe { SHGetKnownFolderPath(&id, 0, std::ptr::null_mut(), &mut out) };
        let path = if hr >= 0 && !out.is_null() {
            // SAFETY: on success `out` is a NUL-terminated string the shell made.
            let len = (0..).take_while(|&i| unsafe { *out.add(i) } != 0).count();
            Some(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(out, len) }))
        } else {
            None
        };
        // SAFETY: the shell's to free, and CoTaskMemFree takes null too.
        unsafe { CoTaskMemFree(out as *const core::ffi::c_void) };
        path
    }

    /// One registry value: absent (the key or the value is not there — then
    /// Windows' own default applies), what it holds, or `Err` when it is
    /// there and could not be read (access denied, another type): then no
    /// one knows, and the bin is taken to be off.
    fn dword(root: HKEY, key: &str, value: &str) -> Result<Option<u32>, ()> {
        let key = match RegKey::predef(root).open_subkey(key) {
            Ok(key) => key,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        match key.get_value::<u32, _>(value) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }

    /// A policy set in either hive: the per-user one wins, as Windows reads it.
    fn policy(value: &str) -> Result<Option<u32>, ()> {
        match dword(HKEY_CURRENT_USER, POLICIES, value)? {
            Some(v) => Ok(Some(v)),
            None => dword(HKEY_LOCAL_MACHINE, POLICIES, value),
        }
    }

    /// The key holding the bin's settings for `path` on volume `guid`: a
    /// known folder's own (Documents moved to a share, say) when `path` is in
    /// one, else the global settings when Windows is told to use them, else
    /// the volume's. Err when that could not be told.
    fn settings_key(guid: Option<&str>, path: &Path) -> Result<Option<String>, ()> {
        let folders = format!(r"{BIT_BUCKET}\KnownFolder");
        match RegKey::predef(HKEY_CURRENT_USER).open_subkey(&folders) {
            Ok(key) => {
                // Each known folder resolved as the entry's path was — links
                // followed, long names, no `\\?\` — or None when it cannot be
                // (moved away, deleted): skipped, see `known_folder_key`.
                let mut candidates = Vec::new();
                for name in key.enum_keys() {
                    let name = name.map_err(|_| ())?;
                    let Some(id) = parse_guid(&name) else { continue };
                    let folder = known_folder(id)
                        .and_then(|folder| dunce::canonicalize(folder).ok())
                        .map(|folder| folder.to_string_lossy().into_owned());
                    candidates.push((format!(r"{folders}\{name}"), folder));
                }
                if let Some(key) = known_folder_key(&path.to_string_lossy(), &candidates) {
                    return Ok(Some(key));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        if dword(HKEY_CURRENT_USER, BIT_BUCKET, "UseGlobalSettings")? == Some(1) {
            return Ok(Some(BIT_BUCKET.to_string()));
        }
        Ok(guid.map(|guid| format!(r"{BIT_BUCKET}\Volume\{guid}")))
    }

    /// Whether `path` can go to the Recycle Bin — see `recycle_bin::takes`.
    ///
    /// The volume is the one the entry's FOLDER is on: the entry itself is
    /// never a link here (`LINKS_GO_TO_BIN`), and its folder has already been
    /// resolved by the confinement, but asking of the folder keeps it so.
    pub fn recycle_bin_for(path: &Path) -> Result<(), String> {
        let folder = path.parent().unwrap_or(path);
        let Some(mount) = mount_point(folder) else {
            return Err(format!("{} — its drive could not be found", super::NO_RECYCLE_BIN));
        };
        // SAFETY: `mount` is NUL-terminated and outlives the call.
        let kind = unsafe { GetDriveTypeW(mount.as_ptr()) };
        let guid = volume_guid(&mount);
        let space = volume_space(&mount);

        let read = (|| -> Result<(Option<bool>, Option<u64>), ()> {
            if policy("NoRecycleFiles")? == Some(1) {
                return Ok((Some(true), None));
            }
            let Some(key) = settings_key(guid.as_deref(), path)? else {
                return Ok((None, None));
            };
            // What is not there is Windows' default; what is there and cannot
            // be read is unknown (`turned_off_by`, `room`).
            let percent = if key == BIT_BUCKET { dword(HKEY_CURRENT_USER, &key, "Percent") } else { Ok(None) };
            let (total, free) = space.map_or((None, None), |(total, free)| (Some(total), Some(free)));
            Ok((
                turned_off_by(dword(HKEY_CURRENT_USER, &key, "NukeOnDelete")),
                room(dword(HKEY_CURRENT_USER, &key, "MaxCapacity"), percent, policy("RecycleBinSize"), total, free),
            ))
        })();
        let (turned_off, room) = read.unwrap_or((None, None));

        let mut facts = Facts { kind, own_volume: guid.is_some(), turned_off, capacity: room, size: Ok(0) };
        // Everything but the size first: a network drive is not walked.
        takes(&facts)?;
        facts.size = match cluster_size(&mount) {
            Some(cluster) => size_on_disk(path, cluster, &WalkLimits::default()),
            None => Err("The drive's cluster size could not be read — not sure the Recycle Bin can hold it".to_string()),
        };
        takes(&facts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_of_the_move_says_so_in_the_same_words() {
        assert!(not_moved("x").starts_with(&format!("Not moved to the {BIN}: ")));
        assert_eq!(BIN, if cfg!(windows) { "Recycle Bin" } else { "Trash" });
        assert_eq!(LINKS_GO_TO_BIN, cfg!(target_os = "macos"));
    }

    #[cfg(unix)]
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-trash-entry-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Review B2 and the second review's N2: on Windows and Linux a link is
    /// never handed to the system, nor removed in its place — the question
    /// promised a move that could be undone. The move fails, saying why, and
    /// the Explorer asks about a permanent delete; nothing is touched. On
    /// macOS it goes to the Trash as the link.
    #[cfg(unix)]
    #[test]
    fn a_link_is_never_handed_to_a_bin_not_trusted_with_one_nor_removed_unasked() {
        let dir = scratch("links");
        let real = dir.join("real");
        fs::create_dir_all(real.join("sub")).unwrap();
        fs::write(real.join("sub").join("a.txt"), "a").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("folder-link")).unwrap();
        std::os::unix::fs::symlink(real.join("sub").join("a.txt"), dir.join("file-link")).unwrap();
        std::os::unix::fs::symlink("nowhere", dir.join("dangling")).unwrap();

        for name in ["folder-link", "file-link", "dangling"] {
            let link = dir.join(name);
            let err = trash_entry(&link, true, |_: &Path| panic!("{name} was handed to the bin"), false).unwrap_err();
            assert_eq!(err, not_moved(link_not_moved()), "{name}");
            assert!(link.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()), "{name} was removed unasked");
        }
        assert_eq!(fs::read_to_string(real.join("sub").join("a.txt")).unwrap(), "a", "what they pointed at stays");
        assert!(link_not_moved().starts_with("It is a link"), "the words the Explorer reads");

        // Where links go to the bin, they go — as the link.
        fs::remove_file(dir.join("folder-link")).unwrap();
        std::os::unix::fs::symlink(&real, dir.join("folder-link")).unwrap();
        let mut handed = None;
        trash_entry(
            &dir.join("folder-link"),
            true,
            |p: &Path| {
                handed = Some(p.to_path_buf());
                fs::remove_file(p).map_err(|e| e.to_string())
            },
            true,
        )
        .unwrap();
        assert_eq!(handed, Some(dir.join("folder-link")));
        assert_eq!(fs::read_to_string(real.join("sub").join("a.txt")).unwrap(), "a");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Windows decides from the volume of the entry's FOLDER (review B2): the
    /// entry's own path would be followed to wherever a link leads.
    #[test]
    fn windows_asks_about_the_folder_not_the_entry() {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("fs").join("trash.rs")).unwrap();
        // Split so this line is not what is found.
        let body = &src[src.find(concat!("pub fn recycle_bin_", "for(path: &Path)")).expect("recycle_bin_for")..];
        let body = &body[..body.find("\n    }\n").or_else(|| body.find("\r\n    }\r\n")).expect("its end")];
        assert!(body.contains("let folder = path.parent().unwrap_or(path);"), "the folder is what is asked about");
        assert!(body.contains("mount_point(folder)"), "the volume is the folder's");
        assert!(!body.contains("mount_point(path)"), "never the entry's own");
        // And the size is measured before the shell is asked.
        assert!(body.contains("Some(cluster) => size_on_disk(path, cluster, &WalkLimits::default()),"));
    }
}
