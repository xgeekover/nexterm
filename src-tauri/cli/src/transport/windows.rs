//! The named pipe (Windows), and who is behind it.
//!
//! NexTerm's pipe has a random name, is created first-instance-only and
//! grants only its user (D1). The CLI cannot see the pipe's DACL from the
//! client side, so it asks who serves it: GetNamedPipeServerProcessId →
//! OpenProcess → OpenProcessToken → the token's user SID, which must be ours.
//! Only then is the request written ("refusing to talk to a pipe owned by
//! another user" otherwise, exit 4).
//!
//! The pipe is opened with SECURITY_IDENTIFICATION: the server may learn who
//! we are (NexTerm checks its client's user) but cannot act as us, which a
//! squatter would otherwise be allowed to by default.

use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_PIPE_BUSY, HANDLE};
use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{Address, Failure, NOT_RUNNING};

/// This user, as the SID in our own process token (its bytes).
#[derive(Clone, Debug)]
pub struct Identity {
    pub sid: Vec<u8>,
}

impl Identity {
    pub fn current() -> Result<Identity, Failure> {
        // SAFETY: the pseudo-handle of the current process needs no closing.
        let process = unsafe { GetCurrentProcess() };
        token_user_sid(process)
            .map(|sid| Identity { sid })
            .map_err(|e| Failure::refused(format!("cannot tell which user this is: {e}")))
    }
}

/// Opens the pipe (waiting while every instance is busy, until `by`), then
/// checks that it is served by `me`.
pub fn connect(address: &Address, me: &Identity, by: Instant) -> Result<File, Failure> {
    let pipe = open_pipe(address.as_str(), by)?;
    check_server(&pipe, me)?;
    Ok(pipe)
}

fn open_pipe(name: &str, by: Instant) -> Result<File, Failure> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    loop {
        let opened = OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
            .open(name);
        match opened {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                let left = by.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(Failure::not_responding("NexTerm is busy: every connection to it is in use"));
                }
                // 0 would mean "the pipe's default wait", not "none".
                let ms = u32::try_from(left.as_millis()).unwrap_or(u32::MAX - 1).max(1);
                // SAFETY: `wide` is NUL-terminated and outlives the call.
                if unsafe { WaitNamedPipeW(wide.as_ptr(), ms) } == 0 {
                    // Gone, or still busy: try again; the deadline ends this.
                    thread::sleep(Duration::from_millis(10));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(Failure::unreachable(NOT_RUNNING));
            }
            Err(e) => return Err(Failure::unreachable(format!("cannot open NexTerm's pipe: {e}"))),
        }
    }
}

/// The process serving `pipe` runs as `me`.
pub fn check_server(pipe: &File, me: &Identity) -> Result<(), Failure> {
    let pid = server_pid(pipe).map_err(|e| {
        Failure::refused(format!("refusing to talk to the pipe: cannot tell which process serves it ({e})"))
    })?;
    let sid = process_user_sid(pid).map_err(|e| {
        Failure::refused(format!("refusing to talk to the pipe: cannot tell which user serves it ({e})"))
    })?;
    if sid != me.sid {
        return Err(Failure::refused("refusing to talk to a pipe owned by another user"));
    }
    Ok(())
}

fn server_pid(pipe: &File) -> io::Result<u32> {
    let mut pid = 0u32;
    // SAFETY: the handle is open for the life of `pipe`; `pid` is one u32.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

fn process_user_sid(pid: u32) -> io::Result<Vec<u8>> {
    // SAFETY: a plain call; a null handle is its failure.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `process` is a handle we now own; OwnedHandle closes it.
    let process = unsafe { OwnedHandle::from_raw_handle(process as RawHandle) };
    token_user_sid(process.as_raw_handle() as HANDLE)
}

/// The user SID of `process`'s token, as bytes (a SID compares by its bytes,
/// which is what EqualSid does).
fn token_user_sid(process: HANDLE) -> io::Result<Vec<u8>> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` is a valid out pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `token` is a handle we now own; OwnedHandle closes it.
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
    let t = token.as_raw_handle() as HANDLE;
    let mut needed = 0u32;
    // SAFETY: asking for the size only; a null buffer of length 0 is allowed.
    unsafe { GetTokenInformation(t, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64s, so the TOKEN_USER at its start is aligned.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `needed` bytes.
    if unsafe { GetTokenInformation(t, TokenUser, buf.as_mut_ptr().cast::<c_void>(), needed, &mut needed) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation wrote a TOKEN_USER at the start of `buf`,
    // whose SID points into `buf`, which lives until the end of this function.
    let sid = unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    if sid.is_null() {
        return Err(io::Error::other("the token has no user"));
    }
    // SAFETY: a valid SID from the token.
    let len = unsafe { GetLengthSid(sid) } as usize;
    if len == 0 {
        return Err(io::Error::other("the token's user SID is empty"));
    }
    // SAFETY: the SID is `len` bytes inside `buf`.
    Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), len) }.to_vec())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::transport::{exchange, parse_address, FailureKind, Timeouts};
    use std::ffi::OsStr;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::Foundation::{ERROR_NO_DATA, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        RevertToSelf, SecurityIdentification, TokenImpersonationLevel, SECURITY_IMPERSONATION_LEVEL,
    };
    use windows_sys::Win32::Storage::FileSystem::{FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, ImpersonateNamedPipeClient, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentThread, OpenThreadToken};

    /// LocalSystem, S-1-5-18: certainly not the user running the tests.
    const SYSTEM_SID: [u8; 12] = [1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];

    pub fn unique_pipe_name() -> String {
        static N: AtomicUsize = AtomicUsize::new(0);
        format!(r"\\.\pipe\nexterm-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))
    }

    /// A pipe instance of ours, as NexTerm makes its own (default DACL here).
    pub fn pipe_server(name: &str) -> File {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated; null security attributes mean the default.
        let h = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                std::ptr::null(),
            )
        };
        assert!(h != INVALID_HANDLE_VALUE, "CreateNamedPipeW: {}", io::Error::last_os_error());
        // SAFETY: a fresh handle we own.
        unsafe { File::from_raw_handle(h as RawHandle) }
    }

    /// Waits for the client — which may already be there (PIPE_CONNECTED),
    /// or already gone again (NO_DATA: a refusing client hangs up at once).
    pub fn accept(server: &File) {
        // SAFETY: a valid pipe handle; no OVERLAPPED.
        if unsafe { ConnectNamedPipe(server.as_raw_handle() as HANDLE, std::ptr::null_mut()) } == 0 {
            let e = io::Error::last_os_error();
            let code = e.raw_os_error();
            assert!(
                code == Some(ERROR_PIPE_CONNECTED as i32) || code == Some(ERROR_NO_DATA as i32),
                "ConnectNamedPipe: {e}"
            );
        }
    }

    /// Serves one request on a pipe instance made before the thread starts.
    pub fn serve_once(server: File, answer: &'static str) -> thread::JoinHandle<String> {
        thread::spawn(move || {
            accept(&server);
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut server = server;
            server.write_all(answer.as_bytes()).unwrap();
            server.write_all(b"\n").unwrap();
            // SAFETY: a valid pipe handle. Waits until the client has read it all.
            unsafe { FlushFileBuffers(server.as_raw_handle() as HANDLE) };
            line
        })
    }

    #[test]
    fn our_own_identity_is_a_sid() {
        let me = Identity::current().unwrap();
        assert_eq!(me.sid[0], 1, "SID revision 1");
        assert_eq!(me.sid.len(), 8 + 4 * me.sid[1] as usize);
        assert_ne!(me.sid, SYSTEM_SID.to_vec());
    }

    #[test]
    fn a_pipe_we_serve_passes_and_one_served_by_another_user_does_not() {
        let name = unique_pipe_name();
        let server = pipe_server(&name);
        let client = open_pipe(&name, Instant::now() + Duration::from_secs(2)).unwrap();
        accept(&server);
        let me = Identity::current().unwrap();
        assert!(check_server(&client, &me).is_ok());
        let other = Identity { sid: SYSTEM_SID.to_vec() };
        let f = check_server(&client, &other).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert_eq!(f.message, "refusing to talk to a pipe owned by another user");
        assert_eq!(server_pid(&client).unwrap(), std::process::id());
    }

    #[test]
    fn a_pipe_served_by_another_user_never_sees_the_request() {
        let name = unique_pipe_name();
        let server = pipe_server(&name);
        let got = thread::spawn(move || {
            accept(&server);
            let mut all = Vec::new();
            // The client closing reads as the end (std turns ERROR_BROKEN_PIPE into 0).
            let _ = (&server).read_to_end(&mut all);
            all
        });
        let address = parse_address(OsStr::new(&name)).unwrap();
        let someone_else = Identity { sid: SYSTEM_SID.to_vec() };
        let quick = Timeouts { connect: Duration::from_secs(2), answer: Duration::from_secs(2) };
        let f = exchange(&address, b"{\"token\":\"secret\"}\n", &someone_else, quick).unwrap_err();
        assert_eq!(f.kind, FailureKind::Refused);
        assert_eq!(f.message, "refusing to talk to a pipe owned by another user");
        assert!(got.join().unwrap().is_empty(), "the token never left");
    }

    #[test]
    fn the_server_may_identify_us_but_not_act_as_us() {
        let name = unique_pipe_name();
        let server = pipe_server(&name);
        let level = thread::spawn(move || {
            accept(&server);
            // A server may impersonate only once it has read from the pipe.
            let mut byte = [0u8; 1];
            (&server).read_exact(&mut byte).unwrap();
            // SAFETY: a connected pipe this thread serves.
            let impersonating = unsafe { ImpersonateNamedPipeClient(server.as_raw_handle() as HANDLE) };
            assert!(impersonating != 0, "ImpersonateNamedPipeClient: {}", io::Error::last_os_error());
            let mut token: HANDLE = std::ptr::null_mut();
            // SAFETY: a valid out pointer. OpenAsSelf: an identification-level
            // token cannot be opened in the client's own context.
            let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
            let why = io::Error::last_os_error();
            // SAFETY: undoes the impersonation above.
            unsafe { RevertToSelf() };
            assert!(opened != 0, "OpenThreadToken: {why}");
            // SAFETY: a token handle we now own.
            let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
            let mut level: SECURITY_IMPERSONATION_LEVEL = -1;
            let mut len = 0u32;
            // SAFETY: `level` is the size given.
            let ok = unsafe {
                GetTokenInformation(
                    token.as_raw_handle() as HANDLE,
                    TokenImpersonationLevel,
                    (&mut level as *mut SECURITY_IMPERSONATION_LEVEL).cast::<c_void>(),
                    std::mem::size_of::<SECURITY_IMPERSONATION_LEVEL>() as u32,
                    &mut len,
                )
            };
            assert!(ok != 0, "GetTokenInformation: {}", io::Error::last_os_error());
            level
        });
        let mut client = open_pipe(&name, Instant::now() + Duration::from_secs(2)).unwrap();
        client.write_all(b"x").unwrap();
        assert_eq!(level.join().unwrap(), SecurityIdentification, "identify, never impersonate");
    }

    #[test]
    fn a_missing_pipe_is_not_running() {
        let f = open_pipe(&unique_pipe_name(), Instant::now() + Duration::from_millis(300)).unwrap_err();
        assert_eq!((f.kind, f.message.as_str()), (FailureKind::Unreachable, NOT_RUNNING));
    }

    #[test]
    fn a_busy_pipe_waits_then_gives_up() {
        let name = unique_pipe_name();
        let server = pipe_server(&name);
        // The only instance, taken.
        let _first = open_pipe(&name, Instant::now() + Duration::from_secs(2)).unwrap();
        accept(&server);
        let started = Instant::now();
        let f = open_pipe(&name, Instant::now() + Duration::from_millis(300)).unwrap_err();
        assert_eq!(f.kind, FailureKind::NotResponding, "{}", f.message);
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn one_request_one_answer_through_a_real_pipe() {
        let name = unique_pipe_name();
        let server = serve_once(pipe_server(&name), r#"{"v":1,"id":1,"ok":true,"result":"tab-term-5"}"#);
        let address = parse_address(OsStr::new(&name)).unwrap();
        let request = b"{\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"list\",\"args\":{}}\n";
        let quick = Timeouts { connect: Duration::from_secs(2), answer: Duration::from_secs(5) };
        let answer = exchange(&address, request, &Identity::current().unwrap(), quick).unwrap();
        assert_eq!(answer, br#"{"v":1,"id":1,"ok":true,"result":"tab-term-5"}"#);
        assert_eq!(server.join().unwrap().as_bytes(), request);
    }
}
