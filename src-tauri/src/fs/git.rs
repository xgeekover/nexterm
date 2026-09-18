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

// `PathBuf` is only named by the tests below; `#![deny(warnings)]` turns an
// unused import into a failed build, and `cargo test` would not have caught it
// because there the import IS used.
use std::path::Path;
use std::process::Command;

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

/// Run `git` in `dir`, or `None` when it could not be run at all.
///
/// A missing `git`, a folder that is not a repository, and a git that returned
/// an error are all the same answer here: nothing to say. None of them is
/// worth an error dialog over a status bar decoration.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
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
    let stdout = git(root, &["status", "--porcelain=v2", "--branch", "-z"])?;
    Some(parse_status(&stdout, &repo_root))
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
