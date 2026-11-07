//! The wire format: one JSON object per line, UTF-8, ended by LF.
//!
//! A request is `{"v":1,"id":<u64>,"token":"…","cmd":"…","args":{…}}`, and
//! nothing else: a key outside those five is `bad_request`, so a typo (or a
//! caller hoping to name its own session) is never quietly ignored. `args`
//! may be left out or `null`, and is then `{}`.
//!
//! An answer is `{"v":1,"id":…,"ok":true,"result":…}` or
//! `{"v":1,"id":…,"ok":false,"error":{"code":"…","message":"…"}}`. The id is
//! the request's own, or `null` when the request could not be read far
//! enough to find one.
//!
//! What is checked here is only the shape. Whether the token is good, the
//! command known, the caller within its limits, is the server's
//! (`server::dispatch`), in an order that tells nobody without a token which
//! commands exist.
//!
//! serde_json does the parsing, and is what keeps a hostile line harmless: it
//! refuses invalid UTF-8, a lone surrogate (`"\ud800"`), and nesting deeper
//! than 128 (a line of `[[[[…` is an error, not a stack overflow). The
//! arguments the page is handed are re-serialised from the same parsed
//! value, so the page can never read a request differently from how it was
//! checked here.

use serde::Serialize;
use serde_json::{Map, Value};

/// The protocol's version: the only `v` accepted.
pub const VERSION: u64 = 1;

/// The longest request line, its LF not counted: 64 KiB.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// The longest answer line, its LF counted: 1 MiB. A larger result (a
/// `read-screen` of 2000 very long lines) is answered `too_large` instead.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// The most text one `send` may carry, in UTF-8 bytes: 16 KiB (spec D3).
pub const MAX_SEND_TEXT_BYTES: usize = 16 * 1024;

/// The longest error message passed on from the page, in characters.
const MAX_MESSAGE_CHARS: usize = 1000;

/// The keys a request may have.
const KEYS: [&str; 5] = ["v", "id", "token", "cmd", "args"];

/// Why a request failed — the same set as `CONTROL_ERROR` in
/// src/lib/controlScope.js, which the page answers with, and the CLI's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
    BadRequest,
    UnknownCommand,
    Unauthorized,
    Disabled,
    Forbidden,
    NotFound,
    Refused,
    RateLimited,
    NotRendered,
    NotResponding,
    TooLarge,
    Internal,
}

impl Code {
    /// Every code, in the order of the spec.
    pub const ALL: [Code; 12] = [
        Code::BadRequest,
        Code::UnknownCommand,
        Code::Unauthorized,
        Code::Disabled,
        Code::Forbidden,
        Code::NotFound,
        Code::Refused,
        Code::RateLimited,
        Code::NotRendered,
        Code::NotResponding,
        Code::TooLarge,
        Code::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Code::BadRequest => "bad_request",
            Code::UnknownCommand => "unknown_command",
            Code::Unauthorized => "unauthorized",
            Code::Disabled => "disabled",
            Code::Forbidden => "forbidden",
            Code::NotFound => "not_found",
            Code::Refused => "refused",
            Code::RateLimited => "rate_limited",
            Code::NotRendered => "not_rendered",
            Code::NotResponding => "not_responding",
            Code::TooLarge => "too_large",
            Code::Internal => "internal",
        }
    }

    pub fn parse(text: &str) -> Option<Code> {
        Code::ALL.into_iter().find(|code| code.as_str() == text)
    }
}

/// A failed request: its code and what to tell the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
    pub message: String,
}

impl Failure {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Failure { code, message: message.into() }
    }
}

/// The commands there are (spec D4). The backend authenticates and limits
/// them; the page carries them out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Notify,
    SetStatus,
    SetProgress,
    List,
    NewSplit,
    Send,
    ReadScreen,
    Focus,
}

impl Command {
    pub const ALL: [Command; 8] = [
        Command::Notify,
        Command::SetStatus,
        Command::SetProgress,
        Command::List,
        Command::NewSplit,
        Command::Send,
        Command::ReadScreen,
        Command::Focus,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Command::Notify => "notify",
            Command::SetStatus => "set-status",
            Command::SetProgress => "set-progress",
            Command::List => "list",
            Command::NewSplit => "new-split",
            Command::Send => "send",
            Command::ReadScreen => "read-screen",
            Command::Focus => "focus",
        }
    }

    pub fn parse(text: &str) -> Option<Command> {
        Command::ALL.into_iter().find(|cmd| cmd.name() == text)
    }

    /// Whether, with `args`, it types into or reads a terminal: "Let
    /// programs type into and read terminals" must be on (spec D5). A
    /// `new-split` with a `command` types that command into the new
    /// terminal, so it is typing too (security review).
    pub fn needs_type_and_read(self, args: &Map<String, Value>) -> bool {
        match self {
            Command::Send | Command::ReadScreen => true,
            Command::NewSplit => args.contains_key("command"),
            _ => false,
        }
    }
}

/// A request of the right shape. `cmd` is still the caller's text: whether
/// it names a command is asked after the token (see the module's doc).
#[derive(Debug)]
pub struct Request {
    pub id: u64,
    pub token: String,
    pub cmd: String,
    pub args: Map<String, Value>,
}

/// `text` for a message: quoted with its control characters escaped, and
/// cut short. It came from the caller, and could be anything of any length.
pub fn shown(text: &str) -> String {
    const MOST: usize = 40;
    let cut: String = text.chars().take(MOST).collect();
    if cut.len() < text.len() {
        format!("{cut:?}\u{2026}")
    } else {
        format!("{cut:?}")
    }
}

/// A request line — without its LF — read, or why not, with the request's
/// id when it got far enough to have one.
pub fn parse(line: &[u8]) -> Result<Request, (Option<u64>, Failure)> {
    let bad = |id: Option<u64>, message: String| (id, Failure::new(Code::BadRequest, message));
    if line.len() > MAX_REQUEST_BYTES {
        return Err((None, Failure::new(Code::TooLarge, format!("a request is at most {MAX_REQUEST_BYTES} bytes"))));
    }
    let text = std::str::from_utf8(line).map_err(|_| bad(None, "the request is not UTF-8".into()))?;
    let value: Value = serde_json::from_str(text).map_err(|e| bad(None, format!("the request is not JSON: {e}")))?;
    let Value::Object(mut object) = value else {
        return Err(bad(None, "a request is one JSON object".into()));
    };

    // The id first, so that every later failure can carry it.
    let id = match object.get("id") {
        Some(Value::Number(n)) => n.as_u64(),
        _ => None,
    };
    let Some(id) = id else {
        return Err(bad(None, "\"id\" must be a whole number from 0 to 2^64-1".into()));
    };
    if let Some(key) = object.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(bad(Some(id), format!("a request has no key {}", shown(key))));
    }
    match object.get("v") {
        Some(Value::Number(n)) if n.as_u64() == Some(VERSION) => {}
        Some(other) => {
            return Err(bad(Some(id), format!("protocol version {} is not spoken here; it is {VERSION}", shown(&other.to_string()))));
        }
        None => return Err(bad(Some(id), format!("\"v\" is required; the protocol version is {VERSION}"))),
    }
    let token = match object.remove("token") {
        Some(Value::String(token)) => token,
        // No token is no authority, whatever the rest says.
        None | Some(Value::Null) => {
            return Err((Some(id), Failure::new(Code::Unauthorized, "a request needs the terminal's NEXTERM_CONTROL_TOKEN")));
        }
        Some(_) => return Err(bad(Some(id), "\"token\" must be a string".into())),
    };
    let cmd = match object.remove("cmd") {
        Some(Value::String(cmd)) => cmd,
        _ => return Err(bad(Some(id), "\"cmd\" must be a string".into())),
    };
    let args = match object.remove("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args,
        Some(_) => return Err(bad(Some(id), "\"args\" must be an object".into())),
    };
    Ok(Request { id, token, cmd, args })
}

#[derive(Serialize)]
struct Answered<'a> {
    v: u64,
    id: u64,
    ok: bool,
    result: &'a Value,
}

#[derive(Serialize)]
struct Refused<'a> {
    v: u64,
    id: Option<u64>,
    ok: bool,
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'static str,
    message: &'a str,
}

/// A failure's line, LF included.
pub fn encode_error(id: Option<u64>, failure: &Failure) -> Vec<u8> {
    let message: String = failure.message.chars().take(MAX_MESSAGE_CHARS).collect();
    let mut line = serde_json::to_vec(&Refused {
        v: VERSION,
        id,
        ok: false,
        error: ErrorBody { code: failure.code.as_str(), message: &message },
    })
    // A struct of a number, a bool and two strings always serialises.
    .unwrap_or_default();
    line.push(b'\n');
    line
}

/// A result's line, LF included — or `too_large` when it would be longer
/// than MAX_RESPONSE_BYTES.
pub fn encode_result(id: u64, result: &Value) -> Vec<u8> {
    match serde_json::to_vec(&Answered { v: VERSION, id, ok: true, result }) {
        Ok(mut line) if line.len() < MAX_RESPONSE_BYTES => {
            line.push(b'\n');
            line
        }
        Ok(line) => encode_error(
            Some(id),
            &Failure::new(
                Code::TooLarge,
                format!("the answer was {} bytes; at most {MAX_RESPONSE_BYTES} are sent (ask for fewer lines)", line.len()),
            ),
        ),
        Err(e) => encode_error(Some(id), &Failure::new(Code::Internal, format!("the answer could not be written: {e}"))),
    }
}

/// What the page answered, made safe to pass on: a code outside the set is
/// `internal`, a message is a string of at most MAX_MESSAGE_CHARS.
pub fn page_failure(error: Option<&Value>) -> Failure {
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .and_then(Code::parse)
        .unwrap_or(Code::Internal);
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(|m| m.chars().take(MAX_MESSAGE_CHARS).collect::<String>())
        .unwrap_or_else(|| format!("NexTerm refused the request ({})", code.as_str()));
    Failure::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }

    fn failure(bytes: &[u8]) -> (Option<u64>, Code) {
        match parse(bytes) {
            Ok(request) => panic!("{:?} was accepted as {request:?}", String::from_utf8_lossy(bytes)),
            Err((id, failure)) => (id, failure.code),
        }
    }

    /// A tiny xorshift: the same "random" bytes on every run and platform,
    /// so a failure here can be reproduced.
    pub(crate) struct Xorshift(pub u64);
    impl Xorshift {
        pub fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    #[test]
    fn a_well_formed_request_is_read_whole() {
        let request = parse(&line(json!({"v":1,"id":7,"token":"t","cmd":"notify","args":{"title":"Done"}}))).unwrap();
        assert_eq!(request.id, 7);
        assert_eq!(request.token, "t");
        assert_eq!(request.cmd, "notify");
        assert_eq!(request.args.get("title"), Some(&json!("Done")));
        // `args` left out, or null, is no arguments.
        assert!(parse(&line(json!({"v":1,"id":1,"token":"t","cmd":"list"}))).unwrap().args.is_empty());
        assert!(parse(&line(json!({"v":1,"id":1,"token":"t","cmd":"list","args":null}))).unwrap().args.is_empty());
        // JSON's own white space, a CR before the LF among it, is fine.
        assert!(parse(b" {\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"list\"}\r").is_ok());
        // The largest id there is.
        assert_eq!(parse(&line(json!({"v":1,"id":u64::MAX,"token":"t","cmd":"list"}))).unwrap().id, u64::MAX);
    }

    #[test]
    fn invalid_utf8_is_a_bad_request() {
        assert_eq!(failure(b"{\"v\":1,\"id\":1,\"token\":\"\xff\",\"cmd\":\"list\"}"), (None, Code::BadRequest));
        // A UTF-8 sequence cut in half, and an overlong encoding of '/'.
        assert_eq!(failure(b"{\"v\":1,\"id\":1,\"token\":\"\xe2\x82\",\"cmd\":\"list\"}"), (None, Code::BadRequest));
        assert_eq!(failure(b"{\"v\":1,\"id\":1,\"token\":\"\xc0\xaf\",\"cmd\":\"list\"}"), (None, Code::BadRequest));
        // A lone surrogate, which a page or a CLI could hold and nothing
        // downstream can carry.
        assert_eq!(failure(br#"{"v":1,"id":1,"token":"\ud800","cmd":"list"}"#), (None, Code::BadRequest));
    }

    #[test]
    fn what_is_not_one_json_object_is_a_bad_request() {
        for bytes in [&b""[..], b" ", b"null", b"1", b"\"x\"", b"[]", b"[{\"v\":1}]", b"{", b"{}{}", b"{\"v\":1,}", b"\x00"] {
            assert_eq!(failure(bytes), (None, Code::BadRequest), "{:?}", String::from_utf8_lossy(bytes));
        }
    }

    #[test]
    fn a_depth_bomb_is_a_bad_request_not_a_crash() {
        // As deep as a line may go, of arrays, and of objects.
        let arrays = "[".repeat(MAX_REQUEST_BYTES);
        assert_eq!(failure(arrays.as_bytes()), (None, Code::BadRequest));
        let objects = "{\"a\":".repeat(MAX_REQUEST_BYTES / 5);
        assert_eq!(failure(objects.as_bytes()), (None, Code::BadRequest));
        // Deep inside an otherwise good request: still refused by the parser,
        // never handed to the page.
        let deep = format!(
            "{{\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"notify\",\"args\":{{\"title\":{}1{}}}}}",
            "[".repeat(200),
            "]".repeat(200)
        );
        assert_eq!(failure(deep.as_bytes()).1, Code::BadRequest);
    }

    #[test]
    fn wrong_types_are_bad_requests_and_keep_the_id_once_it_is_read() {
        let base = || json!({"v":1,"id":5,"token":"t","cmd":"list","args":{}});
        let with = |key: &str, value: Value| {
            let mut request = base();
            request[key] = value;
            line(request)
        };
        // An id that is not a u64 cannot be echoed back.
        for id in [json!("5"), json!(-1), json!(1.5), json!(1e30), json!(null), json!([5]), json!(true)] {
            assert_eq!(failure(&with("id", id.clone())), (None, Code::BadRequest), "id {id}");
        }
        let mut no_id = base();
        no_id.as_object_mut().unwrap().remove("id");
        assert_eq!(failure(&line(no_id)), (None, Code::BadRequest));

        for v in [json!(2), json!(0), json!("1"), json!(1.0), json!(null), json!({"major":1})] {
            assert_eq!(failure(&with("v", v.clone())), (Some(5), Code::BadRequest), "v {v}");
        }
        let mut no_v = base();
        no_v.as_object_mut().unwrap().remove("v");
        assert_eq!(failure(&line(no_v)), (Some(5), Code::BadRequest));

        for token in [json!(1), json!(["t"]), json!({}), json!(false)] {
            assert_eq!(failure(&with("token", token.clone())), (Some(5), Code::BadRequest), "token {token}");
        }
        for cmd in [json!(1), json!(null), json!(["list"]), json!({})] {
            assert_eq!(failure(&with("cmd", cmd.clone())), (Some(5), Code::BadRequest), "cmd {cmd}");
        }
        for args in [json!([]), json!("x"), json!(1), json!(true)] {
            assert_eq!(failure(&with("args", args.clone())), (Some(5), Code::BadRequest), "args {args}");
        }
    }

    #[test]
    fn no_token_is_unauthorized_before_anything_else_is_asked() {
        let mut request = json!({"v":1,"id":3,"cmd":"no-such-command"});
        assert_eq!(failure(&line(request.clone())), (Some(3), Code::Unauthorized));
        request["token"] = Value::Null;
        assert_eq!(failure(&line(request)), (Some(3), Code::Unauthorized));
    }

    #[test]
    fn a_key_outside_the_five_is_a_bad_request() {
        for key in ["session_id", "Token", "target", ""] {
            let mut request = json!({"v":1,"id":9,"token":"t","cmd":"list"});
            request[key] = json!("x");
            assert_eq!(failure(&line(request)), (Some(9), Code::BadRequest), "key {key:?}");
        }
    }

    #[test]
    fn a_line_over_the_cap_is_too_large_without_being_parsed() {
        let mut request = format!("{{\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"notify\",\"args\":{{\"title\":\"{}", "x".repeat(MAX_REQUEST_BYTES));
        request.push_str("\"}}");
        assert_eq!(failure(request.as_bytes()), (None, Code::TooLarge));
        // At the cap exactly, it is read.
        let head = "{\"v\":1,\"id\":1,\"token\":\"t\",\"cmd\":\"notify\",\"args\":{\"title\":\"";
        let tail = "\"}}";
        let fill = MAX_REQUEST_BYTES - head.len() - tail.len();
        let at_cap = format!("{head}{}{tail}", "x".repeat(fill));
        assert_eq!(at_cap.len(), MAX_REQUEST_BYTES);
        assert!(parse(at_cap.as_bytes()).is_ok());
    }

    /// Random bytes, random JSON-ish text and random cuts of a good request:
    /// every one is refused with a code of the set or read as a request,
    /// never a panic, and whatever is refused encodes as a valid answer.
    #[test]
    fn fuzzed_lines_never_panic_and_always_have_an_answer() {
        let good = line(json!({"v":1,"id":42,"token":"abc","cmd":"send","args":{"text":"hi\n","keys":["Enter"]}}));
        let alphabet = b"{}[]\":,\\0123456789eE+-.truefalsn vidtokcmdarg\x00\xff\xc3\xa9\n";
        let mut rng = Xorshift(0x9e37_79b9_7f4a_7c15);
        for round in 0..20_000u32 {
            let len = (rng.next() % 200) as usize;
            let bytes: Vec<u8> = match round % 4 {
                0 => (0..len).map(|_| rng.next() as u8).collect(),
                1 => (0..len).map(|_| alphabet[(rng.next() as usize) % alphabet.len()]).collect(),
                // A good request cut short: a partial line.
                2 => good[..(rng.next() as usize) % good.len()].to_vec(),
                // A good request with one byte changed.
                _ => {
                    let mut bytes = good.clone();
                    let at = (rng.next() as usize) % bytes.len();
                    bytes[at] = rng.next() as u8;
                    bytes
                }
            };
            match parse(&bytes) {
                // A byte changed inside a string can leave a good request.
                Ok(request) => assert!(request.args.len() <= 2),
                Err((id, failure)) => {
                    assert!(Code::ALL.contains(&failure.code));
                    let answer: Value = serde_json::from_slice(&encode_error(id, &failure)).expect("an answer is JSON");
                    assert_eq!(answer["ok"], json!(false));
                    assert_eq!(answer["v"], json!(1));
                }
            }
        }
    }

    #[test]
    fn answers_are_one_line_in_the_documented_shape() {
        let ok = encode_result(4, &json!({"tabs":["a\nb"]}));
        assert_eq!(ok.last(), Some(&b'\n'));
        assert_eq!(ok.iter().filter(|&&b| b == b'\n').count(), 1, "a newline in a result is escaped");
        assert_eq!(
            String::from_utf8(ok).unwrap(),
            "{\"v\":1,\"id\":4,\"ok\":true,\"result\":{\"tabs\":[\"a\\nb\"]}}\n"
        );
        let err = encode_error(None, &Failure::new(Code::Refused, "busy\nnow"));
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "{\"v\":1,\"id\":null,\"ok\":false,\"error\":{\"code\":\"refused\",\"message\":\"busy\\nnow\"}}\n"
        );
    }

    #[test]
    fn an_answer_over_1_mib_is_too_large() {
        let big = Value::String("x".repeat(MAX_RESPONSE_BYTES));
        let answer: Value = serde_json::from_slice(&encode_result(8, &big)).unwrap();
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(answer["id"], json!(8));
        assert_eq!(answer["error"]["code"], json!("too_large"));
        // Just under the cap goes as it is.
        let envelope = encode_result(8, &json!("")).len();
        let fits = Value::String("x".repeat(MAX_RESPONSE_BYTES - envelope));
        let line = encode_result(8, &fits);
        assert_eq!(line.len(), MAX_RESPONSE_BYTES);
        assert_eq!(serde_json::from_slice::<Value>(&line).unwrap()["ok"], json!(true));
    }

    #[test]
    fn the_page_cannot_answer_with_a_code_outside_the_set_or_a_message_of_any_size() {
        assert_eq!(page_failure(Some(&json!({"code":"forbidden","message":"no"}))), Failure::new(Code::Forbidden, "no"));
        assert_eq!(page_failure(Some(&json!({"code":"root","message":"x"}))).code, Code::Internal);
        assert_eq!(page_failure(Some(&json!({"code":1}))).code, Code::Internal);
        assert_eq!(page_failure(None).code, Code::Internal);
        assert_eq!(page_failure(Some(&json!("not an object"))).code, Code::Internal);
        let long = page_failure(Some(&json!({"code":"refused","message":"m".repeat(10_000)})));
        assert_eq!(long.message.chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(page_failure(Some(&json!({"code":"refused","message":5}))).message, "NexTerm refused the request (refused)");
    }

    #[test]
    fn every_code_and_command_has_one_name() {
        for code in Code::ALL {
            assert_eq!(Code::parse(code.as_str()), Some(code));
        }
        for cmd in Command::ALL {
            assert_eq!(Command::parse(cmd.name()), Some(cmd));
        }
        assert_eq!(Command::parse("Notify"), None);
        assert_eq!(Command::parse("notify "), None);
        let none = Map::new();
        let reading: Vec<_> = Command::ALL.into_iter().filter(|c| c.needs_type_and_read(&none)).map(Command::name).collect();
        assert_eq!(reading, ["send", "read-screen"]);
        let command = json!({"command":"npm test"}).as_object().unwrap().clone();
        let typing: Vec<_> = Command::ALL.into_iter().filter(|c| c.needs_type_and_read(&command)).map(Command::name).collect();
        assert_eq!(typing, ["new-split", "send", "read-screen"], "a split that types a command is typing");
        let cwd = json!({"cwd":"/tmp","direction":"down"}).as_object().unwrap().clone();
        assert!(!Command::NewSplit.needs_type_and_read(&cwd));
    }

    /// The page answers with the codes of `CONTROL_ERROR` and dispatches the
    /// commands of `SCHEMAS` (src/lib/controlScope.js). Read from the source,
    /// so that the two sets cannot drift apart unnoticed.
    #[test]
    fn the_page_speaks_the_same_codes_and_commands() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/controlScope.js");
        let Ok(source) = std::fs::read_to_string(&path) else {
            panic!("{} is not there to compare with", path.display());
        };
        let block = |start: &str, end: &str| -> String {
            let from = source.find(start).unwrap_or_else(|| panic!("controlScope.js has no {start}"));
            let rest = &source[from..];
            rest[..rest.find(end).unwrap_or_else(|| panic!("controlScope.js: {start} never ends"))].to_string()
        };
        let errors = block("export const CONTROL_ERROR", "});");
        let mut page_codes: Vec<String> = errors
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect();
        page_codes.sort();
        let mut ours: Vec<String> = Code::ALL.iter().map(|c| c.as_str().to_string()).collect();
        ours.sort();
        assert_eq!(page_codes, ours, "the page's error codes and the backend's differ");

        let schemas = block("const SCHEMAS = {", "\n};");
        for cmd in Command::ALL {
            let name = cmd.name();
            let quoted = format!("'{name}':");
            let bare = format!("\n  {name}:");
            assert!(
                schemas.contains(&quoted) || schemas.contains(&bare),
                "the page has no schema for {name}"
            );
        }
    }
}
