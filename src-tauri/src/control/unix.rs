//! The Unix socket (spec D1): where it is, who may reach it, and who is at
//! the other end of each connection.
//!
//! **Where.** On Linux `$XDG_RUNTIME_DIR/nexterm` when XDG_RUNTIME_DIR names
//! an absolute folder that is there (per user, on tmpfs, gone at logout);
//! otherwise, and always on macOS, `control` in the app's local data folder
//! (`~/Library/Application Support/com.nexterm.ide/control`). The socket is
//! `<16 random hex digits>.sock`, new at every start: a socket left by a
//! crashed run is never bound again, and is swept once nothing answers it
//! (`sweep`). macOS takes a socket path of at most 103 bytes (104 with its
//! NUL), Linux 107; a longer one is refused with the reason, before anything
//! is bound.
//!
//! **The folder** is made for the owner alone (0700) and checked every time
//! the listener starts: looked at itself (`symlink_metadata`), never through
//! a link; then opened with O_NOFOLLOW, and on that open folder checked to be
//! this user's and made 0700 if anything else could reach it. A link, a
//! file, a folder of another user: refused, and the API does not start. The
//! folders above it are the user's own (or the system's runtime folder) and
//! not this module's to judge — as in src/scrollback.rs, which says why the
//! gap between the look and the bind by path is left described rather than
//! closed: only this user and root can rename entries there.
//!
//! **The socket** is made 0600 once bound, and checked to be the socket we
//! bound. Nobody else can reach it anyway — the folder lets nobody else
//! through — so the moment between the bind and the chmod gives nothing away.
//! It is removed when the listener stops (`SocketFile`), and only if it is
//! still the one we bound.
//!
//! **Each connection** is checked to come from this user: the peer's
//! effective uid, from the kernel (`getpeereid` on macOS and the BSDs,
//! `SO_PEERCRED` on Linux), must be ours, or it is closed unanswered.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::server::Incoming;

/// The folder under XDG_RUNTIME_DIR.
pub const UNDER_RUNTIME_DIR: &str = "nexterm";
/// The folder under the app's local data folder.
pub const UNDER_APP_DATA: &str = "control";
const EXTENSION: &str = ".sock";

/// This process's effective uid: whom the folder, the socket and every peer
/// must belong to.
pub fn our_uid() -> libc::uid_t {
    // SAFETY: geteuid cannot fail.
    unsafe { libc::geteuid() }
}

/// The socket's folder (see the module's doc).
pub fn folder(xdg_runtime_dir: Option<&OsStr>, app_local_data: &Path) -> PathBuf {
    folder_for(cfg!(target_os = "linux"), xdg_runtime_dir, app_local_data)
}

fn folder_for(linux: bool, xdg_runtime_dir: Option<&OsStr>, app_local_data: &Path) -> PathBuf {
    if linux {
        if let Some(runtime) = xdg_runtime_dir.map(Path::new) {
            if runtime.is_absolute() && runtime.is_dir() {
                return runtime.join(UNDER_RUNTIME_DIR);
            }
        }
    }
    app_local_data.join(UNDER_APP_DATA)
}

/// The most bytes a socket path may have here, its NUL not counted.
fn longest_path() -> usize {
    // SAFETY: a sockaddr_un of zeros is a valid value; only its size is read.
    let addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_path.len() - 1
}

/// `<instance>.sock` in `dir`, or why it cannot be bound.
fn socket_path(dir: &Path, instance: &str) -> Result<PathBuf, String> {
    let path = dir.join(format!("{instance}{EXTENSION}"));
    let len = path.as_os_str().len();
    if len > longest_path() {
        return Err(format!(
            "the control socket's path is {len} bytes, and this system takes at most {}: {}",
            longest_path(),
            path.display()
        ));
    }
    Ok(path)
}

/// Whether `name` is one of ours: 16 lowercase hex digits and `.sock`.
fn is_instance_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else { return false };
    let Some(stem) = name.strip_suffix(EXTENSION) else { return false };
    stem.len() == 16 && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The folder made if it is not there, and checked (see the module's doc):
/// this user's, not a link, 0700.
pub fn prepare(dir: &Path, uid: libc::uid_t) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{} could not be made: {e}", parent.display()))?;
    }
    match fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{} could not be made: {e}", dir.display())),
    }
    let looked = fs::symlink_metadata(dir).map_err(|e| format!("{} could not be looked at: {e}", dir.display()))?;
    if looked.file_type().is_symlink() {
        return Err(format!("{} is a link \u{2014} NexTerm keeps its control socket in no folder reached through one", dir.display()));
    }
    if !looked.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    // What is checked and tightened from here on is the folder itself, open:
    // a link put in its place meanwhile fails to open.
    let opened = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)
        .map_err(|e| format!("{} could not be opened as a folder: {e}", dir.display()))?;
    let meta = opened.metadata().map_err(|e| format!("{} could not be looked at: {e}", dir.display()))?;
    if meta.uid() != uid {
        return Err(format!("{} belongs to another user (uid {}), not to this one (uid {uid})", dir.display(), meta.uid()));
    }
    if meta.mode() & 0o7777 != 0o700 {
        opened
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{} could not be made private: {e}", dir.display()))?;
        let mode = opened.metadata().map_err(|e| format!("{}: {e}", dir.display()))?.mode() & 0o7777;
        if mode != 0o700 {
            return Err(format!("{} stays mode {mode:o}, not 700", dir.display()));
        }
    }
    Ok(())
}

/// A socket we bound, removed when this is dropped — if it is still ours.
#[derive(Debug)]
pub struct SocketFile {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

impl SocketFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SocketFile {
    fn drop(&mut self) {
        if let Ok(meta) = fs::symlink_metadata(&self.path) {
            if meta.file_type().is_socket() && meta.dev() == self.dev && meta.ino() == self.ino {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[derive(Debug)]
pub struct Bound {
    pub listener: std::os::unix::net::UnixListener,
    pub file: SocketFile,
}

/// A new socket in `dir`, ready for tokio.
pub fn bind(dir: &Path) -> Result<Bound, String> {
    let uid = our_uid();
    prepare(dir, uid)?;
    let instance = getrandom::u64().map_err(|e| format!("no random name could be had: {e}"))?;
    let path = socket_path(dir, &format!("{instance:016x}"))?;
    // A name that is there already is never taken over: the bind fails.
    let listener = std::os::unix::net::UnixListener::bind(&path)
        .map_err(|e| format!("the control socket {} could not be made: {e}", path.display()))?;
    let checked = (|| {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| format!("could not be made private: {e}"))?;
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("could not be looked at: {e}"))?;
        if !meta.file_type().is_socket() || meta.uid() != uid || meta.mode() & 0o777 != 0o600 {
            return Err(format!("is not the private socket just made (mode {:o}, uid {})", meta.mode() & 0o7777, meta.uid()));
        }
        listener.set_nonblocking(true).map_err(|e| format!("could not be made non-blocking: {e}"))?;
        Ok(SocketFile { path: path.clone(), dev: meta.dev(), ino: meta.ino() })
    })();
    match checked {
        Ok(file) => Ok(Bound { listener, file }),
        Err(why) => {
            let _ = fs::remove_file(&path);
            Err(format!("the control socket {} {why}", path.display()))
        }
    }
}

/// The effective uid of the process at the other end of the connected
/// socket `fd`, from the kernel.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn peer_uid(fd: RawFd) -> io::Result<libc::uid_t> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` is a ucred and `len` its size, as SO_PEERCRED fills.
    let done = unsafe {
        libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
    };
    if done != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::other("SO_PEERCRED answered short"));
    }
    Ok(cred.uid)
}

/// The effective uid of the process at the other end of the connected
/// socket `fd`, from the kernel.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub fn peer_uid(fd: RawFd) -> io::Result<libc::uid_t> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: two out-parameters of the types getpeereid writes.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// Whether the peer of `fd` is `uid`. Anything that cannot be told is no.
pub fn peer_is(fd: RawFd, uid: libc::uid_t) -> bool {
    matches!(peer_uid(fd), Ok(peer) if peer == uid)
}

/// Connections on the socket, from this user alone.
pub struct UnixIncoming {
    listener: tokio::net::UnixListener,
    uid: libc::uid_t,
    turned_away: u64,
}

impl UnixIncoming {
    pub fn new(listener: tokio::net::UnixListener) -> Self {
        UnixIncoming { listener, uid: our_uid(), turned_away: 0 }
    }
}

impl Incoming for UnixIncoming {
    type Stream = tokio::net::UnixStream;

    async fn accept(&mut self) -> io::Result<Option<tokio::net::UnixStream>> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            if peer_is(stream.as_raw_fd(), self.uid) {
                return Ok(Some(stream));
            }
            // Only root, or a folder loosened behind our back, could get a
            // stranger this far. Said, but not a thousand times.
            self.turned_away += 1;
            if self.turned_away <= 3 {
                eprintln!("[NexTerm] The control API closed a connection from another user");
            }
        }
    }
}

/// Remove what crashed runs left in `dir`: sockets of ours by their name
/// and owner, not `ours`, that refuse a connection three times in a row —
/// nothing listens there. A socket that answers, or cannot be told, stays.
pub async fn sweep(dir: PathBuf, ours: PathBuf) {
    let uid = our_uid();
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == ours || !is_instance_name(&entry.file_name()) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if !meta.file_type().is_socket() || meta.uid() != uid {
            continue;
        }
        if nothing_listens(&path).await {
            // Still the same file it was when it was looked at.
            if fs::symlink_metadata(&path).is_ok_and(|now| now.ino() == meta.ino() && now.dev() == meta.dev()) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

async fn nothing_listens(path: &Path) -> bool {
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        match tokio::time::timeout(Duration::from_secs(1), tokio::net::UnixStream::connect(path)).await {
            Ok(Err(e)) if e.kind() == ErrorKind::ConnectionRefused => {}
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::super::tests::Scratch;
    use super::*;
    use std::os::unix::net::UnixStream;

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o7777
    }

    #[test]
    fn linux_uses_the_runtime_folder_when_it_is_there_and_everything_else_the_app_s() {
        let scratch = Scratch::new("xdg");
        let runtime = scratch.0.join("run");
        fs::create_dir(&runtime).unwrap();
        let data = Path::new("/home/u/.local/share/com.nexterm.ide");
        assert_eq!(folder_for(true, Some(runtime.as_os_str()), data), runtime.join("nexterm"));
        assert_eq!(folder_for(true, None, data), data.join("control"));
        assert_eq!(folder_for(true, Some(OsStr::new("relative/run")), data), data.join("control"));
        assert_eq!(folder_for(true, Some(scratch.0.join("gone").as_os_str()), data), data.join("control"));
        assert_eq!(folder_for(false, Some(runtime.as_os_str()), data), data.join("control"), "macOS never");
    }

    #[test]
    fn the_folder_is_made_for_the_owner_alone_and_the_socket_0600() {
        let scratch = Scratch::new("mode");
        let dir = scratch.0.join("app").join("control");
        let bound = bind(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        let path = bound.file.path().to_path_buf();
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        assert_eq!(mode(&path), 0o600);
        assert!(is_instance_name(path.file_name().unwrap()), "{}", path.display());
        drop(bound);
        assert!(!path.exists(), "removed with its listener");
    }

    #[test]
    fn a_folder_anyone_else_can_reach_is_tightened() {
        let scratch = Scratch::new("loose");
        let dir = scratch.0.join("control");
        for loose in [0o755, 0o777, 0o711, 0o1700, 0o500] {
            fs::create_dir_all(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(loose)).unwrap();
            prepare(&dir, our_uid()).unwrap_or_else(|why| panic!("{loose:o}: {why}"));
            assert_eq!(mode(&dir), 0o700, "from {loose:o}");
        }
    }

    #[test]
    fn a_link_or_a_file_in_place_of_the_folder_is_refused() {
        let scratch = Scratch::new("link");
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o700)).unwrap();
        let dir = scratch.0.join("control");
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        let why = bind(&dir).unwrap_err();
        assert!(why.contains("is a link"), "{why}");
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "nothing was made through it");

        // A link to nowhere, too.
        fs::remove_file(&dir).unwrap();
        std::os::unix::fs::symlink(scratch.0.join("nowhere"), &dir).unwrap();
        assert!(bind(&dir).unwrap_err().contains("is a link"));

        fs::remove_file(&dir).unwrap();
        fs::write(&dir, b"").unwrap();
        assert!(bind(&dir).unwrap_err().contains("not a folder"));
    }

    #[test]
    fn a_folder_of_another_user_is_refused() {
        // Only root could give the folder away; whose it must be is what
        // is under test.
        let scratch = Scratch::new("own");
        let dir = scratch.0.join("control");
        let why = prepare(&dir, our_uid() + 1).unwrap_err();
        assert!(why.contains("belongs to another user"), "{why}");
        prepare(&dir, our_uid()).unwrap();
    }

    #[test]
    fn a_path_longer_than_the_system_takes_is_refused_before_anything_is_bound() {
        let scratch = Scratch::new("len");
        // `<scratch>/<d…>/<16 hex>.sock`: the scratch, two separators and 21.
        let room = longest_path() - scratch.0.as_os_str().len() - 2 - 21;
        let fits = scratch.0.join("d".repeat(room));
        let bound = bind(&fits).unwrap_or_else(|why| panic!("{why}"));
        assert_eq!(bound.file.path().as_os_str().len(), longest_path(), "the longest there may be");
        let over = scratch.0.join("d".repeat(room + 1));
        let why = bind(&over).unwrap_err();
        assert!(why.contains(&format!("at most {}", longest_path())), "{why}");
        assert_eq!(fs::read_dir(&over).unwrap().count(), 0);
        #[cfg(target_os = "macos")]
        assert_eq!(longest_path(), 103);
        #[cfg(target_os = "linux")]
        assert_eq!(longest_path(), 107);
    }

    #[test]
    fn every_bind_is_a_new_name_and_a_socket_put_in_our_place_is_not_removed() {
        let scratch = Scratch::new("new");
        let dir = scratch.0.join("control");
        let one = bind(&dir).unwrap();
        let two = bind(&dir).unwrap();
        assert_ne!(one.file.path(), two.file.path());
        // Replaced behind our back: not ours to remove.
        let path = one.file.path().to_path_buf();
        fs::remove_file(&path).unwrap();
        let stranger = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(one);
        assert!(path.exists(), "the replacement stays");
        drop(stranger);
    }

    #[test]
    fn the_peer_s_uid_comes_from_the_kernel_and_must_be_ours() {
        let (a, b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(a.as_raw_fd()).unwrap(), our_uid());
        assert!(peer_is(b.as_raw_fd(), our_uid()));
        assert!(!peer_is(b.as_raw_fd(), our_uid() + 1), "another uid is refused");
        // Not a socket at all: cannot be told, so no.
        let file = fs::File::open("/dev/null").unwrap();
        assert!(peer_uid(file.as_raw_fd()).is_err());
        assert!(!peer_is(file.as_raw_fd(), our_uid()));
    }

    #[tokio::test]
    async fn a_connection_from_another_uid_is_closed_unanswered() {
        let scratch = Scratch::new("peer");
        let bound = bind(&scratch.0.join("control")).unwrap();
        let listener = tokio::net::UnixListener::from_std(bound.listener).unwrap();
        // Ours, but taken for a stranger's.
        let mut incoming = UnixIncoming { listener, uid: our_uid() + 1, turned_away: 0 };
        let path = bound.file.path().to_path_buf();
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
            let mut buf = [0u8; 1];
            tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await.unwrap()
        });
        let accepted = tokio::time::timeout(Duration::from_millis(500), incoming.accept()).await;
        assert!(accepted.is_err(), "nothing was let through");
        assert_eq!(client.await.unwrap(), 0, "closed with nothing said");
        assert_eq!(incoming.turned_away, 1);
    }

    #[tokio::test]
    async fn the_sweep_removes_sockets_nothing_listens_on_and_keeps_the_rest() {
        let scratch = Scratch::new("sweep");
        let dir = scratch.0.join("control");
        prepare(&dir, our_uid()).unwrap();
        let ours = bind(&dir).unwrap();
        let alive = bind(&dir).unwrap();
        let _alive = tokio::net::UnixListener::from_std(alive.listener).unwrap();
        // A crashed run's: bound, never removed, nothing behind it.
        let dead = dir.join("00000000000000aa.sock");
        drop(std::os::unix::net::UnixListener::bind(&dead).unwrap());
        // Not ours by name, or not a socket: left alone.
        let other = dir.join("other.sock");
        drop(std::os::unix::net::UnixListener::bind(&other).unwrap());
        let file = dir.join("00000000000000bb.sock");
        fs::write(&file, b"").unwrap();

        sweep(dir.clone(), ours.file.path().to_path_buf()).await;
        assert!(!dead.exists(), "the dead socket is swept");
        assert!(ours.file.path().exists());
        assert!(alive.file.path().exists(), "one that answers stays");
        assert!(other.exists() && file.exists());
    }
}
