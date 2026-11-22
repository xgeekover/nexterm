//! What the clipboard holds, for a right-click paste in a terminal, and the
//! one write a terminal program may ask for (OSC 52).
//!
//! The terminal half — what a right-click does, and the paste itself, through
//! xterm's own `paste` so that a program that asked for bracketed paste gets it
//! bracketed — is src/lib/terminalRightClick.js. `clipboard_read` reads the
//! clipboard: its text, and whether an image is on it.
//!
//! Read here rather than in the webview, because the webview cannot be relied
//! on to answer a right-click:
//!
//! - WebView2 asks the user before `navigator.clipboard.readText()` may read
//!   anything. wry grants that permission itself only for a window built with
//!   `enable_clipboard_access()`, and NexTerm's window is made from
//!   tauri.conf.json, which has no such switch.
//! - WKWebView shows a "Paste" button of its own under the pointer, to be
//!   clicked, for anything another app copied.
//! - Neither can say an image is there without reading all of it.
//!
//! The text comes from arboard (1Password's, and what
//! tauri-plugin-clipboard-manager is built on) with its `image-data` feature
//! off. The plugin, or arboard with that feature, can tell an image is there
//! only by decoding it — tens of megabytes of pixels for a screenshot, made to
//! be thrown away. Whether one is there is instead one question to the OS
//! (`has_image`).
//!
//! `clipboard_write_text` is the only write, and only for OSC 52: a program in
//! a terminal (tmux, vim, a shell over ssh) asking to put text on the
//! clipboard, which src/lib/osc52.js decides on — off unless the user turned
//! it on, never a read, never a clear. Copying a selection is still the
//! webview's own (src/lib/terminalClipboard.js). What a program writes is its
//! user's: it is checked for size here before the clipboard is touched, and it
//! is never logged nor put into an error.

use std::sync::{Mutex, PoisonError};

use serde::Serialize;

/// What a right-click can paste, as the frontend reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClipboardContents {
    /// The clipboard's text; empty when it holds none.
    pub text: String,
    /// Whether it holds an image. A program that pastes images — OpenCode,
    /// Claude Code — reads one for itself when it is handed an empty
    /// bracketed paste.
    pub has_image: bool,
}

/// What a text read means for a paste. No text is an answer — an image, or
/// nothing at all — and any other failure is an error the frontend reports.
fn text_from(read: Result<String, arboard::Error>) -> Result<String, String> {
    match read {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(format!("could not read the clipboard: {e}")),
    }
}

/// The clipboard's text, and whether an image is on it.
///
/// Off the event loop (`async`): Windows lets one window at a time open the
/// clipboard, and arboard waits for whoever has it — a wait that, on the event
/// loop, would freeze the window.
#[tauri::command(async, rename_all = "snake_case")]
pub fn clipboard_read() -> Result<ClipboardContents, String> {
    // First, so that an OS with no clipboard to give (macOS answers no
    // pasteboard at all to a daemon) is an error here, before `has_image`
    // asks it anything.
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("could not open the clipboard: {e}"))?;
    let text = text_from(clipboard.get_text())?;
    Ok(ClipboardContents {
        text,
        has_image: has_image(),
    })
}

/// The most text a program may put on the clipboard: 128 KiB, as UTF-8. The
/// page refuses more before it asks (src/lib/osc52.js, MAX_OSC52_BYTES); this
/// is the same line held again, for whatever else calls.
pub const MAX_WRITE_BYTES: usize = 131_072;

/// Whether `text` may go on the clipboard: not empty — an empty write would be
/// a clear, which is refused — and not more than `MAX_WRITE_BYTES`. The reason
/// never quotes the text: it is the program's, and the error is shown and
/// may be logged.
fn check_write(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("nothing to put on the clipboard".to_string());
    }
    if text.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "too much to put on the clipboard: {} bytes, more than {MAX_WRITE_BYTES}",
            text.len()
        ));
    }
    Ok(())
}

/// The one clipboard the writes go through, kept for as long as the app runs.
///
/// On Linux the text a program copies is not handed to the system: the app
/// that set it serves it to whoever pastes, from arboard's `Clipboard`, and
/// when the last one is dropped the text goes with it unless a clipboard
/// manager took a copy. One made and dropped inside each call would lose every
/// write the moment the command returned. Kept, the text stays until something
/// else is copied or NexTerm quits. On Windows and macOS the OS keeps the text
/// either way; one kept there costs nothing (arboard opens the Windows
/// clipboard only for each operation), and the lock puts writes one at a time,
/// which Windows asks for.
static KEPT: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

/// Put `text` on the system clipboard, for a program's OSC 52 the user allowed.
///
/// Off the event loop (`async`), like `clipboard_read`: Windows lets one
/// window at a time open the clipboard, and arboard waits for whoever has it.
/// Refused — before the clipboard is opened — when it is empty or over
/// `MAX_WRITE_BYTES`. Nothing is logged, and no error carries the text.
#[tauri::command(async, rename_all = "snake_case")]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    check_write(&text)?;
    let mut kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    let clipboard = match kept.as_mut() {
        Some(clipboard) => clipboard,
        None => kept.insert(
            arboard::Clipboard::new().map_err(|e| format!("could not open the clipboard: {e}"))?,
        ),
    };
    clipboard.set_text(text).map_err(|e| {
        // A connection that failed once (the X server went away) is made anew
        // by the next write rather than kept failing.
        *kept = None;
        format!("could not write the clipboard: {e}")
    })
}

/// Whether an image is on the clipboard: one of the bitmap formats Windows
/// converts between (CF_DIB, CF_DIBV5, CF_BITMAP — one there means all three),
/// or the "PNG" that browsers and the Snipping Tool put beside them. Asked
/// without opening the clipboard, and without reading the image.
#[cfg(windows)]
fn has_image() -> bool {
    use clipboard_win::{formats, is_format_avail, register_format};
    [formats::CF_DIB, formats::CF_DIBV5, formats::CF_BITMAP]
        .into_iter()
        .any(is_format_avail)
        || register_format("PNG").is_some_and(|png| is_format_avail(png.get()))
}

/// Whether an image is on the general pasteboard — see `holds_image`.
#[cfg(target_os = "macos")]
fn has_image() -> bool {
    // A pool of its own: this runs on a worker thread, which has none.
    objc2::rc::autoreleasepool(|_| holds_image(&objc2_app_kit::NSPasteboard::generalPasteboard()))
}

/// Whether `pasteboard` holds an image, as PNG or TIFF — the types an image on
/// a Mac pasteboard comes in, from a screenshot, Preview or a browser's Copy
/// Image. Asked of the pasteboard's types, without reading the image.
#[cfg(target_os = "macos")]
fn holds_image(pasteboard: &objc2_app_kit::NSPasteboard) -> bool {
    use objc2_app_kit::{NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::NSArray;

    // SAFETY: AppKit's own type names, which live as long as the process.
    let (png, tiff) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    pasteboard
        .availableTypeFromArray(&NSArray::from_slice(&[png, tiff]))
        .is_some()
}

/// Not asked on Linux: X11 answers that through arboard's own connection, which
/// arboard does not lend out. There, an image alone on the clipboard pastes
/// nothing.
#[cfg(not(any(windows, target_os = "macos")))]
fn has_image() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_text_on_the_clipboard_is_an_empty_paste_not_an_error() {
        assert_eq!(text_from(Ok("ls -la\n".into())), Ok("ls -la\n".to_string()));
        assert_eq!(
            text_from(Err(arboard::Error::ContentNotAvailable)),
            Ok(String::new()),
            "an image alone, or nothing at all, is an answer"
        );
        for error in [
            arboard::Error::ClipboardOccupied,
            arboard::Error::ClipboardNotSupported,
            arboard::Error::ConversionFailure,
        ] {
            let read = text_from(Err(error));
            assert!(
                read.as_ref().is_err_and(|e| e.starts_with("could not read the clipboard")),
                "a clipboard that could not be read must say so: {read:?}"
            );
        }
    }

    #[test]
    fn the_answer_has_the_field_names_the_frontend_reads() {
        // src/lib/terminalRightClick.js reads `text` and `has_image`.
        let value = serde_json::to_value(ClipboardContents {
            text: "hello".into(),
            has_image: true,
        })
        .expect("serialises");
        assert_eq!(value, serde_json::json!({ "text": "hello", "has_image": true }));
    }

    /// The macOS probe, against a pasteboard of its own — never the user's
    /// clipboard. The data is not an image at all: the type is what counts,
    /// and nothing is decoded. (The Windows probe asks the one, global
    /// clipboard, which a test may not write to; WINDOWS_VERIFICATION.md V22
    /// checks it by hand.)
    #[cfg(target_os = "macos")]
    #[test]
    fn an_image_on_the_pasteboard_is_seen_by_its_type_alone() {
        use objc2::msg_send;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
        };
        use objc2_foundation::{NSData, NSString};

        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        // SAFETY: AppKit's own type names, which live as long as the process.
        let (string, png, tiff) =
            unsafe { (NSPasteboardTypeString, NSPasteboardTypePNG, NSPasteboardTypeTIFF) };

        pasteboard.clearContents();
        assert!(!holds_image(&pasteboard), "an empty pasteboard");
        pasteboard.setString_forType(&NSString::from_str("echo hi"), string);
        assert!(!holds_image(&pasteboard), "text alone is no image");
        for (kind, name) in [(png, "PNG"), (tiff, "TIFF")] {
            pasteboard.clearContents();
            pasteboard.setData_forType(Some(&NSData::with_bytes(b"never decoded")), kind);
            assert!(holds_image(&pasteboard), "{name}");
            pasteboard.setString_forType(&NSString::from_str("alt text"), string);
            assert!(holds_image(&pasteboard), "{name}, beside text");
        }

        // SAFETY: `releaseGlobally` takes no arguments and returns nothing; the
        // pasteboard is not used again.
        let () = unsafe { msg_send![&*pasteboard, releaseGlobally] };
    }

    #[test]
    fn a_write_is_refused_when_empty_or_over_128_kib_and_accepted_at_exactly_128_kib() {
        assert_eq!(MAX_WRITE_BYTES, 131_072);
        assert!(check_write("").is_err(), "an empty write would be a clear");
        assert_eq!(check_write("hi"), Ok(()));
        assert_eq!(check_write(&"a".repeat(131_072)), Ok(()), "exactly 128 KiB goes");
        assert!(check_write(&"a".repeat(131_073)).is_err(), "one byte more does not");
        // Bytes, not characters: 43,691 three-byte characters are 131,073 bytes.
        assert_eq!(check_write(&"한".repeat(43_690)), Ok(()));
        assert!(check_write(&"한".repeat(43_691)).is_err());
    }

    #[test]
    fn a_refusal_never_quotes_the_text() {
        let secret = "hunter2-the-program-wrote-this";
        let over = secret.repeat(131_072 / secret.len() + 1);
        assert!(over.len() > MAX_WRITE_BYTES);
        let reason = check_write(&over).expect_err("over the limit");
        assert!(!reason.contains(secret), "{reason}");
        assert!(!reason.contains("hunter2"), "{reason}");
        let reason = check_write("").expect_err("empty");
        assert!(!reason.is_empty());
    }

    #[test]
    fn the_command_refuses_before_it_opens_the_clipboard() {
        // Only refusals are asked for: a write the command accepted would land
        // on the user's own clipboard, which no test may touch.
        let secret = "do-not-echo-me";
        for text in [String::new(), secret.repeat(131_072 / secret.len() + 1)] {
            let reason = clipboard_write_text(text).expect_err("refused");
            assert!(!reason.contains(secret), "{reason}");
            assert!(!reason.starts_with("could not"), "refused by the check, not by the OS: {reason}");
        }
        assert!(
            KEPT.lock().unwrap_or_else(PoisonError::into_inner).is_none(),
            "a refused write never opened the clipboard"
        );
    }

    #[test]
    fn reading_the_real_clipboard_answers_or_says_why_it_cannot() {
        // Reads only — the clipboard is the user's. What it holds is not
        // asserted; that the platform calls run (AppKit's selectors, the Win32
        // format queries) without panicking is. A CI machine with no display
        // has no clipboard, and that has to be an error, not a panic.
        match clipboard_read() {
            Ok(contents) => {
                let _ = contents.has_image;
            }
            Err(e) => assert!(e.starts_with("could not"), "{e}"),
        }
    }
}
