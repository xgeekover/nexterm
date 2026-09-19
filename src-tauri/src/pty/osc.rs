//! OSC 133 / OSC 7 shell-integration filter.
//!
//! The injected shell hooks (see `shell_integration.rs`) print
//! `ESC ] 133 ; <marker> [; exit] BEL` around every prompt/command:
//!
//! - `A` prompt start
//! - `B` command start
//! - `C` command executed
//! - `D;<exit>` command done → reported to the frontend as `pty-command-done`
//!
//! The same hooks also print `ESC ] 7 ; file://<host><path> BEL` (OSC 7,
//! the same "report the live working directory" convention VS Code, iTerm2
//! and Warp use) on every prompt, so the app always knows where the shell
//! actually is — not just where it was originally spawned. `<path>` is
//! percent-encoded per RFC 3986; this filter percent-decodes it before
//! reporting it as `Marker::WorkingDirectory` → the frontend sees it as a
//! `pty-cwd` event (see `manager.rs`). `<host>` is accepted but ignored —
//! only the path is meaningful here.
//!
//! This is a *real terminal*: every byte the shell writes — prompts, the
//! echo of what you type, command output — is forwarded to the screen
//! unchanged. The only bytes this filter ever removes are the OSC 133/OSC 7
//! marker sequences themselves (so neither `\e]133;...` nor `\e]7;...` ever
//! reaches xterm), while still reporting the markers it recognised so the
//! app can react to command boundaries and cwd changes.
//!
//! Everything else in the byte stream passes through untouched, including
//! other OSC sequences (window title, hyperlinks) and CSI colour codes.
//! Sequences may be split across `read()` chunks, so an incomplete escape
//! tail is held back until the next chunk completes it.

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// Upper bound for a held-back partial sequence; beyond this it is flushed as text.
const MAX_PENDING: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    PromptStart,
    CommandStart,
    CommandExecuted,
    CommandFinished(Option<u32>),
    /// OSC 7: the shell's live working directory, percent-decoded, host
    /// component (if any) stripped.
    WorkingDirectory(String),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Filtered {
    /// All non-marker output bytes from this chunk, as lossy UTF-8 — prompts,
    /// typed-input echo and command output alike.
    pub output: String,
    pub markers: Vec<Marker>,
}

#[derive(Default)]
pub struct OscFilter {
    pending: Vec<u8>,
    /// Trailing bytes of a multi-byte UTF-8 character that the last chunk cut
    /// in half. A PTY read boundary lands mid-character often — every 4 KB of
    /// output — and decoding each chunk on its own would turn both halves into
    /// U+FFFD before the frontend ever sees them.
    utf8_tail: Vec<u8>,
}

impl OscFilter {
    pub fn new() -> Self {
        Self { pending: Vec::new(), utf8_tail: Vec::new() }
    }

    /// Anything still held back, for the caller to flush at EOF.
    pub fn take_utf8_tail(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.utf8_tail)
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Filtered {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);

        let mut out: Vec<u8> = Vec::with_capacity(buf.len());
        let mut markers = Vec::new();
        let mut i = 0;

        while i < buf.len() {
            let b = buf[i];
            if b != ESC {
                out.push(b);
                i += 1;
                continue;
            }

            // ESC at the very end: we cannot tell what follows yet.
            if i + 1 >= buf.len() {
                self.pending = buf[i..].to_vec();
                break;
            }

            if buf[i + 1] != b']' {
                // Not an OSC (CSI etc.) — forward the ESC and keep scanning.
                out.push(b);
                i += 1;
                continue;
            }

            // OSC: find the terminator (BEL or ESC \).
            let start = i + 2;
            let mut j = start;
            let mut end: Option<(usize, usize)> = None; // (payload_end, resume_index)
            while j < buf.len() {
                if buf[j] == BEL {
                    end = Some((j, j + 1));
                    break;
                }
                if buf[j] == ESC {
                    if j + 1 < buf.len() {
                        if buf[j + 1] == b'\\' {
                            end = Some((j, j + 2));
                        } else {
                            // A stray ESC inside an OSC: treat as malformed and
                            // resynchronise from here.
                            end = Some((j, j));
                        }
                        break;
                    }
                    // ESC is the last byte; need more data to decide.
                    break;
                }
                j += 1;
            }

            let Some((payload_end, resume)) = end else {
                if buf.len() - i > MAX_PENDING {
                    // Give up on this sequence; emit it as plain text.
                    out.extend_from_slice(&buf[i..]);
                } else {
                    self.pending = buf[i..].to_vec();
                }
                break;
            };

            let payload = &buf[start..payload_end];
            match parse_marker(payload) {
                Some(marker) => {
                    // Recognised OSC 133 marker: strip it from the stream but
                    // report it — never gate the surrounding output on it.
                    markers.push(marker);
                }
                None => {
                    // Foreign OSC (window title, hyperlinks, ...) — always
                    // pass through verbatim.
                    out.extend_from_slice(&buf[i..resume]);
                }
            }
            i = resume;
        }

        // Re-attach whatever the previous chunk could not finish, then hold
        // back a truncated character for the next one. Continuation bytes are
        // all >= 0x80, so they can never be mistaken for ESC, ']' or BEL and
        // this is safe alongside the escape scanner above.
        if !self.utf8_tail.is_empty() {
            let mut joined = std::mem::take(&mut self.utf8_tail);
            joined.extend_from_slice(&out);
            out = joined;
        }
        if let Err(e) = std::str::from_utf8(&out) {
            // `error_len() == None` means "ran out of bytes", i.e. truncated
            // rather than genuinely malformed. Only that is worth waiting for;
            // real garbage still goes through the lossy conversion.
            if e.error_len().is_none() {
                let valid = e.valid_up_to();
                if out.len() - valid <= 3 {
                    self.utf8_tail = out[valid..].to_vec();
                    out.truncate(valid);
                }
            }
        }

        Filtered {
            output: String::from_utf8_lossy(&out).to_string(),
            markers,
        }
    }
}

fn parse_marker(payload: &[u8]) -> Option<Marker> {
    let text = std::str::from_utf8(payload).ok()?;

    if let Some(rest) = text.strip_prefix("133;") {
        let mut parts = rest.splitn(2, ';');
        let kind = parts.next()?;
        let arg = parts.next();
        return match kind {
            "A" => Some(Marker::PromptStart),
            "B" => Some(Marker::CommandStart),
            "C" => Some(Marker::CommandExecuted),
            "D" => Some(Marker::CommandFinished(arg.and_then(|a| a.trim().parse::<u32>().ok()))),
            _ => None,
        };
    }

    if let Some(rest) = text.strip_prefix("7;") {
        return parse_osc7_path(rest).map(Marker::WorkingDirectory);
    }

    None
}

/// Parse an OSC 7 payload's `file://<host><path>` URI — `<host>` is optional
/// (an empty string is fine, e.g. `file:///Users/dev`) and always discarded,
/// since only the absolute path matters to callers. Returns `None` for
/// anything that isn't a `file://` URI with an absolute path, so a foreign
/// use of OSC 7 falls through to the "pass it through unchanged" path
/// alongside every other unrecognised OSC sequence.
fn parse_osc7_path(rest: &str) -> Option<String> {
    let uri = rest.strip_prefix("file://")?;
    let path_start = uri.find('/')?;
    Some(as_native_path(&percent_decode(&uri[path_start..])))
}

/// Turn an OSC 7 URI path back into a path the OS can actually use.
///
/// A `file://` URI path is always absolute and always starts with `/`, so a
/// Windows directory travels as `/C:/Users/dev` — the shape our PowerShell
/// integration deliberately produces, and the shape cmd produces too once the
/// drive letter is spliced in. Nothing turned it back, so `tab.cwd` held
/// `/C:/Users/dev`: a string Windows cannot open. It went into the panel, into
/// *Copy Path*, and into saved sessions, where respawning a terminal at it
/// failed and silently fell back to the workspace root.
///
/// The decision is made by the SHAPE of the path, never by the host OS: a
/// `/C:/…` payload is a Windows path whichever machine parses it, which also
/// means the tests mean the same thing everywhere.
fn as_native_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let is_drive = bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
        && (bytes.len() == 3 || bytes[3] == b'/' || bytes[3] == b'\\');
    if !is_drive {
        return path.to_string();
    }
    // "/C:" is the drive itself: it needs its separator back, or it reads as
    // "the current directory on C:" rather than the root of it.
    let rest = &path[1..];
    let rooted = if rest.len() == 2 { format!("{rest}\\") } else { rest.to_string() };
    rooted.replace('/', "\\")
}

/// RFC 3986 percent-decoding. Invalid/incomplete `%XX` escapes are copied
/// through literally rather than rejected outright — a real path should
/// never contain one, but there is no reason to lose the rest of an
/// otherwise-good path over it.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_str(f: &mut OscFilter, s: &str) -> Filtered {
        f.feed(s.as_bytes())
    }

    #[test]
    fn passes_plain_text_before_any_marker() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "Last login: today\r\n");
        assert_eq!(r.output, "Last login: today\r\n");
        assert!(r.markers.is_empty());
    }

    #[test]
    fn forwards_prompt_echo_and_command_output_while_stripping_markers() {
        // Real-terminal behaviour: the prompt text and the echo of what the
        // user typed must reach the screen, exactly like every other byte —
        // only the OSC 133 marker sequences themselves are removed.
        let mut f = OscFilter::new();
        let r = feed_str(
            &mut f,
            "\x1b]133;D;0\x07\x1b]133;A\x07user@host % echo hi\r\n\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07\x1b]133;A\x07user@host % ",
        );
        assert_eq!(r.output, "user@host % echo hi\r\nhi\r\nuser@host % ");
        assert_eq!(
            r.markers,
            vec![
                Marker::CommandFinished(Some(0)),
                Marker::PromptStart,
                Marker::CommandExecuted,
                Marker::CommandFinished(Some(0)),
                Marker::PromptStart,
            ]
        );
    }

    #[test]
    fn reports_non_zero_exit_codes() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;C\x07boom\r\n\x1b]133;D;127\x07");
        assert_eq!(r.output, "boom\r\n");
        assert_eq!(r.markers.last(), Some(&Marker::CommandFinished(Some(127))));
    }

    #[test]
    fn handles_sequences_split_across_chunks() {
        let mut f = OscFilter::new();
        let a = feed_str(&mut f, "\x1b]133;C\x07out-1\x1b]13");
        assert_eq!(a.output, "out-1");
        assert_eq!(a.markers, vec![Marker::CommandExecuted]);
        let b = feed_str(&mut f, "3;D;2\x07trailing prompt");
        // Text after the (stripped) D marker is still forwarded — nothing
        // gates output based on marker kind any more.
        assert_eq!(b.output, "trailing prompt");
        assert_eq!(b.markers, vec![Marker::CommandFinished(Some(2))]);
    }

    #[test]
    fn split_on_the_escape_byte_itself() {
        let mut f = OscFilter::new();
        let a = feed_str(&mut f, "\x1b]133;C\x07abc\x1b");
        assert_eq!(a.output, "abc");
        let b = feed_str(&mut f, "]133;D;0\x07");
        assert_eq!(b.output, "");
        assert_eq!(b.markers, vec![Marker::CommandFinished(Some(0))]);
    }

    #[test]
    fn accepts_st_terminator() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;C\x1b\\ok\x1b]133;D;0\x1b\\");
        assert_eq!(r.output, "ok");
        assert_eq!(r.markers, vec![Marker::CommandExecuted, Marker::CommandFinished(Some(0))]);
    }

    #[test]
    fn foreign_osc_and_csi_pass_through_while_forwarding() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;C\x07\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b]133;D;0\x07");
        assert_eq!(r.output, "\x1b]0;title\x07\x1b[31mred\x1b[0m");
    }

    #[test]
    fn foreign_osc_and_csi_pass_through_outside_any_command_span() {
        // Before any 133;C and after a 133;D, output used to be gated. Now a
        // foreign OSC (e.g. window-title) and CSI colour codes in the prompt
        // itself must still reach the screen.
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;A\x07\x1b]0;my-title\x07\x1b[32m$\x1b[0m ");
        assert_eq!(r.output, "\x1b]0;my-title\x07\x1b[32m$\x1b[0m ");
        assert_eq!(r.markers, vec![Marker::PromptStart]);
    }

    #[test]
    fn exit_code_missing_is_none() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;D\x07");
        assert_eq!(r.markers, vec![Marker::CommandFinished(None)]);
    }

    #[test]
    fn osc7_parsed_and_stripped() {
        let mut f = OscFilter::new();
        let r = feed_str(
            &mut f,
            "\x1b]7;file://myhost/Users/dev/project\x07user@host % ",
        );
        assert_eq!(r.output, "user@host % ", "the OSC 7 sequence itself must never reach the screen");
        assert_eq!(r.markers, vec![Marker::WorkingDirectory("/Users/dev/project".to_string())]);
    }

    #[test]
    fn osc7_percent_encoded_path_is_decoded() {
        let mut f = OscFilter::new();
        // A space and a literal '%' in the directory name, percent-encoded.
        let r = feed_str(&mut f, "\x1b]7;file://myhost/Users/dev/My%20Project%2520\x07");
        assert_eq!(
            r.markers,
            vec![Marker::WorkingDirectory("/Users/dev/My Project%20".to_string())]
        );
    }

    #[test]
    fn a_windows_drive_path_comes_back_as_a_windows_path() {
        // What PowerShell and cmd actually put on the wire. `tab.cwd` used to
        // keep the URI form, which Windows cannot open.
        assert_eq!(
            parse_osc7_path("file:///C:/Users/dev/project"),
            Some("C:\\Users\\dev\\project".to_string())
        );
        // cmd's $P already uses backslashes; only the leading slash is ours.
        assert_eq!(
            parse_osc7_path("file:///C:\\Users\\dev"),
            Some("C:\\Users\\dev".to_string())
        );
        // A drive root keeps its separator: "C:" alone means "wherever I last
        // was on C:", which is not what the shell said.
        assert_eq!(parse_osc7_path("file:///C:/"), Some("C:\\".to_string()));
        assert_eq!(parse_osc7_path("file:///D:"), Some("D:\\".to_string()));
        // A percent-encoded drive path decodes first, then normalises.
        assert_eq!(
            parse_osc7_path("file:///C:/Users/my%20name"),
            Some("C:\\Users\\my name".to_string())
        );
    }

    #[test]
    fn a_posix_path_is_left_exactly_as_it_arrived() {
        assert_eq!(
            parse_osc7_path("file:///Users/dev/project"),
            Some("/Users/dev/project".to_string())
        );
        // Not a drive letter — a directory that merely starts with one.
        assert_eq!(parse_osc7_path("file:///C/notadrive"), Some("/C/notadrive".to_string()));
        assert_eq!(parse_osc7_path("file:///Cx:/nope"), Some("/Cx:/nope".to_string()));
        assert_eq!(parse_osc7_path("file:///"), Some("/".to_string()));
    }

    #[test]
    fn osc7_with_no_host() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]7;file:///Users/dev\x07");
        assert_eq!(r.markers, vec![Marker::WorkingDirectory("/Users/dev".to_string())]);
    }

    #[test]
    fn osc7_split_across_chunks() {
        let mut f = OscFilter::new();
        let a = feed_str(&mut f, "before\x1b]7;file://host/Users/d");
        assert_eq!(a.output, "before");
        assert!(a.markers.is_empty());
        let b = feed_str(&mut f, "ev/proj\x07after");
        assert_eq!(b.output, "after");
        assert_eq!(b.markers, vec![Marker::WorkingDirectory("/Users/dev/proj".to_string())]);
    }

    #[test]
    fn osc7_alongside_osc133_markers() {
        let mut f = OscFilter::new();
        let r = feed_str(
            &mut f,
            "\x1b]133;D;0\x07\x1b]7;file://h/work\x07\x1b]133;A\x07user@host % ",
        );
        assert_eq!(r.output, "user@host % ");
        assert_eq!(
            r.markers,
            vec![
                Marker::CommandFinished(Some(0)),
                Marker::WorkingDirectory("/work".to_string()),
                Marker::PromptStart,
            ]
        );
    }

    #[test]
    fn malformed_osc7_falls_through_as_foreign_osc() {
        // Not a `file://` URI — not our marker, so it must pass through
        // untouched, same as any other unrecognised OSC sequence.
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]7;not-a-uri\x07ok");
        assert_eq!(r.output, "\x1b]7;not-a-uri\x07ok");
        assert!(r.markers.is_empty());
    }

    /// A PTY read boundary lands mid-character roughly every 4 KB of output.
    /// Decoding each chunk on its own destroyed both halves; these walk every
    /// split point of a mixed-script string and demand a byte-exact result.
    #[test]
    fn multibyte_characters_survive_every_chunk_boundary() {
        let text = "안녕하세요 ✅ café 🚀 ─────";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut filter = OscFilter::new();
            let mut got = String::new();
            got.push_str(&filter.feed(&bytes[..split]).output);
            got.push_str(&filter.feed(&bytes[split..]).output);
            got.push_str(&String::from_utf8_lossy(&filter.take_utf8_tail()));
            assert_eq!(got, text, "corrupted when split at byte {split}");
            assert!(!got.contains('\u{FFFD}'), "replacement char at split {split}");
        }
    }

    #[test]
    fn a_character_split_across_three_chunks_survives() {
        // 🚀 is four bytes; feed it one byte at a time.
        let bytes = "🚀".as_bytes();
        let mut filter = OscFilter::new();
        let mut got = String::new();
        for b in bytes {
            got.push_str(&filter.feed(&[*b]).output);
        }
        assert_eq!(got, "🚀");
        assert!(filter.take_utf8_tail().is_empty());
    }

    #[test]
    fn markers_still_parse_when_a_chunk_ends_mid_character() {
        let mut filter = OscFilter::new();
        let mut payload = "한".as_bytes().to_vec();
        let tail = payload.split_off(1); // cut the first character in half
        let first = filter.feed(&payload);
        assert!(first.markers.is_empty());

        let mut rest = tail;
        rest.extend_from_slice(b"\x1b]133;D;0\x07done");
        let second = filter.feed(&rest);
        assert_eq!(second.output, "한done");
        assert_eq!(second.markers.len(), 1);
        assert!(matches!(second.markers[0], Marker::CommandFinished(Some(0))));
    }

    #[test]
    fn genuinely_invalid_bytes_are_not_held_back_forever() {
        let mut filter = OscFilter::new();
        // 0xFF can never start a UTF-8 sequence; it must go through lossily
        // instead of stalling the stream.
        let out = filter.feed(&[0xFF, b'o', b'k']);
        assert!(out.output.ends_with("ok"));
        assert!(filter.take_utf8_tail().is_empty());
    }
}
