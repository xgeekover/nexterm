//! Reaching NexTerm: the Unix socket (macOS, Linux) or the named pipe
//! (Windows) that `NEXTERM_CONTROL` names — and making sure it is this
//! user's before anything is written to it, the token above all.
//!
//! The threat (spec, "Another user squatting the name"): someone else on the
//! machine creates the socket or pipe first and collects the token of every
//! CLI that connects. On Unix the socket must sit in a folder of ours that
//! nobody else can enter, and the process that answers must run as us
//! (unix.rs). On Windows the process serving the pipe must run as us
//! (windows.rs). Only then is the request written.
//!
//! Timeouts (D3 and the CLI's own): 2 s to connect, 5 s for the answer —
//! longer than NexTerm's own 3 s per request, so its `not_responding` arrives
//! before ours. Every blocking call runs on one worker thread and the caller
//! waits on a channel, so no read, write or connect can outlast them.

use std::io::{self, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use crate::exit;
use crate::protocol::MAX_ANSWER_BYTES;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{connect, Identity};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{connect, Identity};

#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub connect: Duration,
    pub answer: Duration,
}

pub const TIMEOUTS: Timeouts = Timeouts { connect: Duration::from_secs(2), answer: Duration::from_secs(5) };

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// Not this user's socket or pipe, or not an address of NexTerm's: the
    /// token was not sent.
    Refused,
    /// Nothing there, or nothing listening: NexTerm is not running (any
    /// more), or its control is off — turning it off closes the listener
    /// rather than answering `disabled`.
    Unreachable,
    /// Something is there but does not take the connection or answer in time.
    NotResponding,
    /// An answer too large to be one.
    BadAnswer,
}

impl FailureKind {
    pub fn exit_code(self) -> u8 {
        match self {
            FailureKind::Refused => exit::REFUSED,
            FailureKind::Unreachable | FailureKind::NotResponding => exit::NOT_RESPONDING,
            FailureKind::BadAnswer => exit::FAILED,
        }
    }
}

#[derive(Debug)]
pub struct Failure {
    pub kind: FailureKind,
    pub message: String,
}

impl Failure {
    pub fn refused(message: impl Into<String>) -> Failure {
        Failure { kind: FailureKind::Refused, message: message.into() }
    }
    pub fn unreachable(message: impl Into<String>) -> Failure {
        Failure { kind: FailureKind::Unreachable, message: message.into() }
    }
    pub fn not_responding(message: impl Into<String>) -> Failure {
        Failure { kind: FailureKind::NotResponding, message: message.into() }
    }
}

/// Where NexTerm listens, checked for its form (not yet for its owner).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address(String);

impl Address {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a caller sees when NEXTERM_CONTROL names nothing that answers.
/// Turning the API off (Settings ▸ Terminal ▸ Control) closes the socket or
/// pipe, so from here that looks exactly like NexTerm having quit.
pub const NOT_RUNNING: &str =
    "NexTerm is not running, or its control is turned off (Settings ▸ Terminal ▸ Control)";

const PIPE_PREFIX: &str = r"\\.\pipe\";
const PIPE_NAME_PREFIX: &str = "nexterm-";

/// A pipe on THIS computer, named as NexTerm names its pipes
/// (`\\.\pipe\nexterm-<hex>`). `\\host\pipe\…` would carry the token over
/// SMB to another machine, and a pipe there could still pass the owner check
/// by pid; any other form is not what NexTerm sets.
pub fn is_local_pipe_name(raw: &str) -> bool {
    let Some(head) = raw.get(..PIPE_PREFIX.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(PIPE_PREFIX) {
        return false;
    }
    let name = &raw[PIPE_PREFIX.len()..];
    match name.strip_prefix(PIPE_NAME_PREFIX) {
        Some(id) => !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        None => false,
    }
}

/// `NEXTERM_CONTROL`, checked for the form this OS uses.
pub fn parse_address(raw: &std::ffi::OsStr) -> Result<Address, Failure> {
    let Some(raw) = raw.to_str() else {
        return Err(Failure::refused("NEXTERM_CONTROL is not a NexTerm address (not valid text)"));
    };
    parse_address_str(raw)
}

#[cfg(windows)]
fn parse_address_str(raw: &str) -> Result<Address, Failure> {
    if is_local_pipe_name(raw) {
        Ok(Address(raw.to_owned()))
    } else {
        Err(Failure::refused(format!(
            "refusing to talk to {}: NEXTERM_CONTROL is not a NexTerm pipe on this computer",
            crate::output::one_line(raw)
        )))
    }
}

#[cfg(unix)]
fn parse_address_str(raw: &str) -> Result<Address, Failure> {
    if is_local_pipe_name(raw) {
        // WSL: the variable came through WSLENV from a Windows NexTerm.
        return Err(Failure::unreachable(
            "NEXTERM_CONTROL names a Windows pipe; from WSL, run nexterm-cli.exe",
        ));
    }
    if !std::path::Path::new(raw).is_absolute() {
        return Err(Failure::refused(format!(
            "refusing to talk to {}: NEXTERM_CONTROL is not an absolute socket path",
            crate::output::one_line(raw)
        )));
    }
    Ok(Address(raw.to_owned()))
}

/// How the program reaches NexTerm; tests put a fake in its place.
pub trait Link {
    /// Sends `request` (one line) and returns the answer line without its LF.
    fn exchange(&self, address: &Address, request: &[u8]) -> Result<Vec<u8>, Failure>;
}

/// The real thing: this user, the real timeouts.
pub struct Live;

impl Link for Live {
    fn exchange(&self, address: &Address, request: &[u8]) -> Result<Vec<u8>, Failure> {
        let me = Identity::current()?;
        exchange(address, request, &me, TIMEOUTS)
    }
}

enum Step {
    Connected,
    Done(Result<Vec<u8>, Failure>),
}

/// Connects to `address`, checks it is `me`'s, sends `request`, reads one
/// line back — each phase within its timeout.
pub fn exchange(address: &Address, request: &[u8], me: &Identity, timeouts: Timeouts) -> Result<Vec<u8>, Failure> {
    let (tx, rx) = mpsc::channel();
    let address = address.clone();
    let request = request.to_vec();
    let me = me.clone();
    let connect_by = Instant::now() + timeouts.connect;
    thread::Builder::new()
        .name("nexterm-cli-io".to_owned())
        .spawn(move || {
            // `connect` checks the owner; nothing is written before it returns.
            let mut conn = match connect(&address, &me, connect_by) {
                Ok(c) => c,
                Err(f) => {
                    let _ = tx.send(Step::Done(Err(f)));
                    return;
                }
            };
            let _ = tx.send(Step::Connected);
            let _ = tx.send(Step::Done(talk(&mut conn, &request)));
        })
        .map_err(|e| Failure::unreachable(format!("cannot start talking to NexTerm: {e}")))?;

    match rx.recv_timeout(timeouts.connect) {
        Ok(Step::Connected) => {}
        Ok(Step::Done(result)) => return result,
        Err(RecvTimeoutError::Timeout) => {
            return Err(Failure::not_responding(format!(
                "NexTerm did not take the connection within {}",
                seconds(timeouts.connect)
            )))
        }
        Err(RecvTimeoutError::Disconnected) => return Err(Failure::unreachable("the connection stopped unexpectedly")),
    }
    match rx.recv_timeout(timeouts.answer) {
        Ok(Step::Done(result)) => result,
        Ok(Step::Connected) => Err(Failure::unreachable("the connection stopped unexpectedly")),
        Err(RecvTimeoutError::Timeout) => Err(Failure::not_responding(format!(
            "NexTerm is not responding (no answer within {})",
            seconds(timeouts.answer)
        ))),
        Err(RecvTimeoutError::Disconnected) => Err(Failure::unreachable("the connection stopped unexpectedly")),
    }
}

fn seconds(d: Duration) -> String {
    if d.subsec_millis() == 0 {
        format!("{} s", d.as_secs())
    } else {
        format!("{} ms", d.as_millis())
    }
}

fn talk<S: Read + Write>(conn: &mut S, request: &[u8]) -> Result<Vec<u8>, Failure> {
    conn.write_all(request)
        .and_then(|()| conn.flush())
        .map_err(|e| Failure::unreachable(format!("NexTerm closed the connection: {e}")))?;
    read_answer(conn, MAX_ANSWER_BYTES)
}

/// One line, without its LF, of at most `cap` bytes. A line cut off by the
/// end of the stream still counts (the JSON decoder judges it).
pub fn read_answer<R: Read>(conn: &mut R, cap: usize) -> Result<Vec<u8>, Failure> {
    let mut line = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let n = match conn.read(&mut chunk) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Failure::unreachable(format!("NexTerm closed the connection: {e}"))),
        };
        if n == 0 {
            if line.is_empty() {
                return Err(Failure::unreachable("NexTerm closed the connection without answering"));
            }
            return Ok(line);
        }
        let got = &chunk[..n];
        let end = got.iter().position(|&b| b == b'\n');
        line.extend_from_slice(&got[..end.unwrap_or(n)]);
        if line.len() > cap {
            return Err(Failure {
                kind: FailureKind::BadAnswer,
                message: format!("NexTerm's answer is larger than {cap} bytes"),
            });
        }
        if end.is_some() {
            return Ok(line);
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn nothing_answering_names_both_reasons() {
        // Turning the API off closes the listener (it never answers
        // `disabled`), so "not running" alone would mislead.
        assert_eq!(NOT_RUNNING, "NexTerm is not running, or its control is turned off (Settings ▸ Terminal ▸ Control)");
        assert_eq!(Failure::unreachable(NOT_RUNNING).kind.exit_code(), 5);
    }

    #[test]
    fn the_timeouts_are_2_and_5_seconds() {
        assert_eq!(TIMEOUTS.connect, Duration::from_secs(2));
        assert_eq!(TIMEOUTS.answer, Duration::from_secs(5));
    }

    #[test]
    fn failure_kinds_to_exit_codes() {
        assert_eq!(FailureKind::Refused.exit_code(), 4);
        assert_eq!(FailureKind::Unreachable.exit_code(), 5);
        assert_eq!(FailureKind::NotResponding.exit_code(), 5);
        assert_eq!(FailureKind::BadAnswer.exit_code(), 1);
    }

    #[test]
    fn only_local_nexterm_pipe_names_pass() {
        for good in [
            r"\\.\pipe\nexterm-0123456789abcdef0123456789abcdef",
            r"\\.\PIPE\nexterm-ABCDEF",
            r"\\.\pipe\nexterm-a_b-c",
        ] {
            assert!(is_local_pipe_name(good), "{good}");
        }
        for bad in [
            r"\\server\pipe\nexterm-0123",
            r"\\localhost\pipe\nexterm-0123",
            r"\\?\pipe\nexterm-0123",
            r"\\.\pipe\nexterm-",
            r"\\.\pipe\other-0123",
            r"\\.\pipe\nexterm-01\..\x",
            r"\\.\pipe\nexterm-01/x",
            r"\\.\pipe\nexterm-01 x",
            r"\\.\pipe\",
            r"\\.\pip",
            "",
            "/tmp/nexterm.sock",
            "\\\\.\\pipe\\nexterm-가",
            "가가가가가가가가가가",
        ] {
            assert!(!is_local_pipe_name(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_addresses_are_absolute_socket_paths() {
        assert_eq!(parse_address(OsStr::new("/run/user/1000/nexterm/1.sock")).unwrap().as_str(), "/run/user/1000/nexterm/1.sock");
        assert_eq!(parse_address(OsStr::new("nexterm.sock")).unwrap_err().kind, FailureKind::Refused);
        let wsl = parse_address(OsStr::new(r"\\.\pipe\nexterm-00ff")).unwrap_err();
        assert!(wsl.message.contains("nexterm-cli.exe"), "{}", wsl.message);
    }

    #[cfg(windows)]
    #[test]
    fn windows_addresses_are_local_pipe_names() {
        let name = r"\\.\pipe\nexterm-00ff";
        assert_eq!(parse_address(OsStr::new(name)).unwrap().as_str(), name);
        for bad in [r"\\host\pipe\nexterm-00ff", r"C:\Users\me\nexterm.sock", "/tmp/x.sock"] {
            assert_eq!(parse_address(OsStr::new(bad)).unwrap_err().kind, FailureKind::Refused, "{bad}");
        }
    }

    #[test]
    fn reading_one_answer_line() {
        let mut two = &b"{\"ok\":true}\n{\"ok\":false}\n"[..];
        assert_eq!(read_answer(&mut two, 100).unwrap(), b"{\"ok\":true}");
        let mut cut = &b"{\"ok\":true}"[..];
        assert_eq!(read_answer(&mut cut, 100).unwrap(), b"{\"ok\":true}");
        let mut nothing = &b""[..];
        let e = read_answer(&mut nothing, 100).unwrap_err();
        assert_eq!(e.kind, FailureKind::Unreachable);
        let exact = [b'x'; 100];
        assert_eq!(read_answer(&mut &exact[..], 100).unwrap().len(), 100);
        let mut big = vec![b'x'; 101];
        big.push(b'\n');
        assert_eq!(read_answer(&mut &big[..], 100).unwrap_err().kind, FailureKind::BadAnswer);
        let huge = vec![b'x'; MAX_ANSWER_BYTES + 1];
        assert_eq!(read_answer(&mut &huge[..], MAX_ANSWER_BYTES).unwrap_err().kind, FailureKind::BadAnswer);
    }

    /// A Read that yields its bytes a few at a time, like a slow server.
    struct Dribble<'a>(&'a [u8]);
    impl Read for Dribble<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.0.len().min(3).min(buf.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn an_answer_in_pieces_is_one_line() {
        let mut slow = Dribble(b"{\"v\":1,\"id\":1,\"ok\":true,\"result\":\"tab-term-2\"}\nrest");
        assert_eq!(read_answer(&mut slow, 1000).unwrap(), b"{\"v\":1,\"id\":1,\"ok\":true,\"result\":\"tab-term-2\"}");
    }
}
