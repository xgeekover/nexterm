//! What Windows knows about a drive letter without reaching the drive.
//!
//! Two lookups take a path that nobody chose with care — a name printed in a
//! terminal's output (`fs::reveal`), the folder a shell reports it is in
//! (`fs::git::branch_of`) — and both must leave another machine alone.
//! Spelling catches `\\host\share` (`is_network_path`), but not `Z:\…` on a
//! mapped network drive: only asking whether such a path exists connects to
//! the host — a disconnected drive is reconnected, and the call hangs while it
//! is. So both ask the drive's type first, which Windows answers from its own
//! table. And a drive with nothing in it — an empty card reader — puts up an
//! "insert a disk" box when a path on it is looked at, unless the thread says
//! it does not want one (`QuietDriveErrors`).
//!
//! Elsewhere there are no drive letters and no such boxes: both are no-ops.

/// Whether `path` is `X:\…` (or `\\?\X:\…`) on a drive whose type is
/// DRIVE_REMOTE — `GetDriveTypeW` on the drive's root, which reads the type
/// without reaching the drive. Always false off Windows.
pub fn on_a_network_drive(path: &str) -> bool {
    os::on_a_network_drive(path)
}

/// While it lives, this thread shows no "insert a disk" box: a path on an
/// empty card reader or DVD drive fails its lookup quietly. Nothing at all off
/// Windows.
pub struct QuietDriveErrors(#[allow(dead_code)] os::Quiet);

impl QuietDriveErrors {
    pub fn new() -> Self {
        QuietDriveErrors(os::Quiet::new())
    }
}

impl Default for QuietDriveErrors {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
mod os {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows_sys::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS};
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE;

    /// `X:\…` (or `\\?\X:\…`) on a drive whose type is DRIVE_REMOTE.
    pub fn on_a_network_drive(path: &str) -> bool {
        let plain = path.strip_prefix(r"\\?\").unwrap_or(path);
        let bytes = plain.as_bytes();
        if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
            return false;
        }
        let root: Vec<u16> = std::ffi::OsStr::new(&format!("{}:\\", bytes[0] as char))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `root` is NUL-terminated and outlives the call.
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
    }

    /// The thread's error mode with critical-error boxes off, and the mode it
    /// had, put back on drop.
    pub struct Quiet(u32);
    impl Quiet {
        pub fn new() -> Self {
            let mut before = 0;
            // SAFETY: plain call; `before` outlives it.
            unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut before) };
            Quiet(before)
        }
    }
    impl Drop for Quiet {
        fn drop(&mut self) {
            // SAFETY: plain call; the old mode is optional.
            unsafe { SetThreadErrorMode(self.0, std::ptr::null_mut()) };
        }
    }
}

#[cfg(not(windows))]
mod os {
    pub fn on_a_network_drive(_: &str) -> bool {
        false
    }

    /// Nothing to quiet: no other platform asks anyone to insert a disk.
    pub struct Quiet;
    impl Quiet {
        pub fn new() -> Self {
            Quiet
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off Windows there are no drive letters, and so no network drives.
    #[cfg(not(windows))]
    #[test]
    fn no_drive_letter_is_a_network_drive_off_windows() {
        for path in [r"Z:\share\repo", r"\\?\Z:\x", "/Volumes/share", "relative"] {
            assert!(!on_a_network_drive(path), "{path}");
        }
        let _quiet = QuietDriveErrors::new();
    }

    /// Windows only: the drive the system runs from is no network drive, and
    /// asking says so without an error box.
    #[cfg(windows)]
    #[test]
    fn the_system_drive_is_not_a_network_drive() {
        let _quiet = QuietDriveErrors::new();
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        assert!(!on_a_network_drive(&format!(r"{drive}\Windows")));
        assert!(!on_a_network_drive(&format!(r"\\?\{drive}\Windows")));
        assert!(!on_a_network_drive("relative"));
        assert!(!on_a_network_drive(""));
        assert!(!on_a_network_drive("1:"));
    }
}
