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
//!   2. **It skips what the Explorer skips.** The same `is_ignored` the tree
//!      and the file watcher use, so search results and the tree agree about
//!      what is in the project. (A consequence worth knowing: `.gitignore` is
//!      NOT read — only the fixed folder list. A project whose build output
//!      lives somewhere unusual will see it here.)
//!   3. **It never leaves the open folder.** The walk starts at the confined
//!      root and every result is inside it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::fs::watcher::is_ignored;

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

#[derive(Clone, Copy, Debug, Default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// What to look for, compiled once for the whole walk.
enum Matcher {
    /// Plain text. `needle` is already lowercased when the search is
    /// case-insensitive, and the haystack is lowered to match.
    Plain { needle: String, case_sensitive: bool },
    Regex(regex::Regex),
}

impl Matcher {
    fn build(query: &str, options: SearchOptions) -> Result<Self, String> {
        if options.regex || options.whole_word {
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
                .map_err(|e| format!("bad pattern: {e}"))?;
            return Ok(Matcher::Regex(built));
        }
        Ok(Matcher::Plain {
            needle: if options.case_sensitive {
                query.to_string()
            } else {
                query.to_lowercase()
            },
            case_sensitive: options.case_sensitive,
        })
    }

    /// The 0-based byte offset of the first match in `line`, if any.
    fn find(&self, line: &str) -> Option<usize> {
        match self {
            Matcher::Plain { needle, case_sensitive } => {
                if *case_sensitive {
                    line.find(needle.as_str())
                } else {
                    line.to_lowercase().find(needle.as_str())
                }
            }
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

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_ignored(e.path()))
        .filter_map(Result::ok)
    {
        if results.files.len() >= MAX_FILES || total >= MAX_TOTAL_MATCHES {
            results.truncated = true;
            break;
        }
        let path = entry.path();
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
