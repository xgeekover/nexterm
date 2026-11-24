//! Help and usage texts. ASCII only, so they read the same in any console.

use crate::args::UsageError;

const OVERVIEW: &str = "\
nexterm-cli - control NexTerm from a program running in one of its terminals

Usage: nexterm-cli [--json] <command> [arguments]

Commands:
  notify <title> [body] [--occasion always|unfocused|invisible]
      Show a notification from this terminal.
  set-status <text> [--tone info|warn|error]
  set-status --clear
      Set or clear this terminal's line on the status board.
  set-title <text>
  set-title --clear
      Name this terminal's tab, or stop naming it.
  set-progress <0-100> | --indeterminate | --error [n] | --warning [n] | --clear
      Show progress on this terminal's tab.
  list
      List the terminals in this window.
  new-split [--right|--down] [--cwd DIR] [-- command...]
      Open a terminal beside this one and print its id.
  send [--to TARGET] [--raw] [--keys KEY...] [TEXT | -]
      Type text and press keys in a terminal.
  read-screen [--of TARGET] [--lines N] [--no-mask]
      Print what a terminal shows.
  focus [TARGET]
      Switch the window to a terminal.
  wait TARGET [--for idle|exit] [--timeout DURATION]
      Wait until another terminal is idle, or has exited.
  guide [topic]
      Which command to use when: a short guide for agents and scripts.
  help [command]
      Show help for a command.

TARGET is self (this terminal, the default), a tab id from 'list', or
child:<id> for a terminal this one opened with new-split.

Options:
  --json        Print NexTerm's answer as JSON.
  --version     Print the version.
  -h, --help    Show this help, or a command's.

It works only inside a NexTerm terminal, which sets NEXTERM_CONTROL and
NEXTERM_CONTROL_TOKEN. Settings > Terminal > Control decides what it may do.

Exit status:
  0  done
  1  failed (NexTerm said why)
  2  wrong usage, found here or by NexTerm; nothing was done
  3  not inside a NexTerm terminal
  4  refused: not allowed, no such terminal, or the socket or pipe is
     not this user's
  5  NexTerm is not running, busy, not responding, or its control is
     turned off (Settings > Terminal > Control); try again later
  6  wait: timed out
  7  wait: blocked, the terminal is waiting for input
  8  wait: the terminal exited or was closed before it was idle
";

/// `(usage lines, description)` of each command.
fn command(cmd: &str) -> (&'static str, &'static str) {
    match cmd {
        "notify" => (
            "nexterm-cli notify <title> [body] [--occasion always|unfocused|invisible]",
            "\
Shows a notification from this terminal, as a program in it could with
OSC 9 or 777, with the same limits.

  --occasion  always: whatever you are looking at
              unfocused: only when NexTerm is not the active app
              invisible: only when this terminal is not on screen
              (default: always)
",
        ),
        "set-status" => (
            "nexterm-cli set-status <text> [--tone info|warn|error]\n       nexterm-cli set-status --clear",
            "\
Sets this terminal's line on the status board (at most 80 characters are
shown), or clears it. The words are joined with spaces, so quoting is
optional. The line also goes when the shell exits or the terminal closes.

  --tone   info, warn or error: how the line is colored
  --clear  remove the line
",
        ),
        "set-title" => (
            "nexterm-cli set-title <text>\n       nexterm-cli set-title --clear",
            "\
Gives this terminal's tab a title, or removes it. The words are joined
with spaces, so quoting is optional. A text over 200 characters is
refused (exit 2) and nothing is set. Secrets such as *_TOKEN=... are
masked, and NexTerm may shorten a title further when masking made it
longer. A name you gave the tab yourself (Rename) stays: the title shows
only on a tab you did not name.

  --clear  remove the title
",
        ),
        "set-progress" => (
            "nexterm-cli set-progress <0-100> | --clear\n       \
             nexterm-cli set-progress --indeterminate\n       \
             nexterm-cli set-progress --error [n] | --warning [n]",
            "\
Shows progress on this terminal's tab (and the taskbar on Windows).

  <0-100>          how far along, in percent
  --indeterminate  busy, with no way to tell how far
  --error [n]      failed (at n percent)
  --warning [n]    in trouble (at n percent)
  --clear          remove the progress
",
        ),
        "list" => (
            "nexterm-cli list",
            "\
Lists the terminals in this window: id, ROLE (self: this terminal; child:
one it opened with new-split), title, group, agent, status and folder.
* marks the active terminal. --json gives every field.
",
        ),
        "new-split" => (
            "nexterm-cli new-split [--right|--down] [--cwd DIR] [-- command...]",
            "\
Opens a terminal beside this one, with the same shell, and prints its id.
It becomes this terminal's child: send, read-screen and focus can reach it
as child:<id>.

  --right, --down  where it opens (default: --right)
  --cwd DIR        the folder it starts in (default: this terminal's).
                   From WSL, a Windows path (C:\\...), or leave it out.
  -- command...    typed into the new shell as one line once it is ready.
                   The words are joined with spaces, so their quoting is
                   lost; to keep it, quote the whole command as one word:
                     nexterm-cli new-split -- \"printf '%s\\n' 'a b'\"
",
        ),
        "send" => (
            "nexterm-cli send [--to TARGET] [--raw] [--keys KEY...] [TEXT | -]",
            "\
Types TEXT into a terminal, then presses each KEY in order. Never into a
password prompt.

  TEXT           the text to type, or - to read it from standard input
                 (at most 16384 bytes, sent as it is). One line break at
                 its very end is pressed as Enter, so
                   echo make | nexterm-cli send -
                 types make and runs it. Several lines need a program
                 that asked for bracketed paste, or --raw. After --, TEXT
                 is just text: send -- -la, send -- - (a dash).
  --to TARGET    self (default), a tab id, or child:<id>
  --keys KEY...  every word up to the next option: Enter, Tab, Escape,
                 Backspace, Up, Down, Left, Right, Home, End, PageUp,
                 PageDown, Delete, Insert, F1-F12, Space, and Ctrl+, Alt+
                 or Shift+ with a key (Ctrl+C, Shift+Enter)
  --raw          text with line breaks goes as typed even where the program
                 did not ask for bracketed paste (each line then runs)

Needs Settings > Terminal > Control > \"Let programs type into and read
terminals\"; another terminal than this one or its children also needs
\"Let programs control other terminals\".
",
        ),
        "read-screen" => (
            "nexterm-cli read-screen [--of TARGET] [--lines N] [--no-mask]",
            "\
Prints what a terminal shows: the screen, or with --lines its last N lines
(0-2000). A full-screen program's screen is read while it runs. Secrets
such as *_TOKEN=... are masked.

  --of TARGET  self (default), a tab id, or child:<id>
  --lines N    the last N lines instead of the screen
  --no-mask    leave secrets as they are (needs \"Let programs control
               other terminals\")

Needs Settings > Terminal > Control > \"Let programs type into and read
terminals\". A tab never shown since NexTerm started has no screen yet.
",
        ),
        "focus" => (
            "nexterm-cli focus [TARGET]",
            "\
Switches the window to a terminal: its group, its pane, its tab. NexTerm
is not pulled in front of other apps; it asks for attention instead.

  TARGET  self (default), a tab id, or child:<id>
",
        ),
        "wait" => (
            "nexterm-cli wait TARGET [--for idle|exit] [--timeout DURATION]",
            "\
Waits until another terminal is idle, or with --for exit until its shell
has exited or it was closed. It asks NexTerm for the list once a second
and never reads the screen, so it needs only control turned on.

  TARGET              a tab id from 'list', or child:<id> for a terminal
                      this one opened with new-split (not self)
  --for idle          (default) done once the terminal has stayed settled
                      (idle, failed, nothing going on, or waiting while its
                      agent is idle) for 1s after it was busy, or for 3.5s
                      if it was not seen busy
  --for exit          done once its shell has exited or it was closed
  --timeout DURATION  give up after 90 (seconds), 30s, 5m or 1h; at most
                      24h, 0 for no limit (default: 10m)

Blocked: the terminal is waiting for input while its agent is not idle,
such as a question or a permission prompt only a person can answer.

Prints one line, such as: tab-term-7 is idle after 2m 5s. With --json,
one object: target, outcome (idle, exited, closed, blocked, timed_out),
status and waited_ms.

Exit status: 0 done, 6 timed out, 7 blocked, 8 exited or closed before it
was idle (--for idle); 2, 3, 4 and 5 as for every command.
",
        ),
        _ => unreachable!("help for an unknown command"),
    }
}

pub fn help(topic: Option<&str>) -> String {
    match topic {
        None => OVERVIEW.to_owned(),
        Some(cmd) => {
            let (usage, about) = command(cmd);
            format!("Usage: {usage}\n\n{about}\nOptions for every command: --json, -h/--help.\n")
        }
    }
}

/// What a usage error prints (to stderr): the problem, the usage, a pointer.
pub fn usage_error(e: &UsageError) -> String {
    let message = crate::output::one_line(&e.message);
    match e.command {
        Some(cmd) => {
            let (usage, _) = command(cmd);
            format!("nexterm-cli: {message}\nUsage: {usage}\nRun 'nexterm-cli help {cmd}' for more.\n")
        }
        None => format!("nexterm-cli: {message}\nRun 'nexterm-cli help' for the commands.\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::COMMANDS;

    #[test]
    fn every_command_has_help_and_the_overview_names_it() {
        for cmd in COMMANDS {
            let h = help(Some(cmd));
            assert!(h.starts_with(&format!("Usage: nexterm-cli {cmd}")), "{h}");
            assert!(OVERVIEW.contains(&format!("\n  {cmd}")), "{cmd} missing from the overview");
        }
    }

    #[test]
    fn the_overview_names_the_guide_and_the_help_after_the_commands() {
        let guide = OVERVIEW.find("\n  guide [topic]\n      Which command to use when").expect("guide in the overview");
        let help = OVERVIEW.find("\n  help [command]\n").unwrap();
        let focus = OVERVIEW.find("\n  focus [TARGET]\n").unwrap();
        let wait = OVERVIEW.find("\n  wait TARGET [--for idle|exit] [--timeout DURATION]\n").expect("wait in the overview");
        assert!(focus < wait && wait < guide && guide < help, "{OVERVIEW}");
    }

    #[test]
    fn help_is_ascii_and_fits_80_columns() {
        let mut all = vec![help(None)];
        all.extend(COMMANDS.iter().map(|c| help(Some(c))));
        for text in all {
            for line in text.lines() {
                assert!(line.is_ascii(), "{line}");
                assert!(line.len() <= 80, "{} > 80: {line}", line.len());
            }
        }
    }

    #[test]
    fn the_overview_lists_the_exit_codes() {
        for code in ["  0  ", "  1  ", "  2  ", "  3  ", "  4  ", "  5  ", "  6  ", "  7  ", "  8  "] {
            assert!(OVERVIEW.contains(code), "{code}");
        }
        let codes: Vec<&str> = OVERVIEW[OVERVIEW.find("Exit status:\n").unwrap()..]
            .lines()
            .filter_map(|l| l.strip_prefix("  ").and_then(|l| l.split("  ").next()))
            .filter(|code| !code.is_empty())
            .collect();
        assert_eq!(codes, ["0", "1", "2", "3", "4", "5", "6", "7", "8"], "in order, each once");
        assert!(OVERVIEW.contains("  6  wait: timed out\n"));
        assert!(OVERVIEW.contains("  7  wait: blocked, the terminal is waiting for input\n"));
        assert!(OVERVIEW.contains("  8  wait: the terminal exited or was closed before it was idle\n"));
        // Turned off is 5, not 4: turning the API off closes the socket or
        // pipe, so nothing answers at all.
        let four = &OVERVIEW[OVERVIEW.find("  4  ").unwrap()..OVERVIEW.find("  5  ").unwrap()];
        let five = &OVERVIEW[OVERVIEW.find("  5  ").unwrap()..OVERVIEW.find("  6  ").unwrap()];
        assert!(!four.contains("Settings") && !four.contains("off"), "{four}");
        assert!(five.contains("turned off (Settings > Terminal > Control)"), "{five}");
        assert!(five.contains("busy"), "{five}");
        assert!(OVERVIEW.contains("  2  wrong usage, found here or by NexTerm; nothing was done"));
    }

    #[test]
    fn wait_help_names_the_target_the_options_and_the_exit_codes() {
        let h = help(Some("wait"));
        assert!(h.starts_with("Usage: nexterm-cli wait TARGET [--for idle|exit] [--timeout DURATION]\n"), "{h}");
        assert!(h.contains("a tab id from 'list', or child:<id>"), "{h}");
        assert!(h.contains("(not self)"), "{h}");
        assert!(h.contains("--for idle          (default)"), "{h}");
        assert!(h.contains("for 1s after it was busy, or for 3.5s"), "{h}");
        assert!(h.contains("--for exit"), "{h}");
        assert!(h.contains("90 (seconds), 30s, 5m or 1h; at most\n                      24h, 0 for no limit (default: 10m)"), "{h}");
        assert!(h.contains("Blocked: the terminal is waiting for input while its agent is not idle"), "{h}");
        assert!(h.contains("Exit status: 0 done, 6 timed out, 7 blocked, 8 exited or closed before it\nwas idle"), "{h}");
        assert!(h.contains("once a second\nand never reads the screen"), "{h}");
        let e = UsageError::of("wait", "wait needs a TARGET: a tab id from 'list', or child:<id>");
        assert_eq!(
            usage_error(&e),
            "nexterm-cli: wait needs a TARGET: a tab id from 'list', or child:<id>\n\
             Usage: nexterm-cli wait TARGET [--for idle|exit] [--timeout DURATION]\n\
             Run 'nexterm-cli help wait' for more.\n"
        );
    }

    #[test]
    fn new_split_help_says_how_quoting_and_wsl_go() {
        let h = help(Some("new-split"));
        assert!(h.contains("quote the whole command as one word"), "{h}");
        assert!(h.contains(r#"nexterm-cli new-split -- "printf '%s\n' 'a b'""#), "{h}");
        assert!(h.contains(r"From WSL, a Windows path (C:\...), or leave it out."), "{h}");
    }

    #[test]
    fn send_help_says_a_final_line_break_is_enter() {
        let h = help(Some("send"));
        assert!(h.contains("One line break at\n                 its very end is pressed as Enter"), "{h}");
        assert!(h.contains("echo make | nexterm-cli send -"), "{h}");
        assert!(h.contains("send -- - (a dash)"), "{h}");
    }

    #[test]
    fn set_title_help_names_clear_and_the_limit() {
        let h = help(Some("set-title"));
        assert!(h.starts_with("Usage: nexterm-cli set-title <text>\n       nexterm-cli set-title --clear\n"), "{h}");
        assert!(h.contains("A text over 200 characters is\nrefused (exit 2) and nothing is set."), "{h}");
        assert!(h.contains("NexTerm may shorten a title further when masking made it\nlonger."), "{h}");
        assert!(h.contains("--clear  remove the title"), "{h}");
        let e = UsageError::of("set-title", "set-title needs a text, or --clear");
        assert!(usage_error(&e).contains("Run 'nexterm-cli help set-title' for more."));
    }

    #[test]
    fn a_usage_error_shows_the_commands_usage() {
        let e = UsageError::of("focus", "focus takes one TARGET");
        assert_eq!(
            usage_error(&e),
            "nexterm-cli: focus takes one TARGET\nUsage: nexterm-cli focus [TARGET]\nRun 'nexterm-cli help focus' for more.\n"
        );
        let e = UsageError::general("no command given");
        assert_eq!(usage_error(&e), "nexterm-cli: no command given\nRun 'nexterm-cli help' for the commands.\n");
    }
}
