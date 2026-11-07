//! The Unix socket (macOS, Linux), and who is behind it.
//!
//! NexTerm puts its socket in a folder only its user can enter (D1: owned by
//! the user, not a link, mode 0700), so nobody else can create a socket of
//! that name first. The CLI checks the same before connecting — the folder
//! and the socket are ours and the folder is closed to others — and after
//! connecting, the uid of the process at the other end (getpeereid on macOS,
//! SO_PEERCRED on Linux). The last check is the one that settles it: it holds
//! even if something changed between the look and the connect.

use std::fs;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Instant;

use super::{Address, Failure, NOT_RUNNING};

#[derive(Clone, Debug)]
pub struct Identity {
    pub uid: u32,
}

impl Identity {
    pub fn current() -> Result<Identity, Failure> {
        // SAFETY: getuid has no failure case and touches no memory of ours.
        Ok(Identity { uid: unsafe { libc::getuid() } })
    }
}

/// Connects to the socket at `address` once it has been shown to be `me`'s.
/// (`_by` is for the pipe's busy wait on Windows; a Unix connect does not
/// queue that way, and the caller's timeout covers it.)
pub fn connect(address: &Address, me: &Identity, _by: Instant) -> Result<UnixStream, Failure> {
    connect_as(Path::new(address.as_str()), me.uid, me.uid)
}

/// `owner` must own the folder and the socket, and `peer` must be the uid
/// that answers — both this user, except in a test that plays another one
/// at the far end. A refused stream is dropped here: nothing was written.
fn connect_as(path: &Path, owner: u32, peer: u32) -> Result<UnixStream, Failure> {
    check_path(path, owner)?;
    let stream = UnixStream::connect(path).map_err(|e| cannot_connect(path, &e))?;
    check_peer(&stream, peer)?;
    Ok(stream)
}

fn cannot_connect(path: &Path, e: &io::Error) -> Failure {
    match e.kind() {
        // Gone, or a socket file left behind with nobody listening.
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => Failure::unreachable(NOT_RUNNING),
        _ => Failure::unreachable(format!("cannot connect to NexTerm at {}: {e}", path.display())),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Folder,
    Socket,
    Link,
    Other,
}

/// What the checks look at in one directory entry, read without following a link.
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub kind: EntryKind,
    pub uid: u32,
    pub mode: u32,
}

fn entry(path: &Path) -> io::Result<Entry> {
    let meta = fs::symlink_metadata(path)?;
    let t = meta.file_type();
    let kind = if t.is_symlink() {
        EntryKind::Link
    } else if t.is_dir() {
        EntryKind::Folder
    } else if t.is_socket() {
        EntryKind::Socket
    } else {
        EntryKind::Other
    };
    Ok(Entry { kind, uid: meta.uid(), mode: meta.mode() })
}

fn refusing(what: &Path, why: &str) -> Failure {
    Failure::refused(format!("refusing to talk to NexTerm at {}: {why}", what.display()))
}

/// The socket's folder: ours, a real folder (not a link), mode 0700.
pub fn check_folder(folder: &Path, e: Entry, uid: u32) -> Result<(), Failure> {
    match e.kind {
        EntryKind::Folder => {}
        EntryKind::Link => return Err(refusing(folder, "its folder is a link")),
        EntryKind::Socket | EntryKind::Other => return Err(refusing(folder, "its folder is not a folder")),
    }
    if e.uid != uid {
        return Err(Failure::refused(format!(
            "refusing to talk to a socket in a folder owned by another user ({}, uid {})",
            folder.display(),
            e.uid
        )));
    }
    let mode = e.mode & 0o7777;
    if mode != 0o700 {
        return Err(refusing(folder, &format!("its folder is mode {mode:o}, not 700, so others could have put the socket there")));
    }
    Ok(())
}

/// The socket itself: ours, and a socket (not a link to one).
pub fn check_socket(socket: &Path, e: Entry, uid: u32) -> Result<(), Failure> {
    match e.kind {
        EntryKind::Socket => {}
        EntryKind::Link => return Err(refusing(socket, "it is a link")),
        EntryKind::Folder | EntryKind::Other => return Err(refusing(socket, "it is not a socket")),
    }
    if e.uid != uid {
        return Err(Failure::refused(format!(
            "refusing to talk to a socket owned by another user ({}, uid {})",
            socket.display(),
            e.uid
        )));
    }
    Ok(())
}

/// Both checks on the real files. A missing folder or socket means NexTerm
/// is not running or its control is off; anything else that stops the look
/// is a refusal.
pub fn check_path(socket: &Path, uid: u32) -> Result<(), Failure> {
    let folder = socket
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| refusing(socket, "it has no folder"))?;
    let look = |p: &Path| {
        entry(p).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => {
                Failure::unreachable(NOT_RUNNING)
            }
            _ => refusing(p, &format!("cannot check it: {e}")),
        })
    };
    check_folder(folder, look(folder)?, uid)?;
    check_socket(socket, look(socket)?, uid)
}

/// The process at the other end runs as `uid`.
pub fn check_peer(stream: &UnixStream, uid: u32) -> Result<(), Failure> {
    let peer = peer_uid(stream).map_err(|e| Failure::refused(format!("refusing to talk to NexTerm: cannot tell who answers ({e})")))?;
    if peer != uid {
        return Err(Failure::refused(format!("refusing to talk to a socket served by another user (uid {peer})")));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    // SAFETY: ucred is plain data; all zeros is a valid value.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    cred.uid = libc::uid_t::MAX;
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for writes of the sizes given, and
    // the descriptor stays open for the life of `stream`.
    let r = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast::<libc::c_void>(),
            &mut len,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::other("SO_PEERCRED returned a short answer"));
    }
    Ok(cred.uid)
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid: libc::uid_t = libc::uid_t::MAX;
    let mut gid: libc::gid_t = libc::gid_t::MAX;
    // SAFETY: both pointers are valid for one write each, and the descriptor
    // stays open for the life of `stream`.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::transport::{exchange, FailureKind, Timeouts};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    fn me() -> u32 {
        Identity::current().unwrap().uid
    }

    /// A fresh folder of ours, mode 0700, short enough for a socket path
    /// (macOS allows 104 bytes and its temp folder is long).
    pub struct TempDir(pub PathBuf);
    impl TempDir {
        pub fn new() -> TempDir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let name = format!("ncli-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst));
            let mut base = std::env::temp_dir();
            if base.join(&name).join("c.sock").as_os_str().len() > 100 {
                base = PathBuf::from("/tmp");
            }
            let dir = base.join(name);
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            TempDir(dir)
        }
        pub fn socket(&self) -> PathBuf {
            self.0.join("c.sock")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn folder(uid: u32, mode: u32) -> Entry {
        Entry { kind: EntryKind::Folder, uid, mode: 0o040000 | mode }
    }
    fn socket(uid: u32) -> Entry {
        Entry { kind: EntryKind::Socket, uid, mode: 0o140000 | 0o600 }
    }

    #[test]
    fn the_folder_must_be_ours_closed_and_real() {
        let p = Path::new("/x/control");
        assert!(check_folder(p, folder(501, 0o700), 501).is_ok());
        for (e, why) in [
            (folder(502, 0o700), "another user"),
            (folder(501, 0o755), "mode 755"),
            (folder(501, 0o750), "mode 750"),
            (folder(501, 0o701), "mode 701"),
            (folder(501, 0o1700), "mode 1700"),
            (Entry { kind: EntryKind::Link, uid: 501, mode: 0o120777 }, "a link"),
            (Entry { kind: EntryKind::Other, uid: 501, mode: 0o100600 }, "not a folder"),
        ] {
            let f = check_folder(p, e, 501).unwrap_err();
            assert_eq!(f.kind, FailureKind::Refused, "{why}");
            assert!(f.message.contains(why), "{why}: {}", f.message);
        }
    }

    #[test]
    fn the_socket_must_be_ours_and_a_socket() {
        let p = Path::new("/x/control/1.sock");
        assert!(check_socket(p, socket(501), 501).is_ok());
        for (e, why) in [
            (socket(0), "owned by another user"),
            (Entry { kind: EntryKind::Link, uid: 501, mode: 0o120777 }, "a link"),
            (Entry { kind: EntryKind::Other, uid: 501, mode: 0o100600 }, "not a socket"),
            (folder(501, 0o700), "not a socket"),
        ] {
            let f = check_socket(p, e, 501).unwrap_err();
            assert_eq!(f.kind, FailureKind::Refused, "{why}");
            assert!(f.message.contains(why), "{why}: {}", f.message);
        }
    }

    #[test]
    fn checks_on_real_files() {
        let dir = TempDir::new();
        let path = dir.socket();
        // Nothing there yet: not running, or its control turned off (which
        // removes the socket) — the caller cannot tell which, and is told so.
        let f = check_path(&path, me()).unwrap_err();
        assert_eq!((f.kind, f.message.as_str()), (FailureKind::Unreachable, NOT_RUNNING));
        let missing = dir.0.join("gone").join("c.sock");
        let f = check_path(&missing, me()).unwrap_err();
        assert_eq!((f.kind, f.message.as_str()), (FailureKind::Unreachable, NOT_RUNNING));

        let _listener = UnixListener::bind(&path).unwrap();
        assert!(check_path(&path, me()).is_ok());
        // Someone else's (as far as the check knows).
        assert_eq!(check_path(&path, me().wrapping_add(1)).unwrap_err().kind, FailureKind::Refused);

        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o755)).unwrap();
        let f = check_path(&path, me()).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert!(f.message.contains("mode 755"), "{}", f.message);
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();

        // The folder reached through a link: refused, though the link points
        // at the right place.
        let link_dir = TempDir::new();
        let link = link_dir.0.join("via");
        std::os::unix::fs::symlink(&dir.0, &link).unwrap();
        let f = check_path(&link.join("c.sock"), me()).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert!(f.message.contains("link"), "{}", f.message);

        // A plain file where the socket should be.
        let file = dir.0.join("plain.sock");
        fs::write(&file, b"").unwrap();
        let f = check_path(&file, me()).unwrap_err();
        assert!(f.message.contains("not a socket"), "{}", f.message);

        // A link to the real socket.
        let sock_link = dir.0.join("link.sock");
        std::os::unix::fs::symlink(&path, &sock_link).unwrap();
        let f = check_path(&sock_link, me()).unwrap_err();
        assert!(f.message.contains("it is a link"), "{}", f.message);
    }

    #[test]
    fn the_peer_must_run_as_us() {
        let dir = TempDir::new();
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let client = UnixStream::connect(dir.socket()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        assert!(check_peer(&client, me()).is_ok());
        let f = check_peer(&client, me().wrapping_add(1)).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert!(f.message.contains("another user"), "{}", f.message);
        assert_eq!(peer_uid(&client).unwrap(), me());
    }

    #[test]
    fn a_socket_answered_by_another_user_gets_nothing() {
        let dir = TempDir::new();
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut all = Vec::new();
            std::io::Read::read_to_end(&mut s, &mut all).unwrap();
            all
        });
        // The files are ours, but the process at the other end is not.
        let f = connect_as(&dir.socket(), me(), me().wrapping_add(1)).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert!(f.message.contains("served by another user"), "{}", f.message);
        assert!(server.join().unwrap().is_empty(), "nothing reached the other end");
        // And as ourselves the same socket is fine.
        let listener_dir = TempDir::new();
        let _listener = UnixListener::bind(listener_dir.socket()).unwrap();
        assert!(connect_as(&listener_dir.socket(), me(), me()).is_ok());
    }

    /// Accepts one connection, reads one line, answers `answer` (if any) and
    /// returns what it read.
    pub fn serve_once(listener: UnixListener, answer: Option<&'static str>) -> thread::JoinHandle<String> {
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut stream = stream;
            if let Some(a) = answer {
                stream.write_all(a.as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
            } else {
                thread::sleep(Duration::from_millis(1500));
            }
            line
        })
    }

    const QUICK: Timeouts = Timeouts { connect: Duration::from_millis(500), answer: Duration::from_millis(300) };

    #[test]
    fn one_request_one_answer_through_a_real_socket() {
        let dir = TempDir::new();
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = serve_once(listener, Some(r#"{"v":1,"id":1,"ok":true,"result":"tab-term-5"}"#));
        let address = crate::transport::parse_address(dir.socket().as_os_str()).unwrap();
        let request = b"{\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"list\",\"args\":{}}\n";
        let answer = exchange(&address, request, &Identity { uid: me() }, QUICK).unwrap();
        assert_eq!(answer, br#"{"v":1,"id":1,"ok":true,"result":"tab-term-5"}"#);
        assert_eq!(server.join().unwrap().as_bytes(), request);
    }

    #[test]
    fn a_refusal_means_no_connection_at_all() {
        let dir = TempDir::new();
        let listener = UnixListener::bind(dir.socket()).unwrap();
        listener.set_nonblocking(true).unwrap();
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o755)).unwrap();
        let address = crate::transport::parse_address(dir.socket().as_os_str()).unwrap();
        let f = exchange(&address, b"{\"token\":\"secret\"}\n", &Identity { uid: me() }, QUICK).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert!(!f.message.contains("secret"));
        // Nobody knocked: the token never left.
        assert_eq!(listener.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock);
        // And as another user (the folder check fails first, then nothing connects).
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();
        let f = exchange(&address, b"x\n", &Identity { uid: me().wrapping_add(1) }, QUICK).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert_eq!(listener.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }

    #[test]
    fn a_silent_server_times_out_as_not_responding() {
        let dir = TempDir::new();
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = serve_once(listener, None);
        let address = crate::transport::parse_address(dir.socket().as_os_str()).unwrap();
        let started = Instant::now();
        let f = exchange(&address, b"{}\n", &Identity { uid: me() }, QUICK).unwrap_err();
        assert_eq!(f.kind, FailureKind::NotResponding);
        assert!(f.message.contains("not responding"), "{}", f.message);
        assert!(started.elapsed() < Duration::from_millis(1200), "{:?}", started.elapsed());
        server.join().unwrap();
    }

    #[test]
    fn a_server_that_hangs_up_or_is_gone() {
        let dir = TempDir::new();
        let address = crate::transport::parse_address(dir.socket().as_os_str()).unwrap();
        // A socket file with no listener behind it (a crashed NexTerm).
        drop(UnixListener::bind(dir.socket()).unwrap());
        let f = exchange(&address, b"{}\n", &Identity { uid: me() }, QUICK).unwrap_err();
        assert_eq!((f.kind, f.message.as_str()), (FailureKind::Unreachable, NOT_RUNNING));
        fs::remove_file(dir.socket()).unwrap();

        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            drop(s);
        });
        let f = exchange(&address, b"{}\n", &Identity { uid: me() }, QUICK).unwrap_err();
        assert_eq!(f.kind, FailureKind::Unreachable, "{}", f.message);
        server.join().unwrap();
    }
}
