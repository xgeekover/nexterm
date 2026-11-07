//! The wire (D3): one JSON object per line each way.
//!
//! Request: `{"v":1,"id":n,"token":"…","cmd":"…","args":{…}}`.
//! Answer:  `{"v":1,"id":n,"ok":true,"result":…}` or
//!          `{"ok":false,"error":{"code":"…","message":"…"}}`.
//!
//! `args` holds exactly the keys the command names (the page refuses any
//! other key as `bad_request`, src/lib/controlScope.js), and an optional one
//! is left out rather than sent empty.

use std::io::Read;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::args::{Command, Text, UsageError};
use crate::exit;

pub const VERSION: u64 = 1;
/// One request per connection, so one id.
pub const REQUEST_ID: u64 = 1;
/// A request line at most, its LF included (D3: 64 KiB).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// An answer line at most, its LF not included (D3: 1 MiB).
pub const MAX_ANSWER_BYTES: usize = 1024 * 1024;
/// `send`'s text at most, in UTF-8 bytes (D3: 16 KiB; the page counts the same).
pub const MAX_TEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq)]
pub struct Request {
    pub cmd: &'static str,
    pub args: Value,
}

/// The request for `command`. `stdin` is read only for `send -`.
pub fn build(command: &Command, stdin: &mut dyn Read) -> Result<Request, UsageError> {
    let mut args = Map::new();
    let mut put = |key: &str, value: Value| {
        args.insert(key.to_owned(), value);
    };
    let cmd = match command {
        Command::Notify { title, body, occasion } => {
            put("title", json!(title));
            if let Some(b) = body {
                put("body", json!(b));
            }
            if let Some(o) = occasion {
                put("occasion", json!(o));
            }
            "notify"
        }
        Command::SetStatus { text, tone } => {
            // `null` clears: the key is always there (D4 `{text | null}`).
            put("text", text.as_ref().map_or(Value::Null, |t| json!(t)));
            if let Some(t) = tone {
                put("tone", json!(t));
            }
            "set-status"
        }
        Command::SetProgress { state, value } => {
            put("state", json!(state));
            if let Some(v) = value {
                put("value", json!(v));
            }
            "set-progress"
        }
        Command::List => "list",
        Command::NewSplit { direction, cwd, command } => {
            if let Some(d) = direction {
                put("direction", json!(d));
            }
            if let Some(dir) = cwd {
                put("cwd", json!(absolute(dir)?));
            }
            if let Some(c) = command {
                put("command", json!(c));
            }
            "new-split"
        }
        Command::Send { target, text, keys, raw } => {
            put("target", json!(target));
            match text {
                Some(Text::Given(t)) => put("text", json!(checked_text(t.clone(), "TEXT")?)),
                Some(Text::Stdin) => put("text", json!(read_text(stdin)?)),
                None => {}
            }
            if !keys.is_empty() {
                put("keys", json!(keys));
            }
            if *raw {
                put("raw", json!(true));
            }
            "send"
        }
        Command::ReadScreen { target, lines, mask } => {
            put("target", json!(target));
            if let Some(n) = lines {
                put("lines", json!(n));
            }
            if !*mask {
                put("mask", json!(false));
            }
            "read-screen"
        }
        Command::Focus { target } => {
            put("target", json!(target));
            "focus"
        }
    };
    Ok(Request { cmd, args: Value::Object(args) })
}

/// A folder relative to where the caller is, made absolute here: NexTerm's
/// own working folder is not the caller's.
fn absolute(dir: &str) -> Result<String, UsageError> {
    if cfg!(windows) {
        let here = std::env::current_dir().ok();
        if let Some(why) = not_a_windows_folder(dir, here.as_deref().and_then(Path::to_str)) {
            return Err(UsageError::of("new-split", why));
        }
    }
    let path = std::path::absolute(Path::new(dir))
        .map_err(|e| UsageError::of("new-split", format!("--cwd {dir}: {e}")))?;
    path.into_os_string()
        .into_string()
        .map_err(|_| UsageError::of("new-split", "--cwd is not valid text (UTF-8)"))
}

/// What follows "--cwd DIR" when a caller in WSL gave a Linux folder.
const FROM_WSL: &str = "from WSL, --cwd takes a Windows path (C:\\...), or leave it out";

/// On Windows, a `--cwd` that std::path::absolute would quietly turn into
/// another folder — what a caller in WSL (running nexterm-cli.exe through
/// interop) types. Two tells, both cheap and both certain:
/// - one leading `/` (`/home/me`): a Linux path, which Windows reads as the
///   root of the current drive, `C:\home\me`;
/// - a relative folder while the caller's own folder is inside WSL
///   (`\\wsl.localhost\…`, `\\wsl$\…`): it would become a network path,
///   which new-split refuses anyway, with a less useful message.
///
/// `//server/share` (a network path) and `\work` are left to NexTerm.
pub fn not_a_windows_folder(dir: &str, here: Option<&str>) -> Option<String> {
    if dir.starts_with('/') && !dir.starts_with("//") {
        return Some(format!("--cwd {dir} is not a Windows path; {FROM_WSL}"));
    }
    let b = dir.as_bytes();
    let rooted = dir.starts_with(['/', '\\']) || (b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic());
    let in_wsl = here.is_some_and(|h| {
        let h = h.to_ascii_lowercase();
        h.starts_with("\\\\wsl.localhost\\") || h.starts_with("\\\\wsl$\\")
    });
    if !rooted && in_wsl {
        return Some(format!("--cwd {dir} is relative to a folder inside WSL; {FROM_WSL}"));
    }
    None
}

fn checked_text(text: String, what: &str) -> Result<String, UsageError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(UsageError::of(
            "send",
            format!("{what} is {} bytes; send takes at most {MAX_TEXT_BYTES}", text.len()),
        ));
    }
    Ok(text)
}

/// `send -`: standard input, exactly as it is (a final newline included),
/// up to MAX_TEXT_BYTES.
fn read_text(stdin: &mut dyn Read) -> Result<String, UsageError> {
    let mut bytes = Vec::new();
    stdin
        .take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| UsageError::of("send", format!("cannot read standard input: {e}")))?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(UsageError::of(
            "send",
            format!("standard input is longer than {MAX_TEXT_BYTES} bytes, the most send takes"),
        ));
    }
    if bytes.is_empty() {
        return Err(UsageError::of("send", "standard input was empty"));
    }
    let text = String::from_utf8(bytes).map_err(|_| UsageError::of("send", "standard input is not valid text (UTF-8)"))?;
    checked_text(text, "standard input")
}

/// The request line, LF-terminated, or a usage error when it is too large to send.
pub fn encode(token: &str, request: &Request) -> Result<String, UsageError> {
    let line = format!(
        "{{\"v\":{VERSION},\"id\":{REQUEST_ID},\"token\":{},\"cmd\":{},\"args\":{}}}\n",
        Value::from(token),
        Value::from(request.cmd),
        request.args
    );
    if line.len() > MAX_REQUEST_BYTES {
        return Err(UsageError::of(
            request.cmd,
            format!("the request is {} bytes; NexTerm takes at most {MAX_REQUEST_BYTES}", line.len()),
        ));
    }
    Ok(line)
}

#[derive(Debug, PartialEq)]
pub enum Answer {
    Done(Value),
    Failed { code: Option<String>, message: String },
}

/// The answer line (without its LF). An `Err` is an answer this CLI cannot
/// read: another protocol version, another request's id, not JSON.
pub fn decode(line: &[u8]) -> Result<Answer, String> {
    let text = std::str::from_utf8(line).map_err(|_| "NexTerm's answer is not valid UTF-8".to_owned())?;
    let value: Value = serde_json::from_str(text.trim_end_matches('\r'))
        .map_err(|_| "NexTerm's answer is not JSON".to_owned())?;
    let Some(obj) = value.as_object() else {
        return Err("NexTerm's answer is not a JSON object".to_owned());
    };
    // An error about a line NexTerm could not read may come without them.
    if let Some(v) = obj.get("v") {
        if v.as_u64() != Some(VERSION) {
            return Err(format!("NexTerm answered in protocol version {v}; this nexterm-cli speaks version {VERSION}"));
        }
    }
    if let Some(id) = obj.get("id") {
        if !id.is_null() && id.as_u64() != Some(REQUEST_ID) {
            return Err(format!("NexTerm answered request {id}, not {REQUEST_ID}"));
        }
    }
    match obj.get("ok") {
        Some(Value::Bool(true)) => Ok(Answer::Done(obj.get("result").cloned().unwrap_or(Value::Null))),
        Some(Value::Bool(false)) => {
            let error = obj.get("error");
            let code = error.and_then(|e| e.get("code")).and_then(Value::as_str).map(str::to_owned);
            let message = error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_owned)
                .or_else(|| code.clone())
                .unwrap_or_else(|| "NexTerm refused without saying why".to_owned());
            Ok(Answer::Failed { code, message })
        }
        _ => Err("NexTerm's answer says neither ok nor not ok".to_owned()),
    }
}

/// D7's exit codes for NexTerm's error codes (D3):
/// - 2 for `bad_request`: NexTerm read the command line differently from
///   what was meant (`send --keys Enter ls` takes `ls` for a key) and did
///   nothing — a usage error, as one caught here would be;
/// - 4 for "no": not allowed, no such terminal;
/// - 5 for "not now": not responding, or `rate_limited` — the connection cap
///   ("already serving 16 connections"), the queue to the page, or this
///   terminal's own limits; each says to try again in a moment;
/// - 1 for everything else, a code added later included.
pub fn exit_code_for(code: &str) -> u8 {
    match code {
        "bad_request" => exit::USAGE,
        "unauthorized" | "disabled" | "forbidden" | "not_found" | "refused" => exit::REFUSED,
        "not_responding" | "rate_limited" => exit::NOT_RESPONDING,
        _ => exit::FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::Command;

    fn args_of(command: Command) -> (String, Value) {
        let r = build(&command, &mut std::io::empty()).unwrap();
        (r.cmd.to_owned(), r.args)
    }

    #[test]
    fn each_command_sends_exactly_its_keys() {
        let cases: Vec<(Command, &str, Value)> = vec![
            (Command::Notify { title: "T".into(), body: None, occasion: None }, "notify", json!({"title": "T"})),
            (
                Command::Notify { title: "T".into(), body: Some("B".into()), occasion: Some("unfocused") },
                "notify",
                json!({"title": "T", "body": "B", "occasion": "unfocused"}),
            ),
            (Command::SetStatus { text: Some("Running".into()), tone: None }, "set-status", json!({"text": "Running"})),
            (
                Command::SetStatus { text: Some("Slow".into()), tone: Some("warn") },
                "set-status",
                json!({"text": "Slow", "tone": "warn"}),
            ),
            (Command::SetStatus { text: None, tone: None }, "set-status", json!({"text": null})),
            (Command::SetProgress { state: "normal", value: Some(40) }, "set-progress", json!({"state": "normal", "value": 40})),
            (Command::SetProgress { state: "indeterminate", value: None }, "set-progress", json!({"state": "indeterminate"})),
            (Command::SetProgress { state: "error", value: Some(3) }, "set-progress", json!({"state": "error", "value": 3})),
            (Command::SetProgress { state: "remove", value: None }, "set-progress", json!({"state": "remove"})),
            (Command::List, "list", json!({})),
            (Command::NewSplit { direction: None, cwd: None, command: None }, "new-split", json!({})),
            (
                Command::NewSplit { direction: Some("down"), cwd: None, command: Some("npm test".into()) },
                "new-split",
                json!({"direction": "down", "command": "npm test"}),
            ),
            (
                Command::Send { target: "self".into(), text: Some(Text::Given("ls".into())), keys: vec![], raw: false },
                "send",
                json!({"target": "self", "text": "ls"}),
            ),
            (
                Command::Send { target: "tab-term-2".into(), text: None, keys: vec!["Ctrl+C".into(), "Up".into()], raw: true },
                "send",
                json!({"target": "tab-term-2", "keys": ["Ctrl+C", "Up"], "raw": true}),
            ),
            (Command::ReadScreen { target: "self".into(), lines: None, mask: true }, "read-screen", json!({"target": "self"})),
            (
                Command::ReadScreen { target: "child:tab-term-3".into(), lines: Some(0), mask: false },
                "read-screen",
                json!({"target": "child:tab-term-3", "lines": 0, "mask": false}),
            ),
            (Command::Focus { target: "self".into() }, "focus", json!({"target": "self"})),
        ];
        for (command, want_cmd, want_args) in cases {
            let label = format!("{command:?}");
            let (cmd, args) = args_of(command);
            assert_eq!((cmd.as_str(), &args), (want_cmd, &want_args), "{label}");
        }
    }

    #[test]
    fn new_split_cwd_is_made_absolute_from_where_the_caller_is() {
        let (_, args) = args_of(Command::NewSplit { direction: None, cwd: Some("sub/dir".into()), command: None });
        let sent = std::path::PathBuf::from(args["cwd"].as_str().unwrap());
        assert!(sent.is_absolute(), "{sent:?}");
        assert!(sent.starts_with(std::env::current_dir().unwrap()), "{sent:?}");
        assert!(sent.ends_with(Path::new("sub").join("dir")), "{sent:?}");
        let here = std::env::current_dir().unwrap().to_str().unwrap().to_owned();
        let (_, args) = args_of(Command::NewSplit { direction: None, cwd: Some(here.clone()), command: None });
        assert_eq!(args["cwd"], json!(here));
    }

    #[test]
    fn from_wsl_a_linux_cwd_is_refused_on_windows() {
        let wsl = Some(r"\\wsl.localhost\Ubuntu\home\me");
        let old_wsl = Some(r"\\WSL$\Ubuntu\home\me");
        let win = Some(r"C:\Users\me");
        for (dir, here) in [("/home/me", win), ("/", win), ("/home/me", wsl), ("/mnt/c/work", None)] {
            let why = not_a_windows_folder(dir, here).unwrap_or_else(|| panic!("{dir} from {here:?}"));
            assert!(why.contains("is not a Windows path"), "{why}");
            assert!(why.ends_with(r"from WSL, --cwd takes a Windows path (C:\...), or leave it out"), "{why}");
        }
        for (dir, here) in [("sub", wsl), ("../web", old_wsl)] {
            let why = not_a_windows_folder(dir, here).unwrap_or_else(|| panic!("{dir} from {here:?}"));
            assert!(why.contains("is relative to a folder inside WSL"), "{why}");
        }
        for (dir, here) in [
            (r"C:\work", wsl),
            ("C:/work", wsl),
            (r"\work", wsl),
            ("D:sub", wsl),
            ("//server/share", win),
            (r"\\server\share", wsl),
            ("sub", win),
            ("sub", None),
            ("sub", Some(r"\\wsl-backup\share")),
        ] {
            assert_eq!(not_a_windows_folder(dir, here), None, "{dir} from {here:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_new_split_refuses_a_linux_cwd() {
        let split = Command::NewSplit { direction: None, cwd: Some("/home/me".into()), command: None };
        let e = build(&split, &mut std::io::empty()).unwrap_err();
        assert!(e.message.contains("from WSL, --cwd takes a Windows path"), "{}", e.message);
    }

    #[test]
    fn text_is_capped_at_16_kib_of_utf8() {
        let send = |t: String| Command::Send { target: "self".into(), text: Some(Text::Given(t)), keys: vec![], raw: false };
        // 5462 Hangul syllables are 16386 bytes: over, though fewer than 16384 characters.
        let korean = "가".repeat(5462);
        assert!(korean.chars().count() < MAX_TEXT_BYTES && korean.len() > MAX_TEXT_BYTES);
        assert!(build(&send(korean), &mut std::io::empty()).unwrap_err().message.contains("16384"));
        assert!(build(&send("가".repeat(5461)), &mut std::io::empty()).is_ok());
    }

    #[test]
    fn standard_input_is_sent_as_is_and_checked() {
        let send = Command::Send { target: "self".into(), text: Some(Text::Stdin), keys: vec![], raw: false };
        let r = build(&send, &mut "line one\r\nline two\n".as_bytes()).unwrap();
        assert_eq!(r.args["text"], json!("line one\r\nline two\n"));
        assert!(build(&send, &mut std::io::empty()).unwrap_err().message.contains("empty"));
        assert!(build(&send, &mut &[0xffu8, 0xfe][..]).unwrap_err().message.contains("UTF-8"));
        let r = build(&send, &mut "한글 입력".as_bytes()).unwrap();
        assert_eq!(r.args["text"], json!("한글 입력"));
    }

    #[test]
    fn the_request_line_is_one_line_in_the_documented_shape() {
        let r = Request { cmd: "notify", args: json!({"title": "a\nb \"q\""}) };
        let line = encode("tok", &r).unwrap();
        assert_eq!(line, "{\"v\":1,\"id\":1,\"token\":\"tok\",\"cmd\":\"notify\",\"args\":{\"title\":\"a\\nb \\\"q\\\"\"}}\n");
        let back: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(back, json!({"v": 1, "id": 1, "token": "tok", "cmd": "notify", "args": {"title": "a\nb \"q\""}}));
    }

    #[test]
    fn the_request_is_capped_at_64_kib_with_its_newline() {
        let overhead = encode("tok", &Request { cmd: "notify", args: json!({"title": ""}) }).unwrap().len();
        let fits = Request { cmd: "notify", args: json!({"title": "x".repeat(MAX_REQUEST_BYTES - overhead)}) };
        assert_eq!(encode("tok", &fits).unwrap().len(), MAX_REQUEST_BYTES);
        let over = Request { cmd: "notify", args: json!({"title": "x".repeat(MAX_REQUEST_BYTES - overhead + 1)}) };
        assert!(encode("tok", &over).unwrap_err().message.contains("65536"));
    }

    #[test]
    fn decoding_answers() {
        assert_eq!(decode(br#"{"v":1,"id":1,"ok":true,"result":{"id":"tab-term-2"}}"#), Ok(Answer::Done(json!({"id": "tab-term-2"}))));
        assert_eq!(decode(br#"{"v":1,"id":1,"ok":true}"#), Ok(Answer::Done(Value::Null)));
        assert_eq!(decode(b"{\"v\":1,\"id\":1,\"ok\":true,\"result\":[]}\r"), Ok(Answer::Done(json!([]))));
        assert_eq!(
            decode(br#"{"v":1,"id":1,"ok":false,"error":{"code":"disabled","message":"typing is off"}}"#),
            Ok(Answer::Failed { code: Some("disabled".into()), message: "typing is off".into() })
        );
        // An error about an unreadable line has no v or id.
        assert_eq!(
            decode(br#"{"ok":false,"error":{"code":"bad_request","message":"not JSON"}}"#),
            Ok(Answer::Failed { code: Some("bad_request".into()), message: "not JSON".into() })
        );
        assert_eq!(
            decode(br#"{"v":1,"id":null,"ok":false,"error":{"code":"too_large"}}"#),
            Ok(Answer::Failed { code: Some("too_large".into()), message: "too_large".into() })
        );
        assert!(matches!(decode(br#"{"ok":false}"#), Ok(Answer::Failed { code: None, .. })));
        for wrong in [
            &b"not json"[..],
            b"",
            b"[]",
            b"\"ok\"",
            br#"{"v":2,"id":1,"ok":true}"#,
            br#"{"v":"1","id":1,"ok":true}"#,
            br#"{"v":1,"id":2,"ok":true}"#,
            br#"{"v":1,"id":1,"ok":"yes"}"#,
            br#"{"v":1,"id":1}"#,
            &[0xff, 0xfe],
        ] {
            assert!(decode(wrong).is_err(), "{:?}", String::from_utf8_lossy(wrong));
        }
    }

    #[test]
    fn error_codes_to_exit_codes() {
        let all = [
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
            ("", 1),
            ("Forbidden", 1),
            ("Bad_Request", 1),
        ];
        for (code, want) in all {
            assert_eq!(exit_code_for(code), want, "{code}");
        }
    }

    #[test]
    fn caps_are_the_specs() {
        assert_eq!(MAX_REQUEST_BYTES, 65536);
        assert_eq!(MAX_ANSWER_BYTES, 1048576);
        assert_eq!(MAX_TEXT_BYTES, 16384);
        assert_eq!(VERSION, 1);
    }
}
