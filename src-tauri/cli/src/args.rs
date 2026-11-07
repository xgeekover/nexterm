//! The command line (D4, D7): `nexterm-cli [--json] <command> [arguments]`.
//!
//! Parsing never reads the environment or standard input and never connects:
//! a wrong command line is exit 2 with nothing sent, inside NexTerm or not.

use std::ffi::OsString;

/// The commands, in the order the help lists them.
pub const COMMANDS: &[&str] = &[
    "notify",
    "set-status",
    "set-progress",
    "list",
    "new-split",
    "send",
    "read-screen",
    "focus",
];

pub const OCCASIONS: &[&str] = &["always", "unfocused", "invisible"];
pub const TONES: &[&str] = &["info", "warn", "error"];
/// `read-screen --lines` at most (D4: `lines?: 0..2000`).
pub const MAX_LINES: u16 = 2000;

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// Print the help (of one command, or all) and exit 0.
    Help(Option<&'static str>),
    Version,
    Run { json: bool, command: Command },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Notify { title: String, body: Option<String>, occasion: Option<&'static str> },
    /// `text: None` clears the status.
    SetStatus { text: Option<String>, tone: Option<&'static str> },
    SetProgress { state: &'static str, value: Option<u8> },
    List,
    NewSplit { direction: Option<&'static str>, cwd: Option<String>, command: Option<String> },
    Send { target: String, text: Option<Text>, keys: Vec<String>, raw: bool },
    ReadScreen { target: String, lines: Option<u16>, mask: bool },
    Focus { target: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Text {
    Given(String),
    /// `-`: read it from standard input.
    Stdin,
}

/// A wrong command line: the message, and the command whose usage to show.
#[derive(Debug, PartialEq, Eq)]
pub struct UsageError {
    pub message: String,
    pub command: Option<&'static str>,
}

impl UsageError {
    pub fn general(message: impl Into<String>) -> UsageError {
        UsageError { message: message.into(), command: None }
    }
    pub fn of(command: &'static str, message: impl Into<String>) -> UsageError {
        UsageError { message: message.into(), command: Some(command) }
    }
}

pub fn parse(argv: &[OsString]) -> Result<Parsed, UsageError> {
    let mut args = Vec::with_capacity(argv.len());
    for a in argv {
        match a.to_str() {
            Some(s) => args.push(s.to_owned()),
            None => return Err(UsageError::general("an argument is not valid text (UTF-8)")),
        }
    }

    let mut json = false;
    let mut i = 0;
    while let Some(a) = args.get(i) {
        match a.as_str() {
            "--json" => json = true,
            "--version" => return Ok(Parsed::Version),
            "-h" | "--help" => return Ok(Parsed::Help(None)),
            s if s.starts_with('-') => return Err(UsageError::general(format!("unknown option '{s}'"))),
            _ => break,
        }
        i += 1;
    }
    let Some(name) = args.get(i) else {
        return Err(UsageError::general("no command given"));
    };
    let rest = &args[i + 1..];
    if name == "help" {
        return match rest {
            [] => Ok(Parsed::Help(None)),
            [topic] => match known(topic) {
                Some(cmd) => Ok(Parsed::Help(Some(cmd))),
                None => Err(UsageError::general(format!("unknown command '{topic}'"))),
            },
            _ => Err(UsageError::general("help takes one command")),
        };
    }
    let Some(cmd) = known(name) else {
        return Err(UsageError::general(format!("unknown command '{name}'")));
    };
    // `--help` wins wherever it is (before `--`), even next to a mistake.
    for a in rest {
        if a == "--" {
            break;
        }
        if a == "-h" || a == "--help" {
            return Ok(Parsed::Help(Some(cmd)));
        }
    }

    let mut lx = Lexer { args: rest, i: 0, after_dashes: false, cmd, json: false };
    let command = match cmd {
        "notify" => notify(&mut lx)?,
        "set-status" => set_status(&mut lx)?,
        "set-progress" => set_progress(&mut lx)?,
        "list" => list(&mut lx)?,
        "new-split" => new_split(&mut lx)?,
        "send" => send(&mut lx)?,
        "read-screen" => read_screen(&mut lx)?,
        "focus" => focus(&mut lx)?,
        _ => unreachable!("every name in COMMANDS has a parser"),
    };
    Ok(Parsed::Run { json: json || lx.json, command })
}

fn known(name: &str) -> Option<&'static str> {
    COMMANDS.iter().copied().find(|c| *c == name)
}

enum Tok<'a> {
    /// `--name` or `--name=value` (the value is given only in that form).
    Opt(&'a str, Option<&'a str>),
    Word(&'a str),
}

struct Lexer<'a> {
    args: &'a [String],
    i: usize,
    /// Past `--`: everything is a word.
    after_dashes: bool,
    cmd: &'static str,
    /// `--json` among the command's own arguments.
    json: bool,
}

impl<'a> Lexer<'a> {
    fn next(&mut self) -> Option<Tok<'a>> {
        loop {
            let a = self.args.get(self.i)?.as_str();
            self.i += 1;
            if self.after_dashes {
                return Some(Tok::Word(a));
            }
            if a == "--" {
                self.after_dashes = true;
                continue;
            }
            if a == "--json" {
                self.json = true;
                continue;
            }
            if let Some(body) = a.strip_prefix("--") {
                return Some(match body.split_once('=') {
                    Some((name, value)) => Tok::Opt(&a[..name.len() + 2], Some(value)),
                    None => Tok::Opt(a, None),
                });
            }
            // A lone `-` is a word (standard input); `-x` is an option, and
            // none of the commands has a short one.
            if a.len() > 1 && a.starts_with('-') {
                return Some(Tok::Opt(a, None));
            }
            return Some(Tok::Word(a));
        }
    }

    /// The value of `opt`: after `=`, or the next argument — which may begin
    /// with `-` (a negative number gets its own message) but not with `--`.
    fn value(&mut self, opt: &str, inline: Option<&'a str>) -> Result<&'a str, UsageError> {
        if let Some(v) = inline {
            return Ok(v);
        }
        match self.args.get(self.i) {
            Some(v) if !self.after_dashes && !v.starts_with("--") => {
                self.i += 1;
                Ok(v)
            }
            _ => Err(self.err(format!("{opt} needs a value"))),
        }
    }

    /// The next argument if it is a plain word, taken.
    fn take_word_if(&mut self, wanted: impl Fn(&str) -> bool) -> Option<&'a str> {
        let a = self.args.get(self.i)?.as_str();
        if self.after_dashes || a.starts_with('-') || !wanted(a) {
            return None;
        }
        self.i += 1;
        Some(a)
    }

    fn no_value(&self, opt: &str, inline: Option<&str>) -> Result<(), UsageError> {
        match inline {
            Some(_) => Err(self.err(format!("{opt} takes no value"))),
            None => Ok(()),
        }
    }

    fn choice(&mut self, opt: &str, inline: Option<&'a str>, of: &[&'static str]) -> Result<&'static str, UsageError> {
        let v = self.value(opt, inline)?;
        of.iter()
            .copied()
            .find(|c| *c == v)
            .ok_or_else(|| self.err(format!("{opt} must be one of {}, not '{v}'", of.join(", "))))
    }

    fn target(&mut self, opt: &str, inline: Option<&'a str>) -> Result<String, UsageError> {
        let v = self.value(opt, inline)?;
        nonempty_target(self.cmd, v)
    }

    fn unknown(&self, opt: &str) -> UsageError {
        self.err(format!("unknown option '{opt}' (put text that starts with - after --)"))
    }

    fn err(&self, message: impl Into<String>) -> UsageError {
        UsageError::of(self.cmd, message)
    }
}

fn nonempty_target(cmd: &'static str, v: &str) -> Result<String, UsageError> {
    if v.is_empty() {
        return Err(UsageError::of(cmd, "TARGET is empty (self, a tab id, or child:<id>)"));
    }
    Ok(v.to_owned())
}

fn percent(cmd: &'static str, word: &str) -> Result<u8, UsageError> {
    let digits = word.strip_suffix('%').unwrap_or(word);
    match digits.parse::<u8>() {
        Ok(n) if n <= 100 && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => Ok(n),
        _ => Err(UsageError::of(cmd, format!("progress must be a whole number from 0 to 100, not '{word}'"))),
    }
}

fn looks_like_percent(word: &str) -> bool {
    let digits = word.strip_suffix('%').unwrap_or(word);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn notify(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut words = Vec::new();
    let mut occasion = None;
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt("--occasion", v) => occasion = Some(lx.choice("--occasion", v, OCCASIONS)?),
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) => words.push(w),
        }
    }
    let (title, body) = match words.as_slice() {
        [] => return Err(lx.err("notify needs a title")),
        [t] => (*t, None),
        [t, b] => (*t, Some(*b)),
        _ => return Err(lx.err("notify takes a title and at most one body; quote text with spaces")),
    };
    if title.is_empty() {
        return Err(lx.err("the title is empty"));
    }
    Ok(Command::Notify {
        title: title.to_owned(),
        body: body.filter(|b| !b.is_empty()).map(str::to_owned),
        occasion,
    })
}

fn set_status(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut words = Vec::new();
    let mut tone = None;
    let mut clear = false;
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt("--tone", v) => tone = Some(lx.choice("--tone", v, TONES)?),
            Tok::Opt("--clear", v) => {
                lx.no_value("--clear", v)?;
                clear = true;
            }
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) => words.push(w),
        }
    }
    if clear {
        if !words.is_empty() {
            return Err(lx.err("--clear takes no text"));
        }
        if tone.is_some() {
            return Err(lx.err("--tone goes with a text, not with --clear"));
        }
        return Ok(Command::SetStatus { text: None, tone: None });
    }
    // The words are one line, as `echo` would make them: a hook can write
    // `nexterm-cli set-status Running tests` without quoting.
    let text = words.join(" ");
    if words.is_empty() {
        return Err(lx.err("set-status needs a text, or --clear"));
    }
    if text.is_empty() {
        return Err(lx.err("the text is empty; --clear clears the status"));
    }
    Ok(Command::SetStatus { text: Some(text), tone })
}

fn set_progress(lx: &mut Lexer) -> Result<Command, UsageError> {
    const ONE_OF: &str = "a value from 0 to 100, --indeterminate, --error [n], --warning [n] or --clear";
    let mut state: Option<&'static str> = None;
    let mut flag_value = None;
    let mut word = None;
    while let Some(t) = lx.next() {
        let mode = match t {
            Tok::Opt("--indeterminate", v) => {
                lx.no_value("--indeterminate", v)?;
                "indeterminate"
            }
            Tok::Opt("--clear", v) => {
                lx.no_value("--clear", v)?;
                "remove"
            }
            Tok::Opt(o @ ("--error" | "--warning"), v) => {
                // The value is optional: taken when the next word is a number.
                flag_value = match v.or_else(|| lx.take_word_if(looks_like_percent)) {
                    Some(n) => Some(percent(lx.cmd, n)?),
                    None => None,
                };
                if o == "--error" {
                    "error"
                } else {
                    "warning"
                }
            }
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) => {
                if word.is_some() {
                    return Err(lx.err("set-progress takes one value"));
                }
                word = Some(w);
                continue;
            }
        };
        if state.is_some() {
            return Err(lx.err(format!("choose one of {ONE_OF}")));
        }
        state = Some(mode);
    }
    match (state, word) {
        (None, None) => Err(lx.err(format!("set-progress needs {ONE_OF}"))),
        (None, Some(w)) => Ok(Command::SetProgress { state: "normal", value: Some(percent(lx.cmd, w)?) }),
        (Some(_), Some(w)) => Err(lx.err(format!("'{w}' goes right after --error or --warning, or alone"))),
        (Some(s), None) => Ok(Command::SetProgress { state: s, value: flag_value }),
    }
}

fn list(lx: &mut Lexer) -> Result<Command, UsageError> {
    match lx.next() {
        None => Ok(Command::List),
        Some(Tok::Opt(o, _)) => Err(lx.unknown(o)),
        Some(Tok::Word(w)) => Err(lx.err(format!("list takes no arguments, not '{w}'"))),
    }
}

fn new_split(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut direction = None;
    let mut cwd = None;
    let mut command = Vec::new();
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt(o @ ("--right" | "--down"), v) => {
                lx.no_value(o, v)?;
                let d = &o[2..];
                if direction.is_some_and(|was| was != d) {
                    return Err(lx.err("choose --right or --down, not both"));
                }
                direction = Some(if d == "right" { "right" } else { "down" });
            }
            Tok::Opt("--cwd", v) => {
                let dir = lx.value("--cwd", v)?;
                if dir.is_empty() {
                    return Err(lx.err("--cwd is empty"));
                }
                cwd = Some(dir.to_owned());
            }
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) if lx.after_dashes => command.push(w),
            Tok::Word(w) => {
                return Err(lx.err(format!("put the command after --, e.g. nexterm-cli new-split -- {w}")));
            }
        }
    }
    // Typed into the new terminal's shell as one line; the shell splits it.
    let command = command.join(" ");
    Ok(Command::NewSplit { direction, cwd, command: Some(command).filter(|c| !c.trim().is_empty()) })
}

fn send(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut target = None;
    let mut raw = false;
    let mut keys: Vec<String> = Vec::new();
    let mut words = Vec::new();
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt("--to", v) => target = Some(lx.target("--to", v)?),
            Tok::Opt("--raw", v) => {
                lx.no_value("--raw", v)?;
                raw = true;
            }
            Tok::Opt("--keys", v) => {
                let before = keys.len();
                if let Some(v) = v {
                    keys.push(v.to_owned());
                }
                // Every word up to the next option or `--`: a key never
                // begins with `-`.
                while let Some(k) = lx.take_word_if(|_| true) {
                    keys.push(k.to_owned());
                }
                if keys.len() == before {
                    return Err(lx.err("--keys needs at least one key"));
                }
            }
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            // Whether it came after `--`, past which nothing is an option
            // or standard input: `send -- -` types a dash.
            Tok::Word(w) => words.push((w, lx.after_dashes)),
        }
    }
    if keys.iter().any(String::is_empty) {
        return Err(lx.err("a key name is empty"));
    }
    let text = match words.as_slice() {
        [] => None,
        [("-", false)] => Some(Text::Stdin),
        [("", _)] => return Err(lx.err("TEXT is empty")),
        [(w, _)] => Some(Text::Given((*w).to_owned())),
        _ => return Err(lx.err("send takes one TEXT; quote text with spaces")),
    };
    if text.is_none() && keys.is_empty() {
        return Err(lx.err("send needs a TEXT, - for standard input, or --keys"));
    }
    Ok(Command::Send { target: target.unwrap_or_else(|| "self".to_owned()), text, keys, raw })
}

fn read_screen(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut target = None;
    let mut lines = None;
    let mut mask = true;
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt("--of", v) => target = Some(lx.target("--of", v)?),
            Tok::Opt("--lines", v) => {
                let n = lx.value("--lines", v)?;
                lines = Some(match n.parse::<u16>() {
                    Ok(count) if count <= MAX_LINES && n.bytes().all(|b| b.is_ascii_digit()) => count,
                    _ => return Err(lx.err(format!("--lines must be a whole number from 0 to {MAX_LINES}, not '{n}'"))),
                });
            }
            Tok::Opt("--no-mask", v) => {
                lx.no_value("--no-mask", v)?;
                mask = false;
            }
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) => return Err(lx.err(format!("read-screen takes --of TARGET, not '{w}'"))),
        }
    }
    Ok(Command::ReadScreen { target: target.unwrap_or_else(|| "self".to_owned()), lines, mask })
}

fn focus(lx: &mut Lexer) -> Result<Command, UsageError> {
    let mut target = None;
    while let Some(t) = lx.next() {
        match t {
            Tok::Opt(o, _) => return Err(lx.unknown(o)),
            Tok::Word(w) if target.is_none() => target = Some(nonempty_target(lx.cmd, w)?),
            Tok::Word(_) => return Err(lx.err("focus takes one TARGET")),
        }
    }
    Ok(Command::Focus { target: target.unwrap_or_else(|| "self".to_owned()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Parsed, UsageError> {
        let argv: Vec<OsString> = args.iter().map(OsString::from).collect();
        parse(&argv)
    }

    fn cmd(args: &[&str]) -> Command {
        match p(args) {
            Ok(Parsed::Run { command, .. }) => command,
            other => panic!("{args:?}: {other:?}"),
        }
    }

    /// A usage error, and which command's usage it shows.
    fn bad(args: &[&str]) -> UsageError {
        match p(args) {
            Err(e) => e,
            other => panic!("{args:?} should be a usage error: {other:?}"),
        }
    }

    fn s(v: &str) -> String {
        v.to_owned()
    }

    #[test]
    fn global_options() {
        assert_eq!(p(&["--version"]), Ok(Parsed::Version));
        assert_eq!(p(&["--json", "--version"]), Ok(Parsed::Version));
        assert_eq!(p(&["--help"]), Ok(Parsed::Help(None)));
        assert_eq!(p(&["-h"]), Ok(Parsed::Help(None)));
        assert_eq!(p(&["help"]), Ok(Parsed::Help(None)));
        assert_eq!(p(&["help", "send"]), Ok(Parsed::Help(Some("send"))));
        assert_eq!(p(&["--json", "list"]), Ok(Parsed::Run { json: true, command: Command::List }));
        assert_eq!(p(&["list", "--json"]), Ok(Parsed::Run { json: true, command: Command::List }));
        assert_eq!(p(&["list"]), Ok(Parsed::Run { json: false, command: Command::List }));
        assert_eq!(bad(&[]).message, "no command given");
        assert_eq!(bad(&["--nope", "list"]).command, None);
        assert_eq!(bad(&["frob"]).message, "unknown command 'frob'");
        assert_eq!(bad(&["help", "frob"]).message, "unknown command 'frob'");
        assert!(bad(&["help", "send", "list"]).message.contains("one command"));
        assert_eq!(p(&["--version", "x"]), Ok(Parsed::Version));
    }

    #[test]
    fn help_inside_a_command_wins_but_not_after_dashes() {
        assert_eq!(p(&["send", "--to", "x", "--help"]), Ok(Parsed::Help(Some("send"))));
        assert_eq!(p(&["notify", "--bogus", "-h"]), Ok(Parsed::Help(Some("notify"))));
        assert_eq!(
            cmd(&["send", "--", "--help"]),
            Command::Send { target: s("self"), text: Some(Text::Given(s("--help"))), keys: vec![], raw: false }
        );
    }

    #[cfg(unix)]
    #[test]
    fn arguments_that_are_not_text_are_a_usage_error() {
        use std::os::unix::ffi::OsStringExt;
        let argv = vec![OsString::from("notify"), OsString::from_vec(vec![0xff, 0xfe])];
        assert!(parse(&argv).is_err());
    }

    #[test]
    fn notify() {
        assert_eq!(cmd(&["notify", "Done"]), Command::Notify { title: s("Done"), body: None, occasion: None });
        assert_eq!(
            cmd(&["notify", "Done", "All 40 tests pass", "--occasion", "always"]),
            Command::Notify { title: s("Done"), body: Some(s("All 40 tests pass")), occasion: Some("always") }
        );
        assert_eq!(
            cmd(&["notify", "--occasion=invisible", "빌드 끝", "본문"]),
            Command::Notify { title: s("빌드 끝"), body: Some(s("본문")), occasion: Some("invisible") }
        );
        assert_eq!(cmd(&["notify", "T", ""]), Command::Notify { title: s("T"), body: None, occasion: None });
        assert_eq!(bad(&["notify"]).command, Some("notify"));
        assert!(bad(&["notify", ""]).message.contains("empty"));
        assert!(bad(&["notify", "a", "b", "c"]).message.contains("quote"));
        assert!(bad(&["notify", "a", "--occasion", "sometimes"]).message.contains("always, unfocused, invisible"));
        assert!(bad(&["notify", "a", "--occasion"]).message.contains("needs a value"));
        assert!(bad(&["notify", "a", "--loud"]).message.contains("unknown option '--loud'"));
        assert!(bad(&["notify", "-x"]).message.contains("unknown option '-x'"));
        assert_eq!(cmd(&["notify", "--", "-x"]), Command::Notify { title: s("-x"), body: None, occasion: None });
    }

    #[test]
    fn set_status() {
        assert_eq!(cmd(&["set-status", "Running tests"]), Command::SetStatus { text: Some(s("Running tests")), tone: None });
        assert_eq!(cmd(&["set-status", "Running", "tests"]), Command::SetStatus { text: Some(s("Running tests")), tone: None });
        assert_eq!(
            cmd(&["set-status", "--tone", "warn", "Slow"]),
            Command::SetStatus { text: Some(s("Slow")), tone: Some("warn") }
        );
        assert_eq!(cmd(&["set-status", "--clear"]), Command::SetStatus { text: None, tone: None });
        assert!(bad(&["set-status"]).message.contains("--clear"));
        assert!(bad(&["set-status", ""]).message.contains("empty"));
        assert!(bad(&["set-status", "--clear", "x"]).message.contains("no text"));
        assert!(bad(&["set-status", "--clear", "--tone", "info"]).message.contains("--tone"));
        assert!(bad(&["set-status", "x", "--tone", "loud"]).message.contains("info, warn, error"));
        assert!(bad(&["set-status", "--clear=yes"]).message.contains("takes no value"));
    }

    #[test]
    fn set_progress() {
        let sp = |state, value| Command::SetProgress { state, value };
        assert_eq!(cmd(&["set-progress", "0"]), sp("normal", Some(0)));
        assert_eq!(cmd(&["set-progress", "42"]), sp("normal", Some(42)));
        assert_eq!(cmd(&["set-progress", "100%"]), sp("normal", Some(100)));
        assert_eq!(cmd(&["set-progress", "--indeterminate"]), sp("indeterminate", None));
        assert_eq!(cmd(&["set-progress", "--error"]), sp("error", None));
        assert_eq!(cmd(&["set-progress", "--error", "30"]), sp("error", Some(30)));
        assert_eq!(cmd(&["set-progress", "--warning=75"]), sp("warning", Some(75)));
        assert_eq!(cmd(&["set-progress", "--warning"]), sp("warning", None));
        assert_eq!(cmd(&["set-progress", "--clear"]), sp("remove", None));
        for wrong in ["101", "-1", "4.5", "abc", "", "1e2", "+5", "%"] {
            let e = bad(&["set-progress", "--", wrong]);
            assert_eq!(e.command, Some("set-progress"), "{wrong}");
        }
        assert!(bad(&["set-progress", "--error", "200"]).message.contains("0 to 100"));
        assert!(bad(&["set-progress"]).message.contains("--indeterminate"));
        // A value after `--` is not --error's: it stands alone, beside a mode.
        assert!(bad(&["set-progress", "--error", "--", "7"]).message.contains("goes right after"));
        assert!(bad(&["set-progress", "10", "20"]).message.contains("one value"));
        assert!(bad(&["set-progress", "--clear", "--error"]).message.contains("choose one"));
        assert!(bad(&["set-progress", "40", "--indeterminate"]).message.contains("goes right after"));
        assert!(bad(&["set-progress", "--indeterminate=5"]).message.contains("takes no value"));
    }

    #[test]
    fn list() {
        assert_eq!(cmd(&["list"]), Command::List);
        assert!(bad(&["list", "all"]).message.contains("no arguments"));
        assert!(bad(&["list", "--all"]).message.contains("unknown option"));
    }

    #[test]
    fn new_split() {
        assert_eq!(cmd(&["new-split"]), Command::NewSplit { direction: None, cwd: None, command: None });
        assert_eq!(
            cmd(&["new-split", "--right", "--cwd", "../web", "--", "npm", "run", "dev"]),
            Command::NewSplit { direction: Some("right"), cwd: Some(s("../web")), command: Some(s("npm run dev")) }
        );
        assert_eq!(
            cmd(&["new-split", "--down", "--", "npm run dev -- --port 3000"]),
            Command::NewSplit { direction: Some("down"), cwd: None, command: Some(s("npm run dev -- --port 3000")) }
        );
        assert_eq!(cmd(&["new-split", "--right", "--right"]), Command::NewSplit { direction: Some("right"), cwd: None, command: None });
        assert_eq!(cmd(&["new-split", "--"]), Command::NewSplit { direction: None, cwd: None, command: None });
        assert_eq!(cmd(&["new-split", "--cwd=/tmp"]), Command::NewSplit { direction: None, cwd: Some(s("/tmp")), command: None });
        assert!(bad(&["new-split", "--right", "--down"]).message.contains("not both"));
        assert!(bad(&["new-split", "npm"]).message.contains("after --"));
        assert!(bad(&["new-split", "--cwd"]).message.contains("needs a value"));
        assert!(bad(&["new-split", "--cwd", "--right"]).message.contains("needs a value"));
        assert!(bad(&["new-split", "--cwd="]).message.contains("empty"));
        assert!(bad(&["new-split", "--left"]).message.contains("unknown option"));
    }

    #[test]
    fn send() {
        let send = |target: &str, text: Option<Text>, keys: &[&str], raw| Command::Send {
            target: s(target),
            text,
            keys: keys.iter().map(|k| s(k)).collect(),
            raw,
        };
        assert_eq!(cmd(&["send", "ls"]), send("self", Some(Text::Given(s("ls"))), &[], false));
        assert_eq!(cmd(&["send", "-"]), send("self", Some(Text::Stdin), &[], false));
        // After `--` a dash is just a dash.
        assert_eq!(cmd(&["send", "--", "-"]), send("self", Some(Text::Given(s("-"))), &[], false));
        assert_eq!(
            cmd(&["send", "--keys", "Enter", "--", "-"]),
            send("self", Some(Text::Given(s("-"))), &["Enter"], false)
        );
        assert!(bad(&["send", "-", "--", "-"]).message.contains("one TEXT"));
        assert_eq!(cmd(&["send", "--keys", "Ctrl+C"]), send("self", None, &["Ctrl+C"], false));
        assert_eq!(
            cmd(&["send", "--to", "child:tab-term-3", "npm test", "--keys", "Enter"]),
            send("child:tab-term-3", Some(Text::Given(s("npm test"))), &["Enter"], false)
        );
        assert_eq!(
            cmd(&["send", "--keys", "Up", "Enter", "--to=tab-term-2", "--raw", "--", "-la"]),
            send("tab-term-2", Some(Text::Given(s("-la"))), &["Up", "Enter"], true)
        );
        assert_eq!(cmd(&["send", "--keys=Escape", "Enter"]), send("self", None, &["Escape", "Enter"], false));
        assert_eq!(cmd(&["send", "--keys", "Tab", "-"]), send("self", Some(Text::Stdin), &["Tab"], false));
        assert_eq!(cmd(&["send", "--keys", "Up", "--keys", "Down"]), send("self", None, &["Up", "Down"], false));
        assert!(bad(&["send"]).message.contains("--keys"));
        assert!(bad(&["send", "a", "b"]).message.contains("one TEXT"));
        assert!(bad(&["send", ""]).message.contains("empty"));
        assert!(bad(&["send", "--keys"]).message.contains("at least one key"));
        assert!(bad(&["send", "--keys", "--raw"]).message.contains("at least one key"));
        assert!(bad(&["send", "--keys="]).message.contains("empty"));
        assert!(bad(&["send", "--to", "x"]).message.contains("needs a TEXT"));
        assert!(bad(&["send", "--to", "", "x"]).message.contains("TARGET is empty"));
        assert!(bad(&["send", "--to"]).message.contains("needs a value"));
        assert!(bad(&["send", "-la"]).message.contains("after --"));
        assert!(bad(&["send", "--raw=1", "x"]).message.contains("takes no value"));
    }

    #[test]
    fn read_screen() {
        assert_eq!(cmd(&["read-screen"]), Command::ReadScreen { target: s("self"), lines: None, mask: true });
        assert_eq!(
            cmd(&["read-screen", "--of", "child:tab-term-9", "--lines", "200", "--no-mask"]),
            Command::ReadScreen { target: s("child:tab-term-9"), lines: Some(200), mask: false }
        );
        assert_eq!(cmd(&["read-screen", "--lines=0"]), Command::ReadScreen { target: s("self"), lines: Some(0), mask: true });
        assert_eq!(cmd(&["read-screen", "--lines", "2000"]), Command::ReadScreen { target: s("self"), lines: Some(2000), mask: true });
        for wrong in ["2001", "-5", "+5", "ten", "", "65536", "1.5"] {
            assert!(bad(&["read-screen", &format!("--lines={wrong}")]).message.contains("0 to 2000"), "{wrong}");
        }
        assert!(bad(&["read-screen", "tab-term-1"]).message.contains("--of"));
        assert!(bad(&["read-screen", "--of"]).message.contains("needs a value"));
        assert!(bad(&["read-screen", "--mask"]).message.contains("unknown option"));
    }

    #[test]
    fn focus() {
        assert_eq!(cmd(&["focus"]), Command::Focus { target: s("self") });
        assert_eq!(cmd(&["focus", "tab-term-4"]), Command::Focus { target: s("tab-term-4") });
        assert_eq!(cmd(&["focus", "child:tab-term-4"]), Command::Focus { target: s("child:tab-term-4") });
        assert!(bad(&["focus", "a", "b"]).message.contains("one TARGET"));
        assert!(bad(&["focus", ""]).message.contains("TARGET is empty"));
        assert!(bad(&["focus", "--raise"]).message.contains("unknown option"));
    }

    #[test]
    fn every_command_has_a_parser_and_bad_usage_names_it() {
        for c in COMMANDS {
            let e = bad(&[c, "--definitely-not-an-option"]);
            assert_eq!(e.command, Some(*c), "{c}");
        }
    }
}
