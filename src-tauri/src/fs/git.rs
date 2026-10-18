//! What git says about the open folder.
//!
//! Deliberately narrow: the branch, how far it is from its upstream, and which
//! files have changed. No staging, no committing, no diff — that is a second
//! application, and this one is a terminal with git already in it.
//!
//! The status bar used to print a git branch of "main" whatever was actually
//! checked out. That was removed for lying rather than replaced, and the
//! `--vsc-git-*` colours have sat in the stylesheet unused ever since. This is
//! the real thing they were waiting for.
//!
//! **It shells out to the user's own `git`** rather than linking a library.
//! That is what makes worktrees, submodules, `includeIf`, custom `core.*` and
//! every other local configuration behave the way the same folder behaves in
//! the terminal below — which is the whole point of the pairing. Arguments are
//! passed as a list, never through a shell, and the only path involved is the
//! workspace root the backend already owns.
//!
//! **The branch of a terminal's folder is read, never asked** (`branch_of`):
//! one line of `HEAD`, so that a folder anywhere — one only a program's output
//! claims a shell is in — can make nothing run. Where `HEAD` does not say (a
//! reftable repository), there is no branch.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};

/// A repository with this many changes is one you are not reading file by
/// file; past here the Explorer's colours are noise and the list is weight.
const MAX_FILES: usize = 2000;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitFile {
    /// Absolute, because that is what the Explorer's nodes carry.
    pub path: String,
    pub status: GitFileStatus,
    /// True when the change is in the index as well as (or instead of) the
    /// working tree.
    pub staged: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatus {
    /// The branch, or `None` when the head is detached.
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub truncated: bool,
}

/// `CREATE_NO_WINDOW`. Windows gives a console-subsystem child its own console
/// window unless told not to, and `git` is one — so every call flashed a black
/// window over the app. `git_status` runs when a folder is opened AND again,
/// debounced, on every burst of changes the watcher reports, so it was not one
/// flash: it was one every time the user saved a file.
///
/// The app's own binary is already spared this by `windows_subsystem` in
/// main.rs, but that attribute says nothing about what it spawns.
///
/// `std` does not re-export the constant and `windows-sys` would be a whole
/// dependency for one number.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What every call here passes before its subcommand. Nobody asked for any of
/// these calls: they run when a folder is opened or restored, and again after
/// every burst of file changes, so they must leave the repository exactly as
/// they found it and run nothing it names.
///
/// - `--no-optional-locks`: a status otherwise refreshes the index and writes
///   it back, holding `.git/index.lock` while it collects the status. A
///   `git commit` or a rebase step in a terminal that needs the lock at that
///   moment fails with "index.lock: File exists" — and an agent in one of
///   these terminals commits right after writing files, which is exactly when
///   the status runs. git-status(1) recommends this flag for background use.
/// - `core.fsmonitor=false`: `core.fsmonitor` may name a program, which git
///   runs on every status, and a folder from an archive or a shared drive can
///   carry one in its `.git/config`. Given on the command line, this wins over
///   the repository's own setting. A git older than 2.36 reads the value only
///   as a path, so there it names the `false` command, which fails, and git
///   falls back to checking every file itself.
///
/// The status also turns off the filters the repository defines
/// (`repository_filters_off`), and leaves submodules' working trees alone
/// (`STATUS_ARGS`).
const BACKGROUND_OPTIONS: [&str; 3] = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

/// `git` run in `dir` with `BACKGROUND_OPTIONS`, and without a console window.
fn git_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.args(BACKGROUND_OPTIONS).arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Run `git` in `dir`, or `None` when it could not be run at all.
///
/// A missing `git`, a folder that is not a repository, and a git that returned
/// an error are all the same answer here: nothing to say. None of them is
/// worth an error dialog over a status bar decoration.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = git_command(dir, args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// The status char pair `git` reports for a tracked change, as one status.
///
/// `XY` is index-then-worktree. A file both staged and edited again reports
/// two different letters; the worktree side is what the Explorer should
/// colour, since that is the state of the file you would open.
fn tracked_status(xy: &str) -> (GitFileStatus, bool) {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    let staged = index != '.';
    let pick = if worktree != '.' { worktree } else { index };
    let status = match pick {
        'A' => GitFileStatus::Added,
        'D' => GitFileStatus::Deleted,
        'R' | 'C' => GitFileStatus::Renamed,
        'U' => GitFileStatus::Conflicted,
        _ => GitFileStatus::Modified,
    };
    (status, staged)
}

/// Join git's repo-relative path onto the repository root, natively.
///
/// git always writes `/` as the separator, on every platform. `PathBuf::join`
/// with the whole relative string keeps those slashes, so on Windows the
/// result is `C:\\proj\\src/app.js` — a path that matches NOTHING the Explorer
/// holds, because `read_dir_hierarchy` produces `C:\\proj\\src\\app.js`. Every
/// file would simply go uncoloured, silently, on the one platform this app is
/// mostly used on. Pushing component by component lets `PathBuf` use the
/// platform's own separator.
fn join_repo_path(repo_root: &Path, relative: &str) -> String {
    let mut full = repo_root.to_path_buf();
    for part in relative.split('/').filter(|p| !p.is_empty()) {
        full.push(part);
    }
    full.to_string_lossy().to_string()
}

/// Parse `git status --porcelain=v2 --branch -z` into a status.
///
/// `-z` on purpose: without it git quotes and escapes any path that is not
/// plain ASCII, and a project with a Korean directory name would come back
/// with paths that match nothing in the Explorer.
pub fn parse_status(stdout: &str, repo_root: &Path) -> GitStatus {
    let mut status = GitStatus {
        branch: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        truncated: false,
    };

    let mut fields = stdout.split('\0').filter(|f| !f.is_empty()).peekable();
    while let Some(field) = fields.next() {
        if let Some(rest) = field.strip_prefix("# branch.head ") {
            // git writes "(detached)" rather than a name when there is none.
            if rest != "(detached)" {
                status.branch = Some(rest.to_string());
            }
            continue;
        }
        if let Some(rest) = field.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if field.starts_with('#') {
            continue;
        }

        let (relative, file_status, staged) = if let Some(rest) = field.strip_prefix("? ") {
            (rest.to_string(), GitFileStatus::Untracked, false)
        } else if let Some(rest) = field.strip_prefix("1 ") {
            // "<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("..");
            let Some(path) = parts.nth(6) else { continue };
            let (s, staged) = tracked_status(xy);
            (path.to_string(), s, staged)
        } else if let Some(rest) = field.strip_prefix("2 ") {
            // A rename: same shape plus a score, and the ORIGINAL path follows
            // as its own NUL-terminated field, which has to be consumed.
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("..");
            let Some(path) = parts.nth(7) else { continue };
            let (_, staged) = tracked_status(xy);
            let owned = path.to_string();
            fields.next();
            (owned, GitFileStatus::Renamed, staged)
        } else if let Some(rest) = field.strip_prefix("u ") {
            let mut parts = rest.splitn(11, ' ');
            let _ = parts.next();
            let Some(path) = parts.nth(8) else { continue };
            (path.to_string(), GitFileStatus::Conflicted, false)
        } else {
            continue;
        };

        if status.files.len() >= MAX_FILES {
            status.truncated = true;
            break;
        }
        status.files.push(GitFile {
            path: join_repo_path(repo_root, &relative),
            status: file_status,
            staged,
        });
    }

    status
}

/// The status itself. `--ignore-submodules=dirty`: what a submodule's own
/// working tree holds is asked of a git run inside it, which runs whatever
/// filters the submodule's config names (see `repository_filters_off`) and
/// was never shown them. A submodule moved to another commit still shows.
const STATUS_ARGS: [&str; 5] = ["status", "--porcelain=v2", "--branch", "-z", "--ignore-submodules=dirty"];

/// The filter drivers named in `git config -z --get-regexp '^filter\.'`
/// output whose commands the repository sets: with `--show-scope`
/// (`scoped`), each entry comes after its scope, and only `local` (its
/// `.git/config`) and `worktree` (`config.worktree`) — with what they
/// include — are the repository's; without, every driver counts.
///
/// A driver counts once one of those sets its `clean`, `smudge` or
/// `process`; a `required` alone runs nothing.
fn filter_drivers(listing: &str, scoped: bool) -> BTreeSet<String> {
    let mut fields = listing.split('\0');
    let mut names = BTreeSet::new();
    loop {
        let scope = if scoped {
            match fields.next() {
                Some(scope) => scope,
                None => break,
            }
        } else {
            "local"
        };
        let Some(entry) = fields.next() else { break };
        if !matches!(scope, "local" | "worktree") {
            continue;
        }
        // `filter.<name>.<variable>`: git prints the section and the variable
        // in lower case, and the name — which may hold dots — as it is.
        let key = entry.split('\n').next().unwrap_or("");
        let Some((name, variable)) = key.strip_prefix("filter.").and_then(|rest| rest.rsplit_once('.')) else {
            continue;
        };
        if matches!(variable, "clean" | "smudge" | "process") {
            names.insert(name.to_string());
        }
    }
    names
}

/// `-c` settings that switch off every filter driver the repository's own
/// config defines or redefines, or `None` when that cannot be done.
///
/// To tell whether a tracked file changed, `git status` runs it through the
/// clean filter `.gitattributes` assigns it — `filter.<driver>.clean`, or
/// `.process` — whenever the stat data the index keeps for it is out of
/// date, as it always is in a folder just unpacked. Both halves can come with
/// the folder: `.gitattributes` is committed, and a `.git/config` from an
/// archive or a shared drive can define the driver. So the status that runs
/// on opening the folder ran a program the folder named, as `core.fsmonitor`
/// did (see `BACKGROUND_OPTIONS`).
///
/// No git setting turns filters off, so each driver whose command comes from
/// the repository — scope `local` or `worktree`, and what those include — is
/// given empty ones: git runs no filter whose command is empty, and
/// `required=false` keeps a required one from failing the status. Drivers
/// set up in the user's own config, git-lfs's among them, still run. `-c`
/// cannot name a driver with `=` in it (git splits the setting there), so a
/// repository that defines one gets no status at all. A git older than 2.26
/// cannot say where a setting comes from, and then every driver is off.
fn repository_filters_off(root: &Path) -> Option<Vec<String>> {
    let listed = |scoped: bool| -> Option<Option<String>> {
        let mut args = vec!["config", "-z"];
        if scoped {
            args.push("--show-scope");
        }
        args.extend(["--get-regexp", r"^filter\."]);
        let output = git_command(root, &args).output().ok()?;
        match output.status.code() {
            Some(0) => Some(Some(String::from_utf8_lossy(&output.stdout).into_owned())),
            // Nothing matched: no filter drivers anywhere.
            Some(1) => Some(Some(String::new())),
            _ => Some(None),
        }
    };
    let names = match listed(true)? {
        Some(listing) => filter_drivers(&listing, true),
        None => filter_drivers(&listed(false)??, false),
    };
    if names.iter().any(|name| name.contains('=')) {
        return None;
    }
    Some(
        names
            .iter()
            .flat_map(|name| {
                ["clean=", "smudge=", "process=", "required=false"]
                    .map(|setting| ["-c".to_string(), format!("filter.{name}.{setting}")])
            })
            .flatten()
            .collect(),
    )
}

/// Ask git about `root`, or `None` when there is nothing to ask.
pub fn status_of(root: &Path) -> Option<GitStatus> {
    // Also the "is this a repository at all" check, and it gives the root that
    // the status output's paths are relative to — which is NOT necessarily the
    // open folder, since you may have opened a subdirectory.
    let toplevel = git(root, &["rev-parse", "--show-toplevel"])?;
    let trimmed = toplevel.trim();
    if trimmed.is_empty() {
        return None;
    }
    // git prints this with forward slashes on Windows too. Canonicalising
    // gives the platform's own spelling — the same one `read_dir_hierarchy`
    // hands the Explorer, which is what these paths have to match.
    let repo_root = crate::fs::canonical_or(Path::new(trimmed));
    let filters_off = repository_filters_off(root)?;
    let args: Vec<&str> = filters_off.iter().map(String::as_str).chain(STATUS_ARGS).collect();
    let stdout = git(root, &args)?;
    Some(parse_status(&stdout, &repo_root))
}

// ---- The branch a terminal's folder is on -------------------------------------
//
// Every row of the TERMINALS side bar names the branch its terminal's folder
// is on, and a terminal can be anywhere: in another repository, in a worktree,
// in a folder an archive just unpacked, or somewhere a program only CLAIMS the
// shell is (OSC 7 is whatever anything prints). So git is never run for it.
// The branch is one line of one file, `HEAD`, and reading it can run nothing
// the repository configures, costs no process per terminal, and asks nothing
// of a git that may not be installed.
//
// Not even for a reftable repository, whose `HEAD` says nothing: one line in
// any folder's `HEAD` would then make git run there, and git reads that
// repository's config — an `include.path` on another machine is a connection
// carrying the user's credentials, and a FIFO there hung the lookup. Such a
// repository shows no branch.

/// What `git_branch` answers: the branch, or for a detached head the first
/// characters of its commit, with `detached` set.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BranchInfo {
    pub branch: String,
    pub detached: bool,
    /// Which repository — which worktree of it — the folder is in: the folder
    /// holding the `HEAD` that was read, canonical. Folders with the same one
    /// change branch together, so the webview looks at all of them again when
    /// a command ends in one (src/hooks/useBranchLookups.js). Not shown.
    pub repo: String,
}

/// How many folders `branch_of` looks in for `.git`: the one it is given and
/// its parents, up to this many in all. Deeper than any real checkout, and a
/// bound on the work a path made of thousands of `a/` can cause.
pub const BRANCH_WALK_MAX: usize = 64;

/// The most of `HEAD`, or of a `.git` file, that is read. Both are one short
/// line; a file bigger than this is not one git wrote.
pub const HEAD_BYTES_MAX: u64 = 4 * 1024;

/// The longest branch name that leaves the backend, in characters. Longer
/// ones are cut and end in "…" — the same rule as `cleanBranchName` in
/// src/lib/terminalStatus.js, which the webview applies again.
pub const BRANCH_CHARS_MAX: usize = 100;

/// How many characters of a commit id a detached head shows: git's own
/// `--short` default.
const SHORT_ID: usize = 7;

/// What a reftable repository writes to `HEAD` so that an older git sees a
/// repository and a broken branch rather than no repository at all. The real
/// `HEAD` is in the reftable, which only git can read.
const REFTABLE_MARKER: &str = "refs/heads/.invalid";

/// Where branches live among the refs.
const HEADS: &str = "refs/heads/";

/// What `HEAD` says.
#[derive(Debug, PartialEq, Eq)]
enum Head {
    Branch(String),
    Detached(String),
    Reftable,
    Unknown,
}

/// Read `HEAD` the way git does: `ref: refs/heads/<name>` is a branch, when
/// the name is one git would take (`ref_name_ok`); a full commit id — 40 hex
/// digits, or 64 in a SHA-256 repository — ending the text or followed by
/// whitespace, a detached head; reftable's `refs/heads/.invalid` says
/// nothing; and anything else is nothing. Trailing whitespace is git's to
/// ignore too.
fn parse_head(text: &str) -> Head {
    let text = text.trim_end_matches(|c: char| c.is_ascii_whitespace());
    if let Some(rest) = text.strip_prefix("ref:") {
        return head_ref(rest.trim_start_matches(|c: char| c.is_ascii_whitespace()));
    }
    detached_id(text).map_or(Head::Unknown, Head::Detached)
}

/// What a `HEAD` that names `target` — `ref: <target>`, or a link to it — says.
fn head_ref(target: &str) -> Head {
    if target == REFTABLE_MARKER {
        return Head::Reftable;
    }
    match target.strip_prefix(HEADS) {
        Some(name) if ref_name_ok(name) => Head::Branch(name.to_string()),
        _ => Head::Unknown,
    }
}

/// The short id of a detached head, from a `HEAD` holding a whole commit id:
/// git reads the id and takes a space after it, and anything beyond, as the
/// end. Part of an id, or one with more digits, is not one.
fn detached_id(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    [64, 40].into_iter().find_map(|len| {
        let whole = bytes.len() >= len
            && bytes[..len].iter().all(u8::is_ascii_hexdigit)
            && bytes.get(len).map_or(true, u8::is_ascii_whitespace);
        whole.then(|| text[..SHORT_ID].to_ascii_lowercase())
    })
}

/// Characters that do not show, or change how what is around them shows:
/// control characters (C0, DEL, C1); the line and paragraph separators; the
/// bidirectional marks, embeddings, overrides and isolates, which can make a
/// name read as something else; and invisible format characters — zero-width
/// space, soft hyphen, word joiner and invisible operators, the byte-order
/// mark, the combining grapheme joiner, Mongolian and Khmer invisibles,
/// interlinear annotation, musical formatting, tag characters and the Hangul
/// fillers. A name holding one is not shown at all: what is shown has to be
/// the name. Joiners (U+200C, U+200D) and variation selectors stay, as emoji
/// need them. `BRANCH_REFUSED` in src/lib/terminalStatus.js is the same set.
/// Deliberately strict: a flag emoji's tag characters, Mongolian variation
/// selectors, the combining grapheme joiner and the RLM/ALM marks refuse a
/// name that holds them, though some are legitimate text (decided in review).
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '\u{00ad}'
            | '\u{034f}'
            | '\u{061c}'
            | '\u{115f}'
            | '\u{1160}'
            | '\u{17b4}'
            | '\u{17b5}'
            | '\u{180b}'..='\u{180f}'
            | '\u{200b}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{3164}'
            | '\u{feff}'
            | '\u{ffa0}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0000}'..='\u{e007f}'
    )
}

/// Whether `name` is a branch name git would take (`git check-ref-format`
/// for `refs/heads/<name>`, and no leading `-`, which `git branch` refuses)
/// and that shows as it is (`invisible`). A `HEAD` is whatever a file says,
/// and a repository can arrive in an archive: a name git itself would not
/// have written is not one.
fn ref_name_ok(name: &str) -> bool {
    if name.is_empty()
        || name == "@"
        || name.starts_with(['-', '/'])
        || name.ends_with(['/', '.'])
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
    {
        return false;
    }
    if name.chars().any(|c| invisible(c) || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')) {
        return false;
    }
    name.split('/').all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

/// A branch name as it may leave the backend, or `None` for one that is no
/// name (`ref_name_ok`): cut to BRANCH_CHARS_MAX characters, ending in "…".
fn branch_name(name: &str) -> Option<String> {
    if !ref_name_ok(name) {
        return None;
    }
    let chars: Vec<char> = name.chars().collect();
    if chars.len() <= BRANCH_CHARS_MAX {
        return Some(name.to_string());
    }
    let mut cut: String = chars[..BRANCH_CHARS_MAX - 1].iter().collect();
    cut.push('\u{2026}');
    Some(cut)
}

/// The contents of `path` when it is a regular file of at most HEAD_BYTES_MAX
/// bytes of UTF-8, else `None`. With `follow` false, a link is not opened
/// through — it is not a regular file — so a `HEAD` swapped for a link after
/// it was looked at is not read either.
///
/// Asked of the open file, not of the path before opening it: a `HEAD` that is
/// a FIFO would hold the open until something wrote to it, and one swapped
/// between a check and the open would get past the check. So the open does not
/// wait (`O_NONBLOCK`, which changes nothing for a regular file), and what was
/// opened is what is asked whether it is a file.
fn read_small_file(path: &Path, follow: bool) -> Option<String> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | if follow { 0 } else { libc::O_NOFOLLOW });
    }
    #[cfg(windows)]
    if !follow {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > HEAD_BYTES_MAX {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(HEAD_BYTES_MAX + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > HEAD_BYTES_MAX {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// What `head` says. A `HEAD` that is a link — `core.preferSymlinkRefs`,
/// `HEAD -> refs/heads/main` — says it in the link itself, which is read and
/// never followed: followed, it led to the branch's commit and read as a
/// detached head, and a link can lead anywhere.
fn read_head(head: &Path) -> Head {
    let Ok(meta) = std::fs::symlink_metadata(head) else {
        return Head::Unknown;
    };
    if meta.file_type().is_symlink() {
        return match std::fs::read_link(head) {
            Ok(target) => target.to_str().map_or(Head::Unknown, head_ref),
            Err(_) => Head::Unknown,
        };
    }
    read_small_file(head, false).map_or(Head::Unknown, |text| parse_head(&text))
}

/// Whether `path` is not to be looked at: by its spelling — empty, too long,
/// not absolute, another machine, a device (`fs::reveal::refusal`, the rules
/// for a name in a terminal's output) — on a mapped network drive
/// (`network_drive`, `fs::on_a_network_drive` in the app), or through a link
/// that leads to another machine or onto such a drive. Every path
/// `branch_of` opens is asked first.
fn refused(path: &Path, network_drive: &dyn Fn(&str) -> bool) -> bool {
    let spelled = path.to_string_lossy();
    crate::fs::reveal::refusal(&spelled, cfg!(windows)).is_some()
        || network_drive(&spelled)
        || crate::fs::link_leads_off_machine_by(path, network_drive)
}

/// The nearest folder at or above `start`, at most BRANCH_WALK_MAX of them,
/// that holds a `.git` of any kind — and that `.git`.
///
/// Only a `.git` that is certainly not there lets the walk go on up. One that
/// cannot be looked at — a folder that may not be searched — may be a
/// repository of its own, and the one above it would then be shown for a
/// folder that is not on its branch: the walk stops, with no branch.
fn find_dot_git(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut folder = start.to_path_buf();
    for _ in 0..BRANCH_WALK_MAX {
        let candidate = folder.join(".git");
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => return Some((folder, candidate)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        if !folder.pop() {
            return None;
        }
    }
    None
}

/// The repository folder a `.git` stands for, canonical: itself when it is a
/// folder; for a `.git` FILE — a worktree's, a submodule's — the folder its
/// `gitdir: …` line names, read against the file's own folder (`root`) when
/// relative. That line is followed once. Every step is judged before anything
/// beneath it is touched (`refused`), and where it all resolves to is judged
/// again.
fn git_dir_of(root: &Path, dot_git: &Path, network_drive: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    if refused(dot_git, network_drive) {
        return None;
    }
    // Follows a link, which `refused` has just judged to stay on this machine.
    let meta = std::fs::metadata(dot_git).ok()?;
    let target = if meta.is_dir() {
        dot_git.to_path_buf()
    } else {
        let text = read_small_file(dot_git, true)?;
        let named = text.strip_prefix("gitdir: ")?.trim_end_matches(['\n', '\r']);
        if named.is_empty() || named.contains(['\n', '\r', '\0']) {
            return None;
        }
        let named = Path::new(named);
        let target = if named.is_absolute() { named.to_path_buf() } else { root.join(named) };
        if refused(&target, network_drive) {
            return None;
        }
        target
    };
    let git_dir = dunce::canonicalize(&target).ok()?;
    (!refused(&git_dir, network_drive) && git_dir.is_dir()).then_some(git_dir)
}

/// The branch the folder `dir` is on, or `None`: not a repository, a `HEAD`
/// that names no branch, a reftable repository, or a folder that is not
/// looked at (`refused`).
///
/// The folder is resolved to the one its links lead to before walking up, as
/// git sees it from a shell standing in it: a link into the middle of a
/// repository is in that repository. Only after every link in it has been
/// judged to stay on this machine, and judged again once resolved.
pub fn branch_of(dir: &str) -> Option<BranchInfo> {
    branch_in(dir, &crate::fs::on_a_network_drive)
}

/// `branch_of`, with the mapped-drive check handed in so that the suites can
/// say a drive is one.
fn branch_in(dir: &str, network_drive: &dyn Fn(&str) -> bool) -> Option<BranchInfo> {
    // Before anything is looked at — `refused` already reads the links in the
    // path: a folder on an empty card reader fails quietly, with no box.
    let _quiet = crate::fs::QuietDriveErrors::new();
    let given = Path::new(dir);
    // A shell reports where it is with no `..` in it; one with is no folder
    // anybody is in, and walking it up by name would climb somewhere else.
    if given.components().any(|c| matches!(c, std::path::Component::ParentDir)) || refused(given, network_drive) {
        return None;
    }
    let start = dunce::canonicalize(given).ok()?;
    if refused(&start, network_drive) || !start.is_dir() {
        return None;
    }
    let (root, dot_git) = find_dot_git(&start)?;
    let git_dir = git_dir_of(&root, &dot_git, network_drive)?;
    let head = git_dir.join("HEAD");
    if refused(&head, network_drive) {
        return None;
    }
    let (branch, detached) = match read_head(&head) {
        Head::Branch(name) => (branch_name(&name)?, false),
        Head::Detached(id) => (id, true),
        // A reftable repository keeps its `HEAD` where only git can read it,
        // and git is not run for this (see the top of this section).
        Head::Reftable | Head::Unknown => return None,
    };
    Some(BranchInfo { branch, detached, repo: git_dir.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/w/proj")
    }

    /// Fields are NUL-separated, exactly as `-z` writes them.
    fn z(fields: &[&str]) -> String {
        let mut out = String::new();
        for f in fields {
            out.push_str(f);
            out.push('\0');
        }
        out
    }

    #[test]
    fn the_branch_and_how_far_it_is_from_upstream() {
        let out = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +3 -2",
        ]);
        let status = parse_status(&out, &root());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.ahead, 3);
        assert_eq!(status.behind, 2);
        assert!(status.files.is_empty());
    }

    #[test]
    fn a_detached_head_has_no_branch_rather_than_a_fake_one() {
        // The status bar's old lie was a branch that was always "main". None
        // is the honest answer, and the UI has to be able to say so.
        let out = z(&["# branch.oid abc123", "# branch.head (detached)"]);
        assert_eq!(parse_status(&out, &root()).branch, None);
    }

    #[test]
    fn a_modified_file_is_absolute_and_marked() {
        let out = z(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 aaa bbb src/app.js",
        ]);
        let status = parse_status(&out, &root());
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, root().join("src").join("app.js").to_string_lossy());
        assert_eq!(status.files[0].status, GitFileStatus::Modified);
        assert_eq!(status.files[0].staged, false);
    }

    #[test]
    fn staged_is_the_index_column() {
        let out = z(&[
            "# branch.head main",
            "1 M. N... 100644 100644 100644 aaa bbb staged.js",
            "1 MM N... 100644 100644 100644 aaa bbb both.js",
        ]);
        let status = parse_status(&out, &root());
        assert_eq!(status.files[0].staged, true, "M. is staged and clean in the tree");
        assert_eq!(status.files[1].staged, true, "MM is staged AND edited again");
        // The worktree side wins for the colour: that is the state of the file
        // you would open.
        assert_eq!(status.files[1].status, GitFileStatus::Modified);
    }

    #[test]
    fn added_deleted_and_untracked_are_told_apart() {
        let out = z(&[
            "# branch.head main",
            "1 A. N... 000000 100644 100644 aaa bbb new.js",
            "1 .D N... 100644 100644 000000 aaa bbb gone.js",
            "? whatever.log",
        ]);
        let status = parse_status(&out, &root());
        let kinds: Vec<_> = status.files.iter().map(|f| f.status).collect();
        assert_eq!(kinds, vec![GitFileStatus::Added, GitFileStatus::Deleted, GitFileStatus::Untracked]);
    }

    #[test]
    fn a_rename_does_not_swallow_the_next_file() {
        // The original path arrives as its own NUL field. Failing to consume it
        // would make it look like a status line and drop whatever came next.
        let out = z(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.js",
            "old/name.js",
            "1 .M N... 100644 100644 100644 aaa bbb after.js",
        ]);
        let status = parse_status(&out, &root());
        assert_eq!(status.files.len(), 2, "the file after the rename must survive");
        assert_eq!(status.files[0].status, GitFileStatus::Renamed);
        assert!(
            status.files[0].path.ends_with(&*Path::new("new").join("name.js").to_string_lossy()),
            "{}",
            status.files[0].path
        );
        assert!(status.files[1].path.ends_with("after.js"));
    }

    #[test]
    fn a_path_with_spaces_or_non_ascii_survives() {
        // Exactly why `-z` is used: without it git quotes and escapes these,
        // and the paths would match nothing in the Explorer.
        let out = z(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 aaa bbb src/한글 폴더/파일.js",
            "? 새 파일.txt",
        ]);
        let status = parse_status(&out, &root());
        let tail = Path::new("src").join("한글 폴더").join("파일.js");
        assert!(status.files[0].path.ends_with(&*tail.to_string_lossy()), "{}", status.files[0].path);
        assert!(status.files[1].path.ends_with("새 파일.txt"));
    }

    #[test]
    fn paths_are_relative_to_the_repository_not_the_open_folder() {
        // You may have opened a subdirectory of the repository; git's paths are
        // always from the top level.
        let out = z(&["# branch.head main", "1 .M N... 100644 100644 100644 aaa bbb apps/web/src/a.js"]);
        let status = parse_status(&out, Path::new("/w/monorepo"));
        let expected = Path::new("/w/monorepo").join("apps").join("web").join("src").join("a.js");
        assert_eq!(status.files[0].path, expected.to_string_lossy());
    }

    #[test]
    fn a_path_is_joined_with_the_platform_separator() {
        // git writes `/` on every platform. Keeping those on Windows produces
        // `C:\\proj\\src/app.js`, which matches nothing the Explorer holds —
        // every file would go uncoloured, silently, on the platform this app
        // is mostly used on. CI on windows-latest is what caught it.
        let joined = join_repo_path(Path::new("/w/proj"), "src/deep/app.js");
        let expected = Path::new("/w/proj").join("src").join("deep").join("app.js");
        assert_eq!(joined, expected.to_string_lossy());
        assert_eq!(
            joined.contains(std::path::MAIN_SEPARATOR),
            true,
            "nothing was joined natively: {joined}"
        );
        // Only the part this function joined is checked for the separator.
        // The ROOT here is written `/w/proj`, and on Windows those slashes are
        // left exactly as given — it is the joining that had to change, not
        // whatever the caller handed in.
        let tail = &joined[joined.len() - "src/deep/app.js".len()..];
        #[cfg(windows)]
        assert!(!tail.contains('/'), "a forward slash survived the join: {tail}");
        #[cfg(not(windows))]
        assert_eq!(tail, "src/deep/app.js");
    }

    #[test]
    fn nothing_at_all_is_an_empty_status_not_a_panic() {
        let status = parse_status("", &root());
        assert_eq!(status.branch, None);
        assert!(status.files.is_empty());
        assert!(!status.truncated);
    }

    #[test]
    fn a_repository_with_too_many_changes_is_capped() {
        let mut fields = vec!["# branch.head main".to_string()];
        for i in 0..(MAX_FILES + 50) {
            fields.push(format!("1 .M N... 100644 100644 100644 aaa bbb f{i}.js"));
        }
        let refs: Vec<&str> = fields.iter().map(String::as_str).collect();
        let status = parse_status(&z(&refs), &root());
        assert_eq!(status.files.len(), MAX_FILES);
        assert!(status.truncated, "what was cut has to be reported");
    }

    /// Both calls `status_of` makes, as the arguments git is actually given:
    /// the options belong to git itself, so they have to come before the
    /// subcommand, and none of them may be lost on the way.
    #[test]
    fn every_background_call_takes_no_lock_and_runs_no_fsmonitor() {
        for subcommand in [&["rev-parse", "--show-toplevel"][..], &STATUS_ARGS[..]] {
            let command = git_command(Path::new("/w/proj"), subcommand);
            assert_eq!(command.get_program(), "git");
            let args: Vec<String> = command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let at = args
                .iter()
                .position(|a| a == subcommand[0])
                .unwrap_or_else(|| panic!("no subcommand in {args:?}"));
            let (global, rest) = args.split_at(at);
            assert!(
                global.iter().any(|a| a == "--no-optional-locks"),
                "a background {} may take .git/index.lock: {args:?}",
                subcommand[0]
            );
            assert!(
                global.windows(2).any(|w| w[0] == "-c" && w[1] == "core.fsmonitor=false"),
                "a background {} runs whatever core.fsmonitor names: {args:?}",
                subcommand[0]
            );
            assert!(global.windows(2).any(|w| w[0] == "-C" && w[1] == "/w/proj"), "{args:?}");
            assert_eq!(rest, subcommand, "the subcommand's own arguments changed: {args:?}");
        }
    }

    /// A throwaway repository holding one committed file, or `None` when this
    /// machine cannot make one (no git, or one too old for `GIT_CONFIG_GLOBAL`).
    ///
    /// It is set up by a git that reads none of this machine's configuration,
    /// so a developer's `commit.gpgsign` or hooks path cannot get in the way.
    /// What is under test is run the way the app runs it, through `status_of`.
    fn scratch_repo(tag: &str) -> Option<PathBuf> {
        let base = std::env::temp_dir().join(format!("nexterm-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).ok()?;
        let no_config = base.join("empty.gitconfig");
        std::fs::write(&no_config, "").ok()?;
        std::fs::write(repo.join("tracked.txt"), "unchanged\n").ok()?;

        for args in [
            &["init", "-q"][..],
            &["add", "tracked.txt"][..],
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "one file"][..],
        ] {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", &no_config)
                .env("GIT_AUTHOR_NAME", "NexTerm")
                .env("GIT_AUTHOR_EMAIL", "nexterm@example.invalid")
                .env("GIT_COMMITTER_NAME", "NexTerm")
                .env("GIT_COMMITTER_EMAIL", "nexterm@example.invalid")
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false);
            if !ok {
                let _ = std::fs::remove_dir_all(&base);
                return None;
            }
        }
        Some(repo)
    }

    /// The status runs in the background — on opening a folder and after every
    /// burst of file changes — while an agent or the user runs git in a
    /// terminal. A status allowed to take locks refreshes the index and writes
    /// it back, holding `.git/index.lock` meanwhile, and a `git commit` or a
    /// rebase step that needs the lock at that moment fails with "index.lock:
    /// File exists". Writing the index is exactly what taking that lock is for,
    /// so an index that comes through byte for byte is the observable proof.
    #[test]
    fn a_background_status_never_writes_the_index() {
        let Some(repo) = scratch_repo("index") else {
            eprintln!("git unavailable or too old; skipping");
            return;
        };
        // The same content with a different mtime: the stat data the index
        // caches for the file is stale, so a status that may write refreshes
        // it and writes the index back.
        let file = std::fs::File::options()
            .write(true)
            .open(repo.join("tracked.txt"))
            .expect("open the tracked file");
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
            .expect("age the tracked file");
        drop(file);

        let index = repo.join(".git").join("index");
        let before = std::fs::read(&index).expect("the index");
        let status = status_of(&repo);
        let after = std::fs::read(&index).expect("the index");
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());

        let status = status.expect("a repository answers");
        assert!(status.files.is_empty(), "nothing changed, but git said {:?}", status.files);
        assert!(
            before == after,
            "the background status rewrote .git/index, so it held .git/index.lock while it \
             ran — a `git commit` in a terminal at that moment fails"
        );
    }

    /// `core.fsmonitor` may name a program, and git runs it on every status.
    /// A folder from an archive or a shared drive can carry that in
    /// `.git/config`, and the status here runs on its own when the folder is
    /// opened or restored — the user never typed a git command. On Windows,
    /// where cmd.exe has no git prompt, nothing else would have run it.
    #[cfg(unix)]
    #[test]
    fn a_repository_cannot_make_the_background_status_run_a_program() {
        use std::os::unix::fs::PermissionsExt;

        let Some(repo) = scratch_repo("fsmonitor") else {
            eprintln!("git unavailable or too old; skipping");
            return;
        };
        let base = repo.parent().unwrap().to_path_buf();
        let ran = base.join("the-hook-ran");
        let hook = repo.join(".git").join("fsmonitor-hook");
        std::fs::write(&hook, format!("#!/bin/sh\necho ran >> '{}'\n", ran.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Written into the repository's own config, the way it would arrive.
        let config = repo.join(".git").join("config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str(&format!("[core]\n\tfsmonitor = {}\n", hook.display()));
        std::fs::write(&config, text).unwrap();

        let status = status_of(&repo);
        let hook_ran = ran.exists();
        let _ = std::fs::remove_dir_all(&base);

        assert!(status.is_some(), "the repository still answers");
        assert!(!hook_ran, "opening the folder ran the program its .git/config names as core.fsmonitor");
    }

    /// Only a driver whose command the repository sets is switched off; one
    /// from the user's own config — git-lfs's — still runs, even where the
    /// repository marks it required.
    #[test]
    fn only_the_filters_a_repository_sets_commands_for_are_switched_off() {
        let listing = z(&[
            "global",
            "filter.lfs.clean\ngit-lfs clean -- %f",
            "global",
            "filter.lfs.process\ngit-lfs filter-process",
            "local",
            "filter.lfs.required\ntrue",
            "local",
            "filter.evil.clean\n./x",
            "worktree",
            "filter.My.Dotted.name.smudge\n./y",
            "system",
            "filter.site.process\n./z",
            "local",
            "filter.other.textconv\n./w",
        ]);
        let set = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<BTreeSet<_>>();
        assert_eq!(filter_drivers(&listing, true), set(&["My.Dotted.name", "evil"]));
        assert!(filter_drivers("", true).is_empty());
        assert!(filter_drivers("", false).is_empty());

        // A git too old for `--show-scope`: every driver with a command.
        let unscoped = z(&["filter.lfs.clean\nx", "filter.evil.process\ny", "filter.req.required\ntrue"]);
        assert_eq!(filter_drivers(&unscoped, false), set(&["evil", "lfs"]));
    }

    /// Runs git as `scratch_repo` sets repositories up, reading none of this
    /// machine's configuration.
    #[cfg(unix)]
    fn set_up(repo: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "NexTerm")
            .env("GIT_AUTHOR_EMAIL", "nexterm@example.invalid")
            .env("GIT_COMMITTER_NAME", "NexTerm")
            .env("GIT_COMMITTER_EMAIL", "nexterm@example.invalid")
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A clean filter the repository defines, assigned to every file by a
    /// committed `.gitattributes` — the two halves that arrive with a folder —
    /// and a tracked file whose cached stat data is out of date, as in any
    /// folder just unpacked. Returns where the filter leaves its mark.
    #[cfg(unix)]
    fn plant_a_filter(repo: &Path, driver: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let ran = repo.parent().unwrap().join(format!("the-filter-ran-{}", driver.len()));
        let script = repo.parent().unwrap().join(format!("filter-{}.sh", driver.len()));
        std::fs::write(&script, format!("#!/bin/sh\necho ran >> '{}'\ncat\n", ran.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(repo.join(".gitattributes"), format!("* filter={driver}\n")).unwrap();
        set_up(repo, &["add", ".gitattributes"]);
        set_up(repo, &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "attributes"]);
        let config = repo.join(".git").join("config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str(&format!("[filter \"{driver}\"]\n\tclean = {}\n\trequired = true\n", script.display()));
        std::fs::write(&config, text).unwrap();
        let file = std::fs::File::options().write(true).open(repo.join("tracked.txt")).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        ran
    }

    /// Found in review: the status that runs on opening a folder ran the
    /// clean filter the folder's own `.git/config` defines. It answers as
    /// before — an unchanged file unchanged, a changed one changed — without.
    #[cfg(unix)]
    #[test]
    fn a_repository_cannot_make_the_background_status_run_its_filters() {
        let Some(repo) = scratch_repo("filters") else {
            eprintln!("git unavailable or too old; skipping");
            return;
        };
        let ran = plant_a_filter(&repo, "evil");

        let unchanged = status_of(&repo);
        std::fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
        let changed = status_of(&repo);
        let filter_ran = ran.exists();
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());

        assert!(!filter_ran, "opening the folder ran the clean filter its .git/config defines");
        let unchanged = unchanged.expect("the repository still answers, its filter marked required");
        assert!(unchanged.files.is_empty(), "nothing changed, but git said {:?}", unchanged.files);
        let changed = changed.expect("the repository still answers");
        assert!(
            changed.files.iter().any(|f| f.path.ends_with("tracked.txt") && f.status == GitFileStatus::Modified),
            "{:?}",
            changed.files
        );
    }

    /// `-c` cannot name a driver with `=` in it, and git runs one all the same.
    #[cfg(unix)]
    #[test]
    fn a_filter_that_cannot_be_switched_off_costs_the_status_not_a_program() {
        let Some(repo) = scratch_repo("filter-eq") else {
            eprintln!("git unavailable or too old; skipping");
            return;
        };
        let ran = plant_a_filter(&repo, "a=b");

        let status = status_of(&repo);
        let filter_ran = ran.exists();
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());

        assert!(!filter_ran, "the filter named `a=b` ran");
        assert!(status.is_none(), "{status:?}");
    }

    /// A submodule's working tree is asked about by a git run inside it, with
    /// the submodule's own config — filters the status never saw.
    #[cfg(unix)]
    #[test]
    fn a_submodule_cannot_make_the_background_status_run_its_filters() {
        let (Some(sub), Some(repo)) = (scratch_repo("filter-sub"), scratch_repo("filter-super")) else {
            eprintln!("git unavailable or too old; skipping");
            return;
        };
        let sub_path = sub.to_string_lossy().to_string();
        set_up(&repo, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &sub_path, "sub"]);
        set_up(&repo, &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "submodule"]);
        let inside = repo.join("sub");
        // The planted config lands in the superproject's .git/modules/sub.
        let ran = {
            std::fs::write(inside.join(".gitattributes"), "* filter=evil\n").unwrap();
            set_up(&inside, &["add", ".gitattributes"]);
            set_up(&inside, &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "attributes"]);
            let ran = repo.parent().unwrap().join("the-submodule-filter-ran");
            set_up(&inside, &["config", "filter.evil.clean", &format!("sh -c \"echo ran >> '{}'; cat\"", ran.display())]);
            let file = std::fs::File::options().write(true).open(inside.join("tracked.txt")).unwrap();
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
            ran
        };

        let status = status_of(&repo);
        let filter_ran = ran.exists();
        let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        let _ = std::fs::remove_dir_all(sub.parent().unwrap());

        assert!(!filter_ran, "the status ran the clean filter a submodule's config defines");
        let status = status.expect("the repository still answers");
        // The submodule's commit moved (the attributes commit), and that still shows.
        assert!(status.files.iter().any(|f| f.path.ends_with("sub")), "{:?}", status.files);
    }

    #[test]
    fn this_very_repository_answers() {
        // Not a unit test of the parser: the one case that proves the whole
        // path — spawning git, reading porcelain v2, resolving the top level —
        // works against a real repository, which this is.
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        match status_of(here) {
            Some(status) => {
                assert!(
                    status.branch.is_some() || status.files.is_empty() || status.ahead == 0,
                    "a real repository answered with nothing at all"
                );
            }
            None => {
                // git may genuinely be absent on a build machine; that is the
                // "nothing to say" answer and not a failure.
                eprintln!("git unavailable or not a repository; skipping");
            }
        }
    }
}


/// The branch of a terminal's folder (`branch_of`), against real folders made
/// for each case. None of these needs git on the machine but the reftable one,
/// which says so when it cannot run.
#[cfg(test)]
mod branch_tests {
    use super::*;
    use std::fs;

    /// A folder of its own for one test, canonical: cargo runs tests in
    /// parallel.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-branch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// A repository as far as `branch_of` is concerned: a `.git` folder
    /// holding `HEAD`, and nothing else — not one git would accept, which is
    /// how the cases show that git was never asked.
    fn fake_repo(root: &Path, head: &[u8]) {
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("HEAD"), head).unwrap();
    }

    /// What the side bar shows for `dir`: the name and whether it is a
    /// detached head. The repository it is in is asked about on its own.
    fn shown(dir: &str) -> Option<(String, bool)> {
        branch_of(dir).map(|b| (b.branch, b.detached))
    }

    fn shown_in(dir: &str, network_drive: &dyn Fn(&str) -> bool) -> Option<(String, bool)> {
        branch_in(dir, network_drive).map(|b| (b.branch, b.detached))
    }

    fn branch(name: &str) -> Option<(String, bool)> {
        Some((name.to_string(), false))
    }

    /// Nothing above the scratch folders is a repository — or every "no
    /// repository" answer below would be about that one.
    fn premise_no_repository_above(dir: &Path) {
        let mut up = dir.parent().map(Path::to_path_buf);
        while let Some(folder) = up {
            assert!(
                fs::symlink_metadata(folder.join(".git")).is_err(),
                "premise: {} is in a repository",
                folder.display()
            );
            up = folder.parent().map(Path::to_path_buf);
        }
    }

    #[test]
    fn head_names_a_branch_a_detached_commit_or_nothing() {
        let sha1 = "0123456789abcdef0123456789abcdef01234567";
        let sha256 = "0123456789abcdef".repeat(4);
        let detached = || Head::Detached("0123456".into());
        let cases: Vec<(String, Head)> = vec![
            ("ref: refs/heads/main\n".into(), Head::Branch("main".into())),
            ("ref:refs/heads/main".into(), Head::Branch("main".into())),
            ("ref: \trefs/heads/feature/a-b\r\n".into(), Head::Branch("feature/a-b".into())),
            ("ref: refs/heads/main  \n\n".into(), Head::Branch("main".into())),
            ("ref: refs/heads/\u{d55c}\u{ae00}/x\n".into(), Head::Branch("\u{d55c}\u{ae00}/x".into())),
            (format!("{sha1}\n"), detached()),
            (sha1.to_uppercase(), detached()),
            (format!("{sha256}\n"), detached()),
            // git reads the id and takes whatever follows a space as nothing.
            (format!("{sha1} trailing-text\n"), detached()),
            (format!("{sha1}\tx\ny"), detached()),
            ("ref: refs/heads/.invalid\n".into(), Head::Reftable),
            ("ref: refs/remotes/origin/main\n".into(), Head::Unknown),
            ("ref: refs/heads/\n".into(), Head::Unknown),
            ("ref: refs/tags/v1\n".into(), Head::Unknown),
            ("ref: refs/heads/a\nref: refs/heads/b\n".into(), Head::Unknown),
            ("ref: refs/heads/a b\n".into(), Head::Unknown),
            ("".into(), Head::Unknown),
            ("garbage\n".into(), Head::Unknown),
            (sha1[..39].to_string(), Head::Unknown),
            (format!("{}g", &sha1[..39]), Head::Unknown),
            (format!("{sha1}0"), Head::Unknown),
            (format!("{sha1}x"), Head::Unknown),
            (format!("{}{}", sha1, &sha1[..10]), Head::Unknown),
            ("\u{feff}ref: refs/heads/main\n".into(), Head::Unknown),
            (" ref: refs/heads/main".into(), Head::Unknown),
        ];
        for (text, want) in cases {
            assert_eq!(parse_head(&text), want, "{text:?}");
        }
    }

    /// The same vectors as TS-15 in tests/adversarial/terminal_status.test.js
    /// (`cleanBranchName`): the webview checks the name again, and the two
    /// must agree. A name git would refuse, or one holding a character that
    /// does not show, is no name; a long one is cut.
    #[test]
    fn a_branch_name_must_pass_git_and_show_as_it_is() {
        let x = |n: usize| "x".repeat(n);
        let kept: Vec<(String, String)> = vec![
            ("main".into(), "main".into()),
            ("feature/x".into(), "feature/x".into()),
            ("fix-1.2_b+c=d,e".into(), "fix-1.2_b+c=d,e".into()),
            ("\u{d55c}\u{ae00}/\u{bd84}\u{b79c}\u{ce58}".into(), "\u{d55c}\u{ae00}/\u{bd84}\u{b79c}\u{ce58}".into()),
            ("zw\u{200d}j".into(), "zw\u{200d}j".into()),
            ("\u{1f600}".into(), "\u{1f600}".into()),
            ("HEAD".into(), "HEAD".into()),
            (x(100), x(100)),
            (x(101), format!("{}\u{2026}", x(99))),
            ("\u{d55c}".repeat(150), format!("{}\u{2026}", "\u{d55c}".repeat(99))),
            ("\u{1f600}".repeat(120), format!("{}\u{2026}", "\u{1f600}".repeat(99))),
        ];
        for (given, want) in kept {
            assert_eq!(branch_name(&given), Some(want), "{given:?}");
        }
        let refused = [
            "", "a\u{0000}b", "a\u{001b}[31mb", "a\u{007f}b", "x\u{0085}y", "x\u{009f}y",
            "evil\u{202e}gnp.exe", "\u{2066}x\u{2069}", "a\u{200e}b", "a\u{200f}b", "a\u{061c}b",
            "line\u{2028}sep", "para\u{2029}sep",
            "a\u{200b}b", "\u{feff}main", "soft\u{00ad}hyphen", "word\u{2060}joiner", "tag\u{e0041}",
            "\u{e0001}x", "hangul\u{3164}", "\u{115f}x", "x\u{1160}", "half\u{ffa0}width",
            "a..b", "a b", "a\tb", "a~1", "a^", "a:b", "a?", "a*", "a[0]", "a\\b",
            "-x", "/x", "x/", "x.", "x.lock", "a.lock/b", "a/.b", ".x", "a@{1}", "a//b", "@",
        ];
        for given in refused {
            assert_eq!(branch_name(given), None, "{given:?}");
        }
    }

    #[test]
    fn a_folder_deep_in_a_repository_is_on_its_branch() {
        let base = scratch("deep");
        premise_no_repository_above(&base);
        fake_repo(&base, b"ref: refs/heads/feature/x\n");
        let deep = base.join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(shown(&s(&deep)), branch("feature/x"), "no git ran: this repository has no objects");
        assert_eq!(shown(&s(&base)), branch("feature/x"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_detached_head_is_its_commit_cut_to_seven() {
        let base = scratch("detached");
        fake_repo(&base, b"89ABCDEF0123456789abcdef0123456789abcdef\n");
        assert_eq!(shown(&s(&base)), Some(("89abcde".to_string(), true)));
        let _ = fs::remove_dir_all(&base);
    }

    /// Which repository a folder is in — the folder holding the `HEAD` that
    /// was read, canonical — so the webview can look again at every folder
    /// a `git switch` changed. Never shown.
    #[test]
    fn the_repository_is_named_by_the_folder_its_head_is_in() {
        let base = scratch("identity");
        premise_no_repository_above(&base);
        let main = base.join("main");
        fake_repo(&main, b"ref: refs/heads/main\n");
        fs::create_dir_all(main.join("a").join("b")).unwrap();
        let gitdir = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();

        let repo = |dir: &Path| branch_of(&s(dir)).map(|b| b.repo);
        assert_eq!(repo(&main), Some(s(&main.join(".git"))));
        assert_eq!(repo(&main.join("a").join("b")), repo(&main), "one repository, one name");
        assert_eq!(repo(&wt), Some(s(&gitdir)), "a worktree has a HEAD of its own");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&main, base.join("link")).unwrap();
            assert_eq!(repo(&base.join("link").join("a")), repo(&main), "reached through a link, the same");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_head_that_is_garbage_too_big_or_not_text_is_no_branch() {
        let base = scratch("garbage");
        premise_no_repository_above(&base);
        for head in [&b"garbage\n"[..], b"", b"ref: refs/heads/\xff\xfe\n", b"ref: refs/remotes/x\n"] {
            fake_repo(&base, head);
            assert_eq!(shown(&s(&base)), None, "{:?}", String::from_utf8_lossy(head));
        }
        // HEAD_BYTES_MAX exactly is read — and its name cut to what is shown.
        let prefix = "ref: refs/heads/";
        let fits = format!("{prefix}{}\n", "y".repeat(HEAD_BYTES_MAX as usize - prefix.len() - 1));
        assert_eq!(fits.len() as u64, HEAD_BYTES_MAX);
        fake_repo(&base, fits.as_bytes());
        assert_eq!(shown(&s(&base)), branch(&format!("{}\u{2026}", "y".repeat(BRANCH_CHARS_MAX - 1))));
        // One byte more is not.
        let over = format!("{prefix}{}\n", "y".repeat(HEAD_BYTES_MAX as usize - prefix.len()));
        fake_repo(&base, over.as_bytes());
        assert_eq!(shown(&s(&base)), None, "a HEAD over {HEAD_BYTES_MAX} bytes is not one git wrote");
        // A name git would refuse is no name.
        for head in [&b"ref: refs/heads/\x07\x1b\n"[..], b"ref: refs/heads/a..b\n", b"ref: refs/heads/x.lock\n"] {
            fake_repo(&base, head);
            assert_eq!(shown(&s(&base)), None, "{:?}", String::from_utf8_lossy(head));
        }
        // A HEAD that is a folder.
        fs::remove_file(base.join(".git").join("HEAD")).unwrap();
        fs::create_dir_all(base.join(".git").join("HEAD")).unwrap();
        assert_eq!(shown(&s(&base)), None);
        let _ = fs::remove_dir_all(&base);
    }

    /// A FIFO named HEAD would hold an ordinary open until something wrote to
    /// it — and the lookup runs for every terminal.
    #[cfg(unix)]
    #[test]
    fn a_head_that_is_a_fifo_does_not_hold_the_lookup() {
        let base = scratch("fifo");
        fs::create_dir_all(base.join(".git")).unwrap();
        let head = std::ffi::CString::new(s(&base.join(".git").join("HEAD"))).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(head.as_ptr(), 0o644) }, 0, "premise: a FIFO");
        let dir = s(&base);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(branch_of(&dir));
        });
        let answer = rx.recv_timeout(std::time::Duration::from_secs(5));
        let _ = fs::remove_dir_all(&base);
        assert_eq!(answer.expect("the lookup returned rather than waiting on the FIFO"), None);
    }

    /// `core.preferSymlinkRefs`: `HEAD -> refs/heads/main`. What the link
    /// says is the answer; it is never followed — following it read the
    /// branch's commit and showed a detached head.
    #[cfg(unix)]
    #[test]
    fn a_head_that_is_a_link_is_read_as_the_ref_it_names() {
        use std::os::unix::fs::symlink;
        let base = scratch("headlink");
        premise_no_repository_above(&base);
        fs::create_dir_all(base.join(".git").join("refs").join("heads")).unwrap();
        fs::write(base.join(".git").join("refs").join("heads").join("main"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        let head = base.join(".git").join("HEAD");
        symlink("refs/heads/main", &head).unwrap();
        assert_eq!(shown(&s(&base)), branch("main"));
        for target in ["../outside/HEAD", "refs/heads/bad name", "refs/tags/v1", "/etc/passwd", "refs/heads/"] {
            fs::remove_file(&head).unwrap();
            symlink(target, &head).unwrap();
            assert_eq!(shown(&s(&base)), None, "HEAD -> {target}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn no_repository_is_no_branch() {
        let base = scratch("none");
        premise_no_repository_above(&base);
        fs::create_dir_all(base.join("x")).unwrap();
        assert_eq!(shown(&s(&base.join("x"))), None);
        assert_eq!(shown(&s(&base.join("missing"))), None, "a folder that does not exist");
        fs::write(base.join("file.txt"), "x").unwrap();
        assert_eq!(shown(&s(&base.join("file.txt"))), None, "a file is no folder");
        let _ = fs::remove_dir_all(&base);
    }

    /// A repository inside another whose `.git` cannot be looked at is not
    /// taken for no repository: the outer one's branch would be shown for a
    /// folder that is on another.
    #[cfg(unix)]
    #[test]
    fn a_git_that_cannot_be_read_stops_the_walk() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: plain call.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("running as root, which reads anything; skipping");
            return;
        }
        let base = scratch("unreadable");
        premise_no_repository_above(&base);
        fake_repo(&base, b"ref: refs/heads/outer\n");
        let inner = base.join("inner");
        fake_repo(&inner, b"ref: refs/heads/inner\n");
        assert_eq!(shown(&s(&inner)), branch("inner"), "premise");
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o600)).unwrap();
        let answer = shown(&s(&inner));
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&base);
        assert_eq!(answer, None, "the outer repository's branch was shown for the inner one");
    }

    /// The `.git` 63 folders up is found — the 64th folder looked in — and one
    /// 64 up is not.
    #[test]
    fn the_walk_up_looks_in_at_most_64_folders() {
        let base = scratch("walk");
        premise_no_repository_above(&base);
        fake_repo(&base, b"ref: refs/heads/main\n");
        let mut deep = base.clone();
        for _ in 0..(BRANCH_WALK_MAX - 1) {
            deep.push("d");
        }
        fs::create_dir_all(deep.join("d")).unwrap();
        assert_eq!(shown(&s(&deep)), branch("main"), "{} folders up", BRANCH_WALK_MAX - 1);
        assert_eq!(shown(&s(&deep.join("d"))), None, "{BRANCH_WALK_MAX} folders up");
        let _ = fs::remove_dir_all(&base);
    }

    /// A worktree's `.git` is a file naming its folder in the main
    /// repository, relative or absolute; a submodule's the same.
    #[test]
    fn a_git_file_leads_to_its_worktree_relative_or_absolute() {
        let base = scratch("worktree");
        premise_no_repository_above(&base);
        let main = base.join("main");
        fake_repo(&main, b"ref: refs/heads/main\n");
        let gitdir = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();

        let relative = base.join("wt-relative");
        fs::create_dir_all(relative.join("src")).unwrap();
        fs::write(relative.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        assert_eq!(shown(&s(&relative.join("src"))), branch("topic"), "read against the .git file's own folder");

        let absolute = base.join("wt-absolute");
        fs::create_dir_all(&absolute).unwrap();
        fs::write(absolute.join(".git"), format!("gitdir: {}\r\n", s(&gitdir))).unwrap();
        assert_eq!(shown(&s(&absolute)), branch("topic"));
        let _ = fs::remove_dir_all(&base);
    }

    /// Followed once: a `gitdir:` naming another `.git` FILE is not read as
    /// one; a malformed line, or one with more after it, names nothing.
    #[test]
    fn a_git_file_is_followed_once_and_only_when_well_formed() {
        let base = scratch("gitfile");
        premise_no_repository_above(&base);
        let target = base.join("target");
        fake_repo(&target, b"ref: refs/heads/main\n");
        let chained = base.join("chained");
        fs::create_dir_all(&chained).unwrap();
        fs::write(chained.join(".git"), "gitdir: ../target/.git\n").unwrap();
        assert_eq!(shown(&s(&chained)), branch("main"), "premise: a well-formed one is followed");

        let twice = base.join("twice");
        fs::create_dir_all(&twice).unwrap();
        fs::write(twice.join(".git"), "gitdir: ../chained/.git\n").unwrap();
        assert_eq!(shown(&s(&twice)), None, "a .git file naming another .git file");

        let bad = base.join("bad");
        fs::create_dir_all(&bad).unwrap();
        for text in ["gitdir:../target/.git\n", "GITDIR: ../target/.git\n", "gitdir: \n", "gitdir: ../target/.git\nextra\n", "nothing\n"] {
            fs::write(bad.join(".git"), text).unwrap();
            assert_eq!(shown(&s(&bad)), None, "{text:?}");
        }
        fs::write(bad.join(".git"), "gitdir: ../missing\n").unwrap();
        assert_eq!(shown(&s(&bad)), None, "a folder that is not there");
        let _ = fs::remove_dir_all(&base);
    }

    /// Spelled as another machine: never looked at. On Unix `//…` is a LOCAL
    /// path, so a repository that exists is spelled that way too — had it been
    /// read, it would have answered "main".
    #[test]
    fn a_folder_spelled_as_another_machine_is_never_looked_at() {
        let base = scratch("spelled");
        fake_repo(&base, b"ref: refs/heads/main\n");
        fs::create_dir_all(base.join("sub")).unwrap();
        assert_eq!(shown(&s(&base)), branch("main"), "premise");
        let mut asked = vec![
            r"\\host\share\repo".to_string(),
            "//host/share/repo".to_string(),
            r"\\?\UNC\host\share\repo".to_string(),
            r"\??\UNC\host\share\repo".to_string(),
            r"\\wsl$\Ubuntu\home\me\repo".to_string(),
            r"\\.\pipe\x".to_string(),
            "relative/repo".to_string(),
            String::new(),
            format!("{}/{}", s(&base), "x".repeat(crate::fs::reveal::MAX_KIND_PATH_BYTES)),
            format!("{}/sub/../", s(&base)),
        ];
        if cfg!(unix) {
            let spelled = format!("/{}", s(&base));
            assert!(crate::fs::is_network_path(&spelled), "premise: {spelled} reads as another machine");
            assert!(Path::new(&spelled).join(".git").is_dir(), "premise: {spelled} is a repository here");
            asked.push(spelled);
        }
        for dir in &asked {
            assert_eq!(shown(dir), None, "{dir}");
        }

        // A `.git` file sending the lookup there is refused alike.
        if cfg!(unix) {
            let wt = base.join("wt");
            fs::create_dir_all(&wt).unwrap();
            fs::write(wt.join(".git"), format!("gitdir: /{}\n", s(&base.join(".git")))).unwrap();
            assert_eq!(shown(&s(&wt)), None, "a gitdir spelled as another machine");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Links, or chains of them, that lead to a path on another machine are
    /// not followed — wherever they are: in the folder, as `.git`, as `HEAD`.
    #[cfg(unix)]
    #[test]
    fn a_link_leading_off_the_machine_is_never_followed() {
        use std::os::unix::fs::symlink;
        let base = scratch("links");
        premise_no_repository_above(&base);
        let real = base.join("real");
        fake_repo(&real, b"ref: refs/heads/main\n");
        fs::create_dir_all(real.join("sub")).unwrap();

        // A link that stays on this machine is followed, as git would — to
        // where it leads, so a link into the middle of a repository is in
        // that repository, though no `.git` is above the link itself.
        symlink(&real, base.join("near")).unwrap();
        assert_eq!(shown(&s(&base.join("near").join("sub"))), branch("main"), "premise: a local link is followed");
        symlink(real.join("sub"), base.join("into-sub")).unwrap();
        assert_eq!(shown(&s(&base.join("into-sub"))), branch("main"), "walked up from where the link leads");

        // `via -> far -> //<the repository>`
        symlink(format!("/{}", s(&real)), base.join("far")).unwrap();
        symlink("far", base.join("via")).unwrap();
        assert_eq!(shown(&s(&base.join("far").join("sub"))), None);
        assert_eq!(shown(&s(&base.join("via").join("sub"))), None, "through a chain");

        // `.git` itself a link off the machine.
        let dotgit = base.join("dotgit");
        fs::create_dir_all(&dotgit).unwrap();
        symlink(format!("/{}", s(&real.join(".git"))), dotgit.join(".git")).unwrap();
        assert_eq!(shown(&s(&dotgit)), None, ".git leading off the machine");

        // HEAD a link off the machine: never followed, and no ref.
        let headlink = base.join("headlink");
        fs::create_dir_all(headlink.join(".git")).unwrap();
        symlink(format!("/{}", s(&real.join(".git").join("HEAD"))), headlink.join(".git").join("HEAD")).unwrap();
        assert_eq!(shown(&s(&headlink)), None, "HEAD leading off the machine");
        let _ = fs::remove_dir_all(&base);
    }

    /// Found in review: a local link ONTO a mapped network drive — `Z:\…`,
    /// which no spelling gives away — was followed, and the drive's
    /// repository read. Here a folder is said to be on such a drive, and
    /// every way of reaching it through a link is refused before anything on
    /// it is looked at.
    #[cfg(unix)]
    #[test]
    fn a_link_onto_a_mapped_network_drive_is_never_followed() {
        use std::os::unix::fs::symlink;
        let base = scratch("ontodrive");
        premise_no_repository_above(&base);
        let drive = base.join("drive");
        let share = drive.join("share");
        fake_repo(&share, b"ref: refs/heads/secret\n");
        fs::create_dir_all(share.join("sub")).unwrap();
        let mapped = s(&drive);
        let on_drive = move |path: &str| path.starts_with(&mapped);
        let local = base.join("local");
        fs::create_dir_all(&local).unwrap();

        symlink(&share, local.join("via")).unwrap();
        symlink("via", local.join("hop")).unwrap();
        let dotgit = local.join("dotgit");
        fs::create_dir_all(&dotgit).unwrap();
        symlink(share.join(".git"), dotgit.join(".git")).unwrap();
        let gitfile = local.join("gitfile");
        fs::create_dir_all(&gitfile).unwrap();
        fs::write(gitfile.join(".git"), format!("gitdir: {}\n", s(&share.join(".git")))).unwrap();
        let through = local.join("through");
        fs::create_dir_all(&through).unwrap();
        fs::write(through.join(".git"), "gitdir: ../via/.git\n").unwrap();

        let cases = [
            ("a folder linked onto the drive", local.join("via").join("sub")),
            ("a chain of links onto it", local.join("hop").join("sub")),
            (".git linked onto it", dotgit.clone()),
            ("a gitdir: on it", gitfile.clone()),
            ("a gitdir: through a link onto it", through.clone()),
        ];
        for (what, dir) in &cases {
            assert_eq!(shown_in(&s(dir), &|_| false), branch("secret"), "premise, {what}: it is reachable");
            assert_eq!(shown_in(&s(dir), &on_drive), None, "{what}: the drive's repository was read");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Judged where each link lands, BEFORE anything there is resolved: the
    /// lookup used to judge only what the folder resolved to, and resolving
    /// it is what reaches the drive. The drive is told by spelling here, as
    /// Windows tells `Z:\…` by its letter — so a link's target joined to its
    /// folder (`…/local/../drive/…`) is on it — and the places the links
    /// resolve to are never so much as asked about.
    #[cfg(unix)]
    #[test]
    fn nothing_on_a_mapped_drive_is_resolved_before_it_is_judged() {
        use std::os::unix::fs::symlink;
        let base = scratch("beforeresolve");
        premise_no_repository_above(&base);
        let drive = base.join("drive");
        let share = drive.join("share");
        fake_repo(&share, b"ref: refs/heads/secret\n");
        fs::create_dir_all(share.join("sub")).unwrap();
        let local = base.join("local");
        fs::create_dir_all(&local).unwrap();
        symlink("../drive/share", local.join("via")).unwrap();
        let dotgit = local.join("dotgit");
        fs::create_dir_all(&dotgit).unwrap();
        symlink("../../drive/share/.git", dotgit.join(".git")).unwrap();
        let through = local.join("through");
        fs::create_dir_all(&through).unwrap();
        fs::write(through.join(".git"), "gitdir: ../via/.git\n").unwrap();

        // Lexically, as a drive letter is read: `..` taken off by name.
        let lexical = |path: &str| {
            let mut out = PathBuf::new();
            for part in Path::new(path).components() {
                match part {
                    std::path::Component::ParentDir => {
                        out.pop();
                    }
                    other => out.push(other.as_os_str()),
                }
            }
            out
        };
        let resolved = [share.join("sub"), share.join(".git"), share.clone()];
        for dir in [local.join("via").join("sub"), dotgit.clone(), through.clone()] {
            let asked = std::cell::RefCell::new(Vec::new());
            let on_drive = |path: &str| {
                asked.borrow_mut().push(path.to_string());
                lexical(path).starts_with(&drive)
            };
            assert_eq!(shown_in(&s(&dir), &|_| false), branch("secret"), "premise: {}", dir.display());
            assert_eq!(shown_in(&s(&dir), &on_drive), None, "{}", dir.display());
            let asked = asked.into_inner();
            for place in &resolved {
                assert!(
                    !asked.contains(&s(place)),
                    "{}: {} was resolved on the drive before the link onto it was judged: {asked:?}",
                    dir.display(),
                    place.display()
                );
            }
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Windows asks the drive's type for every path it opens (`fs::on_a_
    /// network_drive`): here a drive is said to be a network one, wherever in
    /// the lookup it comes up.
    #[test]
    fn a_mapped_network_drive_is_never_looked_at() {
        let base = scratch("drive");
        premise_no_repository_above(&base);
        let main = base.join("main");
        fake_repo(&main, b"ref: refs/heads/main\n");
        let gitdir = base.join("gitdirs").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../gitdirs/wt\n").unwrap();

        let none = |_: &str| false;
        assert_eq!(shown_in(&s(&main), &none), branch("main"), "premise");
        assert_eq!(shown_in(&s(&wt), &none), branch("topic"), "premise");

        let asked = std::cell::RefCell::new(Vec::new());
        let records = |path: &str| {
            asked.borrow_mut().push(path.to_string());
            false
        };
        let _ = branch_in(&s(&wt), &records);
        let asked = asked.into_inner();
        for must in [s(&wt), s(&wt.join(".git")), s(&gitdir), s(&gitdir.join("HEAD"))] {
            assert!(asked.contains(&must), "{must} was opened without asking its drive: {asked:?}");
        }

        let the_folder = |path: &str| path == s(&main);
        assert_eq!(shown_in(&s(&main), &the_folder), None, "the folder itself");
        let the_gitdir = |path: &str| path.contains("gitdirs");
        assert_eq!(shown_in(&s(&wt), &the_gitdir), None, "where a .git file leads");
        let the_head = |path: &str| path.ends_with("HEAD");
        assert_eq!(shown_in(&s(&main), &the_head), None, "HEAD");
        let _ = fs::remove_dir_all(&base);
    }

    /// The folder is judged again once its links are resolved: what it
    /// resolves to is where the lookup happens. `./real` spells the folder
    /// differently from the canonical path, so only the second check sees it.
    #[cfg(unix)]
    #[test]
    fn the_folder_is_judged_again_where_it_resolves_to() {
        let base = scratch("recheck");
        premise_no_repository_above(&base);
        let real = base.join("real");
        fake_repo(&real, b"ref: refs/heads/main\n");
        std::os::unix::fs::symlink("./real", base.join("alias")).unwrap();
        let canonical = s(&real);
        let only_the_canonical = move |path: &str| path == canonical;
        assert_eq!(shown_in(&s(&base.join("alias")), &|_| false), branch("main"), "premise");
        assert_eq!(shown_in(&s(&base.join("alias")), &only_the_canonical), None);
        let _ = fs::remove_dir_all(&base);
    }

    /// Windows only, and so only ever compiled here: the app's own drive
    /// check is the one `branch_of` uses, and a repository on the system's
    /// own drive answers through it.
    #[cfg(windows)]
    #[test]
    fn branch_of_asks_windows_for_the_drive_type() {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let windows = format!(r"{drive}\Windows");
        assert!(!refused(Path::new(&windows), &crate::fs::on_a_network_drive), "the system drive is local");
        assert!(refused(Path::new(&windows), &|_: &str| true));
        assert!(refused(Path::new(r"\\wsl$\Ubuntu\home"), &crate::fs::on_a_network_drive), "WSL is another machine to Windows");
        let base = scratch("windows");
        premise_no_repository_above(&base);
        fake_repo(&base, b"ref: refs/heads/main\n");
        assert_eq!(shown(&s(&base)), branch("main"), "a local repository answers through the real drive check");
        assert_eq!(shown(&format!(r"\\?\{}", s(&base))), branch("main"), "spelled verbatim too");
        let _ = fs::remove_dir_all(&base);
    }

    /// Found in review: one line, `ref: refs/heads/.invalid`, in any folder's
    /// HEAD made the backend run git there, and git read that repository's
    /// config — an `include.path` on another machine, a FIFO that hung it. A
    /// reftable repository shows no branch, and nothing runs to find out.
    #[test]
    fn a_reftable_head_is_no_branch_and_runs_nothing() {
        let base = scratch("marker");
        premise_no_repository_above(&base);
        fake_repo(&base, b"ref: refs/heads/.invalid\n");
        assert_eq!(shown(&s(&base)), None);

        let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("fs").join("git.rs"))
            .unwrap()
            .replace("\r\n", "\n");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        let start = production.find("// ---- The branch a terminal's folder is on").expect("the branch section");
        let section = &production[start..];
        // As a whole name: `find_dot_git(` is no call to `git(`.
        let calls = |name: &str| {
            section.match_indices(name).any(|(at, _)| {
                !section[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_')
            })
        };
        for call in ["git(", "git_command(", "Command", "symbolic_ref", "symbolic-ref", "repository_filters_off(", "BACKGROUND_OPTIONS"] {
            assert!(!calls(call), "the branch lookup can run git: `{call}` in\n{section}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// A reftable repository made by the real git, where this machine has
    /// one that can: its `HEAD` file says nothing, and nothing is shown.
    #[test]
    fn a_reftable_repository_shows_no_branch() {
        let base = scratch("reftable");
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let made = Command::new("git")
            .args(["init", "-q", "--ref-format=reftable", "--initial-branch=topic"])
            .arg(&repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", base.join("none.gitconfig"))
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !made {
            let _ = fs::remove_dir_all(&base);
            eprintln!("git unavailable or too old for reftable; skipping");
            return;
        }
        let head = fs::read_to_string(repo.join(".git").join("HEAD")).unwrap();
        assert_eq!(parse_head(&head), Head::Reftable, "premise: {head:?}");
        assert_eq!(shown(&s(&repo)), None);
        let _ = fs::remove_dir_all(&base);
    }
}

/// No process this backend spawns may open a console window on Windows.
///
/// A console-subsystem child gets its own console window unless it is given
/// `CREATE_NO_WINDOW`, and `git` is one. `git_status` runs when a folder is
/// opened and again, debounced, on every burst of changes the watcher
/// reports — so it was not one flash on opening a folder, it was one every
/// time a file was saved.
///
/// Nothing on this machine can catch that. The branch is `#[cfg(windows)]`,
/// so it does not exist in a macOS build at all and `cargo test` here cannot
/// reach it; CI's Windows job only proves it compiles, never that the flag is
/// set. So this reads the source — and reads ALL of it, not just this file,
/// because what is worth pinning is that no spawn anywhere is missing the
/// flag, not that this one has it.
///
/// Test code is exempt: it already runs in a console. A file's first
/// `#[cfg(test)]` starts its trailing test module, which is true of every
/// file here and is asserted below rather than assumed.
#[cfg(test)]
mod no_console_window_tests {
    use std::path::Path;

    /// How far after a `Command::new` the flag may appear — enough for the
    /// builder calls in between, not enough to belong to something else.
    const WINDOW: usize = 10;

    fn backend_sources() -> Vec<std::path::PathBuf> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        walkdir::WalkDir::new(src)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
            .map(|e| e.path().to_path_buf())
            .collect()
    }

    #[test]
    fn no_spawn_outside_tests_can_flash_a_console() {
        let mut spawns = 0;

        for path in backend_sources() {
            let body = std::fs::read_to_string(&path).expect("a source file is readable");
            let lines: Vec<&str> = body.lines().collect();
            // Everything from the first `#[cfg(test)]` on is test code.
            let production = lines
                .iter()
                .position(|l| l.trim() == "#[cfg(test)]")
                .unwrap_or(lines.len());

            for (i, line) in lines[..production].iter().enumerate() {
                if !line.contains("Command::new(") {
                    continue;
                }
                spawns += 1;
                let nearby = lines[i..(i + WINDOW).min(production)].join("\n");
                assert!(
                    nearby.contains("creation_flags"),
                    "{}:{} spawns a process without CREATE_NO_WINDOW — on Windows it \
                     will flash a console window over the app:\n{line}",
                    path.display(),
                    i + 1
                );
            }
        }

        assert!(
            spawns > 0,
            "found no process spawns at all — the scan is broken, not the code"
        );
    }

    /// The exemption above is only sound while nothing but tests follows a
    /// file's first `#[cfg(test)]`.
    ///
    /// A file may hold several test modules — `manager.rs` has three — and
    /// that is fine; what would break the scan is production code AFTER the
    /// first marker. Every production item in this crate sits at column 0 and
    /// everything inside a module is indented, so that is what this looks for.
    #[test]
    fn nothing_but_tests_follows_the_first_cfg_test() {
        const TOP_LEVEL: &[&str] = &[
            "pub fn ", "fn ", "pub struct ", "struct ", "pub enum ", "enum ",
            "impl ", "pub const ", "const ", "pub static ", "static ",
        ];

        for path in backend_sources() {
            let body = std::fs::read_to_string(&path).expect("a source file is readable");
            let lines: Vec<&str> = body.lines().collect();
            let Some(first) = lines.iter().position(|l| l.trim() == "#[cfg(test)]") else {
                continue;
            };
            for (offset, line) in lines[first..].iter().enumerate() {
                if TOP_LEVEL.iter().any(|kw| line.starts_with(kw)) {
                    panic!(
                        "{}:{} is production code sitting after the file's first \
                         `#[cfg(test)]`, so the spawn scan would wrongly exempt \
                         anything below it: {line}",
                        path.display(),
                        first + offset + 1
                    );
                }
            }
        }
    }
}
