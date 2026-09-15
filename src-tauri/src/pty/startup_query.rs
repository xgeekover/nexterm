//! ConPTY's startup cursor query.
//!
//! `portable-pty` creates the pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR`
//! (portable-pty 0.9.0, src/win/psuedocon.rs). In that mode the very first
//! thing ConPTY writes is `ESC[6n` — "where is the cursor?" — and it then holds
//! the shell back, prompt and input alike, until the terminal answers.
//!
//! The terminal that would answer is xterm.js in the webview, and its
//! `pty-output` listener attaches only after `pty_spawn` has returned and the
//! tab has rendered. The query is written within milliseconds of the spawn, so
//! it went past before anyone was listening, nothing ever answered, and the
//! terminal sat blank and ignored every key. Measured on Windows 10 19045 with
//! cmd.exe: unanswered, the query is the only output and a typed command
//! produces nothing; answered, the banner and the prompt follow at once.
//!
//! So the backend answers it, and swallows the query so xterm.js cannot answer
//! a second time. Only a query at the very start of the stream is ours — a
//! program that asks later gets xterm's real answer as usual.

pub const QUERY: &[u8] = b"\x1b[6n";

/// A pseudoconsole that has not drawn anything yet has its cursor at the origin.
pub const ANSWER: &[u8] = b"\x1b[1;1R";

/// What to do with one chunk of shell output.
pub struct Scan {
    /// Bytes to pass on to the terminal.
    pub forward: Vec<u8>,
    /// Bytes to write back to the shell, if the query was found.
    pub answer: Option<&'static [u8]>,
}

/// Watches the start of one session's output for the query.
#[derive(Default)]
pub struct StartupCursorQuery {
    held: Vec<u8>,
    done: bool,
}

impl StartupCursorQuery {
    /// True once the start of the stream has been decided either way; from
    /// then on `feed` passes everything through.
    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Scan {
        if self.done {
            return Scan { forward: chunk.to_vec(), answer: None };
        }
        self.held.extend_from_slice(chunk);
        if self.held.len() < QUERY.len() && QUERY.starts_with(&self.held) {
            // Could still be the query, split across reads: hold it back.
            return Scan { forward: Vec::new(), answer: None };
        }
        self.done = true;
        let held = std::mem::take(&mut self.held);
        match held.strip_prefix(QUERY) {
            Some(rest) => Scan { forward: rest.to_vec(), answer: Some(ANSWER) },
            None => Scan { forward: held, answer: None },
        }
    }

    /// The stream ended while a possible query was held back: hand those bytes
    /// over rather than losing them.
    pub fn take_held(&mut self) -> Vec<u8> {
        self.done = true;
        std::mem::take(&mut self.held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_query_is_answered_and_never_reaches_the_terminal() {
        let mut q = StartupCursorQuery::default();
        let scan = q.feed(QUERY);
        assert_eq!(scan.answer, Some(ANSWER));
        assert!(scan.forward.is_empty());
        assert!(q.is_done());
    }

    #[test]
    fn output_after_the_query_in_the_same_read_is_kept() {
        let mut q = StartupCursorQuery::default();
        let scan = q.feed(b"\x1b[6n\x1b[mMicrosoft Windows");
        assert_eq!(scan.answer, Some(ANSWER));
        assert_eq!(scan.forward, b"\x1b[mMicrosoft Windows");
    }

    #[test]
    fn a_query_split_across_reads_is_still_recognised() {
        let mut q = StartupCursorQuery::default();
        for part in [&b"\x1b"[..], b"[6"] {
            let scan = q.feed(part);
            assert!(scan.answer.is_none());
            assert!(scan.forward.is_empty(), "a possible query must be held back");
        }
        let scan = q.feed(b"nC:\\>");
        assert_eq!(scan.answer, Some(ANSWER));
        assert_eq!(scan.forward, b"C:\\>");
    }

    #[test]
    fn a_stream_that_does_not_start_with_the_query_passes_through_untouched() {
        let mut q = StartupCursorQuery::default();
        let scan = q.feed(b"user@host % ");
        assert!(scan.answer.is_none());
        assert_eq!(scan.forward, b"user@host % ");
        assert!(q.is_done());
    }

    #[test]
    fn a_prefix_that_turns_into_something_else_is_released_whole() {
        let mut q = StartupCursorQuery::default();
        assert!(q.feed(b"\x1b[").forward.is_empty());
        let scan = q.feed(b"31mred");
        assert!(scan.answer.is_none());
        assert_eq!(scan.forward, b"\x1b[31mred");
    }

    #[test]
    fn only_the_first_query_is_ours() {
        let mut q = StartupCursorQuery::default();
        q.feed(b"prompt> ");
        let later = q.feed(QUERY);
        assert!(later.answer.is_none(), "a program asking later is answered by xterm, not by us");
        assert_eq!(later.forward, QUERY);
    }

    #[test]
    fn bytes_held_when_the_stream_ends_are_not_lost() {
        let mut q = StartupCursorQuery::default();
        q.feed(b"\x1b[");
        assert_eq!(q.take_held(), b"\x1b[");
        assert!(q.is_done());
    }
}
