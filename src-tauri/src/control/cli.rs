//! Where the shells find the CLI (spec D7): a folder that holds the CLI and
//! nothing else, put first on their PATH.
//!
//! Not the CLI's own folder. That is wherever the app is installed, and holds
//! more than the CLI (review): `/usr/bin` for a Linux package — whose `node`
//! and `python` would then come before the user's `~/.local/bin` and
//! `/usr/local/bin` — `Contents/MacOS` on macOS, where `nexterm` starts the
//! app, the install folder on Windows with its `uninstall.exe`, and for the
//! portable zip any folder at all, perhaps one other users can write to.
//!
//! So the app keeps `bin` in its local data folder, its user's alone, with
//! one entry: `nexterm-cli`, a symbolic link to the real CLI on macOS and
//! Linux; on Windows `nexterm-cli.exe`, a copy kept in step with the real one
//! (by size and modification time; the copy is given the original's). Its
//! path is `NEXTERM_CLI`, and the folder goes first on PATH.
//!
//! - **unix:** the folder is made 0700 and checked as the socket's folder is
//!   (unix.rs, `prepare`): this user's, not a link, 0700.
//! - **Windows:** the folder must not be a link or other reparse point; its
//!   permissions are those of `%LOCALAPPDATA%`, which lets in the user (and
//!   SYSTEM and Administrators), as every per-user app's data does.
//! - **Anything else in the folder** — something no NexTerm put there — and
//!   PATH is left alone: nothing is removed that is not NexTerm's own.
//!
//! When the folder cannot be made or kept, PATH is left exactly as it was
//! and `NEXTERM_CLI` is the real CLI's path, so hooks that use it still work.

use std::fs;
#[cfg(unix)]
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use super::CLI_NAME;

/// The folder, in the app's local data folder.
pub const BIN_DIR: &str = "bin";

/// What the shells are given for the CLI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliPaths {
    /// `NEXTERM_CLI`.
    pub cli: PathBuf,
    /// The folder put first on PATH, when there is one that holds only the CLI.
    pub path_dir: Option<PathBuf>,
}

impl CliPaths {
    /// The real CLI, and PATH left alone.
    pub fn bare(real: &Path) -> CliPaths {
        CliPaths { cli: real.to_path_buf(), path_dir: None }
    }
}

/// The CLI at `real` put in `<app_local_data>/bin`, or, if that cannot be
/// done, the real CLI alone (and why, logged).
pub fn install(app_local_data: &Path, real: &Path) -> CliPaths {
    let dir = app_local_data.join(BIN_DIR);
    match keep_in(&dir, real) {
        Ok(entry) => CliPaths { cli: entry, path_dir: Some(dir) },
        Err(why) => {
            eprintln!("[NexTerm] The CLI is not put on the terminals' PATH ({why}); NEXTERM_CLI is {}", real.display());
            CliPaths::bare(real)
        }
    }
}

/// `real`, as the one entry of `dir`: the entry's path.
fn keep_in(dir: &Path, real: &Path) -> Result<PathBuf, String> {
    if !real.is_absolute() {
        return Err(format!("{} is not an absolute path", real.display()));
    }
    folder(dir)?;
    let entry = dir.join(CLI_NAME);
    #[cfg(unix)]
    keep_link(&entry, real)?;
    #[cfg(windows)]
    keep_copy(real, &entry)?;
    let others: Vec<String> = fs::read_dir(dir)
        .map_err(|e| format!("{} could not be read: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name != CLI_NAME)
        .collect();
    if !others.is_empty() {
        return Err(format!("{} holds more than the CLI: {}", dir.display(), others.join(", ")));
    }
    Ok(entry)
}

#[cfg(unix)]
fn folder(dir: &Path) -> Result<(), String> {
    super::unix::prepare(dir, super::unix::our_uid())
}

#[cfg(windows)]
fn folder(dir: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    let meta = fs::symlink_metadata(dir).map_err(|e| format!("{} could not be looked at: {e}", dir.display()))?;
    if meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("{} is a link", dir.display()));
    }
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(())
}

/// `entry` a symbolic link to `real`: left as it is when it is one already,
/// made — in place of whatever file or link was there — when not.
#[cfg(unix)]
fn keep_link(entry: &Path, real: &Path) -> Result<(), String> {
    match fs::symlink_metadata(entry) {
        Ok(meta) if meta.file_type().is_symlink() && fs::read_link(entry).is_ok_and(|to| to == real) => return Ok(()),
        Ok(meta) if meta.is_dir() => return Err(format!("{} is a folder", entry.display())),
        Ok(_) => fs::remove_file(entry).map_err(|e| format!("{} could not be replaced: {e}", entry.display()))?,
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{} could not be looked at: {e}", entry.display())),
    }
    std::os::unix::fs::symlink(real, entry).map_err(|e| format!("{} could not be made: {e}", entry.display()))
}

/// The name a copy is made under before it replaces `entry`.
#[cfg_attr(not(windows), allow(dead_code))]
fn temp_of(entry: &Path) -> PathBuf {
    let mut name = entry.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    entry.with_file_name(name)
}

/// `entry` a copy of `real` with the same size and modification time: left
/// alone when it is one already, copied — through a temporary file renamed
/// over it — when not. A copy that cannot replace the old one (it is
/// running) fails, and the caller falls back to the real CLI.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn keep_copy(real: &Path, entry: &Path) -> Result<(), String> {
    let source = fs::metadata(real).map_err(|e| format!("{} could not be looked at: {e}", real.display()))?;
    let modified = source.modified().map_err(|e| format!("{} has no modification time: {e}", real.display()))?;
    let temp = temp_of(entry);
    let _ = fs::remove_file(&temp);
    match fs::symlink_metadata(entry) {
        Ok(meta)
            if meta.file_type().is_file() && meta.len() == source.len() && meta.modified().is_ok_and(|m| m == modified) =>
        {
            return Ok(());
        }
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(format!("{} is not a file", entry.display()));
        }
        _ => {}
    }
    let copied = (|| -> std::io::Result<()> {
        fs::copy(real, &temp)?;
        fs::OpenOptions::new().write(true).open(&temp)?.set_modified(modified)?;
        fs::rename(&temp, entry)
    })();
    copied.map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("{} could not be brought up to date: {e}", entry.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("nxc-cli-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        /// A real CLI, somewhere that holds more than it — as /usr/bin does.
        fn real(&self) -> PathBuf {
            let install = self.0.join("install");
            fs::create_dir_all(&install).unwrap();
            fs::write(install.join("node"), b"not ours").unwrap();
            let real = install.join(CLI_NAME);
            fs::write(&real, b"the cli, version one").unwrap();
            real
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn the_cli_is_put_in_a_folder_of_its_own_and_that_folder_goes_on_path() {
        let scratch = Scratch::new("own");
        let real = scratch.real();
        let data = scratch.0.join("data");
        let paths = install(&data, &real);
        let dir = data.join(BIN_DIR);
        assert_eq!(paths, CliPaths { cli: dir.join(CLI_NAME), path_dir: Some(dir.clone()) });
        assert_eq!(names(&dir), [CLI_NAME], "the CLI and nothing else");
        assert_eq!(fs::read(&paths.cli).unwrap(), b"the cli, version one");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::read_link(&paths.cli).unwrap(), real, "a link to the real one");
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o7777, 0o700);
        }
        // Again: nothing changes.
        assert_eq!(install(&data, &real), paths);
    }

    #[cfg(unix)]
    #[test]
    fn a_wrong_link_or_a_file_in_the_cli_s_place_is_replaced() {
        let scratch = Scratch::new("wrong");
        let real = scratch.real();
        let data = scratch.0.join("data");
        let entry = data.join(BIN_DIR).join(CLI_NAME);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(scratch.0.join("elsewhere"), &entry).unwrap();
        assert_eq!(install(&data, &real).path_dir, Some(data.join(BIN_DIR)));
        assert_eq!(fs::read_link(&entry).unwrap(), real);
        fs::remove_file(&entry).unwrap();
        fs::write(&entry, b"an old copy").unwrap();
        assert_eq!(install(&data, &real).path_dir, Some(data.join(BIN_DIR)));
        assert_eq!(fs::read_link(&entry).unwrap(), real);
    }

    #[test]
    fn a_folder_holding_anything_else_leaves_path_alone() {
        let scratch = Scratch::new("more");
        let real = scratch.real();
        let data = scratch.0.join("data");
        fs::create_dir_all(data.join(BIN_DIR)).unwrap();
        fs::write(data.join(BIN_DIR).join("python"), b"someone else's").unwrap();
        assert_eq!(install(&data, &real), CliPaths::bare(&real));
        assert!(data.join(BIN_DIR).join("python").exists(), "nothing that is not ours is removed");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_folder_leaves_path_alone() {
        let scratch = Scratch::new("link");
        let real = scratch.real();
        let data = scratch.0.join("data");
        fs::create_dir_all(&data).unwrap();
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, data.join(BIN_DIR)).unwrap();
        assert_eq!(install(&data, &real), CliPaths::bare(&real));
        assert_eq!(names(&elsewhere).len(), 0, "nothing made through it");
    }

    #[test]
    fn a_relative_cli_path_leaves_path_alone() {
        let scratch = Scratch::new("rel");
        let data = scratch.0.join("data");
        let relative = Path::new(CLI_NAME);
        assert_eq!(install(&data, relative), CliPaths::bare(relative));
    }

    /// Windows keeps a copy (tested everywhere: the code is the same).
    #[test]
    fn a_copy_is_made_kept_and_brought_up_to_date_by_size_and_time() {
        let scratch = Scratch::new("copy");
        let real = scratch.real();
        let entry = scratch.0.join("copy").join(CLI_NAME);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        let then = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::OpenOptions::new().write(true).open(&real).unwrap().set_modified(then).unwrap();

        keep_copy(&real, &entry).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), b"the cli, version one");
        assert_eq!(fs::metadata(&entry).unwrap().modified().unwrap(), then, "given the original's time");
        assert!(!temp_of(&entry).exists());

        // In step: left alone (a mark in the copy survives).
        fs::write(&entry, b"the cli, version ONE").unwrap();
        fs::OpenOptions::new().write(true).open(&entry).unwrap().set_modified(then).unwrap();
        keep_copy(&real, &entry).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), b"the cli, version ONE", "same size and time: not copied again");

        // A new CLI, same size, new time: copied.
        fs::write(&real, b"the cli, version two").unwrap();
        keep_copy(&real, &entry).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), b"the cli, version two");
        // A new size, same time: copied.
        fs::write(&real, b"the cli, version three").unwrap();
        fs::OpenOptions::new().write(true).open(&real).unwrap().set_modified(then).unwrap();
        keep_copy(&real, &entry).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), b"the cli, version three");
        assert_eq!(names(entry.parent().unwrap()), [CLI_NAME], "no temporary file left");
    }
}
