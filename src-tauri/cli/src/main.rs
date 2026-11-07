//! `nexterm-cli`: lets a program running in a NexTerm terminal (an agent's
//! hook, a script) talk to the NexTerm that started it. Stage 7, D3/D4/D7 of
//! "NexTerm - 7단계 CLI와 로컬 제어 API 설계".
//!
//! NexTerm puts two variables into every shell it starts: `NEXTERM_CONTROL`,
//! where it listens (a Unix socket path, or a Windows pipe name), and
//! `NEXTERM_CONTROL_TOKEN`, which says which terminal is calling. This program
//! sends one JSON line there and prints the one line that comes back. Before
//! the token is written it makes sure the socket or pipe is this user's own
//! (transport/): another user who created the name first must not collect it.

mod args;
mod output;
mod protocol;
mod transport;
mod usage;

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::process::ExitCode;

use args::Parsed;
use protocol::Answer;
use transport::Link;

/// The exit codes, which scripts branch on (D7). Anything not listed is 1.
pub mod exit {
    pub const OK: u8 = 0;
    /// NexTerm said no for a reason not listed below, or its answer made no sense.
    pub const FAILED: u8 = 1;
    /// The command line was wrong — found here, or by NexTerm (`bad_request`);
    /// either way nothing was done.
    pub const USAGE: u8 = 2;
    /// No `NEXTERM_CONTROL` (or token): not running inside a NexTerm terminal.
    pub const NOT_INSIDE: u8 = 3;
    /// Refused, disabled, forbidden, unauthorized, not found — or the socket
    /// or pipe is not this user's, so the token was never sent.
    pub const REFUSED: u8 = 4;
    /// NexTerm is not running, its control is off (which closes the socket
    /// or pipe), it is busy (`rate_limited`), or it did not answer in time:
    /// worth trying again later.
    pub const NOT_RESPONDING: u8 = 5;
}

/// What the program reads from its environment, gathered once so `run` can
/// be tested without touching the process's own.
pub struct Env {
    pub control: Option<OsString>,
    pub token: Option<OsString>,
}

impl Env {
    fn from_process() -> Env {
        Env {
            control: std::env::var_os("NEXTERM_CONTROL"),
            token: std::env::var_os("NEXTERM_CONTROL_TOKEN"),
        }
    }
}

fn main() -> ExitCode {
    let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
    let env = Env::from_process();
    // A panic is a bug, but it must still end in one of the documented codes
    // rather than 101: "1 anything else". The default hook has printed it.
    let code = panic::catch_unwind(AssertUnwindSafe(|| {
        let stdin = io::stdin();
        let stdout = io::stdout();
        let stderr = io::stderr();
        // On Windows, std writes to a console with WriteConsoleW (UTF-16), so
        // Korean text comes out right in cmd and PowerShell whatever the
        // console's code page; written to a pipe or a file it stays UTF-8.
        // Nothing changes the console's code page, which would outlive us.
        run(&argv, &env, &mut stdin.lock(), &mut stdout.lock(), &mut stderr.lock(), &transport::Live)
    }))
    .unwrap_or(exit::FAILED);
    ExitCode::from(code)
}

/// The whole program, minus the process: parse, build the request, send it
/// through `link`, print the answer. Returns the exit code.
pub fn run(
    argv: &[OsString],
    env: &Env,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    err: &mut dyn Write,
    link: &dyn Link,
) -> u8 {
    // Write errors on stdout/stderr (a closed pipe) are ignored throughout:
    // the exit code still says what happened.
    let (json, command) = match args::parse(argv) {
        Ok(Parsed::Help(topic)) => {
            let _ = out.write_all(usage::help(topic).as_bytes());
            return exit::OK;
        }
        Ok(Parsed::Version) => {
            let _ = writeln!(out, "nexterm-cli {}", env!("CARGO_PKG_VERSION"));
            return exit::OK;
        }
        Ok(Parsed::Run { json, command }) => (json, command),
        Err(e) => {
            let _ = err.write_all(usage::usage_error(&e).as_bytes());
            return exit::USAGE;
        }
    };

    let Some(control) = env.control.as_ref().filter(|v| !v.is_empty()) else {
        let _ = writeln!(err, "nexterm-cli: Not inside a NexTerm terminal (NEXTERM_CONTROL is not set)");
        return exit::NOT_INSIDE;
    };
    let Some(token) = env.token.as_ref().filter(|v| !v.is_empty()) else {
        let _ = writeln!(err, "nexterm-cli: Not inside a NexTerm terminal (NEXTERM_CONTROL_TOKEN is not set)");
        return exit::NOT_INSIDE;
    };
    let Some(token) = token.to_str() else {
        let _ = writeln!(err, "nexterm-cli: NEXTERM_CONTROL_TOKEN is not a NexTerm token");
        return exit::NOT_INSIDE;
    };
    let address = match transport::parse_address(control) {
        Ok(a) => a,
        Err(f) => return fail(err, &f),
    };

    // Standard input is read before connecting, so a slow writer never holds
    // a connection open against NexTerm's per-line timeout.
    let request = match protocol::build(&command, stdin) {
        Ok(r) => r,
        Err(e) => {
            let _ = err.write_all(usage::usage_error(&e).as_bytes());
            return exit::USAGE;
        }
    };
    let line = match protocol::encode(token, &request) {
        Ok(l) => l,
        Err(e) => {
            let _ = err.write_all(usage::usage_error(&e).as_bytes());
            return exit::USAGE;
        }
    };

    let answer = match link.exchange(&address, line.as_bytes()) {
        Ok(a) => a,
        Err(f) => return fail(err, &f),
    };
    match protocol::decode(&answer) {
        Ok(Answer::Done(result)) => {
            let text = if json { output::json(&result) } else { output::human(&command, &result) };
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
            exit::OK
        }
        Ok(Answer::Failed { code, message }) => {
            let message = output::one_line(&message);
            let _ = match code.as_deref() {
                Some(c) => writeln!(err, "nexterm-cli: {message} [{}]", output::one_line(c)),
                None => writeln!(err, "nexterm-cli: {message}"),
            };
            let exit_code = protocol::exit_code_for(code.as_deref().unwrap_or(""));
            if exit_code == exit::USAGE {
                // As after a usage error caught here: where to read up.
                let _ = writeln!(err, "Run 'nexterm-cli help {}' for more.", request.cmd);
            }
            exit_code
        }
        Err(problem) => {
            let _ = writeln!(err, "nexterm-cli: {problem}");
            exit::FAILED
        }
    }
}

fn fail(err: &mut dyn Write, f: &transport::Failure) -> u8 {
    let _ = writeln!(err, "nexterm-cli: {}", output::one_line(&f.message));
    f.kind.exit_code()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{Address, Failure, FailureKind};
    use std::cell::RefCell;

    const TOKEN: &str = "tok_abcDEF123-_";

    /// Answers every request with `answer` and remembers what it was sent.
    struct FakeLink {
        answer: Result<String, (FailureKind, &'static str)>,
        sent: RefCell<Vec<(String, String)>>,
    }

    impl FakeLink {
        fn answering(line: &str) -> FakeLink {
            FakeLink { answer: Ok(line.to_owned()), sent: RefCell::new(Vec::new()) }
        }
        fn failing(kind: FailureKind, message: &'static str) -> FakeLink {
            FakeLink { answer: Err((kind, message)), sent: RefCell::new(Vec::new()) }
        }
        fn request(&self) -> serde_json::Value {
            let sent = self.sent.borrow();
            assert_eq!(sent.len(), 1, "exactly one request");
            let line = &sent[0].1;
            assert!(line.ends_with('\n'), "one line, LF-terminated");
            assert_eq!(line.matches('\n').count(), 1, "exactly one line");
            serde_json::from_str(line.trim_end()).unwrap()
        }
    }

    impl Link for FakeLink {
        fn exchange(&self, address: &Address, request: &[u8]) -> Result<Vec<u8>, Failure> {
            self.sent
                .borrow_mut()
                .push((address.as_str().to_owned(), String::from_utf8(request.to_vec()).unwrap()));
            match &self.answer {
                Ok(line) => Ok(line.as_bytes().to_vec()),
                Err((kind, message)) => Err(Failure { kind: *kind, message: (*message).to_owned() }),
            }
        }
    }

    fn address() -> &'static str {
        if cfg!(windows) {
            r"\\.\pipe\nexterm-0123456789abcdef0123456789abcdef"
        } else {
            "/run/user/1000/nexterm/1.sock"
        }
    }

    fn inside() -> Env {
        Env { control: Some(address().into()), token: Some(TOKEN.into()) }
    }

    struct Outcome {
        code: u8,
        out: String,
        err: String,
    }

    fn run_with(args: &[&str], env: &Env, stdin: &str, link: &FakeLink) -> Outcome {
        let argv: Vec<OsString> = args.iter().map(OsString::from).collect();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&argv, env, &mut stdin.as_bytes(), &mut out, &mut err, link);
        Outcome { code, out: String::from_utf8(out).unwrap(), err: String::from_utf8(err).unwrap() }
    }

    const OK_NULL: &str = r#"{"v":1,"id":1,"ok":true,"result":null}"#;

    #[test]
    fn outside_nexterm_is_exit_3_with_the_message_and_nothing_is_sent() {
        let link = FakeLink::answering(OK_NULL);
        let none = Env { control: None, token: Some(TOKEN.into()) };
        let o = run_with(&["notify", "hi"], &none, "", &link);
        assert_eq!(o.code, 3);
        assert_eq!(o.err, "nexterm-cli: Not inside a NexTerm terminal (NEXTERM_CONTROL is not set)\n");
        assert!(o.out.is_empty());
        let empty = Env { control: Some("".into()), token: Some(TOKEN.into()) };
        assert_eq!(run_with(&["list"], &empty, "", &link).code, 3);
        let no_token = Env { control: Some(address().into()), token: None };
        let o = run_with(&["list"], &no_token, "", &link);
        assert_eq!(o.code, 3);
        assert!(o.err.contains("NEXTERM_CONTROL_TOKEN is not set"), "{}", o.err);
        assert!(link.sent.borrow().is_empty());
    }

    #[test]
    fn usage_errors_are_exit_2_before_the_environment_is_looked_at() {
        let link = FakeLink::answering(OK_NULL);
        let none = Env { control: None, token: None };
        for args in [
            &["bogus"][..],
            &[],
            &["notify"],
            &["set-progress", "101"],
            &["read-screen", "--lines", "2001"],
            &["send"],
            &["list", "extra"],
            &["--frobnicate", "list"],
        ] {
            let o = run_with(args, &none, "", &link);
            assert_eq!(o.code, 2, "{args:?}: {}", o.err);
            assert!(o.err.starts_with("nexterm-cli: "), "{args:?}: {}", o.err);
            assert!(o.out.is_empty());
        }
        assert!(link.sent.borrow().is_empty());
    }

    #[test]
    fn help_and_version_work_anywhere() {
        let link = FakeLink::answering(OK_NULL);
        let none = Env { control: None, token: None };
        let o = run_with(&["--version"], &none, "", &link);
        assert_eq!((o.code, o.out.as_str()), (0, concat!("nexterm-cli ", env!("CARGO_PKG_VERSION"), "\n")));
        let o = run_with(&["help"], &none, "", &link);
        assert_eq!(o.code, 0);
        assert!(o.out.starts_with("nexterm-cli - control NexTerm"), "{}", o.out);
        let o = run_with(&["send", "--help"], &none, "", &link);
        assert_eq!(o.code, 0);
        assert!(o.out.starts_with("Usage: nexterm-cli send"), "{}", o.out);
        assert!(link.sent.borrow().is_empty());
    }

    #[test]
    fn the_request_is_one_json_line_with_the_token() {
        let link = FakeLink::answering(OK_NULL);
        let o = run_with(&["notify", "Done", "All tests pass", "--occasion", "unfocused"], &inside(), "", &link);
        assert_eq!(o.code, 0, "{}", o.err);
        assert!(o.out.is_empty(), "notify prints nothing: {:?}", o.out);
        assert_eq!(link.sent.borrow()[0].0, address());
        let req = link.request();
        assert_eq!(
            req,
            serde_json::json!({
                "v": 1, "id": 1, "token": TOKEN, "cmd": "notify",
                "args": { "title": "Done", "body": "All tests pass", "occasion": "unfocused" }
            })
        );
        // The documented order, for anyone reading the wire.
        let line = &link.sent.borrow()[0].1;
        assert!(line.starts_with(r#"{"v":1,"id":1,"token":"#), "{line}");
    }

    #[test]
    fn send_reads_standard_input_for_a_dash() {
        let link = FakeLink::answering(OK_NULL);
        let o = run_with(&["send", "--to", "child:tab-term-7", "-", "--keys", "Enter"], &inside(), "make test\n", &link);
        assert_eq!(o.code, 0, "{}", o.err);
        let req = link.request();
        assert_eq!(req["args"], serde_json::json!({ "target": "child:tab-term-7", "text": "make test\n", "keys": ["Enter"] }));
    }

    #[test]
    fn standard_input_over_16_kib_is_a_usage_error_and_nothing_is_sent() {
        let link = FakeLink::answering(OK_NULL);
        let big = "x".repeat(16 * 1024 + 1);
        let o = run_with(&["send", "-"], &inside(), &big, &link);
        assert_eq!(o.code, 2, "{}", o.err);
        assert!(o.err.contains("16384"), "{}", o.err);
        assert!(link.sent.borrow().is_empty());
        let exact = "x".repeat(16 * 1024);
        assert_eq!(run_with(&["send", "-"], &inside(), &exact, &link).code, 0);
    }

    #[test]
    fn an_oversized_request_is_not_sent() {
        let link = FakeLink::answering(OK_NULL);
        let title = "t".repeat(70 * 1024);
        let o = run_with(&["notify", &title], &inside(), "", &link);
        assert_eq!(o.code, 2, "{}", o.err);
        assert!(o.err.contains("65536"), "{}", o.err);
        assert!(link.sent.borrow().is_empty());
    }

    #[test]
    fn every_error_code_maps_to_its_exit_code_through_run() {
        let cases = [
            ("bad_request", 2),
            ("unknown_command", 1),
            ("unauthorized", 4),
            ("disabled", 4),
            ("forbidden", 4),
            ("not_found", 4),
            ("refused", 4),
            ("rate_limited", 5),
            ("not_rendered", 1),
            ("not_responding", 5),
            ("too_large", 1),
            ("internal", 1),
            ("something_new", 1),
        ];
        for (code, want) in cases {
            let line = format!(r#"{{"v":1,"id":1,"ok":false,"error":{{"code":"{code}","message":"no, because {code}"}}}}"#);
            let link = FakeLink::answering(&line);
            let o = run_with(&["focus"], &inside(), "", &link);
            assert_eq!(o.code, want, "{code}");
            let hint = if code == "bad_request" { "Run 'nexterm-cli help focus' for more.\n" } else { "" };
            assert_eq!(o.err, format!("nexterm-cli: no, because {code} [{code}]\n{hint}"));
            assert!(o.out.is_empty());
        }
    }

    #[test]
    fn the_connection_cap_is_busy_exit_5_and_a_bad_request_is_usage_exit_2() {
        // As server.rs answers a 17th connection: no id, it never read a request.
        let cap = r#"{"v":1,"id":null,"ok":false,"error":{"code":"rate_limited","message":"NexTerm is already serving 16 connections; try again in a moment"}}"#;
        let o = run_with(&["set-status", "Running"], &inside(), "", &FakeLink::answering(cap));
        assert_eq!(o.code, 5, "{}", o.err);
        assert!(o.err.contains("try again in a moment [rate_limited]"), "{}", o.err);
        // `ls` taken for a key: NexTerm did nothing, as with a usage error here.
        let bad = r#"{"v":1,"id":1,"ok":false,"error":{"code":"bad_request","message":"unknown key \"ls\""}}"#;
        let o = run_with(&["send", "--keys", "Enter", "ls"], &inside(), "", &FakeLink::answering(bad));
        assert_eq!(o.code, 2, "{}", o.err);
        assert_eq!(o.err, "nexterm-cli: unknown key \"ls\" [bad_request]\nRun 'nexterm-cli help send' for more.\n");
    }

    #[test]
    fn transport_failures_map_to_their_exit_codes() {
        for (kind, want) in [
            (FailureKind::Refused, 4),
            (FailureKind::Unreachable, 5),
            (FailureKind::NotResponding, 5),
            (FailureKind::BadAnswer, 1),
        ] {
            let link = FakeLink::failing(kind, "it went wrong");
            let o = run_with(&["list"], &inside(), "", &link);
            assert_eq!(o.code, want, "{kind:?}");
            assert_eq!(o.err, "nexterm-cli: it went wrong\n");
        }
    }

    #[test]
    fn an_answer_that_makes_no_sense_is_exit_1() {
        for line in ["not json", "[1,2]", r#"{"v":2,"id":1,"ok":true}"#, r#"{"v":1,"id":9,"ok":true}"#, r#"{"v":1,"id":1}"#] {
            let link = FakeLink::answering(line);
            let o = run_with(&["list"], &inside(), "", &link);
            assert_eq!(o.code, 1, "{line}: {}", o.err);
        }
    }

    #[test]
    fn json_prints_the_raw_result_and_human_output_a_table() {
        let line = r#"{"v":1,"id":1,"ok":true,"result":[{"id":"tab-term-1","title":"zsh","cwd":"/w","group":"Main","active":true,"agent":null,"status":null,"self":true,"child":false}]}"#;
        let link = FakeLink::answering(line);
        let o = run_with(&["--json", "list"], &inside(), "", &link);
        assert_eq!(o.code, 0);
        let printed: serde_json::Value = serde_json::from_str(o.out.trim_end()).unwrap();
        let sent: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(printed, sent["result"]);
        let link = FakeLink::answering(line);
        let o = run_with(&["list"], &inside(), "", &link);
        assert_eq!(o.code, 0);
        assert!(o.out.starts_with("   ID"), "{}", o.out);
        assert!(o.out.contains("* tab-term-1  self"), "{}", o.out);
        // --json after the command means the same.
        let link = FakeLink::answering(line);
        let o = run_with(&["list", "--json"], &inside(), "", &link);
        assert!(o.out.starts_with('['), "{}", o.out);
    }

    #[test]
    fn a_server_message_cannot_write_escape_sequences_to_the_terminal() {
        let link = FakeLink::answering(r#"{"v":1,"id":1,"ok":false,"error":{"code":"refused","message":"no\u001b]0;pwned\u0007 way\nreally"}}"#);
        let o = run_with(&["focus"], &inside(), "", &link);
        assert_eq!(o.code, 4);
        assert!(!o.err.contains('\u{1b}') && !o.err.contains('\u{7}'), "{:?}", o.err);
        assert_eq!(o.err.matches('\n').count(), 1, "one line: {:?}", o.err);
    }

    #[test]
    fn a_bad_address_is_refused_before_anything_is_sent() {
        let link = FakeLink::answering(OK_NULL);
        let env = Env {
            control: Some(if cfg!(windows) { r"\\evil-host\pipe\nexterm-1" } else { "relative.sock" }.into()),
            token: Some(TOKEN.into()),
        };
        let o = run_with(&["list"], &env, "", &link);
        assert_eq!(o.code, 4, "{}", o.err);
        assert!(link.sent.borrow().is_empty());
    }
}
