//! The named pipe (spec D1): `\\.\pipe\nexterm-<128 random bits>`, for this
//! user alone.
//!
//! - **Its DACL** is `D:P(A;;GA;;;<this user's SID>)`: one entry, letting in
//!   the user the app runs as and nobody else — not Administrators, not
//!   SYSTEM, not another user — and protected, so no entry is inherited. The
//!   SID is the one in this process's own token (`TokenUser`).
//! - **Elevated** (Run as administrator: `TokenElevation`), it also carries
//!   the label `S:(ML;;NWNR;;;HI)` (`pipe_sddl`, mod.rs): high integrity, no
//!   read and no write from below. Without it a program of the same user that
//!   is not elevated could open the pipe and drive the elevated shells
//!   (review). If the label cannot be set, creating the pipe fails and the API
//!   does not start; if whether the app is elevated cannot be told, it does
//!   not start either.
//! - **First instance only** (`FILE_FLAG_FIRST_PIPE_INSTANCE`): if anyone
//!   made a pipe of that name first, creating it fails, and the API does not
//!   start. The name is random and new at every start, so nobody can know it
//!   in advance; and while the app runs it always holds one instance, so the
//!   name is never free for someone else to take.
//! - **No remote clients** (`PIPE_REJECT_REMOTE_CLIENTS`): a pipe is
//!   otherwise reachable over SMB from another machine.
//! - **Each client** is looked up as well, as defence in depth: the process
//!   at the other end (`GetNamedPipeClientProcessId`) must run as this user,
//!   read from its token. A client that cannot be told is closed unanswered.

use std::ffi::{c_void, OsStr};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null_mut;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, IsValidSid, TokenElevation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

use super::server::Incoming;

/// What every pipe name starts with.
pub const PIPE_PREFIX: &str = r"\\.\pipe\nexterm-";

/// A new pipe name: the prefix and 32 hex digits.
pub fn pipe_name() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("{PIPE_PREFIX}{hex}"))
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// The SID, as its bytes, of the user `token` belongs to.
fn token_user(token: HANDLE) -> io::Result<Vec<u8>> {
    let mut len = 0u32;
    // SAFETY: asking for the size only; the call fails, and says how much.
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64s, so that the TOKEN_USER at its start is aligned.
    let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `len` bytes.
    if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), len, &mut len) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call filled a TOKEN_USER at the buffer's start; its SID
    // points into the same buffer, which outlives these reads.
    unsafe {
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;
        if IsValidSid(sid) == 0 {
            return Err(io::Error::other("the token's user SID is not valid"));
        }
        let size = GetLengthSid(sid) as usize;
        Ok(std::slice::from_raw_parts(sid as *const u8, size).to_vec())
    }
}

/// Whether `token` is elevated.
fn token_elevated(token: HANDLE) -> io::Result<bool> {
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0u32;
    let size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
    // SAFETY: `elevation` is a TOKEN_ELEVATION of `size` bytes.
    if unsafe { GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(), size, &mut len) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}

/// `process`'s token, open for queries.
fn process_token(process: HANDLE) -> io::Result<OwnedHandle> {
    let mut token: HANDLE = null_mut();
    // SAFETY: `token` receives a handle we then own.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a handle just opened, closed when this goes.
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

/// The SID of the user `process` runs as.
fn process_user(process: HANDLE) -> io::Result<Vec<u8>> {
    token_user(process_token(process)?.as_raw_handle())
}

/// Whether this process runs elevated.
pub fn current_elevated() -> io::Result<bool> {
    // SAFETY: the pseudo-handle of this process; it needs no closing.
    token_elevated(process_token(unsafe { GetCurrentProcess() })?.as_raw_handle())
}

/// The SID of the user this process runs as.
pub fn current_user() -> io::Result<Vec<u8>> {
    // SAFETY: the pseudo-handle of this process; it needs no closing.
    process_user(unsafe { GetCurrentProcess() })
}

/// The SID of the user process `pid` runs as.
pub fn user_of_process(pid: u32) -> io::Result<Vec<u8>> {
    // SAFETY: a plain call; a null handle is its failure.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a handle just opened, closed when this goes.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    process_user(process.as_raw_handle())
}

/// The user (SID bytes) process `pid` runs as, and whether elevated — what
/// the PTY manager compares with this process's own (src/pty/owner.rs).
/// OpenProcess's error is kept as it is: ERROR_INVALID_PARAMETER for a
/// process that is no more.
pub fn identity_of_process(pid: u32) -> io::Result<(Vec<u8>, bool)> {
    // SAFETY: a plain call; a null handle is its failure.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a handle just opened, closed when this goes.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let token = process_token(process.as_raw_handle())?;
    Ok((token_user(token.as_raw_handle())?, token_elevated(token.as_raw_handle())?))
}

/// `sid` written out: `S-1-5-21-…`.
pub fn sid_string(sid: &[u8]) -> io::Result<String> {
    let mut text: *mut u16 = null_mut();
    // SAFETY: `sid` is a whole SID (from `token_user`); the call only reads
    // it, and allocates `text`, which is freed below.
    if unsafe { ConvertSidToStringSidW(sid.as_ptr() as *mut c_void, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a NUL-terminated string the call allocated.
    let string = unsafe {
        let len = (0..).take_while(|&i| *text.add(i) != 0).count();
        let string = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        string
    };
    Ok(string)
}

/// A security descriptor that lets in one user, for every instance of the
/// pipe, and that user's SID.
pub struct OnlyUser {
    descriptor: PSECURITY_DESCRIPTOR,
    pub sid: Vec<u8>,
}

// SAFETY: the descriptor is only read once made, and freed once, on drop.
unsafe impl Send for OnlyUser {}
unsafe impl Sync for OnlyUser {}

impl OnlyUser {
    pub fn for_current_user() -> io::Result<OnlyUser> {
        let sid = current_user()?;
        let sddl = wide(&super::pipe_sddl(&sid_string(&sid)?, current_elevated()?));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: a NUL-terminated SDDL string; `descriptor` receives memory
        // the call allocated, freed on drop.
        let made = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
        };
        if made == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(OnlyUser { descriptor, sid })
    }

    /// An instance of pipe `name`: the first one of that name, or another.
    pub fn create(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        };
        // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES whose
        // descriptor lives as long as `self`, past this call.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(name, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast())
        }
    }
}

impl Drop for OnlyUser {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptor…, freed once.
        unsafe { LocalFree(self.descriptor) };
    }
}

/// Whether the client connected to `pipe` runs as the user `sid` is.
pub fn client_is(pipe: &NamedPipeServer, sid: &[u8]) -> bool {
    let mut pid = 0u32;
    // SAFETY: a pipe handle we hold, and an out-parameter.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return false;
    }
    matches!(user_of_process(pid), Ok(user) if user == sid)
}

/// Connections on the pipe, from this user alone. One instance always waits
/// for the next client.
pub struct PipeIncoming {
    name: String,
    security: OnlyUser,
    next: NamedPipeServer,
    turned_away: u64,
}

impl PipeIncoming {
    /// The pipe, as the first instance of a new name. In a tokio runtime.
    pub fn create() -> Result<PipeIncoming, String> {
        let security = OnlyUser::for_current_user().map_err(|e| format!("this user's SID could not be read: {e}"))?;
        let name = pipe_name().ok_or("no random name could be had")?;
        let next = security
            .create(&name, true)
            .map_err(|e| format!("the control pipe {name} could not be made: {e}"))?;
        Ok(PipeIncoming { name, security, next, turned_away: 0 })
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Incoming for PipeIncoming {
    type Stream = NamedPipeServer;

    async fn accept(&mut self) -> io::Result<Option<NamedPipeServer>> {
        loop {
            let connected = self.next.connect().await;
            // The next instance before this one is handed on: the name is
            // never without one of ours.
            let fresh = self.security.create(&self.name, false)?;
            let this = std::mem::replace(&mut self.next, fresh);
            connected?;
            if client_is(&this, &self.security.sid) {
                return Ok(Some(this));
            }
            self.turned_away += 1;
            if self.turned_away <= 3 {
                eprintln!("[NexTerm] The control API closed a connection from another user");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSidToSidW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, LABEL_SECURITY_INFORMATION, OBJECT_SECURITY_INFORMATION, PSID};

    /// The DACL of `pipe`, read back from the object, as SDDL.
    fn dacl_of(pipe: &NamedPipeServer) -> String {
        read_back(pipe, DACL_SECURITY_INFORMATION)
    }

    /// What `which` of `pipe`'s security descriptor holds, read back from
    /// the object, as SDDL.
    fn read_back(pipe: &NamedPipeServer, which: OBJECT_SECURITY_INFORMATION) -> String {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: a handle we hold; `descriptor` receives memory freed below.
        let read = unsafe {
            GetSecurityInfo(
                pipe.as_raw_handle(),
                SE_KERNEL_OBJECT,
                which,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(read, 0, "GetSecurityInfo failed: {read}");
        let mut text: *mut u16 = null_mut();
        // SAFETY: the descriptor just read; `text` is allocated by the call.
        let written = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, which, &mut text, null_mut())
        };
        assert_ne!(written, 0, "{}", io::Error::last_os_error());
        // SAFETY: a NUL-terminated string the call allocated.
        unsafe {
            let len = (0..).take_while(|&i| *text.add(i) != 0).count();
            let sddl = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text.cast());
            LocalFree(descriptor);
            sddl
        }
    }

    /// LocalSystem's SID, as bytes: a user this test's process is not.
    fn system_sid() -> Vec<u8> {
        let mut sid: PSID = null_mut();
        let text = wide("S-1-5-18");
        // SAFETY: a NUL-terminated string; `sid` is allocated by the call.
        unsafe {
            assert_ne!(ConvertStringSidToSidW(text.as_ptr(), &mut sid), 0);
            let bytes = std::slice::from_raw_parts(sid as *const u8, GetLengthSid(sid) as usize).to_vec();
            LocalFree(sid);
            bytes
        }
    }

    #[test]
    fn a_pipe_name_is_the_prefix_and_128_random_bits() {
        let name = pipe_name().unwrap();
        let hex = name.strip_prefix(PIPE_PREFIX).unwrap();
        assert_eq!(hex.len(), 32);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(pipe_name(), Some(name));
    }

    #[tokio::test]
    async fn the_pipe_s_dacl_lets_in_this_user_alone() {
        let incoming = PipeIncoming::create().unwrap();
        let ours = sid_string(&incoming.security.sid).unwrap();
        assert!(ours.starts_with("S-1-"), "{ours}");
        let dacl = dacl_of(&incoming.next);
        assert!(dacl.starts_with("D:"), "{dacl}");
        assert_eq!(dacl.matches('(').count(), 1, "one entry and no other: {dacl}");
        assert!(dacl.contains("(A;"), "an allow entry: {dacl}");
        assert!(dacl.ends_with(&format!(";;;{ours})")), "for this user: {dacl}");
        // Every later instance has it too.
        let another = incoming.security.create(&incoming.name, false).unwrap();
        assert_eq!(dacl_of(&another), dacl);
    }

    /// Elevated — as CI's runner may well be — the pipe carries the high
    /// integrity label, read back from the object; not elevated, none.
    #[tokio::test]
    async fn an_elevated_nexterm_s_pipe_keeps_out_everything_below_high_integrity() {
        let elevated = current_elevated().expect("whether this process is elevated");
        eprintln!("this test process is {}elevated", if elevated { "" } else { "not " });
        let incoming = PipeIncoming::create().expect("the pipe is made, label and all");
        let label = read_back(&incoming.next, LABEL_SECURITY_INFORMATION);
        if elevated {
            assert!(label.contains("(ML;;NWNR;;;HI)"), "elevated, but the label is {label:?}");
        } else {
            assert!(!label.contains("ML;"), "not elevated, yet labelled {label:?}");
        }
        // The descriptor built from the SDDL either way is a valid one.
        for elevated in [false, true] {
            let sddl = wide(&super::super::pipe_sddl(&sid_string(&incoming.security.sid).unwrap(), elevated));
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            // SAFETY: as in `for_current_user`; freed at once.
            let made = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
            };
            assert_ne!(made, 0, "elevated={elevated}: {}", io::Error::last_os_error());
            // SAFETY: allocated just above.
            unsafe { LocalFree(descriptor) };
        }
    }

    #[tokio::test]
    async fn a_name_someone_holds_already_cannot_be_taken() {
        let squatter = OnlyUser::for_current_user().unwrap();
        let name = pipe_name().unwrap();
        let _held = squatter.create(&name, true).unwrap();
        let ours = OnlyUser::for_current_user().unwrap();
        assert!(ours.create(&name, true).is_err(), "a first instance of a name in use fails");
    }

    #[tokio::test]
    async fn a_client_is_let_in_only_as_this_user() {
        let mut incoming = PipeIncoming::create().unwrap();
        let name = incoming.name.clone();
        let _client = ClientOptions::new().open(&name).unwrap();
        incoming.next.connect().await.unwrap();
        let ours = current_user().unwrap();
        assert_eq!(user_of_process(std::process::id()).unwrap(), ours);
        assert!(client_is(&incoming.next, &ours), "this process is this user");
        assert!(!client_is(&incoming.next, &system_sid()), "and not LocalSystem");

        // Through accept: a client taken for another user's is turned away.
        incoming.security.sid = system_sid();
        let fresh = incoming.security.create(&name, false).unwrap();
        incoming.next = fresh;
        let _stranger = ClientOptions::new().open(&name).unwrap();
        let accepted = tokio::time::timeout(std::time::Duration::from_millis(500), incoming.accept()).await;
        assert!(accepted.is_err(), "nothing was let through");
        assert_eq!(incoming.turned_away, 1);
    }
}
