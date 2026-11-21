//! A file or folder of the open folder, opened in the user's own editor
//! (bundle 2, A12-4): Explorer ▸ *Open in External Editor*.
//!
//! **Only the program the user set, never the OS default app.** The setting
//! is a program and its arguments — `code`, `subl -w` — split here into an
//! argument list (`split_command`) and started directly, without a shell: no
//! `sh -c`, no `cmd /c` of our own, no `$VAR`, globs, pipes or `;`. A shell,
//! a program that runs its arguments as a command or a script (`env`,
//! `xargs`, `osascript`, `wsl`, …) or an OS opener as the program
//! (`refused_program`) is refused — each would run the path, or hand it to
//! whatever app the OS picks for it, which runs an `.exe`, a script or an
//! `.app` — and nothing here asks the OS to open the path itself. Reveal
//! (`reveal.rs`) still never opens anything; this is the one place a program
//! of the user's choosing gets a path.
//!
//! **A guard against a mistake, not a sandbox.** `REFUSED_PROGRAMS` matches
//! the program's name only, and only the user writes the setting: whatever
//! else it names runs, with the path as its last argument. An interpreter
//! such as `python` or `node` is not refused, nor a renamed copy of a shell.
//!
//! **Confined like every other file command.** The path goes through
//! `confine_to` against the open folder, so `..`, an absolute path elsewhere
//! or a link that leads out is refused, and with no folder open everything
//! is (`prepare`). The confined path is absolute, and it goes last as one
//! argument of its own, so it is never read as an option or split at a space.
//!
//! **Found when NexTerm was started from Finder.** The editor runs with the
//! login shell's PATH ahead of the app's own (`commands::agent::search_path`).
//! On Windows a bare name is looked up on that PATH as Windows does, with
//! `.exe`, `.com`, `.cmd` and `.bat` (`resolve_windows_program`); VS Code's
//! `code` is `code.cmd`.
//!
//! **Nothing inside the open folder is found as a program**, though the
//! editor runs there, in three ways. A program given as a relative path is
//! refused (`check_program_location`). Relative PATH entries are dropped
//! (`editor_search_path`), so a `.` in PATH finds nothing there; and on
//! Windows the program is resolved to a full path beforehand, never from the
//! current folder. And on Windows the editor's process gets
//! `NoDefaultCurrentDirectoryInExePath=1` (`child_env_for_windows`): cmd.exe,
//! which runs a `.cmd` or `.bat` editor such as `code.cmd`, otherwise looks a
//! bare command name up in its working directory before PATH, so a wrapper
//! that calls `node` would run a `node.bat` planted at the root of a cloned
//! repository. The variable is inherited by what the editor starts.
//!
//! **Quiet, and never waited for.** `quiet_command` (no console window on
//! Windows), stdin, stdout and stderr null, the open folder as the working
//! directory. `subl -w` and `code --wait` stay running until the file is
//! closed, so the child is reaped on a thread of its own (`spawn_detached`)
//! and the command returns as soon as it has started.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::commands::agent::quiet_command;
use crate::fs::{confine_to, Workspace};

/// The longest command the setting may hold, in bytes.
pub const MAX_COMMAND_BYTES: usize = 4096;

/// The most words the command may split into, the program included.
pub const MAX_COMMAND_WORDS: usize = 32;

/// Programs never run as the editor, by file stem, compared case-insensitively:
/// the shells, which would run the path or a line built around it; the OS
/// openers, which hand it to its default app; and the wrappers that exist to
/// run their arguments as a command or a script (`env`, `nohup`, `xargs`,
/// `wsl`, `conhost`; `osascript`, `cscript`, `wscript`, `mshta`). A guard
/// against a mistake, not a sandbox: by name only, and an interpreter such as
/// `python` or `node` is not on it.
pub const REFUSED_PROGRAMS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu", "cmd", "powershell", "pwsh",
    "open", "xdg-open", "gio", "kde-open", "kde-open5", "gnome-open", "exo-open", "wslview", "start",
    "explorer", "rundll32",
    "env", "nohup", "xargs", "osascript", "cscript", "wscript", "mshta", "wsl", "conhost",
];

/// What Windows starts by name, in the order a bare name is tried.
const RUNNABLE_EXTENSIONS: &[&str] = &["exe", "com", "cmd", "bat"];

/// Whether std escapes the arguments of a `.cmd` or `.bat` file, which runs
/// through cmd.exe and reads `&`, `|` or `%` in an argument as its own
/// (CVE-2024-24576). Fixed in Rust 1.77.2, which is also the `rust-version`
/// of tauri 2, so cargo refuses to build NexTerm with any toolchain that
/// lacks it; CI builds with stable and the release with a pinned 1.99.1.
/// `resolve_windows_program` takes it as an argument, so the refusal it
/// would give is tested too.
///
/// The follow-up, CVE-2024-43402, is fixed only in Rust 1.81.0, later than
/// that `rust-version`: a batch file named with a dot or a space at its end
/// (`code.cmd.`), which Windows strips, was not seen as a batch file, so its
/// arguments went unescaped. It cannot arise here, whatever the toolchain:
/// `resolve_windows_program` returns either the name with `.exe`, `.com`,
/// `.cmd` or `.bat` appended, or a full path whose own last component ends in
/// one of them, so the name std checks ends in the extension Windows runs.
pub const BATCH_ARGUMENTS_ESCAPED: bool = true;

/// The setting split into words, without a shell.
///
/// Whitespace separates words; `'…'` and `"…"` quote, and may sit inside a
/// word (`--title="a b"` is `--title=a b`); there is no escape character, so
/// a backslash is kept as it is and `C:\Program Files\…` needs only quotes.
/// Refused: nothing but whitespace, a quote never closed, a NUL, more than
/// `MAX_COMMAND_BYTES` bytes or `MAX_COMMAND_WORDS` words, and an empty
/// program (`"" -w`).
pub fn split_command(command: &str) -> Result<Vec<String>, String> {
    if command.len() > MAX_COMMAND_BYTES {
        return Err(format!(
            "The external editor command is {} bytes long, more than {MAX_COMMAND_BYTES}",
            command.len()
        ));
    }
    if command.contains('\0') {
        return Err("The external editor command contains a NUL character".to_string());
    }
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                in_word = true;
            }
            None if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            None => {
                word.push(c);
                in_word = true;
            }
        }
        if words.len() > MAX_COMMAND_WORDS {
            break;
        }
    }
    if let Some(q) = quote {
        return Err(format!("The external editor command has a {q} that is never closed"));
    }
    if in_word {
        words.push(word);
    }
    if words.len() > MAX_COMMAND_WORDS {
        return Err(format!(
            "The external editor command has more than {MAX_COMMAND_WORDS} words"
        ));
    }
    match words.first() {
        None => Err("No external editor is set".to_string()),
        Some(program) if program.is_empty() => {
            Err("The external editor command starts with an empty program name".to_string())
        }
        Some(_) => Ok(words),
    }
}

/// The last component of `program`, `/` and `\` both separators on every
/// platform, without what Windows ignores at its end (dots, spaces) and
/// without its extension, lowercased: `C:\Windows\System32\CMD.EXE` is `cmd`.
pub fn program_stem(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.trim_end_matches(['.', ' ']).to_lowercase();
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name,
    }
}

/// Why `program` is not run as the editor, when it is a shell, an opener or a
/// wrapper that runs its arguments (`REFUSED_PROGRAMS`); None for anything
/// else. The words are those of the shells and openers, which the wrappers
/// stand in for.
pub fn refused_program(program: &str) -> Option<String> {
    let stem = program_stem(program);
    REFUSED_PROGRAMS.contains(&stem.as_str()).then(|| {
        format!(
            "'{program}' is a shell or opens files in their default app, so NexTerm does not run it \
             as the external editor. Set the editor itself, for example code or subl -w"
        )
    })
}

/// A program named by a path must be a full one: a relative path would be
/// looked up in the open folder, which is where the editor runs.
fn check_program_location(program: &str) -> Result<(), String> {
    let has_dir = program.contains('/') || program.contains('\\');
    if has_dir && !Path::new(program).is_absolute() {
        return Err(format!(
            "'{program}' is a relative path. Give the editor as a name found on PATH or as a full path"
        ));
    }
    Ok(())
}

/// `path` without its relative entries (`.`, `bin`, an empty one): looked up
/// from the open folder, they would find a program inside it.
pub fn editor_search_path(path: Option<OsString>) -> Option<OsString> {
    let path = path?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).filter(|d| d.is_absolute()).collect();
    std::env::join_paths(dirs).ok()
}

/// The lowercased extension of the last component of `name`, if any.
fn extension_of(name: &str) -> Option<String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let dot = last.rfind('.')?;
    (dot > 0 && dot + 1 < last.len()).then(|| last[dot + 1..].to_lowercase())
}

/// The file Windows would start for `program`: a full path as it is, a bare
/// name on `path_env`'s absolute folders, in order, each tried with `.exe`,
/// `.com`, `.cmd` and `.bat` unless the name ends in one of them already.
/// Never the current folder. A `.cmd` or `.bat` is refused with the reason
/// unless `batch_ok` (`BATCH_ARGUMENTS_ESCAPED`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn resolve_windows_program(
    program: &str,
    path_env: Option<&OsStr>,
    batch_ok: bool,
) -> Result<PathBuf, String> {
    let names: Vec<String> = match extension_of(program) {
        Some(ext) if RUNNABLE_EXTENSIONS.contains(&ext.as_str()) => vec![program.to_string()],
        _ => RUNNABLE_EXTENSIONS.iter().map(|ext| format!("{program}.{ext}")).collect(),
    };
    let has_dir = program.contains('/') || program.contains('\\');
    let found = if has_dir {
        names.iter().map(PathBuf::from).find(|p| p.is_absolute() && p.is_file())
    } else {
        path_env
            .map(|p| std::env::split_paths(p).filter(|d| d.is_absolute()).collect::<Vec<_>>())
            .unwrap_or_default()
            .iter()
            .find_map(|dir| names.iter().map(|n| dir.join(n)).find(|p| p.is_file()))
    };
    let Some(found) = found else {
        return Err(format!(
            "'{program}' was not found{} (looked for .exe, .com, .cmd and .bat)",
            if has_dir { "" } else { " on PATH" }
        ));
    };
    let batch = matches!(extension_of(&found.to_string_lossy()).as_deref(), Some("cmd" | "bat"));
    if batch && !batch_ok {
        return Err(format!(
            "'{}' is a batch file, and this build of NexTerm cannot pass it a path safely \
             (CVE-2024-24576, fixed in Rust 1.77.2). Set the editor's .exe instead",
            found.display()
        ));
    }
    Ok(found)
}

/// What the editor's process gets in its environment on Windows, besides
/// PATH: `NoDefaultCurrentDirectoryInExePath`, set, makes cmd.exe — which
/// runs a `.cmd` or `.bat` editor — skip its working directory, the open
/// folder, when it looks up a bare command name, so a `node.bat` planted
/// there is not what the editor's wrapper starts. Harmless for an `.exe`.
/// Pure, so it is checked on every platform; `build_command` sets it on
/// Windows only.
pub fn child_env_for_windows() -> &'static [(&'static str, &'static str)] {
    &[("NoDefaultCurrentDirectoryInExePath", "1")]
}

/// The editor's process, built and not started: `program`, then `args`, then
/// `path` as one last argument; the open folder `cwd` as its working
/// directory, `path_env` as its PATH, on Windows `child_env_for_windows` too,
/// stdin, stdout and stderr null, and no console window (`quiet_command`).
/// No shell anywhere.
pub fn build_command(
    program: impl AsRef<OsStr>,
    args: &[String],
    path: &Path,
    cwd: &Path,
    path_env: Option<&OsStr>,
) -> Command {
    let mut command = quiet_command(program);
    command
        .args(args)
        .arg(path)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path_env) = path_env {
        command.env("PATH", path_env);
    }
    // `cfg!`, not `#[cfg]`: the same code is compiled, and type-checked, on
    // every platform, and runs on Windows only.
    if cfg!(windows) {
        for (name, value) in child_env_for_windows() {
            command.env(name, value);
        }
    }
    command
}

/// Everything checked, in this order, and the process built — nothing is
/// started here: the open folder (none open is refused), `path` confined to
/// it (`confine_to`, as `Workspace::confine` does) and there, the command
/// split (`split_command`), its program not a shell or an opener
/// (`refused_program`) nor a relative path, and on Windows found on PATH
/// (`resolve_windows_program`). `path_env` is the PATH to run with
/// (`commands::agent::search_path`), relative entries dropped.
pub fn prepare(
    workspace: &Workspace,
    command: &str,
    path: &str,
    path_env: Option<OsString>,
) -> Result<Command, String> {
    let root = workspace.root().ok_or_else(|| "No folder is open".to_string())?;
    let target = confine_to(&root, path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    let words = split_command(command)?;
    let (program, args) = words.split_first().ok_or_else(|| "No external editor is set".to_string())?;
    if let Some(reason) = refused_program(program) {
        return Err(reason);
    }
    check_program_location(program)?;
    let path_env = editor_search_path(path_env);
    #[cfg(windows)]
    let program = {
        let found = resolve_windows_program(program, path_env.as_deref(), BATCH_ARGUMENTS_ESCAPED)?;
        if let Some(reason) = refused_program(&found.to_string_lossy()) {
            return Err(reason);
        }
        found.into_os_string()
    };
    #[cfg(not(windows))]
    let program = OsString::from(program);
    Ok(build_command(&program, args, &target, &root, path_env.as_deref()))
}

/// Start `command` and return as soon as it has started; its exit is waited
/// for on a thread of its own, so an editor that stays running (`subl -w`)
/// holds nothing up and leaves no zombie behind.
pub fn spawn_detached(mut command: Command) -> Result<(), String> {
    let program = command.get_program().to_string_lossy().to_string();
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start the external editor '{program}': {e}"))?;
    // When no thread can be made the editor has started all the same; it is
    // only left unreaped until NexTerm exits.
    let _ = std::thread::Builder::new()
        .name("external-editor-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-xe-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn xe_01_split_command_splits_without_a_shell() {
        assert_eq!(split_command("code").unwrap(), words(&["code"]));
        assert_eq!(split_command("  subl   -w  ").unwrap(), words(&["subl", "-w"]));
        assert_eq!(split_command("subl\t-w\n").unwrap(), words(&["subl", "-w"]));
        assert_eq!(
            split_command("\"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl\" -w").unwrap(),
            words(&["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl", "-w"])
        );
        assert_eq!(
            split_command("'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd' --wait").unwrap(),
            words(&["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd", "--wait"]),
            "single quotes, backslashes kept"
        );
        assert_eq!(
            split_command("C:\\tools\\subl.exe -w").unwrap(),
            words(&["C:\\tools\\subl.exe", "-w"]),
            "a backslash is not an escape"
        );
        assert_eq!(
            split_command("code --title=\"a b\" 'it''s' \"\"").unwrap(),
            words(&["code", "--title=a b", "its", ""]),
            "quotes inside a word; an empty quoted argument is kept"
        );
        assert_eq!(
            split_command("code \"it's\" 'say \"hi\"'").unwrap(),
            words(&["code", "it's", "say \"hi\""]),
            "the other quote inside a quote is literal"
        );
        // What a shell would act on is only text here.
        assert_eq!(
            split_command("code $HOME;rm -rf ~ | cat & `x`").unwrap(),
            words(&["code", "$HOME;rm", "-rf", "~", "|", "cat", "&", "`x`"])
        );

        for empty in ["", "   ", "\t\n"] {
            assert_eq!(split_command(empty).unwrap_err(), "No external editor is set", "{empty:?}");
        }
        assert!(split_command("\"code -w").unwrap_err().contains("never closed"));
        assert!(split_command("code 'a").unwrap_err().contains("' that is never closed"));
        assert!(split_command("\"\" -w").unwrap_err().contains("empty program"));
        assert!(split_command("code a\0b").unwrap_err().contains("NUL"));

        let thirty_two = vec!["w"; MAX_COMMAND_WORDS].join(" ");
        assert_eq!(split_command(&thirty_two).unwrap().len(), MAX_COMMAND_WORDS, "32 words is the limit");
        let thirty_three = vec!["w"; MAX_COMMAND_WORDS + 1].join(" ");
        assert!(split_command(&thirty_three).unwrap_err().contains("more than 32 words"));

        let at_limit = format!("code {}", "a".repeat(MAX_COMMAND_BYTES - 5));
        assert_eq!(at_limit.len(), MAX_COMMAND_BYTES);
        assert!(split_command(&at_limit).is_ok(), "4096 bytes is the limit");
        let over = format!("{at_limit}a");
        assert!(split_command(&over).unwrap_err().contains("more than 4096"));
    }

    /// The deny-list of A12-4 and the wrappers added after review (A-R2),
    /// written out here rather than read from `REFUSED_PROGRAMS`, so a name
    /// removed, misspelled or replaced there fails `xe_02`.
    const EXPECTED_REFUSED: [&str; 32] = [
        "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu", "cmd", "powershell", "pwsh",
        "open", "xdg-open", "gio", "kde-open", "kde-open5", "gnome-open", "exo-open", "wslview", "start",
        "explorer", "rundll32",
        "env", "nohup", "xargs", "osascript", "cscript", "wscript", "mshta", "wsl", "conhost",
    ];

    #[test]
    fn xe_02_shells_and_openers_are_refused_however_spelled() {
        // The constant holds exactly these names: none missing, changed or
        // added (order aside; a duplicate in place of a name fails too).
        let mut actual: Vec<&str> = REFUSED_PROGRAMS.to_vec();
        let mut expected: Vec<&str> = EXPECTED_REFUSED.to_vec();
        actual.sort_unstable();
        expected.sort_unstable();
        assert_eq!(actual, expected, "the deny-list of A12-4, all of it and nothing else");

        // Each name is refused, checked from the literal list and not from
        // the constant, however it is spelled.
        for name in EXPECTED_REFUSED {
            let upper = name.to_uppercase();
            for spelled in [
                name.to_string(),
                format!("{name}.exe"),
                format!("{upper}.EXE"),
                upper.clone(),
                format!("/usr/bin/{name}"),
                format!("C:\\Windows\\System32\\{name}.exe"),
                format!("{name}.exe."),
            ] {
                let reason = refused_program(&spelled);
                assert!(reason.is_some(), "{spelled} must be refused");
                assert!(reason.unwrap().contains("default app"), "{spelled}: the reason says why");
            }
        }
        assert_eq!(REFUSED_PROGRAMS.len(), 32, "the deny-list of A12-4 and the wrappers, all of it");
        // Spellings written out by hand, as a user might set them.
        for spelled in [
            "/usr/bin/env",
            "NOHUP",
            "/usr/bin/xargs",
            "/usr/bin/osascript",
            "C:\\Windows\\System32\\cscript.exe",
            "WScript.exe",
            "C:\\Windows\\System32\\mshta.exe",
            "wsl.exe",
            "C:\\Windows\\System32\\conhost.exe",
            "ZSH",
            "zsh.exe",
            "bash.",
            "Bash.EXE. ",
            "/bin/zsh",
            "/usr/local/bin/fish",
            "C:\\Windows\\System32\\cmd.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe",
            "pwsh.exe",
            "/usr/bin/xdg-open",
            "/usr/bin/open",
            "Explorer.EXE",
            "rundll32.exe",
        ] {
            assert!(refused_program(spelled).is_some(), "{spelled} must be refused");
        }
        for allowed in [
            "code",
            "code.cmd",
            "subl",
            "sublime_text.exe",
            "/usr/local/bin/nvim",
            "C:\\Program Files\\Notepad++\\notepad++.exe",
            "openscad",
            "bashful",
            "zed",
            "envy",
            "wslconfig",
        ] {
            assert_eq!(refused_program(allowed), None, "{allowed} is an editor");
        }
        // A guard against a mistake, not a sandbox (README, Settings): an
        // interpreter is not refused, and runs with the path as its argument.
        for interpreter in ["python", "python3", "node", "/usr/bin/perl"] {
            assert_eq!(refused_program(interpreter), None, "{interpreter} is not on the list");
        }
        assert_eq!(program_stem("C:\\Windows\\System32\\CMD.EXE"), "cmd");
        assert_eq!(program_stem("/bin/kde-open5"), "kde-open5");
        assert_eq!(program_stem(".bashrc"), ".bashrc");
    }

    #[test]
    fn xe_03_outside_the_open_folder_or_none_open_is_refused_before_a_spawn() {
        let root = temp_dir("confine");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a b.txt"), "x").unwrap();
        let outside = temp_dir("confine-outside");
        fs::write(outside.join("secret.txt"), "x").unwrap();

        let none = Workspace::new();
        assert_eq!(
            prepare(&none, "subl -w", &root.join("src/a b.txt").to_string_lossy(), None).unwrap_err(),
            "No folder is open"
        );

        let workspace = Workspace::new();
        workspace.set_root(&root).unwrap();
        let secret = outside.join("secret.txt").to_string_lossy().to_string();
        assert!(prepare(&workspace, "subl -w", &secret, None).is_err(), "an absolute path elsewhere");
        let dotdot = format!("../{}/secret.txt", outside.file_name().unwrap().to_string_lossy());
        assert!(prepare(&workspace, "subl -w", &dotdot, None).is_err(), "`..` out");
        assert!(prepare(&workspace, "subl -w", "src/missing.txt", None).unwrap_err().contains("does not exist"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("src/link.txt")).unwrap();
            assert!(prepare(&workspace, "subl -w", "src/link.txt", None).is_err(), "a link that leads out");
        }
        // The command is checked too, before anything starts.
        let inside = root.join("src/a b.txt").to_string_lossy().to_string();
        assert!(prepare(&workspace, "bash -c", &inside, None).unwrap_err().contains("default app"));
        assert!(prepare(&workspace, "OPEN.exe -a TextEdit", &inside, None).unwrap_err().contains("default app"));
        assert!(prepare(&workspace, "   ", &inside, None).is_err());
        assert!(prepare(&workspace, "bin/editor", &inside, None).unwrap_err().contains("relative path"));
        assert!(prepare(&workspace, ".\\editor.exe", &inside, None).unwrap_err().contains("relative path"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn xe_04_the_command_is_the_program_its_args_and_the_path_last() {
        let root = temp_dir("build");
        let file = root.join("a b.txt");
        fs::write(&file, "x").unwrap();
        let path_env = std::env::join_paths([root.join("bin")]).unwrap();

        let command = build_command("subl", &words(&["-w"]), &file, &root, Some(&path_env));
        assert_eq!(command.get_program(), OsStr::new("subl"), "the program itself, not a shell");
        let args: Vec<&OsStr> = command.get_args().collect();
        assert_eq!(args, vec![OsStr::new("-w"), file.as_os_str()], "exactly -w and the path, as one argument");
        assert_eq!(command.get_current_dir(), Some(root.as_path()), "run in the open folder");
        // Besides PATH, what keeps cmd.exe out of the open folder, on Windows
        // only (`child_env_for_windows`); nothing else, anywhere.
        let extra: Vec<(&OsStr, Option<&OsStr>)> = if cfg!(windows) {
            child_env_for_windows().iter().map(|(k, v)| (OsStr::new(*k), Some(OsStr::new(*v)))).collect()
        } else {
            Vec::new()
        };
        let mut envs: Vec<_> = command.get_envs().collect();
        envs.sort();
        let mut expected = extra.clone();
        expected.push((OsStr::new("PATH"), Some(path_env.as_os_str())));
        expected.sort();
        assert_eq!(envs, expected, "PATH, on Windows NoDefaultCurrentDirectoryInExePath, and nothing else set");
        #[cfg(windows)]
        {
            let set = command.get_envs().find(|(k, _)| *k == OsStr::new("NoDefaultCurrentDirectoryInExePath"));
            assert_eq!(set, Some((OsStr::new("NoDefaultCurrentDirectoryInExePath"), Some(OsStr::new("1")))));
        }

        let bare = build_command("code", &[], &file, &root, None);
        assert_eq!(bare.get_args().collect::<Vec<_>>(), vec![file.as_os_str()]);
        let mut bare_envs: Vec<_> = bare.get_envs().collect();
        bare_envs.sort();
        assert_eq!(bare_envs, extra, "no PATH to set: the app's own");

        // Through `prepare`, as the command does: the path confined, absolute and last.
        #[cfg(not(windows))]
        {
            let workspace = Workspace::new();
            workspace.set_root(&root).unwrap();
            let own = std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("rel/bin")]).unwrap();
            let command = prepare(&workspace, "'subl' -w", "a b.txt", Some(own)).unwrap();
            assert_eq!(command.get_program(), OsStr::new("subl"));
            assert_eq!(command.get_args().collect::<Vec<_>>(), vec![OsStr::new("-w"), file.as_os_str()]);
            assert_eq!(command.get_current_dir(), Some(root.as_path()));
            let path = command.get_envs().find(|(k, _)| *k == OsStr::new("PATH")).and_then(|(_, v)| v).unwrap();
            assert_eq!(path, OsStr::new("/usr/bin"), "relative PATH entries dropped");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn xe_05_windows_finds_code_cmd_on_path_or_refuses_batch_with_a_reason() {
        let first = temp_dir("resolve-1");
        let second = temp_dir("resolve-2");
        fs::write(first.join("code.cmd"), "@echo off").unwrap();
        fs::write(second.join("code.exe"), "").unwrap();
        fs::write(second.join("subl.exe"), "").unwrap();
        fs::write(second.join("subl.cmd"), "").unwrap();
        let path_env = std::env::join_paths([PathBuf::from("relative"), first.clone(), second.clone()]).unwrap();
        let path = Some(path_env.as_os_str());

        assert_eq!(resolve_windows_program("code", path, true).unwrap(), first.join("code.cmd"), "the first folder that has it");
        assert_eq!(resolve_windows_program("subl", path, true).unwrap(), second.join("subl.exe"), ".exe before .cmd");
        assert_eq!(resolve_windows_program("code.exe", path, true).unwrap(), second.join("code.exe"));
        let refused = resolve_windows_program("code", path, false).unwrap_err();
        assert!(refused.contains("batch file") && refused.contains("CVE-2024-24576"), "{refused}");
        assert_eq!(resolve_windows_program("subl", path, false).unwrap(), second.join("subl.exe"), "an .exe needs no escaping");

        assert!(resolve_windows_program("nvim", path, true).unwrap_err().contains("not found on PATH"));
        assert!(resolve_windows_program("code", None, true).is_err(), "no PATH: nothing found");
        let full = first.join("code.cmd").to_string_lossy().to_string();
        assert_eq!(resolve_windows_program(&full, None, true).unwrap(), first.join("code.cmd"), "a full path as it is");
        assert!(resolve_windows_program(&full, None, false).unwrap_err().contains("batch file"));
        assert!(BATCH_ARGUMENTS_ESCAPED, "every toolchain that builds tauri 2 escapes batch arguments");

        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }

    /// A-R1: on Windows cmd.exe, which runs a `.cmd` or `.bat` editor in the
    /// open folder, must not find a bare command name there. Checked on every
    /// platform through the pure helper `build_command` uses; xe_04 checks on
    /// Windows that the built command carries it. V67-7 checks it for real.
    #[test]
    fn xe_07_on_windows_cmd_exe_never_looks_up_a_program_in_the_open_folder() {
        let env = child_env_for_windows();
        assert_eq!(
            env,
            &[("NoDefaultCurrentDirectoryInExePath", "1")],
            "NoDefaultCurrentDirectoryInExePath set, and nothing else: PATH is the caller's"
        );
        assert!(
            !env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")),
            "the PATH set by build_command is never overridden"
        );
        // The working directory stays the open folder: only the lookup changes.
        let root = temp_dir("no-cwd-lookup");
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let command = build_command("C:\\tools\\editor.cmd", &[], &file, &root, None);
        assert_eq!(command.get_current_dir(), Some(root.as_path()));
        let names: Vec<&OsStr> = command.get_envs().map(|(k, _)| k).collect();
        if cfg!(windows) {
            assert_eq!(names, vec![OsStr::new("NoDefaultCurrentDirectoryInExePath")]);
        } else {
            assert!(names.is_empty(), "elsewhere nothing is set: {names:?}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// The one spawn here, and of `true`, not an editor: it starts, the call
    /// returns without waiting, and nothing was run through a shell.
    #[cfg(unix)]
    #[test]
    fn xe_06_spawn_detached_starts_and_returns() {
        let root = temp_dir("spawn");
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let path_env = editor_search_path(std::env::var_os("PATH"));
        let command = build_command("true", &[], &file, &root, path_env.as_deref());
        assert_eq!(spawn_detached(command), Ok(()));
        let missing = build_command("nexterm-no-such-editor", &[], &file, &root, path_env.as_deref());
        assert!(spawn_detached(missing).unwrap_err().contains("Could not start the external editor 'nexterm-no-such-editor'"));
        let _ = fs::remove_dir_all(&root);
    }
}
