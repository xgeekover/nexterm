//! What is printed. Human text by default, NexTerm's raw result with
//! `--json` (D7).
//!
//! Everything printed came from somewhere else — a tab title a program set,
//! a folder name, a status line, a screen — and goes to the caller's
//! terminal, so it must not be able to carry escape sequences, or bidi
//! controls that make it read differently from what it is. Human output
//! turns those into U+FFFD; JSON output escapes the ones serde_json leaves
//! raw (DEL, C1, bidi, line separators) as \uXXXX, which stays valid JSON.

use serde_json::Value;

use crate::args::Command;

/// Bidi embedding, override and isolate controls, and the marks.
fn is_bidi_control(c: char) -> bool {
    matches!(c as u32, 0x061C | 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069)
}

/// What must never reach a terminal raw: C0 (but tab and newline, decided by
/// the caller), DEL, C1, bidi controls, and the Unicode line and paragraph
/// separators.
fn is_unsafe(c: char) -> bool {
    let n = c as u32;
    n < 0x20 || (0x7F..=0x9F).contains(&n) || is_bidi_control(c) || n == 0x2028 || n == 0x2029
}

/// One line of someone else's text: line breaks and tabs become spaces, the
/// rest of the unsafe characters U+FFFD.
pub fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            c if is_unsafe(c) => char::REPLACEMENT_CHARACTER,
            c => c,
        })
        .collect()
}

/// A screen line: tabs kept, the rest of the unsafe characters U+FFFD.
fn screen_line(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\t' => '\t',
            c if is_unsafe(c) => char::REPLACEMENT_CHARACTER,
            c => c,
        })
        .collect()
}

/// `--json`: the result as NexTerm sent it, on one line.
pub fn json(result: &Value) -> String {
    let raw = result.to_string();
    let mut out = String::with_capacity(raw.len() + 1);
    for c in raw.chars() {
        // serde_json escapes C0 itself; these it leaves as they are. They can
        // only stand inside a string, where \uXXXX means the same character.
        let n = c as u32;
        if (0x7F..=0x9F).contains(&n) || is_bidi_control(c) || n == 0x2028 || n == 0x2029 {
            out.push_str(&format!("\\u{n:04x}"));
        } else {
            out.push(c);
        }
    }
    out.push('\n');
    out
}

/// The human form of `result` for `command`. Commands that only report back
/// print nothing (exit 0 says it worked).
pub fn human(command: &Command, result: &Value) -> String {
    match command {
        Command::List => list_table(result),
        Command::ReadScreen { .. } => screen(result),
        Command::NewSplit { .. } => new_tab(result),
        _ => String::new(),
    }
}

/// Columns a character takes in a terminal: 2 for East Asian wide and
/// full-width (Hangul, CJK, full-width forms, most emoji), 0 for combining
/// marks and zero-width characters, 1 for the rest. Close enough to line up a
/// table; xterm.js's own tables decide what the user finally sees.
pub fn char_width(c: char) -> usize {
    let n = c as u32;
    let zero = matches!(n,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x0610..=0x061A | 0x064B..=0x065F
        | 0x1160..=0x11FF | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x200B..=0x200D | 0x2060..=0x2064
        | 0x20D0..=0x20FF | 0xD7B0..=0xD7FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0xFEFF
        | 0xE0100..=0xE01EF);
    if zero {
        return 0;
    }
    let wide = matches!(n,
        0x1100..=0x115F | 0x231A..=0x231B | 0x2329..=0x232A | 0x23E9..=0x23EC | 0x23F0 | 0x23F3
        | 0x25FD..=0x25FE | 0x2614..=0x2615 | 0x2648..=0x2653 | 0x267F | 0x2693 | 0x26A1
        | 0x26AA..=0x26AB | 0x26BD..=0x26BE | 0x26C4..=0x26C5 | 0x26CE | 0x26D4 | 0x26EA
        | 0x26F2..=0x26F3 | 0x26F5 | 0x26FA | 0x26FD | 0x2705 | 0x270A..=0x270B | 0x2728 | 0x274C
        | 0x274E | 0x2753..=0x2755 | 0x2757 | 0x2795..=0x2797 | 0x27B0 | 0x27BF | 0x2B1B..=0x2B1C
        | 0x2B50 | 0x2B55 | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE10..=0xFE19
        | 0xFE30..=0xFE6F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x1F004 | 0x1F0CF | 0x1F18E
        | 0x1F191..=0x1F19A | 0x1F200..=0x1F251 | 0x1F300..=0x1F64F | 0x1F680..=0x1F6FF
        | 0x1F7E0..=0x1F7EB | 0x1F90C..=0x1F9FF | 0x1FA70..=0x1FAFF | 0x20000..=0x2FFFD
        | 0x30000..=0x3FFFD);
    if wide {
        2
    } else {
        1
    }
}

pub fn width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// `s` cut to at most `max` columns, with an ellipsis when cut.
fn clip(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = char_width(c);
        if used + w + 1 > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

/// A field as a table cell: strings as they are, null as "-", an object by
/// its first naming field — the shape of `group`, `agent` and `status` is the
/// page's to choose, and the table should not break when it does.
fn cell(v: Option<&Value>) -> String {
    let text = match v {
        None | Some(Value::Null) => return "-".to_owned(),
        Some(Value::String(s)) if s.is_empty() => return "-".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "yes" } else { "no" }.to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(items)) => items.iter().map(|i| cell(Some(i))).collect::<Vec<_>>().join(", "),
        Some(Value::Object(o)) => {
            match ["text", "name", "title", "label", "id"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)) {
                Some(s) => s.to_owned(),
                None => Value::Object(o.clone()).to_string(),
            }
        }
    };
    one_line(&text)
}

fn flag(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true)))
}

/// `list`: one row per terminal. `*` marks the active one; ROLE says which
/// is the caller (self) and which it opened (child).
fn list_table(result: &Value) -> String {
    let Some(items) = result.as_array() else {
        return json(result);
    };
    if items.is_empty() {
        return "No terminals.\n".to_owned();
    }
    // (heading, widest a cell may be; 0 = as wide as it is)
    const COLUMNS: [(&str, usize); 7] =
        [("ID", 0), ("ROLE", 0), ("TITLE", 28), ("GROUP", 16), ("AGENT", 14), ("STATUS", 32), ("CWD", 0)];
    let mut rows: Vec<(bool, Vec<String>)> = vec![(false, COLUMNS.iter().map(|(h, _)| (*h).to_owned()).collect())];
    for item in items {
        let get = |k: &str| item.get(k);
        let role = if flag(get("self")) {
            "self"
        } else if flag(get("child")) {
            "child"
        } else {
            "-"
        };
        let cells = vec![
            cell(get("id")),
            role.to_owned(),
            cell(get("title")),
            cell(get("group")),
            cell(get("agent")),
            cell(get("status")),
            cell(get("cwd")),
        ];
        let cells = cells
            .into_iter()
            .zip(COLUMNS)
            .map(|(c, (_, max))| if max > 0 { clip(&c, max) } else { c })
            .collect();
        rows.push((flag(get("active")), cells));
    }
    let mut widths = vec![0; COLUMNS.len()];
    for (_, cells) in &rows {
        for (w, c) in widths.iter_mut().zip(cells) {
            *w = (*w).max(width(c));
        }
    }
    let mut out = String::new();
    for (active, cells) in rows {
        let mut line = String::from(if active { " * " } else { "   " });
        for (i, c) in cells.iter().enumerate() {
            line.push_str(c);
            if i + 1 < cells.len() {
                line.push_str(&" ".repeat(widths[i] - width(c) + 2));
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// `read-screen`: the lines as text, each ending in a newline.
fn screen(result: &Value) -> String {
    let lines: Vec<String> = match result {
        Value::Null => return String::new(),
        Value::String(s) => text_lines(s),
        Value::Object(o) => match (o.get("lines"), o.get("text")) {
            (Some(Value::Array(lines)), _) => {
                lines.iter().map(|l| l.as_str().map(str::to_owned).unwrap_or_else(|| l.to_string())).collect()
            }
            (None, Some(Value::String(t))) => text_lines(t),
            _ => return json(result),
        },
        _ => return json(result),
    };
    let mut out = String::new();
    for l in &lines {
        out.push_str(&screen_line(l.strip_suffix('\r').unwrap_or(l)));
        out.push('\n');
    }
    out
}

/// A text's lines; a final newline does not start another one.
fn text_lines(text: &str) -> Vec<String> {
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.is_empty() {
        return Vec::new();
    }
    text.split('\n').map(str::to_owned).collect()
}

/// `new-split`: the new terminal's id, alone on its line, for `$(…)`.
fn new_tab(result: &Value) -> String {
    let id = match result {
        Value::String(s) => Some(s.as_str()),
        Value::Object(o) => ["id", "tabId", "tab"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)),
        _ => None,
    };
    match id {
        Some(id) => format!("{}\n", one_line(id)),
        None => json(result),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ch(n: u32) -> char {
        char::from_u32(n).unwrap()
    }

    #[test]
    fn nothing_unsafe_reaches_the_terminal_in_human_output() {
        let evil: String = [
            "a",
            &ch(0x1b).to_string(),
            "]0;x",
            &ch(0x07).to_string(),
            &ch(0x9b).to_string(),
            "31m",
            &ch(0x202e).to_string(),
            "b",
            &ch(0x2028).to_string(),
            &ch(0x7f).to_string(),
            "\r\n\tc",
        ]
        .concat();
        // Named one by one, not through is_unsafe: the test must not lean on
        // the predicate it checks.
        let forbidden = [0x1b, 0x07, 0x9b, 0x202e, 0x2028, 0x7f, 0x0d, 0x0a].map(ch);
        let line = one_line(&evil);
        for c in forbidden {
            assert!(!line.contains(c), "{:#x} in {line:?}", c as u32);
        }
        assert!(!line.contains('\t'));
        assert!(line.starts_with('a') && line.ends_with('c'));
        let screen = screen_line(&evil);
        for c in forbidden {
            assert!(!screen.contains(c), "{:#x} in {screen:?}", c as u32);
        }
        assert!(screen.contains('\t'));
        // The zero-width joiner inside an emoji is not a control to strip.
        let family = format!("{}{}{}", ch(0x1F468), ch(0x200D), ch(0x1F469));
        assert_eq!(one_line(&family), family);
    }

    #[test]
    fn json_output_escapes_what_serde_json_leaves_raw() {
        let v = json!({ "t": format!("a{}b{}c{}d{}e", ch(0x9b), ch(0x202e), ch(0x2028), ch(0x7f)), "k": "한글" });
        let out = json(&v);
        assert!(out.ends_with('\n'));
        for n in [0x9b, 0x202e, 0x2028, 0x7f] {
            assert!(!out.contains(ch(n)), "{n:#x} raw in {out:?}");
        }
        assert!(out.contains("\\u009b") && out.contains("\\u202e") && out.contains("\\u2028") && out.contains("\\u007f"));
        assert!(out.contains("한글"), "Korean stays as it is: {out}");
        let back: Value = serde_json::from_str(out.trim_end()).unwrap();
        assert_eq!(back, v, "still the same JSON");
    }

    #[test]
    fn widths_of_korean_and_others() {
        assert_eq!(width("abc"), 3);
        assert_eq!(width("한글"), 4);
        assert_eq!(width("日本"), 4);
        assert_eq!(width(&format!("e{}", ch(0x301))), 1);
        assert_eq!(width(&ch(0x1F600).to_string()), 2);
        assert_eq!(clip("한글한글한글", 7), "한글한…");
        assert_eq!(width(&clip("한글한글한글", 7)), 7);
        assert_eq!(clip("abcdef", 6), "abcdef");
        assert_eq!(clip("abcdefg", 6), "abcde…");
    }

    #[test]
    fn list_as_a_table() {
        let result = json!([
            {"id": "tab-term-1", "title": "zsh", "cwd": "/Users/me/web", "group": "Main", "active": true,
             "agent": null, "status": null, "self": true, "child": false},
            {"id": "tab-term-12", "title": "빌드", "cwd": "/Users/me/api", "group": {"id": "g2", "name": "API"},
             "active": false, "agent": "opencode", "status": {"text": "Running tests", "tone": "info"},
             "self": false, "child": true},
            {"id": "tab-term-3", "title": format!("x{}y", ch(0x1b)), "cwd": null, "group": "Main", "active": false,
             "agent": {"name": "claude"}, "status": "", "self": false, "child": false},
        ]);
        let out = list_table(&result);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 4, "{out}");
        assert_eq!(lines[0], "   ID           ROLE   TITLE  GROUP  AGENT     STATUS         CWD");
        assert_eq!(lines[1], " * tab-term-1   self   zsh    Main   -         -              /Users/me/web");
        assert_eq!(lines[2], "   tab-term-12  child  빌드   API    opencode  Running tests  /Users/me/api");
        assert_eq!(lines[3], format!("   tab-term-3   -      x{}y    Main   claude    -              -", char::REPLACEMENT_CHARACTER));
        // Columns line up in display width, Korean included.
        let col = |l: &str| width(&l[..l.find("GROUP").or_else(|| l.find("Main")).or_else(|| l.find("API")).unwrap()]);
        assert_eq!(col(lines[0]), col(lines[1]));
        assert_eq!(col(lines[0]), col(lines[2]));
        assert_eq!(list_table(&json!([])), "No terminals.\n");
        assert_eq!(list_table(&json!({"odd": 1})), "{\"odd\":1}\n");
    }

    #[test]
    fn long_cells_are_clipped_but_ids_and_folders_are_not() {
        let long = "t".repeat(60);
        let cwd = format!("/{}", "d".repeat(80));
        let out = list_table(&json!([{ "id": "tab-term-1", "title": long, "cwd": cwd }]));
        let row = out.lines().nth(1).unwrap();
        assert!(row.contains(&format!("{}…", "t".repeat(27))), "{row}");
        assert!(row.ends_with(&cwd), "{row}");
    }

    #[test]
    fn screen_as_text() {
        assert_eq!(screen(&json!({"lines": ["$ ls", "a  b", ""], "alternate": false})), "$ ls\na  b\n\n");
        assert_eq!(screen(&json!({"lines": []})), "");
        assert_eq!(screen(&json!({"text": "one\ntwo\n"})), "one\ntwo\n");
        assert_eq!(screen(&json!({"text": "one\ntwo"})), "one\ntwo\n");
        assert_eq!(screen(&json!("one\r\ntwo")), "one\ntwo\n");
        assert_eq!(screen(&Value::Null), "");
        let evil = json!({"lines": [format!("ok{}[2J", ch(0x1b))]});
        assert_eq!(screen(&evil), format!("ok{}[2J\n", char::REPLACEMENT_CHARACTER));
        assert_eq!(screen(&json!(5)), "5\n");
    }

    #[test]
    fn new_split_prints_the_id_alone() {
        assert_eq!(new_tab(&json!("tab-term-9")), "tab-term-9\n");
        assert_eq!(new_tab(&json!({"id": "tab-term-9"})), "tab-term-9\n");
        assert_eq!(new_tab(&json!({"tabId": "tab-term-9"})), "tab-term-9\n");
        assert_eq!(new_tab(&json!({"other": 1})), "{\"other\":1}\n");
    }

    #[test]
    fn reporting_commands_print_nothing() {
        let quiet = [
            Command::Notify { title: "t".into(), body: None, occasion: None },
            Command::SetStatus { text: None, tone: None },
            Command::SetProgress { state: "remove", value: None },
            Command::Focus { target: "self".into() },
            Command::Send { target: "self".into(), text: None, keys: vec!["Enter".into()], raw: false },
        ];
        for c in quiet {
            assert_eq!(human(&c, &json!({"ok": true})), "", "{c:?}");
        }
    }
}
