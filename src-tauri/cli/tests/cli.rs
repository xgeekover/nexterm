//! The real `nexterm-cli` binary against a tiny fake NexTerm: a socket (or,
//! on Windows, a pipe) of the test's own that answers canned JSON lines.
//! What these add over the unit tests: the process's exit codes, its
//! environment, standard input and output as bytes, and the real timeouts.

use std::io::Write;
use std::process::{Command, Output, Stdio};

const TOKEN: &str = "test·token_0123456789abcdefABCDEF-_";

/// The binary's message when NEXTERM_CONTROL names nothing that answers
/// (src/transport/mod.rs NOT_RUNNING; repeated here, as a user reads it).
const NOT_RUNNING: &str = "NexTerm is not running, or its control is turned off (Settings ▸ Terminal ▸ Control)";

fn cli() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_nexterm-cli"));
    // The tests may themselves run inside a NexTerm terminal.
    c.env_remove("NEXTERM_CONTROL").env_remove("NEXTERM_CONTROL_TOKEN");
    c
}

fn run(mut c: Command, stdin: &[u8]) -> Output {
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().expect("start nexterm-cli");
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8(b.to_vec()).expect("output is UTF-8")
}

#[test]
fn outside_nexterm_it_says_so_with_exit_3() {
    let o = run(cli_with(&["notify", "hi"]), b"");
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(text(&o.stderr).trim_end(), "nexterm-cli: Not inside a NexTerm terminal (NEXTERM_CONTROL is not set)");
    assert!(o.stdout.is_empty());
}

#[test]
fn usage_help_and_version() {
    let o = run(cli_with(&["send", "--bogus"]), b"");
    assert_eq!(o.status.code(), Some(2));
    assert!(text(&o.stderr).contains("Usage: nexterm-cli send"), "{}", text(&o.stderr));
    let o = run(cli_with(&[]), b"");
    assert_eq!(o.status.code(), Some(2));
    let o = run(cli_with(&["--version"]), b"");
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(text(&o.stdout), format!("nexterm-cli {}\n", env!("CARGO_PKG_VERSION")));
    let o = run(cli_with(&["help"]), b"");
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o.stdout).contains("Exit status:"));
}

fn cli_with(args: &[&str]) -> Command {
    let mut c = cli();
    c.args(args);
    c
}

#[test]
fn the_version_matches_the_app() {
    // The CLI ships inside the app's installers and says which NexTerm it
    // belongs to; a release bump must move all of these together.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let read = |p: &str| std::fs::read_to_string(root.join(p)).unwrap();
    let cargo = read("Cargo.toml");
    let app = cargo
        .lines()
        .find_map(|l| l.strip_prefix("version = \"").and_then(|v| v.strip_suffix('"')))
        .expect("version in src-tauri/Cargo.toml");
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let package: serde_json::Value = serde_json::from_str(&read("../package.json")).unwrap();
    let mine = env!("CARGO_PKG_VERSION");
    assert_eq!(mine, app, "src-tauri/cli/Cargo.toml vs src-tauri/Cargo.toml");
    assert_eq!(mine, conf["version"], "src-tauri/cli/Cargo.toml vs tauri.conf.json");
    assert_eq!(mine, package["version"], "src-tauri/cli/Cargo.toml vs package.json");
}

/// How the CLI gets into the installers (src-tauri/cli/stage.mjs says why).
mod packaging {
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    fn tauri_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }
    /// A file's text, CRLF made LF (Windows CI checks out CRLF).
    fn read(p: &str) -> String {
        std::fs::read_to_string(tauri_dir().join(p)).unwrap_or_else(|e| panic!("{p}: {e}")).replace("\r\n", "\n")
    }
    fn conf(p: &str) -> Value {
        serde_json::from_str(&read(p)).unwrap()
    }

    #[test]
    fn external_bin_is_only_in_the_bundle_overlay() {
        // tauri-build insists every externalBin exists whenever the app
        // crate compiles: in tauri.conf.json, or in a platform file Tauri
        // merges on its own, it would break the app's cargo test and check.
        for f in ["tauri.conf.json", "tauri.linux.conf.json", "tauri.windows.conf.json", "tauri.macos.conf.json"] {
            if tauri_dir().join(f).exists() {
                assert!(conf(f)["bundle"]["externalBin"].is_null(), "{f} must not name externalBin");
            }
        }
        let base = conf("tauri.conf.json");
        let overlay = conf("tauri.sidecar.conf.json");
        assert_eq!(overlay["bundle"], json!({"externalBin": ["binaries/nexterm-cli"]}));
        // It replaces the base beforeBuildCommand, which must still run.
        let before = base["build"]["beforeBuildCommand"].as_str().unwrap();
        assert_eq!(overlay["build"], json!({"beforeBuildCommand": format!("{before} && npm run build:cli")}));
        assert_eq!(overlay.as_object().unwrap().len(), 2, "the overlay changes nothing else: {overlay}");
    }

    #[test]
    fn the_scripts_and_ci_use_the_overlay() {
        let package: Value = serde_json::from_str(&read("../package.json")).unwrap();
        assert_eq!(package["scripts"]["build:cli"], "node src-tauri/cli/stage.mjs");
        assert_eq!(package["scripts"]["bundle"], "tauri build --config src-tauri/tauri.sidecar.conf.json");
        let ci = read("../.github/workflows/build.yml");
        for needle in [
            "run: npm run build:cli",
            "args: --config src-tauri/tauri.sidecar.conf.json",
            "Copy-Item $cli \"$name/nexterm-cli.exe\"",
            "working-directory: src-tauri/cli\n        run: cargo test",
            "run: node src-tauri/cli/check-windows-exe.mjs src-tauri/target/release/nexterm-cli.exe",
            "- name: nexterm-cli must be inside every bundle (macOS, Linux)",
            "- name: nexterm-cli must be inside every bundle (Windows)",
        ] {
            assert!(ci.contains(needle), "build.yml lost: {needle}");
        }
        let ignored: Vec<String> = read("../.gitignore").lines().map(str::to_owned).collect();
        for dir in ["src-tauri/binaries/", "src-tauri/cli/target/"] {
            assert!(ignored.iter().any(|l| l == dir), ".gitignore lost {dir}");
        }
    }

    #[test]
    fn the_crates_stay_apart_and_the_c_runtime_is_linked_in() {
        assert!(!read("Cargo.toml").contains("nexterm-cli"), "the app crate must not depend on the CLI");
        assert!(read("cli/Cargo.toml").lines().any(|l| l.trim() == "[workspace]"), "the CLI is its own workspace");
        assert!(read("cli/.cargo/config.toml").contains("rustflags = [\"-C\", \"target-feature=+crt-static\"]"));
        // Only a cargo run from src-tauri/cli reads that file.
        assert!(read("cli/stage.mjs").contains("cwd: cliDir,"));
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    struct Fake {
        dir: PathBuf,
    }

    impl Fake {
        fn new() -> Fake {
            static N: AtomicUsize = AtomicUsize::new(0);
            let name = format!("ncli-e2e-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst));
            let mut base = std::env::temp_dir();
            if base.join(&name).join("c.sock").as_os_str().len() > 100 {
                base = PathBuf::from("/tmp");
            }
            let dir = base.join(name);
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            Fake { dir }
        }

        fn socket(&self) -> PathBuf {
            self.dir.join("c.sock")
        }

        /// Answers one connection with `answer` and returns the request line.
        fn serve(&self, answer: &'static str) -> thread::JoinHandle<String> {
            let listener = UnixListener::bind(self.socket()).unwrap();
            thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
                let mut stream = stream;
                stream.write_all(answer.as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
                line
            })
        }

        fn cli(&self, args: &[&str]) -> Command {
            let mut c = cli_with(args);
            c.env("NEXTERM_CONTROL", self.socket()).env("NEXTERM_CONTROL_TOKEN", TOKEN);
            c
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700));
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn request(line: &str) -> serde_json::Value {
        assert!(line.ends_with('\n'), "{line:?}");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    const LIST: &str = r#"{"v":1,"id":1,"ok":true,"result":[{"id":"tab-term-1","title":"빌드","cwd":"/w","group":"Main","active":true,"agent":"opencode","status":null,"self":true,"child":false}]}"#;

    #[test]
    fn list_end_to_end_as_a_table_and_as_json() {
        let fake = Fake::new();
        let server = fake.serve(LIST);
        let o = run(fake.cli(&["list"]), b"");
        assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
        let out = text(&o.stdout);
        assert!(out.starts_with("   ID          ROLE"), "{out}");
        assert!(out.contains(" * tab-term-1  self  빌드"), "{out}");
        let req = request(&server.join().unwrap());
        assert_eq!(req, serde_json::json!({"v": 1, "id": 1, "token": TOKEN, "cmd": "list", "args": {}}));

        fs::remove_file(fake.socket()).unwrap();
        let server = fake.serve(LIST);
        let o = run(fake.cli(&["--json", "list"]), b"");
        assert_eq!(o.status.code(), Some(0));
        let printed: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(printed[0]["title"], "빌드");
        // Korean goes out as UTF-8 bytes when stdout is not a terminal.
        assert!(o.stdout.windows("빌드".len()).any(|w| w == "빌드".as_bytes()));
        server.join().unwrap();
        assert!(!text(&o.stdout).contains(TOKEN) && !text(&o.stderr).contains(TOKEN));
    }

    #[test]
    fn send_from_standard_input_end_to_end() {
        let fake = Fake::new();
        let server = fake.serve(r#"{"v":1,"id":1,"ok":true,"result":null}"#);
        // Standard input as it is, its final line break included: the page
        // presses that one as Enter.
        let o = run(fake.cli(&["send", "--to", "child:tab-term-4", "-", "--keys", "Tab"]), "echo 한글\n".as_bytes());
        assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
        assert!(o.stdout.is_empty());
        let req = request(&server.join().unwrap());
        assert_eq!(req["cmd"], "send");
        assert_eq!(req["args"], serde_json::json!({"target": "child:tab-term-4", "text": "echo 한글\n", "keys": ["Tab"]}));
    }

    #[test]
    fn new_split_prints_the_new_id() {
        let fake = Fake::new();
        let server = fake.serve(r#"{"v":1,"id":1,"ok":true,"result":{"id":"tab-term-8"}}"#);
        let o = run(fake.cli(&["new-split", "--down", "--cwd", "/", "--", "npm", "test"]), b"");
        assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
        assert_eq!(text(&o.stdout), "tab-term-8\n");
        let req = request(&server.join().unwrap());
        assert_eq!(req["args"], serde_json::json!({"direction": "down", "cwd": "/", "command": "npm test"}));
    }

    #[test]
    fn nexterm_errors_become_exit_codes() {
        for (code, want) in [("forbidden", 4), ("disabled", 4), ("not_responding", 5), ("rate_limited", 5), ("bad_request", 2)] {
            let fake = Fake::new();
            let answer: &'static str = Box::leak(
                format!(r#"{{"v":1,"id":1,"ok":false,"error":{{"code":"{code}","message":"said {code}"}}}}"#).into_boxed_str(),
            );
            let server = fake.serve(answer);
            let o = run(fake.cli(&["focus", "tab-term-2"]), b"");
            assert_eq!(o.status.code(), Some(want), "{code}: {}", text(&o.stderr));
            let hint = if want == 2 { "Run 'nexterm-cli help focus' for more.\n" } else { "" };
            assert_eq!(text(&o.stderr), format!("nexterm-cli: said {code} [{code}]\n{hint}"));
            server.join().unwrap();
        }
    }

    #[test]
    fn a_folder_others_can_enter_is_refused_and_nothing_is_sent() {
        let fake = Fake::new();
        let listener = UnixListener::bind(fake.socket()).unwrap();
        listener.set_nonblocking(true).unwrap();
        fs::set_permissions(&fake.dir, fs::Permissions::from_mode(0o777)).unwrap();
        let o = run(fake.cli(&["notify", "hi"]), b"");
        assert_eq!(o.status.code(), Some(4), "{}", text(&o.stderr));
        assert!(text(&o.stderr).contains("refusing to talk to NexTerm"), "{}", text(&o.stderr));
        assert!(!text(&o.stderr).contains(TOKEN));
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock, "it never connected");
    }

    #[test]
    fn nexterm_gone_is_exit_5() {
        let fake = Fake::new();
        let o = run(fake.cli(&["list"]), b"");
        assert_eq!(o.status.code(), Some(5), "{}", text(&o.stderr));
        // What a terminal sees after its control was turned off, too: the
        // socket is gone.
        assert_eq!(text(&o.stderr), format!("nexterm-cli: {NOT_RUNNING}\n"));
        // A socket left behind by a NexTerm that crashed.
        drop(UnixListener::bind(fake.socket()).unwrap());
        let o = run(fake.cli(&["list"]), b"");
        assert_eq!(o.status.code(), Some(5), "{}", text(&o.stderr));
        assert_eq!(text(&o.stderr), format!("nexterm-cli: {NOT_RUNNING}\n"));
    }

    #[test]
    fn a_silent_nexterm_is_exit_5_after_the_5_second_answer_timeout() {
        let fake = Fake::new();
        let listener = UnixListener::bind(fake.socket()).unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_secs(7));
            drop(s);
        });
        let started = Instant::now();
        let o = run(fake.cli(&["set-status", "Running", "tests"]), b"");
        let took = started.elapsed();
        assert_eq!(o.status.code(), Some(5), "{}", text(&o.stderr));
        assert!(text(&o.stderr).contains("not responding"), "{}", text(&o.stderr));
        assert!(took >= Duration::from_millis(4900) && took < Duration::from_millis(6500), "{took:?}");
        server.join().unwrap();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs::File;
    use std::io::{self, BufRead, BufReader};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn pipe_name() -> String {
        static N: AtomicUsize = AtomicUsize::new(0);
        format!(r"\\.\pipe\nexterm-e2e-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))
    }

    /// One pipe instance answering one request with `answer`.
    fn serve(name: &str, answer: &'static str) -> thread::JoinHandle<String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated; default security.
        let h = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                std::ptr::null(),
            )
        };
        assert!(h != INVALID_HANDLE_VALUE, "CreateNamedPipeW: {}", io::Error::last_os_error());
        // SAFETY: a fresh handle we own.
        let server = unsafe { File::from_raw_handle(h as RawHandle) };
        thread::spawn(move || {
            // SAFETY: a valid pipe handle, no OVERLAPPED.
            if unsafe { ConnectNamedPipe(server.as_raw_handle() as HANDLE, std::ptr::null_mut()) } == 0 {
                let e = io::Error::last_os_error();
                assert_eq!(e.raw_os_error(), Some(ERROR_PIPE_CONNECTED as i32), "{e}");
            }
            let mut line = String::new();
            BufReader::new(server.try_clone().unwrap()).read_line(&mut line).unwrap();
            let mut server = server;
            server.write_all(answer.as_bytes()).unwrap();
            server.write_all(b"\n").unwrap();
            // SAFETY: a valid pipe handle; waits until the client has read it.
            unsafe { FlushFileBuffers(server.as_raw_handle() as HANDLE) };
            line
        })
    }

    fn cli_at(name: &str, args: &[&str]) -> Command {
        let mut c = cli_with(args);
        c.env("NEXTERM_CONTROL", name).env("NEXTERM_CONTROL_TOKEN", TOKEN);
        c
    }

    #[test]
    fn list_end_to_end_through_a_real_pipe() {
        let name = pipe_name();
        let server = serve(
            &name,
            r#"{"v":1,"id":1,"ok":true,"result":[{"id":"tab-term-1","title":"빌드","cwd":"C:\\w","group":"Main","active":true,"agent":null,"status":null,"self":true,"child":false}]}"#,
        );
        let o = run(cli_at(&name, &["list"]), b"");
        assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
        let out = text(&o.stdout);
        assert!(out.contains(" * tab-term-1  self  빌드"), "{out}");
        let req: serde_json::Value = serde_json::from_str(server.join().unwrap().trim_end()).unwrap();
        assert_eq!(req, serde_json::json!({"v": 1, "id": 1, "token": TOKEN, "cmd": "list", "args": {}}));
    }

    #[test]
    fn korean_goes_to_a_redirected_stdout_as_utf8() {
        let name = pipe_name();
        let server = serve(&name, r#"{"v":1,"id":1,"ok":true,"result":{"lines":["안녕하세요"]}}"#);
        let o = run(cli_at(&name, &["read-screen"]), b"");
        assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
        assert_eq!(o.stdout, "안녕하세요\n".as_bytes());
        server.join().unwrap();
    }

    #[test]
    fn a_missing_pipe_is_exit_5_and_a_remote_one_exit_4() {
        let o = run(cli_at(&pipe_name(), &["list"]), b"");
        assert_eq!(o.status.code(), Some(5), "{}", text(&o.stderr));
        assert_eq!(text(&o.stderr), format!("nexterm-cli: {NOT_RUNNING}\n"));
        let o = run(cli_at(r"\\some-server\pipe\nexterm-00ff", &["list"]), b"");
        assert_eq!(o.status.code(), Some(4), "{}", text(&o.stderr));
    }
}
