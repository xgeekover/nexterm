pub mod watcher;
pub use watcher::FsWatcherManager;

use parking_lot::Mutex;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::models::FileNode;

const SKIPPED_FOLDERS: &[&str] = &[".git", "node_modules", "target", ".agents", "dist"];

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
            .canonicalize()
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
            if let Ok(canonical) = cwd.canonicalize() {
                return canonical;
            }
        }
    }
    let home = home_dir();
    home.canonicalize().unwrap_or(home)
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
        match cursor.canonicalize() {
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
        dir.canonicalize().unwrap()
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
