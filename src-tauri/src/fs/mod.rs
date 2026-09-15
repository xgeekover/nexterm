pub mod watcher;
pub use watcher::FsWatcherManager;

use parking_lot::Mutex;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::models::FileNode;

pub const SKIPPED_FOLDERS: &[&str] = &[".git", "node_modules", "target", ".agents", "dist"];

/// `Path::canonicalize`, without the `\\?\` prefix Windows puts on the result.
///
/// That verbatim spelling went everywhere a path goes: the title bar showed
/// `\\?\D:\…`, and cmd.exe, handed it as a working directory, rejected it as a
/// UNC path and started in C:\Windows instead. `dunce` drops the prefix
/// whenever the plain path means the same thing, and is `canonicalize` itself
/// off Windows. Everything in this module canonicalizes through here — root
/// and candidate alike — so `starts_with(root)` compares like with like.
trait Canonical {
    fn canonical(&self) -> std::io::Result<PathBuf>;
}

impl Canonical for Path {
    fn canonical(&self) -> std::io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

pub fn resolve_path(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed.is_empty() || trimmed == "." {
        return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    if let Some(stripped) = trimmed.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return PathBuf::from(home).join(stripped);
        }
    }
    PathBuf::from(trimmed)
}

pub fn read_dir_hierarchy(root_str: &str, max_depth: Option<usize>) -> Result<Vec<FileNode>, String> {
    let root = resolve_path(root_str);
    if !root.exists() {
        return Err(format!("Directory not found: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", root.display()));
    }

    let depth_limit = max_depth.unwrap_or(3);
    read_dir_recursive(&root, 0, depth_limit)
}

fn read_dir_recursive(dir: &Path, current_depth: usize, max_depth: usize) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory '{}': {e}", dir.display()))?;

    let mut nodes = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let is_dir = path.is_dir();
        if is_dir && SKIPPED_FOLDERS.contains(&name.as_str()) {
            continue;
        }

        let id = path.to_string_lossy().to_string();
        let path_str = id.clone();

        if is_dir {
            let children = if current_depth + 1 < max_depth {
                match read_dir_recursive(&path, current_depth + 1, max_depth) {
                    Ok(ch) => Some(ch),
                    Err(_) => Some(Vec::new()),
                }
            } else {
                Some(Vec::new())
            };

            nodes.push(FileNode {
                id,
                name,
                path: path_str,
                is_dir: true,
                size: Some(0),
                children,
                extension: None,
            });
        } else {
            let size = entry.metadata().ok().map(|m| m.len());
            let extension = path.extension().map(|e| e.to_string_lossy().to_string());

            nodes.push(FileNode {
                id,
                name,
                path: path_str,
                is_dir: false,
                size,
                children: None,
                extension,
            });
        }
    }

    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

pub fn read_file(path_str: &str) -> Result<String, String> {
    let path = resolve_path(path_str);
    if !path.exists() {
        return Err(format!("File not found: {path_str}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file '{path_str}': {e}"))
}

pub fn write_file(path_str: &str, content: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file '{path_str}': {e}"))
}

pub fn create_file(path_str: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    if path.exists() {
        return Err(format!("File already exists: {path_str}"));
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }
    fs::write(&path, "").map_err(|e| format!("Failed to create file '{path_str}': {e}"))
}

pub fn create_dir(path_str: &str) -> Result<(), String> {
    let path = resolve_path(path_str);
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory '{path_str}': {e}"))
}

pub fn delete_path(path_str: &str, recursive: bool) -> Result<(), String> {
    let path = resolve_path(path_str);
    if !path.exists() {
        return Err(format!("Path does not exist: {path_str}"));
    }
    if path.is_dir() {
        if recursive {
            fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory recursively '{path_str}': {e}"))
        } else {
            fs::remove_dir(&path).map_err(|e| format!("Failed to delete directory '{path_str}': {e}"))
        }
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file '{path_str}': {e}"))
    }
}

/// True when both paths name the same on-disk entry.
///
/// String comparison cannot answer this: on a case-insensitive volume (APFS
/// and NTFS by default) `Foo.txt` and `foo.txt` are one file, and macOS also
/// folds NFC and NFD spellings of the same name together. `canonicalize`
/// returns the filesystem's own spelling, so comparing those answers it.
fn is_same_entry(a: &Path, b: &Path) -> bool {
    match (a.canonical(), b.canonical()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Rename or move a path in one filesystem operation.
///
/// This exists because the obvious alternative — read, write to the new name,
/// delete the old — is wrong in ways that destroy data:
///
///   * it walks the tree, so anything the walk misses is deleted and never
///     copied;
///   * it decodes file contents, so a binary file aborts it half-way;
///   * and it decides "is this the same file?" with a string comparison, which
///     says `Foo.txt` and `foo.txt` differ when the filesystem says they do
///     not — so the write lands in the original and the delete then removes it.
///
/// `fs::rename` has none of those failure modes: it is atomic, it never looks
/// inside the entry, and the kernel resolves same-entry questions.
pub fn rename_path(from_str: &str, to_str: &str) -> Result<(), String> {
    let from = resolve_path(from_str);
    let to = resolve_path(to_str);

    // `exists()` follows symlinks and so reports false for a broken one, which
    // would make a dangling link unrenameable. Ask about the link itself.
    if from.symlink_metadata().is_err() {
        return Err(format!("Path does not exist: {from_str}"));
    }

    let same = is_same_entry(&from, &to);

    // A pure case or Unicode-normalization change resolves to the same entry;
    // that is a rename to allow, not a collision to refuse.
    if to.symlink_metadata().is_ok() && !same {
        let name = to
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| to_str.to_string());
        return Err(format!("A file or folder named '{name}' already exists"));
    }

    // `rename` reports this as a bare EINVAL; say what actually happened.
    let from_is_dir = from
        .symlink_metadata()
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if from_is_dir && !same && to.starts_with(&from) {
        return Err(format!("Cannot move '{from_str}' inside itself"));
    }

    if let Some(parent) = to.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }

    fs::rename(&from, &to)
        .map_err(|e| format!("Failed to rename '{from_str}' to '{to_str}': {e}"))
}


// ---------------------------------------------------------------------------
// Workspace root confinement
//
// Every fs_* command resolves its path through `Workspace::confine`, which
// rejects anything that escapes the active root. The root itself can only be
// changed by `fs_pick_root`, which goes through a native folder dialog, so the
// webview cannot widen its own access by calling a command.
// ---------------------------------------------------------------------------

pub struct Workspace {
    root: Mutex<PathBuf>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(default_root()),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.root.lock().clone()
    }

    pub fn set_root(&self, candidate: &Path) -> Result<PathBuf, String> {
        let canonical = candidate
            .canonical()
            .map_err(|e| format!("Cannot open '{}': {e}", candidate.display()))?;
        if !canonical.is_dir() {
            return Err(format!("Not a directory: {}", canonical.display()));
        }
        *self.root.lock() = canonical.clone();
        Ok(canonical)
    }

    pub fn confine(&self, path_str: &str) -> Result<PathBuf, String> {
        confine_to(&self.root(), path_str)
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn default_root() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        // A bundled .app launches with cwd "/", which is never a useful root.
        if cwd.parent().is_some() {
            if let Ok(canonical) = cwd.canonical() {
                return canonical;
            }
        }
    }
    let home = home_dir();
    home.canonical().unwrap_or(home)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn confine_to(root: &Path, path_str: &str) -> Result<PathBuf, String> {
    let trimmed = path_str.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(root.to_path_buf());
    }

    let expanded = match trimmed.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(trimmed),
    };
    let joined = if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    };
    let normalized = lexical_normalize(&joined);

    // Canonicalize the deepest part that exists so a symlink cannot point out
    // of the root; segments that do not exist yet are re-appended afterwards.
    let mut cursor = normalized.as_path();
    let mut pending: Vec<OsString> = Vec::new();
    let resolved = loop {
        match cursor.canonical() {
            Ok(canonical) => break canonical,
            Err(_) => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("Invalid path: {path_str}"))?
                    .to_os_string();
                pending.push(name);
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("Invalid path: {path_str}"))?;
            }
        }
    };

    let mut final_path = resolved;
    for segment in pending.iter().rev() {
        final_path.push(segment);
    }

    if !final_path.starts_with(root) {
        return Err(format!(
            "Path is outside the workspace root ({}): {path_str}",
            root.display()
        ));
    }
    Ok(final_path)
}

#[cfg(test)]
mod confine_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-confine-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("inner/file.txt"), "ok").unwrap();
        dir.canonical().unwrap()
    }

    #[test]
    fn accepts_paths_inside_root() {
        let root = temp_root("inside");
        let p = confine_to(&root, &root.join("inner/file.txt").to_string_lossy()).unwrap();
        assert!(p.starts_with(&root));
        let rel = confine_to(&root, "inner/file.txt").unwrap();
        assert_eq!(rel, root.join("inner/file.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_not_yet_existing_paths_inside_root() {
        let root = temp_root("new");
        let p = confine_to(&root, "inner/new-dir/new-file.txt").unwrap();
        assert_eq!(p, root.join("inner/new-dir/new-file.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_dot_dot_escape() {
        let root = temp_root("dotdot");
        assert!(confine_to(&root, "../../etc/passwd").is_err());
        assert!(confine_to(&root, "inner/../../outside").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let root = temp_root("abs");
        assert!(confine_to(&root, "/etc/passwd").is_err());
        assert!(confine_to(&root, "~/.ssh/id_rsa").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows' own canonicalize answers `\\?\D:\…`, which cmd.exe refuses as a
    /// working directory and the title bar printed as-is.
    #[test]
    fn paths_handed_out_carry_no_verbatim_prefix() {
        let root = temp_root("verbatim");
        let workspace = Workspace::new();
        let set = workspace.set_root(&root).unwrap();
        let confined = workspace.confine("inner/file.txt").unwrap();
        for path in [&root, &set, &confined] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "verbatim path handed out: {}",
                path.display()
            );
        }
        assert!(confined.starts_with(&set), "{} is not under {}", confined.display(), set.display());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = temp_root("symlink");
        let outside = std::env::temp_dir().join(format!("nexterm-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(confine_to(&root, "link/secret").is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_file_crud_operations() {
        let temp_dir = std::env::temp_dir().join(format!("nexterm_test_crud_{}", uuid::Uuid::new_v4().simple()));
        let dir_str = temp_dir.to_string_lossy().to_string();

        // Create dir
        assert!(create_dir(&dir_str).is_ok());

        // Create file
        let file_path = temp_dir.join("test.txt");
        let file_str = file_path.to_string_lossy().to_string();
        assert!(create_file(&file_str).is_ok());
        assert!(create_file(&file_str).is_err(), "Duplicate creation should fail");

        // Write & Read
        assert!(write_file(&file_str, "hello world").is_ok());
        let content = read_file(&file_str).unwrap();
        assert_eq!(content, "hello world");

        // Delete file
        assert!(delete_path(&file_str, false).is_ok());
        assert!(read_file(&file_str).is_err(), "Deleted file should not exist");

        // Delete dir
        assert!(delete_path(&dir_str, true).is_ok());
        assert!(!temp_dir.exists());
    }

    #[test]
    fn test_read_dir_hierarchy_and_skips() {
        let temp_dir = std::env::temp_dir().join(format!("nexterm_test_tree_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(temp_dir.join("src")).unwrap();
        fs::create_dir_all(temp_dir.join(".git")).unwrap();
        fs::create_dir_all(temp_dir.join("node_modules")).unwrap();
        fs::create_dir_all(temp_dir.join("target")).unwrap();
        fs::create_dir_all(temp_dir.join(".agents")).unwrap();
        fs::create_dir_all(temp_dir.join("dist")).unwrap();

        fs::write(temp_dir.join("package.json"), "{}").unwrap();
        fs::write(temp_dir.join("src/App.jsx"), "export default function App() {}").unwrap();
        fs::write(temp_dir.join(".git/config"), "secret").unwrap();

        let nodes = read_dir_hierarchy(&temp_dir.to_string_lossy(), Some(3)).unwrap();

        let names: Vec<String> = nodes.iter().map(|n| n.name.clone()).collect();
        assert!(names.contains(&"src".to_string()), "src dir must be included");
        assert!(names.contains(&"package.json".to_string()), "package.json must be included");

        // Ensure skipped folders are not present
        assert!(!names.contains(&".git".to_string()), ".git must be skipped");
        assert!(!names.contains(&"node_modules".to_string()), "node_modules must be skipped");
        assert!(!names.contains(&"target".to_string()), "target must be skipped");
        assert!(!names.contains(&".agents".to_string()), ".agents must be skipped");
        assert!(!names.contains(&"dist".to_string()), "dist must be skipped");

        // Ensure directories come before files
        let first_is_dir = nodes[0].is_dir;
        assert!(first_is_dir, "Directories must sort before files");

        let src_node = nodes.iter().find(|n| n.name == "src").unwrap();
        assert!(src_node.children.is_some());
        let src_children = src_node.children.as_ref().unwrap();
        assert_eq!(src_children.len(), 1);
        assert_eq!(src_children[0].name, "App.jsx");

        // Cleanup
        let _ = fs::remove_dir_all(&temp_dir);
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    /// Each test gets its own directory. Sharing one fixed path between tests
    /// is what made the shell-integration suite flaky under cargo's parallel
    /// harness; do not repeat it here.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("nexterm-rename-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonical().unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn case_only_rename_keeps_the_file() {
        let root = temp_root("case");
        let from = root.join("Foo.txt");
        let to = root.join("foo.txt");
        fs::write(&from, "important data").unwrap();

        rename_path(&s(&from), &s(&to)).unwrap();

        // On a case-insensitive volume these are one entry, on a
        // case-sensitive one they are two; either way the bytes must survive
        // and the directory must still hold exactly one file.
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "rename lost the file: {names:?}");
        assert_eq!(fs::read_to_string(root.join(&names[0])).unwrap(), "important data");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unicode_normalization_rename_keeps_the_file() {
        let root = temp_root("nfc");
        let nfc = root.join("\u{d55c}.txt"); // 한 as one precomposed code point
        let nfd = root.join("\u{1112}\u{1161}\u{11ab}.txt"); // the same syllable, decomposed
        fs::write(&nfc, "korean").unwrap();

        rename_path(&s(&nfc), &s(&nfd)).unwrap();

        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "rename lost the file: {names:?}");
        assert_eq!(fs::read_to_string(root.join(&names[0])).unwrap(), "korean");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn directory_rename_keeps_every_descendant() {
        let root = temp_root("dir");
        let proj = root.join("proj");
        // Depth 3, plus one folder the directory listing deliberately hides.
        fs::create_dir_all(proj.join("src/nested/deeper")).unwrap();
        fs::create_dir_all(proj.join(".git")).unwrap();
        fs::write(proj.join("top.txt"), "top").unwrap();
        fs::write(proj.join("src/a.js"), "a").unwrap();
        fs::write(proj.join("src/nested/b.js"), "b").unwrap();
        fs::write(proj.join("src/nested/deeper/c.js"), "c").unwrap();
        fs::write(proj.join(".git/config"), "cfg").unwrap();
        // A byte sequence that is not valid UTF-8: a copy that decodes file
        // contents aborts here, a rename never looks inside.
        fs::write(proj.join("logo.png"), [0x89u8, 0x50, 0x4e, 0x47, 0xff, 0xfe]).unwrap();

        let dest = root.join("proj2");
        rename_path(&s(&proj), &s(&dest)).unwrap();

        assert!(!proj.exists(), "source directory still present");
        assert_eq!(fs::read_to_string(dest.join("top.txt")).unwrap(), "top");
        assert_eq!(fs::read_to_string(dest.join("src/a.js")).unwrap(), "a");
        assert_eq!(fs::read_to_string(dest.join("src/nested/b.js")).unwrap(), "b");
        assert_eq!(fs::read_to_string(dest.join("src/nested/deeper/c.js")).unwrap(), "c");
        assert_eq!(fs::read_to_string(dest.join(".git/config")).unwrap(), "cfg");
        assert_eq!(fs::read(dest.join("logo.png")).unwrap(), vec![0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_overwrite_an_existing_entry() {
        let root = temp_root("collide");
        fs::write(root.join("keep.txt"), "KEEP ME").unwrap();
        fs::write(root.join("other.txt"), "other").unwrap();

        let err = rename_path(&s(&root.join("other.txt")), &s(&root.join("keep.txt")))
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "KEEP ME");
        assert_eq!(fs::read_to_string(root.join("other.txt")).unwrap(), "other");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_move_a_directory_into_itself() {
        let root = temp_root("selfmove");
        let dir = root.join("outer");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("inside.txt"), "still here").unwrap();

        let err = rename_path(&s(&dir), &s(&dir.join("child"))).unwrap_err();
        assert!(err.contains("inside itself"), "{err}");
        assert_eq!(fs::read_to_string(dir.join("inside.txt")).unwrap(), "still here");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_is_an_error_and_a_dangling_link_is_not() {
        let root = temp_root("missing");
        assert!(rename_path(&s(&root.join("nope.txt")), &s(&root.join("x.txt"))).is_err());

        #[cfg(unix)]
        {
            // A broken symlink is a real directory entry; renaming it must
            // move the link, not report it missing.
            std::os::unix::fs::symlink(root.join("no-such-target"), root.join("link")).unwrap();
            rename_path(&s(&root.join("link")), &s(&root.join("link2"))).unwrap();
            assert!(root.join("link2").symlink_metadata().is_ok());
            assert!(root.join("link").symlink_metadata().is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }
}
