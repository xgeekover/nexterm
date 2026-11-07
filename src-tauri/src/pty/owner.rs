//! Whether the programs in a terminal's foreground run as this user — what
//! the page asks before a control `send` types into it (spec F3): typing a
//! program's text into `sudo`, `su`, `login`, or the root shell one of them
//! started, is typing as another user, and is refused there.
//!
//! **Every process is looked at, not one** (review). The answer is "ours"
//! only when every process found is this user's and at least one was found;
//! one that is not, or one that cannot be read, is "not ours". A process
//! that has gone between the listing and the look no longer reads the
//! terminal and does not count.
//!
//! **macOS and Linux** look at the terminal's foreground process group
//! (`tcgetpgrp` on the pty's master): every member, not just its leader —
//! `/usr/bin/time /usr/bin/login` has a leader of the user's and a set-uid
//! root `login` reading the terminal, and in `true | login </dev/tty` the
//! leader has already gone. A member's real and effective uid must both be
//! ours: `sudo`, `su` and `login` are set-uid, so their effective uid is
//! root's even while they only ask for a password.
//! - **Linux:** the members are the processes whose `/proc/<pid>/stat` names
//!   that group (its fifth field); their uids are the `Uid:` line of
//!   `/proc/<pid>/status`. With `/proc` mounted `hidepid`, another user's
//!   processes cannot be seen at all, so nothing can be told: "not ours".
//! - **macOS:** `proc_listpgrppids` for the members, `proc_pidinfo
//!   (PROC_PIDTBSDINFO)` for each (`pbi_ruid`, `pbi_uid`). A set-uid root
//!   process the user started is not the user's to look at
//!   (`PermissionDenied`), which is the same answer.
//! - Anywhere else nothing can be told: "not ours".
//!
//! **Windows** has no foreground group, so the shell and every process
//! descended from it are looked at (a process snapshot, by parent ids): each
//! must run as this user with this process's elevation — not elevated when
//! NexTerm is not — or the answer is "not ours". `gsudo`, `sudo` and
//! "Run as administrator" all start an elevated process the shell's own
//! descends from. A process that cannot be opened or whose token cannot be
//! read is "not ours". Only when no snapshot can be taken at all is there no
//! answer (`None`).
//!
//! Read when asked, never cached. For a moment after a set-uid program's
//! exec the system can still report the credentials from before it
//! (measured on macOS, microseconds after the shell starts it); the page asks
//! right before it types, long after.

use std::collections::{HashMap, HashSet};

/// What was learned of one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    Ours,
    NotOurs,
    /// Gone since it was listed: it reads nothing any more.
    Gone,
    /// It could not be read.
    Unknown,
}

/// The verdict over what was seen: ours only if something was seen and all
/// of it was ours.
pub fn judge(seen: impl IntoIterator<Item = Seen>) -> bool {
    let mut ours = 0;
    for one in seen {
        match one {
            Seen::Ours => ours += 1,
            Seen::Gone => {}
            Seen::NotOurs | Seen::Unknown => return false,
        }
    }
    ours > 0
}

/// `root` and every process descended from it in `table` (`(pid, parent)`
/// pairs, as a process snapshot lists them): breadth first, each once, so a
/// parent id reused by a descendant cannot make it go round for ever. Empty
/// when `root` is not in the table.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn family(root: u32, table: &[(u32, u32)]) -> Vec<u32> {
    if !table.iter().any(|&(pid, _)| pid == root) {
        return Vec::new();
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, parent) in table {
        if pid != parent {
            children.entry(parent).or_default().push(pid);
        }
    }
    let mut found = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut next = 0;
    while next < found.len() {
        if let Some(kids) = children.get(&found[next]) {
            for &kid in kids {
                if seen.insert(kid) {
                    found.push(kid);
                }
            }
        }
        next += 1;
    }
    found
}

/// Whether `/proc` is mounted so that other users' processes are hidden,
/// from the text of `/proc/self/mountinfo`.
#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
pub fn hidepid_in(mountinfo: &str) -> bool {
    mountinfo.lines().any(|line| {
        let Some((mount, fs)) = line.split_once(" - ") else { return false };
        let mount_point = mount.split(' ').nth(4);
        let mut fs = fs.split(' ');
        let (kind, options) = (fs.next(), fs.nth(1));
        kind == Some("proc")
            && mount_point == Some("/proc")
            && options.is_some_and(|options| {
                options
                    .split(',')
                    .filter_map(|o| o.strip_prefix("hidepid="))
                    .any(|value| value != "0" && value != "off")
            })
    })
}

#[cfg(unix)]
pub use unix::foreground_runs_as;
#[cfg(windows)]
pub use windows::descendants_run_as_us;

#[cfg(unix)]
mod unix {
    use super::{judge, Seen};
    use std::io;

    /// Whether a process of real and effective uid `ids` runs as `uid`:
    /// both must be it — a set-uid program run by the user has the user's
    /// real uid.
    pub(super) fn runs_as((real, effective): (libc::uid_t, libc::uid_t), uid: libc::uid_t) -> bool {
        real == uid && effective == uid
    }

    /// Whether every process of the terminal's foreground group `group`
    /// runs as `uid`. No group, no members, anything unreadable: no.
    pub fn foreground_runs_as(group: Option<libc::pid_t>, uid: libc::uid_t) -> bool {
        let Some(group) = group.filter(|&g| g > 0) else { return false };
        let Ok(members) = members(group) else { return false };
        judge(members.into_iter().map(|pid| seen(pid, uid)))
    }

    pub(super) fn seen(pid: libc::pid_t, uid: libc::uid_t) -> Seen {
        match uids(pid) {
            Ok(ids) if runs_as(ids, uid) => Seen::Ours,
            Ok(_) => Seen::NotOurs,
            Err(e) if gone(&e) => Seen::Gone,
            Err(_) => Seen::Unknown,
        }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn gone(e: &io::Error) -> bool {
        e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ESRCH)
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    fn gone(e: &io::Error) -> bool {
        e.raw_os_error() == Some(libc::ESRCH)
    }

    /// The real and effective uid of process `pid`.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(super) fn uids(pid: libc::pid_t) -> io::Result<(libc::uid_t, libc::uid_t)> {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
        let line = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .ok_or_else(|| io::Error::other("no Uid line"))?;
        let mut ids = line.split_whitespace().map(str::parse::<libc::uid_t>);
        match (ids.next(), ids.next()) {
            (Some(Ok(real)), Some(Ok(effective))) => Ok((real, effective)),
            _ => Err(io::Error::other(format!("an unreadable Uid line: {line:?}"))),
        }
    }

    /// The processes of group `group`: every `/proc/<pid>/stat` whose fifth
    /// field it is. An error when other users' processes are hidden.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(super) fn members(group: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
        if super::hidepid_in(&std::fs::read_to_string("/proc/self/mountinfo")?) {
            return Err(io::Error::other("/proc hides other users' processes"));
        }
        let mut found = Vec::new();
        for entry in std::fs::read_dir("/proc")?.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<libc::pid_t>().ok()) else {
                continue;
            };
            // Gone meanwhile: not a member any more.
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            // `pid (comm) state ppid pgrp …`, where comm may hold anything,
            // brackets and spaces included: counted from the last `)`.
            let Some((_, rest)) = stat.rsplit_once(')') else { continue };
            if rest.split_whitespace().nth(2).and_then(|g| g.parse::<libc::pid_t>().ok()) == Some(group) {
                found.push(pid);
            }
        }
        Ok(found)
    }

    /// The real and effective uid of process `pid`.
    #[cfg(target_os = "macos")]
    pub(super) fn uids(pid: libc::pid_t) -> io::Result<(libc::uid_t, libc::uid_t)> {
        // SAFETY: a proc_bsdinfo of zeros is a valid value to be written over.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: `info` is a proc_bsdinfo of `size` bytes, what this flavor fills.
        let got =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        if got <= 0 {
            return Err(io::Error::last_os_error());
        }
        if got != size {
            return Err(io::Error::other("proc_pidinfo answered short"));
        }
        Ok((info.pbi_ruid, info.pbi_uid))
    }

    /// The processes of group `group`, from the kernel.
    #[cfg(target_os = "macos")]
    pub(super) fn members(group: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
        let mut room = 256usize;
        loop {
            let mut pids = vec![0 as libc::pid_t; room];
            let bytes = (room * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
            // SAFETY: `pids` holds `bytes` bytes of pid_t.
            let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), bytes) };
            if count < 0 {
                return Err(io::Error::last_os_error());
            }
            let count = count as usize;
            // A full buffer may have been cut short: ask again with more room.
            if count < room {
                pids.truncate(count);
                pids.retain(|&pid| pid > 0);
                return Ok(pids);
            }
            if room >= 1 << 16 {
                return Err(io::Error::other("too many processes in the group to tell"));
            }
            room *= 4;
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    pub(super) fn uids(_pid: libc::pid_t) -> io::Result<(libc::uid_t, libc::uid_t)> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "no way to ask on this system"))
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    pub(super) fn members(_group: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "no way to ask on this system"))
    }
}

#[cfg(windows)]
mod windows {
    use super::{family, judge, Seen};
    use crate::control::windows::{current_elevated, current_user, identity_of_process};
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    /// Every process now, as `(pid, parent)`; `None` when no snapshot can be
    /// taken.
    fn snapshot() -> Option<Vec<(u32, u32)>> {
        // SAFETY: a plain call; INVALID_HANDLE_VALUE is its failure.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return None;
        }
        // SAFETY: a handle just opened, closed when this goes.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let raw = std::os::windows::io::AsRawHandle::as_raw_handle(&handle);
        // SAFETY: a zeroed PROCESSENTRY32W with its size set, as the calls want.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut table = Vec::new();
        // SAFETY: the snapshot handle and an entry of the right size.
        let mut more = unsafe { Process32FirstW(raw, &mut entry) } != 0;
        while more {
            table.push((entry.th32ProcessID, entry.th32ParentProcessID));
            // SAFETY: as above.
            more = unsafe { Process32NextW(raw, &mut entry) } != 0;
        }
        (!table.is_empty()).then_some(table)
    }

    /// Whether the shell `root` and every process descended from it run as
    /// this user, with this process's elevation. `None` only when there is no
    /// snapshot to look at.
    pub fn descendants_run_as_us(root: u32) -> Option<bool> {
        let table = snapshot()?;
        let (Ok(user), Ok(elevated)) = (current_user(), current_elevated()) else {
            return Some(false);
        };
        Some(judge(family(root, &table).into_iter().map(|pid| match identity_of_process(pid) {
            Ok((sid, theirs)) if sid == user && theirs == elevated => Seen::Ours,
            Ok(_) => Seen::NotOurs,
            // OpenProcess's answer for a process id that is no more.
            Err(e) if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => Seen::Gone,
            Err(_) => Seen::Unknown,
        })))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A plain child of this test, with a grandchild of its own: all of
        /// it this user's, none elevated beyond this process.
        #[test]
        fn a_plain_child_and_its_own_children_are_ours() {
            let mut child = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
                .spawn()
                .expect("cmd starts");
            let table = snapshot().expect("a snapshot");
            assert!(table.iter().any(|&(pid, _)| pid == child.id()), "the child is in it");
            assert_eq!(descendants_run_as_us(child.id()), Some(true));
            assert_eq!(descendants_run_as_us(std::process::id()), Some(true), "this test and all it started");
            let _ = child.kill();
            let _ = child.wait();
            // Gone: nothing of it left to be ours.
            assert_eq!(descendants_run_as_us(child.id()), Some(false));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ours_only_when_everything_seen_is_ours() {
        use Seen::*;
        assert!(judge([Ours]));
        assert!(judge([Ours, Gone, Ours]), "gone ones read nothing");
        assert!(!judge([Ours, NotOurs]), "one set-uid member is enough");
        assert!(!judge([Ours, Unknown]), "one that cannot be read is enough");
        assert!(!judge([Gone]), "nothing left to look at");
        assert!(!judge([]), "no members at all");
    }

    #[test]
    fn a_family_is_its_root_and_everything_below_once() {
        let table = [(1, 0), (10, 1), (11, 10), (12, 10), (13, 11), (20, 1), (99, 98)];
        let mut found = family(10, &table);
        found.sort();
        assert_eq!(found, [10, 11, 12, 13]);
        assert_eq!(family(13, &table), [13]);
        assert!(family(42, &table).is_empty(), "a root not there has no family");
        // A parent id reused by a descendant: round once, not for ever.
        let looped = [(5, 7), (6, 5), (7, 6)];
        let mut found = family(5, &looped);
        found.sort();
        assert_eq!(found, [5, 6, 7]);
        assert_eq!(family(4, &[(4, 4)]), [4], "its own parent");
    }

    #[test]
    fn hidepid_is_read_from_proc_s_own_mount() {
        let plain = "22 26 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw\n";
        let hidden = "22 26 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw,hidepid=2\n";
        let invisible = "22 26 0:21 / /proc rw,relatime - proc proc rw,gid=10,hidepid=invisible\n";
        let off = "22 26 0:21 / /proc rw - proc proc rw,hidepid=0\n";
        let elsewhere = "40 26 0:44 / /run/x/proc rw - proc proc rw,hidepid=2\n";
        assert!(!hidepid_in(plain));
        assert!(hidepid_in(hidden));
        assert!(hidepid_in(invisible));
        assert!(!hidepid_in(off));
        assert!(!hidepid_in(elsewhere), "only /proc itself");
        assert!(hidepid_in(&format!("{plain}{hidden}")));
    }

    #[cfg(unix)]
    fn our_uid() -> libc::uid_t {
        // SAFETY: cannot fail.
        unsafe { libc::geteuid() }
    }

    #[cfg(unix)]
    #[test]
    fn real_and_effective_uid_must_both_be_ours() {
        assert!(unix::runs_as((501, 501), 501));
        assert!(!unix::runs_as((501, 0), 501), "set-uid root, run by us: sudo, su");
        assert!(!unix::runs_as((0, 501), 501));
        assert!(!unix::runs_as((0, 0), 501));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_and_its_group_are_this_user() {
        let pid = std::process::id() as libc::pid_t;
        // SAFETY: cannot fail.
        let (real, group) = unsafe { (libc::getuid(), libc::getpgrp()) };
        assert_eq!(unix::uids(pid).unwrap(), (real, our_uid()));
        assert_eq!(unix::seen(pid, our_uid()), if real == our_uid() { Seen::Ours } else { Seen::NotOurs });
        assert_eq!(unix::seen(pid, our_uid() + 1), Seen::NotOurs);
        let members = unix::members(group).unwrap();
        assert!(members.contains(&pid), "{pid} not among {members:?}");
    }

    #[cfg(unix)]
    #[test]
    fn init_s_group_is_not_this_user_and_no_group_is_nobody_s() {
        if our_uid() == 0 {
            eprintln!("running as root: init is this user; skipping");
            return;
        }
        assert!(!foreground_runs_as(Some(1), our_uid()));
        assert!(!foreground_runs_as(None, our_uid()), "no foreground group");
        assert!(!foreground_runs_as(Some(0x7fff_fff0), our_uid()), "a group with no members");
        assert_eq!(unix::seen(0x7fff_fff0, our_uid()), Seen::Gone);
    }
}
