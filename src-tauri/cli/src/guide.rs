//! `nexterm-cli guide [topic]` (A9): a short usage guide for an agent or a
//! script, printed from here like the help. It never reads the environment,
//! connects, or writes a file, so it works anywhere, inside NexTerm or not.
//! The exact flags stay in `nexterm-cli help <command>` (usage.rs); this says
//! which command to use when. ASCII only, at most 80 columns, no colour, so
//! it reads the same in cmd, PowerShell and any other console.

/// The topics, in the order the index lists them (the order of the help).
pub const TOPICS: &[&str] = &["notify", "set-status", "set-title", "set-progress", "new-split", "read-screen", "wait"];

const INDEX: &str = "\
nexterm-cli guide - how an agent or a script uses nexterm-cli

Usage: nexterm-cli guide [topic]

Topics:
  notify        the user should look now: done, failed, or waiting for them
  set-status    one line on the status board: what this terminal is doing
  set-title     name this terminal's tab after its task
  set-progress  how far along a long job is, on the tab
  new-split     open a terminal beside this one for a server or a watcher
  read-screen   read what a terminal shows, and type into one with send
  wait          wait for another terminal to be idle, blocked or exited

In short: set-status (and set-progress) while you work, notify when the
user is needed, set-title once per task, wait for work you handed to a
split. Clear what you set when you are done.

nexterm-cli works only inside a NexTerm terminal, which sets
NEXTERM_CONTROL and NEXTERM_CONTROL_TOKEN. Check its exit status:
  0  done
  1  failed: NexTerm said why, on stderr
  2  wrong usage, nothing was done: see nexterm-cli help <command>
  3  not inside a NexTerm terminal: skip the call, nothing is wrong
  4  refused: not allowed (see nexterm-cli guide read-screen), there is
     no such terminal, or send found it read-only. Do not retry; tell the
     user if it matters.
  5  NexTerm is busy, not running, or its control is turned off: try
     again later, or skip the call
  6  wait timed out: wait again, or tell the user
  7  wait found the terminal blocked on a person (a question, a
     permission prompt): tell the user
  8  wait: the terminal exited or was closed before it was idle

This guide needs no NexTerm and changes nothing. The exact flags of a
command: nexterm-cli help <command>.
";

fn topic(name: &str) -> Option<&'static str> {
    Some(match name {
        "notify" => {
            "\
nexterm-cli guide notify - tell the user to look

Use notify when the user is needed now: the task is done, it failed, or
you are waiting for an answer or a permission. Not for every step; that
is what set-status is for.

  nexterm-cli notify \"Tests\" \"All 412 passed\"
  nexterm-cli notify \"Waiting\" \"Approve the migration\" --occasion unfocused

--occasion unfocused shows it only while NexTerm is not the active app,
invisible only while this terminal is not on screen; always (the default)
shows it whatever the user is looking at.

A terminal may notify once every 2 seconds and 10 times a minute, and
the notifications its programs print (OSC 9 or 777) count too. Beyond
that a call is refused as rate-limited: exit 5. NexTerm already tells the
user when Claude Code is done, without any hook, and that uses the same
allowance.

Exact flags: nexterm-cli help notify
"
        }
        "set-status" => {
            "\
nexterm-cli guide set-status - say what this terminal is doing

Use set-status for the one line the user reads about this terminal on the
status board (its row in the TERMINALS panel): what you are doing now.
Update it as you go and clear it when you are done. At most 80 characters
are shown; the words are joined with spaces, so quoting is optional.

  nexterm-cli set-status Running migrations
  nexterm-cli set-status --tone warn Waiting for your answer
  nexterm-cli set-status --tone error Build failed
  nexterm-cli set-status --clear

--tone colors the line: info, warn (say, while you wait for the user) or
error (something failed). Each call replaces the line; it also goes when
the shell exits or the terminal closes. A status does not make the user
look: when you need them now, notify as well.

Exact flags: nexterm-cli help set-status
"
        }
        "set-title" => {
            "\
nexterm-cli guide set-title - name this terminal's tab after its task

Use set-title once when you take on a task, so the user can tell the
terminals apart. It names only this terminal: its tab, its TERMINALS row
and its title in nexterm-cli list.

  nexterm-cli set-title Fix the login bug
  nexterm-cli set-title --clear

A name the user gave the tab (Rename) always wins: your title shows only
on a tab they have not named, and shows again if they clear their name.
It lasts until set-title --clear, until the shell exits or until a new
shell starts in that terminal; then the tab is Terminal N again. It is
never saved. One line: a text over 200 characters is refused (exit 2)
and nothing is set. Secrets such as *_TOKEN=... are masked, and NexTerm
may shorten a title further when masking made it longer.

Exact flags: nexterm-cli help set-title
"
        }
        "set-progress" => {
            "\
nexterm-cli guide set-progress - show how far along a long job is

Use set-progress for a job that takes a while: a bar on this terminal's
tab (and on the taskbar on Windows). Give a percent when you can tell,
--indeterminate when you cannot, and clear it when the job ends.

  nexterm-cli set-progress 40
  nexterm-cli set-progress --indeterminate
  nexterm-cli set-progress --error 70
  nexterm-cli set-progress --clear

--error [n] marks a job that failed (at n percent), --warning [n] one in
trouble. The bar has no words: say what the job is with set-status.

Exact flags: nexterm-cli help set-progress
"
        }
        "new-split" => {
            "\
nexterm-cli guide new-split - open a terminal beside this one

Use new-split for something that runs on its own while you keep working:
a dev server, a watcher, a log. It opens beside this terminal, in its
folder and shell, prints the new terminal's id (tab-term-7, say) and
leaves the keyboard where the user is.

  nexterm-cli new-split --down -- npm run dev
  nexterm-cli new-split --right

The new terminal is this one's child: send, read-screen and focus reach
it as child:<id> (see nexterm-cli guide read-screen). The command after
-- is typed into the new shell as one line once it is ready; its words
are joined with spaces, so quote the whole command as one word to keep
its own quoting. A command is typing: it needs the switch \"Let programs
type into and read terminals\", or the call is refused (exit 4); a split
without one does not. At most 8 splits open at a time per terminal, 32
in all, 10 a minute.

Exact flags: nexterm-cli help new-split
"
        }
        "read-screen" => {
            "\
nexterm-cli guide read-screen - read a terminal, and type into one with send

Use read-screen to see what a terminal shows (the dev server you opened
with new-split, say) and send to type into one. Both are off until the
user turns them on. Settings > Terminal > Control has three switches:

  \"Let programs in terminals control NexTerm\" (on by default)
      notify, set-status, set-title, set-progress, list, new-split, focus
  \"Let programs type into and read terminals\" (off by default)
      send, read-screen, and new-split with a command after --
  \"Let programs control other terminals\" (off by default)
      any terminal, not only this one and the splits it opened; and
      read-screen --no-mask

  nexterm-cli read-screen --lines 200
  nexterm-cli read-screen --of child:tab-term-7
  nexterm-cli send --to child:tab-term-7 \"npm test\" --keys Enter
  nexterm-cli send --to child:tab-term-7 --keys Ctrl+C

Secrets such as *_TOKEN=... are masked in what read-screen prints; only
--no-mask, with the third switch on, leaves them. Exit 4 means the switch
it needs is off or there is no such terminal: ask the user rather than
retry. A tab never shown since NexTerm started has no screen yet. send
never types into a password prompt, nor into a terminal the user made
read-only: that is refused with exit 4, whatever the switches say, until
they turn read-only off there (read-screen still reads it). The user sees
each call: the terminal flashes and is marked, and the palette's Show
Control Log lists it.

Exact flags: nexterm-cli help read-screen, nexterm-cli help send
"
        }
        "wait" => {
            "\
nexterm-cli guide wait - wait until another terminal is idle or has exited

Use wait when you handed work to another terminal (Claude Code in a split
you opened with new-split, say) and need to know it is done before you go
on. It asks NexTerm for the list once a second and never reads the
screen, so it needs only \"Let programs in terminals control NexTerm\",
like list. Ctrl+C stops it.

  nexterm-cli wait child:tab-term-7
  nexterm-cli wait child:tab-term-7 --timeout 30m
  nexterm-cli wait tab-term-3 --for exit --timeout 90
  nexterm-cli --json wait child:tab-term-7 --timeout 0

TARGET is a tab id from list, or child:<id> for a split this terminal
opened (one it did not open is exit 4); never self (exit 2).

  0  idle: it stayed settled (idle, nothing going on, its last command
     failed, or its agent idle with a notification unread) for 1s after
     it was seen busy, or for 3.5s if it never was. With --for exit:
     its shell has exited or it was closed.
  6  timed out: --timeout passed first (default 10m, at most 24h, 0 for
     no limit). Wait again, or tell the user.
  7  blocked: an unread notification while its agent is not idle, such
     as a question or a permission prompt only a person can answer. Tell
     the user.
  8  it exited or was closed before it was idle (--for idle only).

It prints one line, on stdout for 0 and on stderr for 6, 7 and 8. --json
prints one object on stdout instead: target, outcome (idle, exited,
closed, blocked, timed_out), status and waited_ms.

What it cannot see. Blocked comes only from what NexTerm hears: an unread
notification, and Claude Code's working or idle title. A permission
prompt is a 7 only when a notification reached NexTerm (Claude Code's
Kitty notifications, OSC 99, or a PermissionRequest hook that runs
nexterm-cli notify) while its title does not say idle. With none, it
reads as idle (exit 0) if the title says idle, or as busy until the
timeout (exit 6). Another agent or a plain shell reports no activity, so
any unread notification there counts as blocked. A split new-split just
opened looks settled until its command shows as started: if that takes
over 3.5s, wait calls it idle. list gives at most 200 terminals: one past
them looks absent (exit 4 at first, closed later).

Exact flags: nexterm-cli help wait
"
        }
        _ => return None,
    })
}

/// The guide's index (`None`) or one topic's text. An unknown topic is the
/// message for stderr, listing the topics: exit 2, like any wrong usage.
pub fn text(name: Option<&str>) -> Result<&'static str, String> {
    match name {
        None => Ok(INDEX),
        Some(name) => topic(name).ok_or_else(|| {
            format!(
                "nexterm-cli: unknown guide topic '{}'\n{}\nRun 'nexterm-cli guide' for the index.\n",
                crate::output::one_line(name),
                topic_list()
            )
        }),
    }
}

/// `Topics: notify, set-status, ...`, wrapped at 80 columns with each
/// further line lined up under the first topic.
fn topic_list() -> String {
    let mut out = String::from("Topics:");
    let mut width = out.len();
    for (i, t) in TOPICS.iter().enumerate() {
        let word = if i + 1 < TOPICS.len() { format!("{t},") } else { (*t).to_owned() };
        if width + 1 + word.len() > 80 {
            out.push_str("\n       ");
            width = 7;
        }
        out.push(' ');
        out.push_str(&word);
        width += 1 + word.len();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::{self, Parsed};
    use std::ffi::OsString;

    fn all() -> Vec<&'static str> {
        let mut texts = vec![INDEX];
        texts.extend(TOPICS.iter().map(|t| text(Some(t)).unwrap()));
        texts
    }

    #[test]
    fn the_index_lists_every_topic_and_each_has_a_text() {
        for t in TOPICS {
            assert!(INDEX.contains(&format!("\n  {t}  ")), "{t} missing from the index");
            let body = text(Some(t)).unwrap();
            assert!(body.starts_with(&format!("nexterm-cli guide {t} - ")), "{body}");
            // The exact flags stay in the help, which every topic points at.
            assert!(body.contains(&format!("nexterm-cli help {t}")), "{t}: {body}");
            assert!(body.ends_with('\n') && !body.ends_with("\n\n"), "{t}");
        }
        assert_eq!(TOPICS, ["notify", "set-status", "set-title", "set-progress", "new-split", "read-screen", "wait"]);
        assert!(INDEX.starts_with("nexterm-cli guide - "), "{INDEX}");
        assert!(INDEX.contains("Usage: nexterm-cli guide [topic]\n"));
        assert!(INDEX.contains("nexterm-cli help <command>"));
    }

    #[test]
    fn every_topic_is_a_command() {
        for t in TOPICS {
            assert!(args::COMMANDS.contains(t), "{t}");
        }
    }

    #[test]
    fn the_guide_is_ascii_without_colour_and_fits_80_columns() {
        let mut texts: Vec<String> = all().into_iter().map(str::to_owned).collect();
        texts.push(text(Some("frob")).unwrap_err());
        for t in texts {
            for line in t.lines() {
                assert!(line.is_ascii(), "{line}");
                // No escape (ANSI colour) or other control characters: cmd and
                // PowerShell would show them as they are.
                assert!(!line.chars().any(|c| c.is_ascii_control()), "{line:?}");
                assert!(line.len() <= 80, "{} > 80: {line}", line.len());
                assert_eq!(line, line.trim_end(), "trailing space");
            }
        }
    }

    #[test]
    fn an_unknown_topic_names_every_topic() {
        let e = text(Some("frob")).unwrap_err();
        assert_eq!(
            e,
            "nexterm-cli: unknown guide topic 'frob'\n\
             Topics: notify, set-status, set-title, set-progress, new-split, read-screen,\n        \
             wait\n\
             Run 'nexterm-cli guide' for the index.\n"
        );
        // Wrapped at 80 columns: every topic once, in order, nothing else.
        let list = &e[e.find("Topics: ").unwrap() + "Topics: ".len()..e.find("\nRun 'nexterm-cli guide'").unwrap()];
        let named: Vec<&str> = list.split(|c: char| c == ',' || c.is_whitespace()).filter(|w| !w.is_empty()).collect();
        assert_eq!(named, TOPICS, "{e}");
        assert!(e.lines().all(|l| l.len() <= 80), "{e}");
        // A command that is not a topic is still unknown here; so is a case
        // that differs, and a name with a line break stays on one line.
        for name in ["list", "send", "focus", "Notify", "", "set-status "] {
            assert!(text(Some(name)).unwrap_err().contains("Topics: notify, "), "{name:?}");
        }
        assert!(text(Some("a\nb")).unwrap_err().starts_with("nexterm-cli: unknown guide topic 'a b'\n"));
    }

    /// Splits an example the way sh, cmd and PowerShell all would: on spaces,
    /// with double quotes around a word that holds some.
    fn words(line: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut word = String::new();
        let (mut quoted, mut any) = (false, false);
        for c in line.chars() {
            match c {
                '"' => {
                    quoted = !quoted;
                    any = true;
                }
                ' ' if !quoted => {
                    if any {
                        out.push(std::mem::take(&mut word));
                    }
                    any = false;
                }
                c => {
                    word.push(c);
                    any = true;
                }
            }
        }
        assert!(!quoted, "unbalanced quotes: {line}");
        if any {
            out.push(word);
        }
        out
    }

    #[test]
    fn every_example_is_a_valid_command_line() {
        let mut seen = 0;
        for body in all() {
            for line in body.lines().filter_map(|l| l.strip_prefix("  nexterm-cli ")) {
                let argv: Vec<OsString> = words(line).into_iter().map(OsString::from).collect();
                match args::parse(&argv) {
                    Ok(Parsed::Run { .. }) => seen += 1,
                    other => panic!("{line}: {other:?}"),
                }
            }
        }
        assert!(seen >= 22, "{seen} examples");
        assert_eq!(words(r#"send --to x "npm test" --keys Enter"#), ["send", "--to", "x", "npm test", "--keys", "Enter"]);
    }

    /// The README from its Control section on, CRLF made LF: the repo has no
    /// .gitattributes, so a Windows checkout (CI) has CRLF line endings.
    fn control_section(readme: &str) -> String {
        let readme = readme.replace("\r\n", "\n");
        let at = readme.find("\n### Control NexTerm from a terminal\n").expect("the Control section");
        readme[at..].to_string()
    }

    #[test]
    fn read_screen_names_the_three_switches_as_the_readme_does_and_the_masking() {
        let body = text(Some("read-screen")).unwrap();
        let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md")).unwrap();
        let control = control_section(&readme);
        // The same section from either checkout, whichever this one is.
        let lf = readme.replace("\r\n", "\n");
        assert_eq!(control_section(&lf.replace('\n', "\r\n")), control, "a CRLF checkout");
        assert_eq!(control_section(&lf), control, "an LF checkout");
        for (switch, default) in [
            ("Let programs in terminals control NexTerm", "on"),
            ("Let programs type into and read terminals", "off"),
            ("Let programs control other terminals", "off"),
        ] {
            assert!(body.contains(&format!("\"{switch}\" ({default} by default)")), "{switch}: {body}");
            assert!(control.contains(&format!("| {switch} | {default} |")), "README: {switch}");
        }
        assert!(body.contains(
            "\"Let programs type into and read terminals\" (off by default)\n      \
             send, read-screen, and new-split with a command after --\n"
        ));
        assert!(body.contains("Secrets such as *_TOKEN=... are masked"), "{body}");
        assert!(body.contains("only\n--no-mask, with the third switch on, leaves them"), "{body}");
        assert!(body.contains("send\nnever types into a password prompt"), "{body}");
        // A split that types a command is typing (control/server.rs).
        let split = text(Some("new-split")).unwrap();
        assert!(split.contains("A command is typing: it needs the switch \"Let programs\ntype into and read terminals\""), "{split}");
        assert!(body.contains("nexterm-cli help send"), "{body}");
    }

    #[test]
    fn read_screen_says_send_to_a_read_only_terminal_is_refused_as_the_readme_does() {
        // Bundle 4, A3: a read-only terminal takes nothing from send (the
        // app's controlDispatcher.js refuses it with code `refused`, exit 4).
        let body = text(Some("read-screen")).unwrap();
        assert!(body.contains("nor into a terminal the user made\nread-only: that is refused with exit 4"), "{body}");
        assert!(body.contains("(read-screen still reads it)"), "{body}");
        assert!(INDEX.contains("or send found it read-only"), "{INDEX}");
        let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md")).unwrap();
        let control = control_section(&readme).replace('\n', " ");
        assert!(control.contains("`send` to a read-only terminal"), "README: the exit codes");
        assert!(control.contains("it is refused with exit 4 (\"that terminal is read-only\")"), "README: send");
        assert!(control.contains("`read-screen` still reads it"), "README: read-screen");
    }

    #[test]
    fn set_title_says_a_name_the_user_gave_wins() {
        let body = text(Some("set-title")).unwrap();
        assert!(body.contains("A name the user gave the tab (Rename) always wins"), "{body}");
        assert!(body.contains("shows only\non a tab they have not named"), "{body}");
        assert!(body.contains("then the tab is Terminal N again"), "{body}");
        assert!(body.contains("never saved"), "{body}");
        assert!(body.contains("a text over 200 characters is refused (exit 2)\nand nothing is set"), "{body}");
        assert!(body.contains("NexTerm\nmay shorten a title further when masking made it longer"), "{body}");
    }

    #[test]
    fn each_topic_says_when_to_use_it() {
        for (t, when) in [
            ("notify", "Use notify when the user is needed now"),
            ("set-status", "Use set-status for the one line"),
            ("set-title", "Use set-title once when you take on a task"),
            ("set-progress", "Use set-progress for a job that takes a while"),
            ("new-split", "Use new-split for something that runs on its own"),
            ("read-screen", "Use read-screen to see what a terminal shows"),
            ("wait", "Use wait when you handed work to another terminal"),
        ] {
            assert!(text(Some(t)).unwrap().contains(when), "{t}");
        }
        assert!(text(Some("notify")).unwrap().contains("rate-limited: exit 5"));
        assert!(INDEX.contains("  3  not inside a NexTerm terminal: skip the call"));
    }

    #[test]
    fn the_readme_describes_wait_its_exit_codes_and_every_guide_topic() {
        let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md")).unwrap();
        // Words only: a line break, or a list item's indent, is one space.
        let control = control_section(&readme).split_whitespace().collect::<Vec<_>>().join(" ");
        let topics = &control[control.find("`nexterm-cli guide <topic>` prints one of").expect("README: the guide's topics")..];
        let topics = &topics[..topics.find("; another word exits 2").expect("README: the guide's topics end")];
        for t in TOPICS {
            assert!(topics.contains(&format!("`{t}`")), "README: guide topic {t}");
        }
        for said in [
            "`wait` adds three of its own: 6 when it timed out, 7 when the terminal is blocked on a person, and 8 when the terminal exited or was closed before it was idle",
            "**Waiting for another terminal.** `nexterm-cli wait TARGET`",
            "for 1 second after it was seen busy",
            "or for 3.5 seconds if it was never seen busy",
            "at most `24h`, `0` for no limit; 10 minutes by default",
            "**Blocked is only what NexTerm hears**",
            "**`list` gives at most 200 terminals**",
            "**H12** — Claude Code in a child split",
            "(AC-B2-H1;",
            "**H13** — on Windows, `wait` works from cmd, from PowerShell and from WSL",
            "(AC-B2-H2;",
        ] {
            assert!(control.contains(said), "README: {said}");
        }
    }

    #[test]
    fn wait_says_what_each_outcome_means_with_wait_s_own_numbers() {
        use crate::args::{Command, Until, DEFAULT_WAIT_TIMEOUT, MAX_WAIT_TIMEOUT};
        use crate::exit;
        use crate::wait::{SETTLE, START_GRACE};
        let body = text(Some("wait")).unwrap();
        // The times are wait.rs's and args.rs's: change one, change the guide.
        assert!(body.contains(&format!("for {}s after\n", SETTLE.as_secs_f64())), "{body}");
        assert!(body.contains(&format!("or for {}s if it never was", START_GRACE.as_secs_f64())), "{body}");
        assert!(body.contains(&format!("(default {}m, at most {}h, 0 for\n", DEFAULT_WAIT_TIMEOUT.as_secs() / 60, MAX_WAIT_TIMEOUT.as_secs() / 3600)), "{body}");
        // The exit codes are the crate's, each with what it means.
        for (code, means) in [
            (exit::OK, "idle: it stayed settled"),
            (exit::TIMED_OUT, "timed out: --timeout passed first"),
            (exit::BLOCKED, "blocked: an unread notification while its agent is not idle"),
            (exit::ENDED, "it exited or was closed before it was idle (--for idle only)"),
        ] {
            assert!(body.contains(&format!("\n  {code}  {means}")), "{code}: {body}");
        }
        assert!(body.contains("With --for exit:\n     its shell has exited or it was closed."), "{body}");
        assert!(body.contains("never self (exit 2)"), "{body}");
        assert!(body.contains("(one it did not open is exit 4)"), "{body}");
        assert!(body.contains("one line, on stdout for 0 and on stderr for 6, 7 and 8"), "{body}");
        assert!(body.contains("prints one object on stdout instead: target, outcome (idle, exited,\nclosed, blocked, timed_out), status and waited_ms"), "{body}");
        assert!(body.contains("never reads the\nscreen, so it needs only \"Let programs in terminals control NexTerm\""), "{body}");
        // What it cannot see: blocked needs a notification NexTerm heard and a
        // title that is not idle; other agents have no activity; 200 rows.
        assert!(body.contains("Kitty notifications, OSC 99, or a PermissionRequest hook"), "{body}");
        assert!(body.contains("it\nreads as idle (exit 0) if the title says idle, or as busy until the\ntimeout (exit 6)"), "{body}");
        assert!(body.contains("any unread notification there counts as blocked"), "{body}");
        let dispatcher = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/lib/controlDispatcher.js")).unwrap();
        assert!(dispatcher.contains("export const LIST_MAX = 200;"), "list's limit moved: fix the guide");
        assert!(body.contains("list gives at most 200 terminals: one past\nthem looks absent"), "{body}");
        assert!(body.contains(&format!("if that takes\nover {}s, wait calls it idle", START_GRACE.as_secs_f64())), "{body}");

        // The examples are real wait command lines, covering --for exit, no
        // limit and --json.
        let waits: Vec<(bool, Command)> = body
            .lines()
            .filter_map(|l| l.strip_prefix("  nexterm-cli "))
            .map(|l| match args::parse(&words(l).into_iter().map(OsString::from).collect::<Vec<_>>()) {
                Ok(Parsed::Run { json, command: c @ Command::Wait { .. } }) => (json, c),
                other => panic!("{l}: {other:?}"),
            })
            .collect();
        assert_eq!(waits.len(), 4, "{body}");
        assert!(waits.iter().any(|(_, c)| matches!(c, Command::Wait { until: Until::Exit, .. })));
        assert!(waits.iter().any(|(_, c)| matches!(c, Command::Wait { timeout: None, .. })));
        assert!(waits.iter().any(|(json, _)| *json));
        assert!(waits.iter().any(|(_, c)| matches!(c, Command::Wait { target, .. } if target.starts_with("child:"))));

        // The index lists wait's exit codes after 5, in order, each once.
        let codes: Vec<&str> = INDEX[INDEX.find("Check its exit status:\n").unwrap()..]
            .lines()
            .filter_map(|l| l.strip_prefix("  ").and_then(|l| l.split("  ").next()))
            .filter(|code| !code.is_empty() && code.chars().all(|c| c.is_ascii_digit()))
            .collect();
        assert_eq!(codes, ["0", "1", "2", "3", "4", "5", "6", "7", "8"], "{INDEX}");
        assert!(INDEX.contains("  6  wait timed out: wait again, or tell the user\n"), "{INDEX}");
        assert!(INDEX.contains("  7  wait found the terminal blocked on a person"), "{INDEX}");
        assert!(INDEX.contains("  8  wait: the terminal exited or was closed before it was idle\n"), "{INDEX}");
        assert!(INDEX.contains("\n  wait          wait for another terminal to be idle, blocked or exited\n"), "{INDEX}");
    }
}
