//! How much CPU and memory each terminal uses (B8): its shell and every
//! process descended from it, counted together, as the TERMINALS panel and a
//! tab's hover card show it (`pty_resource_usage`).
//!
//! **One look at the processes per call**, however many terminals are asked
//! about: a table of every process with its parent, from which each shell's
//! tree is taken (owner.rs `family`). What each OS gives:
//! - **Linux:** one pass over `/proc/<pid>/stat`: the parent (4th field),
//!   CPU time (`utime` + `stime`, 14th and 15th, in clock ticks), the start
//!   (22nd, in ticks after boot) and resident memory (`rss`, 24th, in pages).
//! - **macOS:** `proc_listallpids`, the parent of each from `proc_pidinfo
//!   (PROC_PIDT_SHORTBSDINFO)` (which any process may ask of any other), and
//!   for each process in a tree asked about `PROC_PIDTBSDINFO` for its start
//!   and `PROC_PIDTASKINFO` for CPU time and resident memory. That CPU time
//!   is in Mach absolute time units, nanoseconds only where the timebase is
//!   1/1 (Intel); on Apple Silicon a unit is 125/3 ns, so it is converted
//!   with `mach_timebase_info` — unconverted, a busy process reads ~2%.
//! - **Windows:** a Toolhelp snapshot for the parents (owner.rs `snapshot`),
//!   and for each process in a tree asked about `OpenProcess` with limited
//!   query rights, `GetProcessTimes` (the creation time; kernel + user time
//!   in 100 ns units) and `K32GetProcessMemoryInfo` (the working set). Every
//!   handle is closed as it goes out of scope.
//!
//! **CPU percent** is the CPU time a tree used between two calls over the
//! wall time between them, × 100: 100 is one core, on every OS. A process is
//! known by its pid *and* its start, so a pid reused by a new process is a
//! new process: neither it nor one new since the last call adds anything for
//! that interval, and one gone since is not counted at all. A terminal's
//! first call has nothing to compare with: its CPU is `None`.
//!
//! **Memory** is the resident memory of the tree added up (Linux `rss`,
//! macOS resident size, Windows working set), so memory shared between its
//! processes is counted once for each.
//!
//! **Windows keeps an orphan's parent id.** It does not re-parent a process
//! whose parent has gone, and gives that parent's id to a later process: a
//! shell that got the id would have the orphan counted in its tree. So there
//! a process that started before its parent is not that parent's child, and
//! neither it nor anything below it is counted (`parentage`). Windows's
//! creation times are wall-clock UTC, so a clock set back can make a real
//! child look older than its shell: that child, and everything below it, is
//! then left out of the figures. That under-count is accepted there, as a
//! stale parent id would otherwise over-count. Where a start time cannot be
//! read, the link stands: so an unreadable orphan whose dead parent's id
//! went to the shell can add 1 to `processes` and set `partial`, with no
//! figures — cutting such links would also hide a real `sudo` or elevated
//! child. Elsewhere an orphan goes to init or launchd, so no parent id is
//! stale; macOS's start is the wall clock as well, and a clock set back
//! there would drop real children for nothing, so the rule is Windows's
//! alone.
//!
//! **Bounds:** at most `MAX_ASKED` session ids a call, each of at most
//! `MAX_ID_BYTES`; the rest is ignored (`bounded`). A session id is
//! `pty-<n>`, and the page asks about the tabs it shows.
//!
//! **Partial:** a process of the tree that cannot be read — another user's
//! (`sudo`), or a protected one — is counted as a process with no figures,
//! and the answer says it is partial. Processes that left the tree
//! (daemons, `nohup`, re-parented to init or launchd) are not counted at all.
//!
//! Only numbers come out: never a process's name, arguments or path.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::owner::family;

/// What was read of one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    /// When it started, in the OS's own units: with the pid, what tells it
    /// from a later process given the same pid.
    pub start: u64,
    /// The CPU time it has used so far, user and system, in nanoseconds.
    pub cpu_ns: u64,
    /// Its resident memory now, in bytes.
    pub resident_bytes: u64,
}

/// What became of looking at one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    Read(Reading),
    /// Gone since it was listed: nothing to count.
    Gone,
    /// It could not be read (another user's, a protected one): a process
    /// with no figures, and the answer partial.
    Unreadable,
    /// Not looked at: it is in no tree asked about.
    NotAsked,
}

/// One process of a listing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub seen: Seen,
}

/// What lists the processes: the system itself (`System`), or a script in a
/// test.
pub trait Enumerate: Send {
    /// Every process there is now, with what it uses read for at least each
    /// one in the tree of a pid in `roots`. `None` when the processes cannot
    /// be listed at all.
    fn processes(&mut self, roots: &[u32]) -> Option<Vec<Process>>;
}

/// At most this many session ids are looked at a call; the rest is ignored.
pub const MAX_ASKED: usize = 1024;
/// A session id longer than this is no session's (`pty-<n>`): ignored.
pub const MAX_ID_BYTES: usize = 128;

/// The first `MAX_ASKED` of `asked`, less every id longer than
/// `MAX_ID_BYTES`: what `pty_resource_usage` looks at.
pub fn bounded(asked: &[String]) -> Vec<String> {
    asked.iter().take(MAX_ASKED).filter(|id| id.len() <= MAX_ID_BYTES).cloned().collect()
}

/// What `pty_resource_usage` answers for one terminal.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResourceUsage {
    pub session_id: String,
    /// The tree's CPU since the last call for this terminal, 100 = one
    /// core; `None` on its first.
    pub cpu_percent: Option<f64>,
    /// The tree's resident memory, added up.
    pub memory_bytes: u64,
    /// How many processes the tree has (those that could not be read too).
    pub processes: u32,
    /// Some process of the tree could not be read: the figures leave it out.
    pub partial: bool,
}

/// One terminal's last call: when, and the CPU time of each process of its
/// tree then, by (pid, start).
struct Previous {
    at: Instant,
    cpu: HashMap<(u32, u64), u64>,
}

/// The figures of each terminal from one listing a call, and each one's last
/// call to measure its CPU against.
pub struct Sampler {
    list: Box<dyn Enumerate>,
    previous: HashMap<String, Previous>,
    /// A parent id may name a later process than the parent (Windows): a
    /// child that started before its parent is not its (`parentage`).
    stale_parents: bool,
}

impl Sampler {
    pub fn new(list: Box<dyn Enumerate>) -> Self {
        Self { list, previous: HashMap::new(), stale_parents: cfg!(windows) }
    }

    /// The figures of each terminal in `asked` (in its order, each once)
    /// that is in `sessions` — every terminal there is now, by session id,
    /// with its shell's pid where it was looked up — as of `now`. A
    /// terminal asked about that is not there, or whose shell has no pid,
    /// is left out; one no longer there is forgotten. One listing of the
    /// processes, and none when there is nothing to measure. An error only
    /// when the processes cannot be listed, and then nothing is forgotten.
    pub fn sample(
        &mut self,
        asked: &[String],
        sessions: &HashMap<String, Option<u32>>,
        now: Instant,
    ) -> Result<Vec<ResourceUsage>, String> {
        self.previous.retain(|id, _| sessions.contains_key(id));
        let mut once = HashSet::new();
        let wanted: Vec<(&str, u32)> = asked
            .iter()
            .filter(|id| once.insert(id.as_str()))
            .filter_map(|id| match sessions.get(id) {
                Some(Some(pid)) => Some((id.as_str(), *pid)),
                _ => None,
            })
            .collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let roots: Vec<u32> = wanted.iter().map(|&(_, pid)| pid).collect();
        let processes = self
            .list
            .processes(&roots)
            .ok_or_else(|| "The processes could not be listed".to_string())?;
        let table = parentage(&processes, self.stale_parents);
        let seen: HashMap<u32, Seen> = processes.iter().map(|p| (p.pid, p.seen)).collect();

        let mut answer = Vec::with_capacity(wanted.len());
        for (id, root) in wanted {
            let before = self.previous.remove(id);
            let mut usage = ResourceUsage {
                session_id: id.to_string(),
                cpu_percent: None,
                memory_bytes: 0,
                processes: 0,
                partial: false,
            };
            let mut cpu = HashMap::new();
            let mut used: u64 = 0;
            for pid in family(root, &table) {
                match seen.get(&pid).copied().unwrap_or(Seen::NotAsked) {
                    Seen::Read(reading) => {
                        usage.processes += 1;
                        usage.memory_bytes = usage.memory_bytes.saturating_add(reading.resident_bytes);
                        // The same process as last time, or no delta at all.
                        if let Some(&was) = before.as_ref().and_then(|b| b.cpu.get(&(pid, reading.start))) {
                            used = used.saturating_add(reading.cpu_ns.saturating_sub(was));
                        }
                        cpu.insert((pid, reading.start), reading.cpu_ns);
                    }
                    Seen::Gone => {}
                    // Not looked at although in a tree: the lister's fault,
                    // told as honestly as one that could not be read.
                    Seen::Unreadable | Seen::NotAsked => {
                        usage.processes += 1;
                        usage.partial = true;
                    }
                }
            }
            usage.cpu_percent = before.and_then(|b| percent(used, now.saturating_duration_since(b.at)));
            self.previous.insert(id.to_string(), Previous { at: now, cpu });
            answer.push(usage);
        }
        Ok(answer)
    }
}

/// The `(pid, parent)` pairs of a listing. With `stale_parents` (Windows),
/// less every parent a process cannot have: one that started after it,
/// which is a later process given the id of its parent that has gone. That
/// process is then listed as its own parent, in no tree but its own, and so
/// is everything below it. Where either start is not known, the parent
/// stands.
fn parentage(processes: &[Process], stale_parents: bool) -> Vec<(u32, u32)> {
    let start = |seen: Seen| match seen {
        Seen::Read(reading) => Some(reading.start),
        _ => None,
    };
    let starts: HashMap<u32, u64> =
        if stale_parents { processes.iter().filter_map(|p| Some((p.pid, start(p.seen)?))).collect() } else { HashMap::new() };
    processes
        .iter()
        .map(|p| {
            let before_its_parent = match (starts.get(&p.pid), starts.get(&p.parent)) {
                (Some(own), Some(parent)) => own < parent,
                _ => false,
            };
            (p.pid, if before_its_parent { p.pid } else { p.parent })
        })
        .collect()
}

/// `used` nanoseconds of CPU over `wall` as a percent of one core, to a
/// tenth; `None` over no time at all.
fn percent(used: u64, wall: Duration) -> Option<f64> {
    let wall = wall.as_nanos();
    (wall > 0).then(|| (used as f64 * 1000.0 / wall as f64).round() / 10.0)
}

/// Mach absolute time `ticks` in nanoseconds, by the timebase `numer/denom`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mach_ns(ticks: u64, (numer, denom): (u32, u32)) -> u64 {
    let ns = u128::from(ticks) * u128::from(numer) / u128::from(denom.max(1));
    u64::try_from(ns).unwrap_or(u64::MAX)
}

/// What `/proc/<pid>/stat` says of a process.
#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
struct Stat {
    parent: u32,
    /// `utime` + `stime`, in clock ticks.
    cpu_ticks: u64,
    /// `starttime`, in clock ticks after boot.
    start: u64,
    /// `rss`, in pages.
    rss_pages: u64,
}

/// `pid (comm) state ppid …`, where comm may hold anything, brackets and
/// spaces included: the fields are counted from the last `)`.
#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
fn parse_stat(text: &str) -> Option<Stat> {
    let (_, rest) = text.rsplit_once(')')?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // `rest` begins at the 3rd field, `state`.
    let field = |n: usize| fields.get(n - 3).and_then(|value| value.parse::<u64>().ok());
    Some(Stat {
        parent: u32::try_from(field(4)?).ok()?,
        cpu_ticks: field(14)?.saturating_add(field(15)?),
        start: field(22)?,
        rss_pages: field(24)?,
    })
}

/// The processes of this machine, as its OS tells them.
pub struct System {
    /// Mach absolute time to nanoseconds: `(numer, denom)`.
    #[cfg(target_os = "macos")]
    timebase: (u32, u32),
}

impl System {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            timebase: platform::timebase(),
        }
    }
}

impl Default for System {
    fn default() -> Self {
        Self::new()
    }
}

impl Enumerate for System {
    fn processes(&mut self, roots: &[u32]) -> Option<Vec<Process>> {
        platform::processes(self, roots)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use super::{parse_stat, Process, Reading, Seen, System};

    pub(super) fn processes(_system: &System, _roots: &[u32]) -> Option<Vec<Process>> {
        // SAFETY: plain calls.
        let (tick, page) = unsafe { (libc::sysconf(libc::_SC_CLK_TCK), libc::sysconf(libc::_SC_PAGESIZE)) };
        if tick <= 0 || page <= 0 {
            return None;
        }
        let (tick, page) = (tick as u64, page as u64);
        let mut found = Vec::new();
        for entry in std::fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            // Gone meanwhile, or not to be read: its parent is not known, so
            // it is in no tree.
            let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            let Some(stat) = parse_stat(&text) else { continue };
            let cpu_ns = u128::from(stat.cpu_ticks) * 1_000_000_000 / u128::from(tick);
            found.push(Process {
                pid,
                parent: stat.parent,
                seen: Seen::Read(Reading {
                    start: stat.start,
                    cpu_ns: u64::try_from(cpu_ns).unwrap_or(u64::MAX),
                    resident_bytes: stat.rss_pages.saturating_mul(page),
                }),
            });
        }
        (!found.is_empty()).then_some(found)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{family, mach_ns, Process, Reading, Seen, System};
    use std::collections::HashSet;
    use std::io;
    use std::mem::size_of;

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
    }

    /// The Mach timebase, `(numer, denom)`: 1/1 on Intel, 125/3 on Apple
    /// Silicon.
    pub(super) fn timebase() -> (u32, u32) {
        let mut base = Timebase { numer: 0, denom: 0 };
        // SAFETY: the call fills the struct it is given.
        let ok = unsafe { mach_timebase_info(&mut base) } == 0;
        if ok && base.numer > 0 && base.denom > 0 {
            (base.numer, base.denom)
        } else {
            (1, 1)
        }
    }

    pub(super) fn processes(system: &System, roots: &[u32]) -> Option<Vec<Process>> {
        let mut found: Vec<Process> = Vec::new();
        for pid in all_pids()? {
            // Gone since it was listed, or not to be told: in no tree.
            let Some(parent) = parent_of(pid) else { continue };
            found.push(Process { pid: pid as u32, parent, seen: Seen::NotAsked });
        }
        let table: Vec<(u32, u32)> = found.iter().map(|p| (p.pid, p.parent)).collect();
        let members: HashSet<u32> = roots.iter().flat_map(|&root| family(root, &table)).collect();
        for process in found.iter_mut().filter(|p| members.contains(&p.pid)) {
            process.seen = read(process.pid as libc::pid_t, system.timebase);
        }
        (!found.is_empty()).then_some(found)
    }

    /// Every pid there is now.
    fn all_pids() -> Option<Vec<libc::pid_t>> {
        let mut room = 1024usize;
        loop {
            let mut pids = vec![0 as libc::pid_t; room];
            let bytes = (room * size_of::<libc::pid_t>()) as libc::c_int;
            // SAFETY: `pids` holds `bytes` bytes of pid_t.
            let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
            if count <= 0 {
                return None;
            }
            let count = count as usize;
            // A full buffer may have been cut short: ask again with more room.
            if count < room {
                pids.truncate(count);
                pids.retain(|&pid| pid >= 0);
                return Some(pids);
            }
            if room >= 1 << 20 {
                return None;
            }
            room *= 4;
        }
    }

    /// `pid`'s parent, which any process may ask of any other.
    fn parent_of(pid: libc::pid_t) -> Option<u32> {
        // SAFETY: a proc_bsdshortinfo of zeros is a valid value to be written over.
        let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
        let size = size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
        // SAFETY: `info` is a proc_bsdshortinfo of `size` bytes, what this flavor fills.
        let got = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (&mut info as *mut libc::proc_bsdshortinfo).cast(), size)
        };
        (got == size).then_some(info.pbsi_ppid)
    }

    /// `pid`'s start, CPU time and resident memory: this user's processes
    /// only (another's answers `EPERM`), a zombie none (`ESRCH`).
    fn read(pid: libc::pid_t, timebase: (u32, u32)) -> Seen {
        let outcome = (|| -> io::Result<Reading> {
            // SAFETY: zeroed structs are valid values to be written over.
            let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let mut task: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
            let bsd_size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let task_size = size_of::<libc::proc_taskinfo>() as libc::c_int;
            // SAFETY: each struct is of the size given, what its flavor fills.
            let got = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut bsd as *mut libc::proc_bsdinfo).cast(), bsd_size)
            };
            if got <= 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: as above.
            let got_task = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, (&mut task as *mut libc::proc_taskinfo).cast(), task_size)
            };
            if got_task <= 0 {
                return Err(io::Error::last_os_error());
            }
            if got != bsd_size || got_task != task_size {
                return Err(io::Error::other("proc_pidinfo answered short"));
            }
            Ok(Reading {
                start: bsd.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(bsd.pbi_start_tvusec),
                cpu_ns: mach_ns(task.pti_total_user.saturating_add(task.pti_total_system), timebase),
                resident_bytes: task.pti_resident_size,
            })
        })();
        match outcome {
            Ok(reading) => Seen::Read(reading),
            Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Seen::Gone,
            Err(_) => Seen::Unreadable,
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{family, Process, Reading, Seen, System};
    use std::collections::HashSet;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, FILETIME};
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub(super) fn processes(_system: &System, roots: &[u32]) -> Option<Vec<Process>> {
        let table = crate::pty::owner::snapshot()?;
        let members: HashSet<u32> = roots.iter().flat_map(|&root| family(root, &table)).collect();
        Some(
            table
                .into_iter()
                .map(|(pid, parent)| Process {
                    pid,
                    parent,
                    seen: if members.contains(&pid) { read(pid) } else { Seen::NotAsked },
                })
                .collect(),
        )
    }

    fn filetime(time: FILETIME) -> u64 {
        (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
    }

    /// `pid`'s creation time, CPU time and working set.
    fn read(pid: u32) -> Seen {
        match query(pid) {
            Ok(reading) => Seen::Read(reading),
            // OpenProcess's answer for a process id that is no more.
            Err(("OpenProcess", e)) if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => Seen::Gone,
            Err(_) => Seen::Unreadable,
        }
    }

    /// What `read` asks, with the call that failed and its error when one
    /// does — what the tests name.
    pub(super) fn query(pid: u32) -> Result<Reading, (&'static str, std::io::Error)> {
        let failed = |call: &'static str| (call, std::io::Error::last_os_error());
        // SAFETY: a plain call; a null handle is its failure.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return Err(failed("OpenProcess"));
        }
        // SAFETY: a handle just opened, closed when this goes.
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        let handle = process.as_raw_handle();
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: an open handle with query rights and four FILETIMEs to fill.
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return Err(failed("GetProcessTimes"));
        }
        // SAFETY: a zeroed PROCESS_MEMORY_COUNTERS with its size set, as the call wants.
        let mut memory: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        memory.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        // SAFETY: the open handle and a struct of the size given. Limited
        // query rights: underneath, the call asks for ProcessVmCounters,
        // which needs no more, though its documentation also lists
        // PROCESS_VM_READ. The Windows tests read this process and a child
        // through here, and name this call if it fails.
        if unsafe { K32GetProcessMemoryInfo(handle, &mut memory, memory.cb) } == 0 {
            return Err(failed("K32GetProcessMemoryInfo"));
        }
        Ok(Reading {
            start: filetime(created),
            cpu_ns: filetime(kernel).saturating_add(filetime(user)).saturating_mul(100),
            resident_bytes: memory.WorkingSetSize as u64,
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
mod platform {
    use super::{Process, System};

    /// No way to ask here.
    pub(super) fn processes(_system: &System, _roots: &[u32]) -> Option<Vec<Process>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn read(pid: u32, parent: u32, start: u64, cpu_ns: u64, resident_bytes: u64) -> Process {
        Process { pid, parent, seen: Seen::Read(Reading { start, cpu_ns, resident_bytes }) }
    }

    /// Answers the listings it was given, one a call, and counts the calls
    /// and the roots each was asked for.
    struct Script {
        listings: VecDeque<Option<Vec<Process>>>,
        calls: Arc<AtomicUsize>,
        roots: Arc<Mutex<Vec<Vec<u32>>>>,
    }

    impl Enumerate for Script {
        fn processes(&mut self, roots: &[u32]) -> Option<Vec<Process>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.roots.lock().unwrap().push(roots.to_vec());
            self.listings.pop_front().flatten()
        }
    }

    fn sampler(listings: Vec<Option<Vec<Process>>>) -> (Sampler, Arc<AtomicUsize>, Arc<Mutex<Vec<Vec<u32>>>>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let roots = Arc::new(Mutex::new(Vec::new()));
        let script = Script { listings: listings.into(), calls: calls.clone(), roots: roots.clone() };
        (Sampler::new(Box::new(script)), calls, roots)
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn shells(pairs: &[(&str, Option<u32>)]) -> HashMap<String, Option<u32>> {
        pairs.iter().map(|&(id, pid)| (id.to_string(), pid)).collect()
    }

    const SECOND: Duration = Duration::from_secs(1);
    const MS: u64 = 1_000_000;

    #[test]
    fn cpu_is_the_tree_s_cpu_time_over_wall_time_with_none_at_first() {
        // A shell (10) with a busy child (11) and a grandchild (12); 99 is
        // another terminal's, 1 is init.
        let first = vec![read(1, 0, 1, 0, 0), read(10, 1, 5, 100 * MS, 1000), read(11, 10, 6, 0, 200), read(12, 11, 7, 50 * MS, 30), read(99, 1, 8, 0, 5000)];
        let second = vec![read(1, 0, 1, 0, 0), read(10, 1, 5, 150 * MS, 1000), read(11, 10, 6, 900 * MS, 200), read(12, 11, 7, 100 * MS, 30), read(99, 1, 8, 9000 * MS, 5000)];
        let (mut sampler, calls, _) = sampler(vec![Some(first), Some(second)]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();

        let one = sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        assert_eq!(
            one,
            [ResourceUsage { session_id: "a".into(), cpu_percent: None, memory_bytes: 1230, processes: 3, partial: false }],
            "a tree sum over family(), and nothing to compare with yet"
        );
        let two = sampler.sample(&ids(&["a"]), &sessions, t0 + 2 * SECOND).unwrap();
        // (50 + 900 + 50) ms of CPU over 2 s: half a core. 99's 9 s are not this tree's.
        assert_eq!(two[0].cpu_percent, Some(50.0));
        assert_eq!((two[0].memory_bytes, two[0].processes), (1230, 3));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn one_core_is_one_hundred_and_more_cores_more() {
        let busy = |cpu| vec![read(10, 1, 5, cpu, 1), read(11, 10, 6, cpu, 1)];
        let (mut sampler, _, _) = sampler(vec![Some(busy(0)), Some(busy(SECOND.as_nanos() as u64))]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        let two = sampler.sample(&ids(&["a"]), &sessions, t0 + SECOND).unwrap();
        assert_eq!(two[0].cpu_percent, Some(200.0), "two processes each busy for the whole second");
    }

    #[test]
    fn a_process_gone_between_samples_is_not_counted() {
        let first = vec![read(10, 1, 5, 0, 100), read(11, 10, 6, 400 * MS, 50)];
        let second = vec![read(10, 1, 5, 100 * MS, 100)];
        let (mut sampler, _, _) = sampler(vec![Some(first), Some(second)]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        let two = sampler.sample(&ids(&["a"]), &sessions, t0 + SECOND).unwrap();
        assert_eq!(two[0].cpu_percent, Some(10.0), "only the shell's 100 ms");
        assert_eq!((two[0].memory_bytes, two[0].processes), (100, 1));
    }

    #[test]
    fn a_reused_pid_with_a_new_start_is_a_new_process_not_a_delta() {
        let first = vec![read(10, 1, 5, 0, 100), read(11, 10, 6, 100 * MS, 50)];
        // 11 is another process now, started later, with 3 s of its own.
        let second = vec![read(10, 1, 5, 0, 100), read(11, 10, 9, 3000 * MS, 70)];
        let third = vec![read(10, 1, 5, 0, 100), read(11, 10, 9, 3500 * MS, 70)];
        let (mut sampler, _, _) = sampler(vec![Some(first), Some(second), Some(third)]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        let two = sampler.sample(&ids(&["a"]), &sessions, t0 + SECOND).unwrap();
        assert_eq!(two[0].cpu_percent, Some(0.0), "neither 3000 - 100 ms nor 3000 ms counted");
        assert_eq!((two[0].memory_bytes, two[0].processes), (170, 2), "its memory is the tree's");
        let three = sampler.sample(&ids(&["a"]), &sessions, t0 + 2 * SECOND).unwrap();
        assert_eq!(three[0].cpu_percent, Some(50.0), "and from then on it is measured");
    }

    #[test]
    fn an_unknown_session_is_left_out_and_the_order_asked_kept() {
        let listing = vec![read(10, 1, 5, 0, 1), read(20, 1, 5, 0, 2)];
        let (mut sampler, _, roots) = sampler(vec![Some(listing)]);
        let sessions = shells(&[("a", Some(10)), ("b", Some(20)), ("no-pid", None)]);
        let got = sampler.sample(&ids(&["b", "ghost", "a", "b", "no-pid"]), &sessions, Instant::now()).unwrap();
        let got: Vec<&str> = got.iter().map(|u| u.session_id.as_str()).collect();
        assert_eq!(got, ["b", "a"], "each once, the unknown and the pid-less left out");
        assert_eq!(*roots.lock().unwrap(), [vec![20, 10]]);
    }

    /// AC-B8-3: one listing per call, however many terminals are asked about.
    #[test]
    fn one_listing_a_call_whatever_the_number_of_sessions() {
        for count in [1usize, 3, 10, 40] {
            let listing: Vec<Process> = (0..count as u32).map(|n| read(100 + n, 1, 1, 0, 1)).collect();
            let (mut sampler, calls, _) = sampler(vec![Some(listing.clone()), Some(listing)]);
            let names: Vec<String> = (0..count).map(|n| format!("s{n}")).collect();
            let sessions: HashMap<String, Option<u32>> =
                names.iter().enumerate().map(|(n, id)| (id.clone(), Some(100 + n as u32))).collect();
            let t0 = Instant::now();
            assert_eq!(sampler.sample(&names, &sessions, t0).unwrap().len(), count);
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{count} sessions, one listing");
            let again = sampler.sample(&names, &sessions, t0 + SECOND).unwrap();
            assert!(again.iter().all(|u| u.cpu_percent == Some(0.0)));
            assert_eq!(calls.load(Ordering::SeqCst), 2, "{count} sessions, one listing again");
        }
        // Nothing to measure: no listing at all.
        let (mut sampler, calls, _) = sampler(vec![]);
        assert_eq!(sampler.sample(&ids(&["ghost"]), &shells(&[]), Instant::now()), Ok(vec![]));
        assert_eq!(sampler.sample(&[], &shells(&[("a", Some(10))]), Instant::now()), Ok(vec![]));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_session_gone_is_forgotten_and_starts_afresh_if_seen_again() {
        let listing = || Some(vec![read(10, 1, 5, 0, 1)]);
        let (mut sampler, _, _) = sampler(vec![listing(), listing(), listing()]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &shells(&[("a", Some(10))]), t0).unwrap();
        // Asked while "a" is no more: left out and forgotten.
        let other = sampler.sample(&ids(&["a", "b"]), &shells(&[("b", Some(10))]), t0 + SECOND).unwrap();
        assert_eq!(other.len(), 1);
        assert!(!sampler.previous.contains_key("a"));
        let again = sampler.sample(&ids(&["a"]), &shells(&[("a", Some(10))]), t0 + 2 * SECOND).unwrap();
        assert_eq!(again[0].cpu_percent, None, "nothing kept to compare with");
    }

    #[test]
    fn a_process_that_cannot_be_read_marks_the_answer_partial() {
        let listing = vec![
            read(10, 1, 5, 0, 100),
            Process { pid: 11, parent: 10, seen: Seen::Unreadable },
            read(12, 11, 6, 0, 30),
            Process { pid: 13, parent: 10, seen: Seen::Gone },
        ];
        let (mut sampler, _, _) = sampler(vec![Some(listing)]);
        let got = sampler.sample(&ids(&["a"]), &shells(&[("a", Some(10))]), Instant::now()).unwrap();
        assert_eq!(
            got,
            [ResourceUsage { session_id: "a".into(), cpu_percent: None, memory_bytes: 130, processes: 3, partial: true }],
            "sudo's process counted with no figures, below it still measured, the gone one not at all"
        );
    }

    #[test]
    fn a_shell_gone_from_the_listing_has_an_empty_tree() {
        let (mut sampler, _, _) = sampler(vec![Some(vec![read(10, 1, 5, 0, 100)]), Some(vec![read(1, 0, 1, 0, 0)])]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        let got = sampler.sample(&ids(&["a"]), &sessions, t0 + SECOND).unwrap();
        assert_eq!((got[0].cpu_percent, got[0].memory_bytes, got[0].processes, got[0].partial), (Some(0.0), 0, 0, false));
    }

    #[test]
    fn no_listing_is_an_error_and_keeps_what_was_measured() {
        let (mut sampler, _, _) = sampler(vec![Some(vec![read(10, 1, 5, 0, 1)]), None, Some(vec![read(10, 1, 5, 500 * MS, 1)])]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        assert!(sampler.sample(&ids(&["a"]), &sessions, t0 + SECOND).is_err());
        let got = sampler.sample(&ids(&["a"]), &sessions, t0 + 2 * SECOND).unwrap();
        assert_eq!(got[0].cpu_percent, Some(25.0), "500 ms over the 2 s since the last good call");
    }

    /// Windows (review A-R2): 12's parent id is 10, but 12 started before
    /// 10 did — the id of a parent that has gone, given since to the shell.
    /// Neither it nor its own child 13 is the shell's; 11, a real child, and
    /// 14, started at the same moment as the shell, are. A parent whose start
    /// is not known (15) stands.
    #[test]
    fn a_child_older_than_its_parent_is_not_in_its_tree_where_parent_ids_go_stale() {
        let listing = || {
            vec![
                read(1, 0, 1, 0, 0),
                read(10, 1, 50, 0, 1000),
                read(11, 10, 60, 0, 200),
                read(12, 10, 40, 0, 30_000),
                read(13, 12, 45, 0, 4_000),
                read(14, 10, 50, 0, 5),
                Process { pid: 15, parent: 10, seen: Seen::Unreadable },
                read(16, 15, 20, 0, 7),
            ]
        };
        let sessions = shells(&[("a", Some(10))]);
        let (mut windows, _, _) = sampler(vec![Some(listing())]);
        windows.stale_parents = true;
        let got = windows.sample(&ids(&["a"]), &sessions, Instant::now()).unwrap();
        assert_eq!(
            (got[0].memory_bytes, got[0].processes, got[0].partial),
            (1000 + 200 + 5 + 7, 5, true),
            "10, 11, 14, 15 (unreadable) and 16 under it; not 12 or 13"
        );
        let mut tree = family(10, &parentage(&listing(), true));
        tree.sort();
        assert_eq!(tree, [10, 11, 14, 15, 16]);
        // Where an orphan goes to init (macOS, Linux), the ids are not stale
        // and every child is counted, whatever its start says.
        let (mut elsewhere, _, _) = sampler(vec![Some(listing())]);
        elsewhere.stale_parents = false;
        let got = elsewhere.sample(&ids(&["a"]), &sessions, Instant::now()).unwrap();
        assert_eq!(got[0].processes, 7);
        assert_eq!(Sampler::new(Box::new(System::new())).stale_parents, cfg!(windows), "the rule is Windows's");
    }

    /// Review A-R4: the first MAX_ASKED ids only, and none longer than
    /// MAX_ID_BYTES, however many or long the page sends.
    #[test]
    fn the_ids_asked_about_are_bounded_in_number_and_length() {
        assert_eq!((MAX_ASKED, MAX_ID_BYTES), (1024, 128));
        let exact = "p".repeat(MAX_ID_BYTES);
        let long = "p".repeat(MAX_ID_BYTES + 1);
        assert_eq!(bounded(&[exact.clone(), long, "pty-1".into()]), [exact, "pty-1".to_string()]);
        let many: Vec<String> = (0..MAX_ASKED + 10).map(|n| format!("pty-{n}")).collect();
        let kept = bounded(&many);
        assert_eq!(kept.len(), MAX_ASKED);
        assert_eq!(kept.last().map(String::as_str), Some("pty-1023"), "the first ones, in order");
        assert!(bounded(&[]).is_empty());
    }

    #[test]
    fn two_calls_at_one_instant_have_no_cpu_figure() {
        let listing = || Some(vec![read(10, 1, 5, 0, 1)]);
        let (mut sampler, _, _) = sampler(vec![listing(), listing()]);
        let sessions = shells(&[("a", Some(10))]);
        let t0 = Instant::now();
        sampler.sample(&ids(&["a"]), &sessions, t0).unwrap();
        assert_eq!(sampler.sample(&ids(&["a"]), &sessions, t0).unwrap()[0].cpu_percent, None);
    }

    /// Numbers and a count only: no name, argument or path can come out.
    #[test]
    fn the_answer_holds_numbers_and_a_count_only() {
        let usage = ResourceUsage { session_id: "pty-1".into(), cpu_percent: Some(12.5), memory_bytes: 4096, processes: 2, partial: false };
        assert_eq!(
            serde_json::to_value(&usage).unwrap(),
            serde_json::json!({ "session_id": "pty-1", "cpu_percent": 12.5, "memory_bytes": 4096, "processes": 2, "partial": false })
        );
        let first = ResourceUsage { cpu_percent: None, ..usage };
        assert_eq!(serde_json::to_value(&first).unwrap()["cpu_percent"], serde_json::Value::Null);
    }

    #[test]
    fn mach_time_is_converted_by_the_timebase() {
        // Apple Silicon: 24 MHz ticks, 125/3 ns each.
        assert_eq!(mach_ns(24_000_000, (125, 3)), 1_000_000_000);
        assert_eq!(mach_ns(3, (125, 3)), 125);
        assert_eq!(mach_ns(1_234_567, (1, 1)), 1_234_567, "Intel: ticks are nanoseconds");
        assert_eq!(mach_ns(u64::MAX, (125, 3)), u64::MAX, "no overflow");
        assert_eq!(mach_ns(7, (1, 0)), 7, "a timebase of nothing is not a division by zero");
    }

    #[test]
    fn a_stat_line_is_read_from_after_the_last_bracket() {
        let line = "4242 (my (odd) prog) S 4200 4242 4200 34816 4242 4194304 1500 0 0 0 \
                    731 269 0 0 20 0 3 0 987654 123456789 2048 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n";
        assert_eq!(parse_stat(line), Some(Stat { parent: 4200, cpu_ticks: 1000, start: 987654, rss_pages: 2048 }));
        assert_eq!(parse_stat("1 (init) S 0 1 1 0 -1"), None, "cut short");
        assert_eq!(parse_stat("no brackets at all"), None);
    }

    /// A shell of a known pid with a child: the child is in its tree, read,
    /// with resident memory (AC-B8-2).
    #[cfg(unix)]
    #[test]
    fn a_real_child_is_in_its_shell_s_tree_with_memory() {
        let mut shell = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .expect("sh starts");
        let root = shell.id();
        let mut system = System::new();
        // The shell forks its child just after it starts.
        let deadline = Instant::now() + Duration::from_secs(10);
        let child = loop {
            let listing = system.processes(&[root]).expect("a listing");
            let table: Vec<(u32, u32)> = listing.iter().map(|p| (p.pid, p.parent)).collect();
            let tree = family(root, &table);
            if let Some(&child) = tree.iter().find(|&&pid| pid != root) {
                let seen = listing.iter().find(|p| p.pid == child).unwrap().seen;
                match seen {
                    Seen::Read(reading) => assert!(reading.resident_bytes > 0, "{seen:?}"),
                    other => panic!("the child could not be read: {other:?}"),
                }
                break child;
            }
            assert!(Instant::now() < deadline, "no child under {root}: {tree:?}");
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut sampler = Sampler::new(Box::new(System::new()));
        let sessions = shells(&[("t", Some(root))]);
        let first = sampler.sample(&ids(&["t"]), &sessions, Instant::now()).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].cpu_percent, first[0].processes, first[0].partial), (None, 2, false), "{first:?}");
        assert!(first[0].memory_bytes > 0);
        std::thread::sleep(Duration::from_millis(50));
        let second = sampler.sample(&ids(&["t"]), &sessions, Instant::now()).unwrap();
        assert!(second[0].cpu_percent.is_some_and(|cpu| cpu >= 0.0), "{second:?}");
        // SAFETY: a plain call, on the child this test started.
        unsafe { libc::kill(child as libc::pid_t, libc::SIGKILL) };
        let _ = shell.kill();
        let _ = shell.wait();
    }

    /// This process's CPU time as listed agrees with what the clock of its
    /// own CPU time says: nanoseconds, not Mach ticks (off ~40× on Apple
    /// Silicon) nor clock ticks.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_s_cpu_time_is_in_nanoseconds() {
        fn own_cpu_ns() -> u64 {
            // SAFETY: a zeroed timespec, filled by the call.
            let mut now: libc::timespec = unsafe { std::mem::zeroed() };
            // SAFETY: as above.
            assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut now) }, 0);
            now.tv_sec as u64 * 1_000_000_000 + now.tv_nsec as u64
        }
        // Burn a little CPU so there is something to compare.
        let spin = Instant::now();
        let mut x = 0u64;
        while spin.elapsed() < Duration::from_millis(300) {
            x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
        }
        let me = std::process::id();
        let before = own_cpu_ns();
        let listing = System::new().processes(&[me]).expect("a listing");
        let after = own_cpu_ns();
        let Some(Process { seen: Seen::Read(reading), .. }) = listing.iter().find(|p| p.pid == me).copied() else {
            panic!("this process is not read");
        };
        // Linux counts in ticks of 10 ms, and both sample the same clock a
        // moment apart; a wrong unit is off by a factor of 40 or 10^7.
        let slack = 60 * MS;
        assert!(
            reading.cpu_ns + slack >= before * 8 / 10 && reading.cpu_ns <= after * 12 / 10 + slack,
            "listed {} ns, the clock {before}..{after} ns",
            reading.cpu_ns
        );
        assert!(reading.resident_bytes > 0);
    }

    /// Windows (review A-R1): this process reads through OpenProcess with
    /// limited query rights, GetProcessTimes and K32GetProcessMemoryInfo —
    /// a call that fails is named — with a working set, a creation time that
    /// is a FILETIME in the past, and CPU time in nanoseconds.
    #[cfg(windows)]
    #[test]
    fn this_process_reads_on_windows() {
        // Burn a little CPU so there is something to measure.
        let spin = Instant::now();
        let mut x = 0u64;
        while spin.elapsed() < Duration::from_millis(300) {
            x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
        }
        let me = std::process::id();
        let reading = match platform::query(me) {
            Ok(reading) => reading,
            Err((call, e)) => panic!("{call} failed for this very process: {e}"),
        };
        assert!(reading.resident_bytes > 0, "{reading:?}");
        // 100 ns units since 1601, as the system clock counts them.
        let since_1970 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
        let now = u64::try_from(since_1970.as_nanos() / 100).unwrap() + 116_444_736_000_000_000;
        let year_2020 = 132_223_104_000_000_000;
        assert!((year_2020..=now + 10_000_000).contains(&reading.start), "created at {} of {now}", reading.start);
        // At least most of the 300 ms just spent (Windows counts in ~16 ms
        // ticks; unconverted 100 ns units would be 3 ms), at most every core
        // busy all the time this process has been alive.
        let alive_ns = now.saturating_sub(reading.start).saturating_mul(100);
        let cores = std::thread::available_parallelism().map_or(64, |n| n.get() as u64);
        assert!(reading.cpu_ns >= 150 * MS, "{} ns of CPU", reading.cpu_ns);
        assert!(reading.cpu_ns <= alive_ns.saturating_mul(cores) + 100 * MS, "{} ns of CPU in {alive_ns} ns", reading.cpu_ns);
        // And the same through the listing.
        let listing = System::new().processes(&[me]).expect("a snapshot");
        let seen = listing.iter().find(|p| p.pid == me).map(|p| p.seen);
        assert!(matches!(seen, Some(Seen::Read(r)) if r.resident_bytes > 0), "{seen:?}");
    }

    /// Windows (review A-R1): a child this process started is in its tree,
    /// read with a working set, kept by the stale-parent rule (it started
    /// after this process), and counted by the sampler.
    #[cfg(windows)]
    #[test]
    fn a_real_child_is_in_this_process_s_tree_on_windows() {
        /// Ends the child however the test ends.
        struct Killed(std::process::Child);
        impl Drop for Killed {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Killed(
            std::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("ping starts"),
        );
        let (me, pid) = (std::process::id(), child.0.id());
        let listing = System::new().processes(&[me]).expect("a snapshot");
        assert!(family(me, &parentage(&listing, true)).contains(&pid), "{pid} is not under {me}");
        let seen = listing.iter().find(|p| p.pid == pid).map(|p| p.seen);
        match seen {
            Some(Seen::Read(reading)) => assert!(reading.resident_bytes > 0, "{reading:?}"),
            other => panic!("the child could not be read: {other:?}; {:?}", platform::query(pid).err()),
        }
        let mut sampler = Sampler::new(Box::new(System::new()));
        let got = sampler.sample(&ids(&["t"]), &shells(&[("t", Some(me))]), Instant::now()).unwrap();
        assert!(got[0].processes >= 2 && got[0].memory_bytes > 0, "{got:?}");
        drop(child);
    }

    /// A busy child reads as a plausible share of one core: about 100, not 2
    /// (unconverted Mach ticks) nor thousands.
    #[cfg(unix)]
    #[test]
    fn a_busy_child_reads_about_one_core() {
        let mut busy = std::process::Command::new("yes")
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("yes starts");
        let sessions = shells(&[("busy", Some(busy.id()))]);
        let mut sampler = Sampler::new(Box::new(System::new()));
        std::thread::sleep(Duration::from_millis(100));
        sampler.sample(&ids(&["busy"]), &sessions, Instant::now()).unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        let got = sampler.sample(&ids(&["busy"]), &sessions, Instant::now()).unwrap();
        let _ = busy.kill();
        let _ = busy.wait();
        let cpu = got[0].cpu_percent.expect("a second sample has a figure");
        assert!((10.0..=200.0).contains(&cpu), "`yes` at {cpu}% of a core");
    }
}
