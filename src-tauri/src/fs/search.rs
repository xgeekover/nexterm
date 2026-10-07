//! Searching the open folder's files for a string.
//!
//! The Explorer can filter by NAME (that is the funnel in its header). This is
//! the other question — "where does this text appear" — which until now meant
//! leaving the app for `rg`. Having the terminal right there made that cheap,
//! but it still cost you the result being a thing you can click.
//!
//! Three rules keep the answer usable rather than merely correct:
//!
//!   1. **It is bounded.** Every cap below exists because an unbounded answer
//!      to `e` in a large repository is not an answer — it is a hang, then a
//!      megabyte of JSON the webview has to render. What was cut is reported,
//!      never silently dropped.
//!   2. **It skips what the Explorer skips.** The same folder list the tree
//!      and the file watcher use, matched below the open folder only
//!      (`is_ignored_below`), so search results and the tree agree about
//!      what is in the project. (A consequence worth knowing: `.gitignore` is
//!      NOT read — only the fixed folder list. A project whose build output
//!      lives somewhere unusual will see it here.)
//!   3. **It never leaves the open folder.** The walk starts at the confined
//!      root and every result is inside it.
//!
//! Quick Open's list of files (`list_files`) is the same walk, without the
//! reading: everything the editor could open, bounded the same way.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use std::collections::VecDeque;

use crate::fs::watcher::is_ignored_below;
use crate::fs::{link_leads_off_machine, Canonical};

/// A file bigger than this is not something anyone greps for a phrase; it is a
/// build artifact, a lockfile dump or a log, and reading it costs more than the
/// answer is worth.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// A matched line is shown, not stored — past this the rest is noise that
/// cannot be read in a result row anyway.
const MAX_LINE_CHARS: usize = 400;

/// Caps, all reported when hit. See the module note on being bounded.
const MAX_MATCHES_PER_FILE: usize = 50;
const MAX_FILES: usize = 300;
const MAX_TOTAL_MATCHES: usize = 2000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchMatch {
    /// 1-based, so it can go straight to the editor.
    pub line: u32,
    /// 1-based column of the match within the line.
    pub column: u32,
    /// The line itself, truncated. Leading whitespace is kept: indentation is
    /// how you recognise where in a file you are looking.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchFile {
    pub path: String,
    pub matches: Vec<SearchMatch>,
    /// True when this file had more matches than `MAX_MATCHES_PER_FILE`.
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResults {
    pub files: Vec<SearchFile>,
    pub total_matches: u32,
    pub files_searched: u32,
    /// True when any cap was hit, so the UI can say "showing the first N"
    /// rather than implying this is everything.
    pub truncated: bool,
}

/// How many files `list_files` hands back when not told: every file of any
/// project one opens to edit, in a reply the webview takes in at once.
pub const DEFAULT_LIST_LIMIT: usize = 20_000;

/// The most `list_files` hands back whatever it is asked for, so the reply
/// stays a few megabytes of JSON.
const MAX_LIST_LIMIT: usize = 100_000;

/// Every file in the open folder, for Quick Open.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileList {
    /// Absolute paths, in the platform's own spelling, sorted.
    pub files: Vec<String>,
    /// True when the folder holds more files than were listed.
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// What to look for, compiled once for the whole walk.
enum Matcher {
    /// Plain text, case included: the one search a substring find answers.
    Exact(String),
    /// Everything else — a pattern, a whole word, or text in any case.
    Regex(regex::Regex),
}

impl Matcher {
    /// Text in any case is a regex too, of the text escaped. It used to be
    /// found by lowercasing the line and the query, and that gave the match's
    /// offset in the LOWERCASED line. Lowercasing changes some characters'
    /// length in bytes — the Kelvin sign (3 bytes) becomes `k` (1), the
    /// Turkish İ (2) becomes `i̇` (3) — so the offset, applied to the line as
    /// written, could land inside a character, which panicked and left the
    /// search unanswered, or past the end of the line. A regex match says
    /// where it is in the line itself.
    fn build(query: &str, options: SearchOptions) -> Result<Self, String> {
        if options.case_sensitive && !options.regex && !options.whole_word {
            return Ok(Matcher::Exact(query.to_string()));
        }
        let escaped = if options.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        // `\b` on both sides is what "whole word" means, and it composes
        // with a user-supplied pattern the same way.
        let pattern = if options.whole_word {
            format!(r"\b(?:{escaped})\b")
        } else {
            escaped
        };
        let built = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| {
                // Escaped text is always a valid pattern; all it can do is
                // outgrow the size limit, at several thousand characters.
                if options.regex {
                    format!("bad pattern: {e}")
                } else {
                    format!("search text too long: {e}")
                }
            })?;
        Ok(Matcher::Regex(built))
    }

    /// The 0-based byte offset of the first match in `line`, if any.
    fn find(&self, line: &str) -> Option<usize> {
        match self {
            Matcher::Exact(needle) => line.find(needle.as_str()),
            Matcher::Regex(re) => re.find(line).map(|m| m.start()),
        }
    }
}

/// Is this file worth reading at all?
fn searchable(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.len() <= MAX_FILE_BYTES,
        Err(_) => false,
    }
}

/// Cut a line down to something a result row can hold, on a char boundary.
fn clip(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    line.chars().take(MAX_LINE_CHARS).collect::<String>() + "…"
}

/// Search every file under `root` for `query`.
///
/// An empty query is not a search and returns nothing — the caller's input box
/// is empty while they are still thinking, and answering that with every file
/// in the project would be both slow and useless.
pub fn search(root: &Path, query: &str, options: SearchOptions) -> Result<SearchResults, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults::default());
    }
    let matcher = Matcher::build(query, options)?;

    let mut results = SearchResults::default();
    let mut total = 0usize;

    for entry in visible(root, WalkDir::new(root)) {
        if results.files.len() >= MAX_FILES || total >= MAX_TOTAL_MATCHES {
            results.truncated = true;
            break;
        }
        let path = entry.path();
        // A link is read only when it leads to a file inside the open folder,
        // as Quick Open lists it and confinement opens it: following one that
        // leads out returned that file's lines under a path inside, and one
        // to another machine connects to it.
        if entry.path_is_symlink() && !link_opens_inside(root, path) {
            continue;
        }
        if !searchable(path) {
            continue;
        }
        // Non-UTF-8 is a binary file for this purpose. Reading it as bytes and
        // giving up is cheaper than guessing an encoding, and a grep hit inside
        // a PNG is not a result anyone wanted.
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        results.files_searched += 1;

        let mut matches = Vec::new();
        let mut file_truncated = false;
        for (index, line) in contents.lines().enumerate() {
            let Some(offset) = matcher.find(line) else {
                continue;
            };
            if matches.len() >= MAX_MATCHES_PER_FILE {
                file_truncated = true;
                results.truncated = true;
                break;
            }
            matches.push(SearchMatch {
                line: (index + 1) as u32,
                // Columns are counted in characters, not bytes: the editor
                // places a caret by character and a byte offset would land in
                // the wrong place on any line with non-ASCII before the match.
                column: (line[..offset].chars().count() + 1) as u32,
                text: clip(line),
            });
            total += 1;
            if total >= MAX_TOTAL_MATCHES {
                results.truncated = true;
                break;
            }
        }

        if !matches.is_empty() {
            results.files.push(SearchFile {
                path: path.to_string_lossy().to_string(),
                matches,
                truncated: file_truncated,
            });
        }
    }

    results.total_matches = total as u32;
    Ok(results)
}

/// Every entry `walker` meets under `root`, the root included, outside the
/// folders the Explorer hides. Search and `list_files` both walk through
/// here, in the order each sets on `walker`.
///
/// A link to a folder is met as an entry and never walked into: following
/// one that leads above it would walk the tree again inside itself, and one
/// that leads out would walk out of the open folder.
fn visible(root: &Path, walker: WalkDir) -> impl Iterator<Item = walkdir::DirEntry> + '_ {
    walker
        .follow_links(false)
        .into_iter()
        .filter_entry(move |e| !is_ignored_below(root, e.path()))
        .filter_map(Result::ok)
}

/// Whether the link at `path` leads to a file inside `root` — resolved as
/// confinement resolves it, and in its spelling — so that the editor would
/// open it. One that leads out, or nowhere, or to another machine (never
/// followed, see `link_leads_off_machine`) is a file it would refuse.
fn link_opens_inside(root: &Path, path: &Path) -> bool {
    !link_leads_off_machine(path)
        && path.canonical().is_ok_and(|target| target.starts_with(root) && target.is_file())
}

/// Every file under `root` the editor could open, for Quick Open: at most
/// `limit` (and never more than `MAX_LIST_LIMIT`), with `truncated` saying
/// whether there were more.
///
/// Level by level, each folder in name order: when there are too many, the
/// ones kept are those nearest the top, the same ones each time. A walk that
/// finished each folder before the next spent the whole budget on the first
/// big one — a `.venv`, an `app/build` — and `src/main.py` and `README.md`
/// were not in the list at all. A link is listed when it leads to a file
/// inside the open folder (`link_opens_inside`).
pub fn list_files(root: &Path, limit: usize) -> FileList {
    let limit = limit.min(MAX_LIST_LIMIT);
    let mut list = FileList::default();
    let mut folders = VecDeque::from([root.to_path_buf()]);
    'walk: while let Some(folder) = folders.pop_front() {
        let Ok(read) = std::fs::read_dir(&folder) else {
            continue;
        };
        let mut entries: Vec<std::fs::DirEntry> = read.filter_map(Result::ok).collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            if is_ignored_below(root, &path) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let opens = if kind.is_symlink() {
                link_opens_inside(root, &path)
            } else if kind.is_dir() {
                // A link to a folder is not walked into, as nowhere else is.
                folders.push_back(path);
                continue;
            } else {
                kind.is_file()
            };
            if !opens {
                continue;
            }
            if list.files.len() >= limit {
                list.truncated = true;
                break 'walk;
            }
            list.files.push(path.to_string_lossy().to_string());
        }
    }
    list.files.sort();
    list
}

/// The confined root a search should start from, or an error when no folder is
/// open — the same rule every other fs command follows.
pub fn root_of(root: Option<PathBuf>) -> Result<PathBuf, String> {
    root.ok_or_else(|| "No folder is open".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A directory of this test's own.
    ///
    /// `cargo test` runs these in parallel and they all used one name keyed on
    /// the process id, so each one's `remove_dir_all` deleted whichever other
    /// test was mid-walk — the failure moved between cases on every run, which
    /// is what a shared fixture looks like from the outside.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("nexterm-search-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture(name: &str) -> PathBuf {
        let dir = scratch(name);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("src/app.js"), "const Needle = 1;\nconsole.log('needle');\n").unwrap();
        fs::write(dir.join("src/other.rs"), "// nothing here\nfn main() {}\n").unwrap();
        fs::write(dir.join("README.md"), "A needle in a haystack.\n").unwrap();
        // The thing every search in a JS project must not drown in.
        fs::write(dir.join("node_modules/pkg/index.js"), "needle needle needle\n").unwrap();
        dir
    }

    fn opts() -> SearchOptions {
        SearchOptions::default()
    }

    #[test]
    fn finds_the_text_and_says_where() {
        let dir = fixture("finds");
        let out = search(&dir, "needle", opts()).unwrap();
        let app = out
            .files
            .iter()
            .find(|f| f.path.ends_with("app.js"))
            .expect("app.js should match");
        // Case-insensitive by default, so both lines hit.
        assert_eq!(app.matches.len(), 2);
        assert_eq!(app.matches[0].line, 1);
        assert_eq!(app.matches[0].column, 7, "1-based column of `Needle`");
        assert_eq!(app.matches[1].line, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_skips_what_the_explorer_skips() {
        // A search that returns node_modules is a search nobody uses twice.
        let dir = fixture("skips");
        let out = search(&dir, "needle", opts()).unwrap();
        assert!(
            !out.files.iter().any(|f| f.path.contains("node_modules")),
            "node_modules must not be searched: {:?}",
            out.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A dependency opened from `node_modules` to read it: every path in it
    /// has `node_modules` in it, and the walk used to be cut at the open
    /// folder itself — nothing searched, "No results".
    #[test]
    fn a_folder_opened_inside_node_modules_is_searched() {
        let base = scratch("inside-node-modules");
        let root = base.join("node_modules").join("lib");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("dep")).unwrap();
        fs::write(root.join("src").join("index.js"), "needle\n").unwrap();
        fs::write(root.join("node_modules").join("dep").join("index.js"), "needle\n").unwrap();

        let out = search(&root, "needle", opts()).unwrap();

        let found: Vec<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(out.files.len(), 1, "{found:?}");
        assert!(found[0].ends_with("index.js") && found[0].contains("src"), "{found:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn case_sensitivity_is_a_choice() {
        let dir = fixture("case");
        let sensitive = SearchOptions { case_sensitive: true, ..Default::default() };
        let out = search(&dir, "Needle", sensitive).unwrap();
        let app = out.files.iter().find(|f| f.path.ends_with("app.js")).unwrap();
        assert_eq!(app.matches.len(), 1, "only the capitalised one");
        assert_eq!(app.matches[0].line, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whole_word_does_not_match_inside_a_word() {
        let dir = scratch("wholeword");
        fs::write(dir.join("a.txt"), "need\nneedle\nneedless\n").unwrap();
        let whole = SearchOptions { whole_word: true, ..Default::default() };
        let out = search(&dir, "needle", whole).unwrap();
        let file = &out.files[0];
        assert_eq!(file.matches.len(), 1);
        assert_eq!(file.matches[0].line, 2, "`needless` is not the word `needle`");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_pattern_is_an_error_not_a_panic() {
        let dir = fixture("badpattern");
        let re = SearchOptions { regex: true, ..Default::default() };
        let err = search(&dir, "a(", re).unwrap_err();
        assert!(err.contains("bad pattern"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_query_is_not_a_search() {
        let dir = fixture("empty");
        for query in ["", "   "] {
            let out = search(&dir, query, opts()).unwrap();
            assert!(out.files.is_empty());
            assert_eq!(out.total_matches, 0);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_line_is_clipped_rather_than_returned_whole() {
        let dir = scratch("longline");
        fs::write(dir.join("a.txt"), format!("needle{}\n", "x".repeat(5000))).unwrap();
        let out = search(&dir, "needle", opts()).unwrap();
        let text = &out.files[0].matches[0].text;
        assert!(text.chars().count() <= MAX_LINE_CHARS + 1, "line not clipped: {}", text.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_column_is_counted_in_characters_not_bytes() {
        // A byte offset lands in the wrong place on any line with non-ASCII
        // before the match, and the editor places a caret by character.
        let dir = scratch("utf8");
        fs::write(dir.join("a.txt"), "한글이 있는 줄 needle\n").unwrap();
        let out = search(&dir, "needle", opts()).unwrap();
        assert_eq!(out.files[0].matches[0].column, 10);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Lowercasing changes some characters' length in bytes: the Kelvin sign
    /// (3 bytes) becomes `k` (1), the Turkish İ (2) becomes `i̇` (3). The match
    /// was found in a lowercased copy of the line and its offset used on the
    /// line as written, which landed inside a character — a panic, and a
    /// search that never answered — or past the end of the line, or a column
    /// or two off.
    #[test]
    fn case_folding_that_changes_byte_lengths_neither_panics_nor_moves_the_column() {
        let dir = scratch("folding");
        fs::write(dir.join("kelvin.txt"), "\u{212A} needle\n").unwrap();
        fs::write(dir.join("turkish.txt"), "İİİab\nİ needle\n").unwrap();
        let column = |out: &SearchResults, file: &str, line: u32| {
            out.files
                .iter()
                .find(|f| f.path.ends_with(file))
                .and_then(|f| f.matches.iter().find(|m| m.line == line))
                .map(|m| m.column)
                .unwrap_or_else(|| panic!("no match on {file}:{line}: {out:?}"))
        };

        let out = search(&dir, "needle", opts()).unwrap();
        assert_eq!(column(&out, "kelvin.txt", 1), 3, "after `K `");
        assert_eq!(column(&out, "turkish.txt", 2), 3, "after `İ `");

        let out = search(&dir, "AB", opts()).unwrap();
        assert_eq!(column(&out, "turkish.txt", 1), 4, "after `İİİ`");

        // The Kelvin sign is a capital K to Unicode, and any-case text is
        // found in any case.
        let out = search(&dir, "k needle", opts()).unwrap();
        assert_eq!(column(&out, "kelvin.txt", 1), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Text in any case is compiled, and past some thousands of characters
    /// it outgrows the regex size limit. That is the only way escaped text
    /// fails to compile, and "bad pattern" would blame a pattern nobody wrote.
    #[test]
    fn text_too_long_to_search_for_says_so() {
        let dir = fixture("toolong");
        let query = "needle ".repeat(10_000);
        let err = search(&dir, &query, opts()).unwrap_err();
        assert!(err.contains("too long"), "unexpected error: {err}");
        assert!(!err.contains("bad pattern"), "{err}");
        // A few hundred characters is an ordinary search.
        let out = search(&dir, &"x".repeat(500), opts()).unwrap();
        assert!(out.files.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Quick Open's list: every file, sorted, absolute, and nothing from the
    /// folders the Explorer hides.
    #[test]
    fn every_file_is_listed_sorted_without_what_the_explorer_hides() {
        let dir = fixture("list");
        let list = list_files(&dir, DEFAULT_LIST_LIMIT);
        let mut expected: Vec<String> = [&["README.md"][..], &["src", "app.js"], &["src", "other.rs"]]
            .iter()
            .map(|names| names.iter().fold(dir.clone(), |path, name| path.join(name)))
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        expected.sort();
        assert_eq!(list.files, expected);
        assert!(!list.truncated);
        assert!(list.files.iter().all(|f| Path::new(f).is_absolute()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_list_stops_at_the_limit_and_says_so() {
        let dir = scratch("list-limit");
        for name in ["a", "b", "c", "d", "e"] {
            fs::write(dir.join(name), name).unwrap();
        }
        let list = list_files(&dir, 3);
        assert_eq!(list.files.len(), 3);
        assert!(list.truncated);
        // The walk is in name order, so the same three come back each time.
        assert_eq!(list.files, ["a", "b", "c"].map(|n| dir.join(n).to_string_lossy().to_string()));

        let all = list_files(&dir, 5);
        assert_eq!(all.files.len(), 5);
        assert!(!all.truncated, "exactly the limit is everything");
        assert!(list_files(&dir, 0).truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_opened_inside_node_modules_lists_its_files() {
        let base = scratch("list-inside-node-modules");
        let root = base.join("node_modules").join("lib");
        fs::create_dir_all(root.join("node_modules").join("dep")).unwrap();
        fs::write(root.join("index.js"), "").unwrap();
        fs::write(root.join("node_modules").join("dep").join("index.js"), "").unwrap();

        let list = list_files(&root, DEFAULT_LIST_LIMIT);

        assert_eq!(list.files, vec![root.join("index.js").to_string_lossy().to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    /// A link to a folder is never walked into — one back up the tree would
    /// list it again inside itself — and a link is listed only when it leads
    /// to a file the editor would open.
    #[cfg(unix)]
    #[test]
    fn links_are_listed_only_when_they_lead_to_a_file_inside() {
        use std::os::unix::fs::symlink;
        // Canonical, as the open folder always is (`Workspace::set_root`).
        let dir = dunce::canonicalize(scratch("list-links")).unwrap();
        let outside = scratch("list-links-outside");
        fs::write(outside.join("secret.txt"), "").unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("a.js"), "").unwrap();
        fs::write(dir.join("CLAUDE.md"), "").unwrap();
        symlink("CLAUDE.md", dir.join("AGENTS.md")).unwrap();
        symlink("src", dir.join("shared")).unwrap();
        symlink(".", dir.join("loop")).unwrap();
        symlink(outside.join("secret.txt"), dir.join("ext.txt")).unwrap();
        symlink("nowhere", dir.join("dangling")).unwrap();

        let list = list_files(&dir, DEFAULT_LIST_LIMIT);

        let names: Vec<String> = list
            .files
            .iter()
            .map(|f| Path::new(f).strip_prefix(&dir).unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["AGENTS.md", "CLAUDE.md", "src/a.js"]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    /// Found in review: the list was cut wherever a folder-at-a-time walk
    /// had got to, so one big folder that sorts early — a `.venv`, an
    /// `app/build` — took the whole budget and the project's own files were
    /// not in it.
    #[test]
    fn a_big_folder_that_sorts_first_does_not_crowd_out_the_project() {
        let dir = scratch("list-crowded");
        let deep = dir.join(".venv").join("lib").join("site-packages").join("torch");
        fs::create_dir_all(&deep).unwrap();
        for i in 0..20 {
            fs::write(deep.join(format!("m{i:02}.py")), "").unwrap();
        }
        // And one that sorts last, so neither end of the order can win.
        let cache = dir.join("~cache").join("a").join("b");
        fs::create_dir_all(&cache).unwrap();
        for i in 0..20 {
            fs::write(cache.join(format!("c{i:02}.bin")), "").unwrap();
        }
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("main.py"), "").unwrap();
        fs::write(dir.join("README.md"), "").unwrap();
        fs::write(dir.join("pyproject.toml"), "").unwrap();

        let list = list_files(&dir, 10);

        assert!(list.truncated);
        assert_eq!(list.files.len(), 10);
        for kept in [dir.join("README.md"), dir.join("pyproject.toml"), dir.join("src").join("main.py")] {
            let kept = kept.to_string_lossy().to_string();
            assert!(list.files.contains(&kept), "{kept} was left out: {:?}", list.files);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Found in review: search followed a link to a file outside the open
    /// folder and returned that file's lines under the link's path inside —
    /// which Quick Open leaves out and opening refuses.
    #[cfg(unix)]
    #[test]
    fn search_never_reads_through_a_link_that_leads_out() {
        use std::os::unix::fs::symlink;
        let dir = dunce::canonicalize(scratch("search-link-out")).unwrap();
        let outside = scratch("search-link-out-outside");
        fs::write(outside.join("credentials"), "TOKEN=hunter2\n").unwrap();
        symlink(outside.join("credentials"), dir.join("notes.txt")).unwrap();
        fs::write(dir.join("CLAUDE.md"), "TOKEN in the folder\n").unwrap();
        symlink("CLAUDE.md", dir.join("AGENTS.md")).unwrap();

        let results = search(&dir, "TOKEN", SearchOptions::default()).unwrap();

        let mut found: Vec<String> =
            results.files.iter().map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().to_string()).collect();
        found.sort();
        assert_eq!(found, vec!["AGENTS.md", "CLAUDE.md"], "a link inside is still searched");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    /// A link to another machine is never followed, not even to ask what it
    /// is: on Windows that alone connects to the host and signs in. (`//…` is
    /// a local path on Unix, which is what lets this run here: this one leads
    /// to a file inside the open folder, which a link that was followed would
    /// have put in the list and the results.)
    #[cfg(unix)]
    #[test]
    fn a_link_to_another_machine_is_never_listed_or_searched() {
        use std::os::unix::fs::symlink;
        let dir = dunce::canonicalize(scratch("list-link-off-machine")).unwrap();
        fs::write(dir.join("real.md"), "TOKEN in the folder\n").unwrap();
        let spelled = format!("/{}", dir.join("real.md").display());
        assert!(spelled.starts_with("//"), "premise: spelled as a network path");
        symlink(&spelled, dir.join("docs.md")).unwrap();
        assert!(crate::fs::link_leads_off_machine(&dir.join("docs.md")));

        let listed = list_files(&dir, DEFAULT_LIST_LIMIT).files;
        assert_eq!(listed, vec![dir.join("real.md").to_string_lossy().to_string()]);
        let found: Vec<String> =
            search(&dir, "TOKEN", SearchOptions::default()).unwrap().files.into_iter().map(|f| f.path).collect();
        assert_eq!(found, vec![dir.join("real.md").to_string_lossy().to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_matching_is_an_empty_answer_not_an_error() {
        let dir = fixture("nomatch");
        let out = search(&dir, "zzzznotthere", opts()).unwrap();
        assert!(out.files.is_empty());
        assert_eq!(out.total_matches, 0);
        assert!(!out.truncated);
        assert!(out.files_searched > 0, "it did look");
        let _ = fs::remove_dir_all(&dir);
    }
}
