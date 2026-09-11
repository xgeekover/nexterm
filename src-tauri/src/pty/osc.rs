//! OSC 133 shell-integration filter.
//!
//! The injected shell hooks (see `shell_integration.rs`) print
//! `ESC ] 133 ; <marker> [; exit] BEL` around every prompt/command:
//!
//! - `A` prompt start        → we stop forwarding output (prompt + typed echo)
//! - `C` command executed    → we start forwarding output
//! - `D;<exit>` command done → reported to the frontend as `pty-command-done`
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
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Filtered {
    /// Output bytes that belong to a running command (or to the shell before
    /// any marker was seen), as lossy UTF-8.
    pub output: String,
    pub markers: Vec<Marker>,
}

pub struct OscFilter {
    pending: Vec<u8>,
    forwarding: bool,
}

impl Default for OscFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl OscFilter {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            // Until the first prompt marker arrives, pass the shell's startup
            // output through so nothing is silently swallowed.
            forwarding: true,
        }
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
                if self.forwarding {
                    out.push(b);
                }
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
                if self.forwarding {
                    out.push(b);
                }
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
                    if self.forwarding {
                        out.extend_from_slice(&buf[i..]);
                    }
                } else {
                    self.pending = buf[i..].to_vec();
                }
                break;
            };

            let payload = &buf[start..payload_end];
            match parse_marker(payload) {
                Some(marker) => {
                    match marker {
                        Marker::PromptStart | Marker::CommandStart => self.forwarding = false,
                        Marker::CommandExecuted => self.forwarding = true,
                        Marker::CommandFinished(_) => self.forwarding = false,
                    }
                    markers.push(marker);
                }
                None => {
                    // Foreign OSC — pass through verbatim when forwarding.
                    if self.forwarding {
                        out.extend_from_slice(&buf[i..resume]);
                    }
                }
            }
            i = resume;
        }

        Filtered {
            output: String::from_utf8_lossy(&out).to_string(),
            markers,
        }
    }
}

fn parse_marker(payload: &[u8]) -> Option<Marker> {
    let text = std::str::from_utf8(payload).ok()?;
    let rest = text.strip_prefix("133;")?;
    let mut parts = rest.splitn(2, ';');
    let kind = parts.next()?;
    let arg = parts.next();
    match kind {
        "A" => Some(Marker::PromptStart),
        "B" => Some(Marker::CommandStart),
        "C" => Some(Marker::CommandExecuted),
        "D" => Some(Marker::CommandFinished(arg.and_then(|a| a.trim().parse::<u32>().ok()))),
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
    fn gates_prompt_and_echo_but_forwards_command_output() {
        let mut f = OscFilter::new();
        let r = feed_str(
            &mut f,
            "\x1b]133;D;0\x07\x1b]133;A\x07user@host % echo hi\r\n\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07\x1b]133;A\x07user@host % ",
        );
        assert_eq!(r.output, "hi\r\n");
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
        assert_eq!(b.output, "");
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
    fn exit_code_missing_is_none() {
        let mut f = OscFilter::new();
        let r = feed_str(&mut f, "\x1b]133;D\x07");
        assert_eq!(r.markers, vec![Marker::CommandFinished(None)]);
    }
}
