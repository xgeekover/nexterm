//! Closing the window or quitting while an editor tab holds unsaved changes.
//!
//! The backend is the gate. The webview keeps it told whether anything is
//! unsaved (`app_set_unsaved`), and every close request and every macOS quit
//! is decided here, by [`Gate`]:
//!
//! - Nothing unsaved: it goes ahead at once, exactly as with no guard at all.
//!   It never waits on the page.
//! - Something unsaved: it is held, the window is brought forward, and the
//!   webview is asked (`CLOSE_REQUESTED`, `QUIT_REQUESTED`). The page shows
//!   the same Save / Don't Save / Cancel prompt as closing one tab
//!   (src/hooks/useUnsavedGuard.js) and, once that is answered, finishes
//!   through `app_close_window` or `app_quit`.
//!
//! Holding is only for a page that can answer. A WebView2 renderer that
//! crashed or hung (a white window after resume, out of memory, a script
//! stuck in a loop), or a WKWebView content process that died, never will.
//! So the page has to say it heard each question (`app_close_ack`) within
//! `ACK_TIMEOUT`. If it does not, the close or the quit goes ahead anyway
//! when the time is up, and a request made once `REPEAT_GRACE` has passed
//! goes ahead at once. What was in the dead page is lost either way; a guard
//! that waited on it as well would leave a window that its ✕, Alt+F4 and the
//! taskbar could not close, and a Mac that could not quit, log out or
//! restart.
//!
//! That is what the first version did. It listened for the window's close
//! request in the webview, and once a window has such a listener Tauri
//! prevents every close of it, unsaved or not, and leaves the window to the
//! page (tauri 2.11.5, src/manager/window.rs).
//!
//! The window's close covers every way of closing it: its ✕, File ▸ Exit,
//! Ctrl/⌘+Shift+W, Alt+F4, the taskbar. On Windows and Linux that is how the
//! app is quit.
//!
//! It does not cover Windows shutting down, signing out, or restarting for an
//! update. Windows does not close the window then. It sends
//! WM_QUERYENDSESSION, which tao 0.35.3 does not handle (the default window
//! procedure agrees to end the session), and then WM_ENDSESSION, on which tao
//! only stops its event loop. The process ends, and every unsaved edit is lost
//! without a prompt. Whether a Linux session ending closes the window first
//! has not been checked.
//!
//! Quitting a macOS app is not a window close. ⌘Q, the Dock's Quit and logging
//! out all send `terminate:` to the application, and tao, the windowing layer
//! under Tauri, does not implement `applicationShouldTerminate:` — so AppKit
//! goes straight on to `applicationWillTerminate:` and the process ends
//! without the window being asked anything. Tauri reports that as
//! `RunEvent::Exit`, which cannot be prevented: `RunEvent::ExitRequested`
//! only comes from `AppHandle::exit` and from the last window going away. So
//! on macOS the app delegate is given an `applicationShouldTerminate:` that
//! asks the gate. `app_quit` is `AppHandle::exit`, which stops the event loop
//! rather than sending `terminate:` again, so the delegate is not asked a
//! second time.
//!
//! A held quit is cancelled as far as AppKit knows. When the page then never
//! answers, the backend quits by itself once the time is up, but a logout or
//! restart that was waiting on this app has been called off by then, and has
//! to be started again.

use std::time::{Duration, Instant};

use parking_lot::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

/// The event the webview is asked about a window close on. Mirrors
/// `CLOSE_REQUESTED_EVENT` in src/hooks/useUnsavedGuard.js.
pub const CLOSE_REQUESTED: &str = "app-close-requested";

/// The event the webview is asked about a quit on. Mirrors
/// `QUIT_REQUESTED_EVENT` in src/hooks/useUnsavedGuard.js.
pub const QUIT_REQUESTED: &str = "app-quit-requested";

/// How long the webview has to say it heard a question before the close or
/// quit it holds goes ahead without it. A live page answers within
/// milliseconds; this is for one that will not answer at all.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(2);

/// How soon after a question a second request still counts as part of the
/// first, rather than the user asking again because nothing happened.
///
/// A double-click on the title bar's ✕ is two close requests, and the second
/// can reach the backend before a busy page has said it heard the first.
/// Letting that one through would close the window over the unsaved edits
/// the first was asking about. So within this it is held as well, without a
/// second question; after it, a page that has still not said it heard is
/// taken to be gone, and the request goes ahead at once.
pub const REPEAT_GRACE: Duration = Duration::from_millis(500);

/// Whether a close or a quit may go ahead, and what the webview was last
/// asked. Plain data with the clock handed in, so that every rule is tested
/// without a window (see the tests at the end of this file).
#[derive(Debug)]
pub struct Gate {
    unsaved: bool,
    asked: Option<Asked>,
    last_id: u64,
}

/// The latest question put to the webview.
#[derive(Clone, Copy, Debug)]
struct Asked {
    id: u64,
    at: Instant,
    heard: bool,
}

/// What a close request or a quit comes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Let it happen, now.
    Go,
    /// Hold it, and ask the webview. The question carries this id, which the
    /// page hands back through `app_close_ack`.
    Ask(u64),
    /// Hold it without asking again: the question went out moments ago, and
    /// the page may still be about to say it heard.
    Hold,
}

impl Verdict {
    /// Whether the request is held: the window's close prevented, the quit
    /// cancelled.
    pub fn holds(self) -> bool {
        self != Verdict::Go
    }
}

impl Gate {
    pub const fn new() -> Self {
        Gate {
            unsaved: false,
            asked: None,
            last_id: 0,
        }
    }

    /// What the webview says: whether any editor tab is unsaved.
    pub fn set_unsaved(&mut self, unsaved: bool) {
        self.unsaved = unsaved;
    }

    /// A close or a quit has been asked for, at `now`.
    pub fn request(&mut self, now: Instant) -> Verdict {
        if !self.unsaved {
            return Verdict::Go;
        }
        if let Some(asked) = self.asked {
            if !asked.heard {
                // Asked, and not heard from. Moments ago, that is one gesture
                // arriving twice; any later, a page that is not going to
                // answer.
                return if now.saturating_duration_since(asked.at) < REPEAT_GRACE {
                    Verdict::Hold
                } else {
                    Verdict::Go
                };
            }
        }
        // Never asked, or asked and heard. A page that answered last time is
        // asked again and has to answer again: having been alive then says
        // nothing about now.
        self.last_id += 1;
        self.asked = Some(Asked {
            id: self.last_id,
            at: now,
            heard: false,
        });
        Verdict::Ask(self.last_id)
    }

    /// The webview says it heard question `id` and is asking the user. False,
    /// and nothing changes, when that is not the latest question.
    pub fn heard(&mut self, id: u64) -> bool {
        match self.asked.as_mut() {
            Some(asked) if asked.id == id => {
                asked.heard = true;
                true
            }
            _ => false,
        }
    }

    /// Whether question `id` went unanswered: it is still the latest, the page
    /// never said it heard, and `ACK_TIMEOUT` has passed by `now`. The close
    /// or quit it held then goes ahead.
    pub fn unanswered(&self, id: u64, now: Instant) -> bool {
        matches!(self.asked, Some(asked)
            if asked.id == id
                && !asked.heard
                && now.saturating_duration_since(asked.at) >= ACK_TIMEOUT)
    }
}

/// The app's gate. One webview, one answer to "is anything unsaved".
static GATE: Mutex<Gate> = Mutex::new(Gate::new());

fn gate() -> MutexGuard<'static, Gate> {
    GATE.lock()
}

/// Whether any editor tab is unsaved. Sent when that changes, not per key.
#[tauri::command(rename_all = "snake_case")]
pub fn app_set_unsaved(unsaved: bool) {
    gate().set_unsaved(unsaved);
}

/// The webview heard question `id` (`CLOSE_REQUESTED`, `QUIT_REQUESTED`) and
/// is asking the user, so the close or quit it is about stays held until the
/// user answers.
#[tauri::command(rename_all = "snake_case")]
pub fn app_close_ack(id: u64) {
    gate().heard(id);
}

/// Close the window, now that the user has answered about the unsaved tabs.
///
/// Destroyed, not closed: a close would be one more close request, held
/// again for the edits that "Don't Save" leaves unsaved.
#[tauri::command(rename_all = "snake_case")]
pub fn app_close_window(window: Window) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Quit, now that the user has answered about the unsaved tabs.
#[tauri::command(rename_all = "snake_case")]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// A window was asked to close. main.rs hands every `CloseRequested` here,
/// and prevents the close when this returns true.
pub fn hold_close(window: &Window) -> bool {
    let verdict = gate().request(Instant::now());
    if let Verdict::Ask(id) = verdict {
        let app = window.app_handle().clone();
        let window = window.clone();
        ask_webview(app, CLOSE_REQUESTED, id, move || {
            eprintln!(
                "[NexTerm] The page did not answer about unsaved changes within {ACK_TIMEOUT:?}; closing the window anyway"
            );
            if let Err(e) = window.destroy() {
                eprintln!("[NexTerm] Could not close the window: {e}");
            }
        });
    }
    verdict.holds()
}

/// Ask the webview question `id` on `event`, with the window brought forward
/// so that the prompt it answers with is seen. If the page has not said it
/// heard within `ACK_TIMEOUT`, `go_anyway` runs.
///
/// From a worker, not from the caller. A macOS quit is asked inside AppKit's
/// `terminate:`, in the middle of a menu action or an Apple Event, and what
/// is sent to a window or a webview from the main thread goes straight into
/// the event loop's own state. From a worker it is queued like any other
/// message, in the order it was sent.
fn ask_webview(
    app: AppHandle,
    event: &'static str,
    id: u64,
    go_anyway: impl FnOnce() + Send + 'static,
) {
    tauri::async_runtime::spawn(async move {
        // A prompt in a hidden or minimised window is a question nobody sees,
        // held open until the user gives up on it.
        #[cfg(target_os = "macos")]
        let _ = app.show();
        for window in app.webview_windows().values() {
            bring_forward(window);
        }
        if let Err(e) = app.emit(event, id) {
            eprintln!("[NexTerm] Could not ask about unsaved changes: {e}");
        }
        tokio::time::sleep(ACK_TIMEOUT).await;
        let unanswered = gate().unanswered(id, Instant::now());
        if unanswered {
            go_anyway();
        }
    });
}

/// Un-minimise, show and focus `window`. Each step on its own: one that fails
/// must not stop the question being asked.
fn bring_forward(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
pub use macos::ask_before_quitting;

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::OnceLock;
    use std::time::Instant;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, msg_send, sel};
    use tauri::AppHandle;

    use super::{ask_webview, gate, Verdict, ACK_TIMEOUT, QUIT_REQUESTED};

    /// How the webview is asked about a quit, by the question's id. Set once,
    /// by `ask_before_quitting`.
    static ASK: OnceLock<Box<dyn Fn(u64) + Send + Sync>> = OnceLock::new();

    // NSApplicationTerminateReply.
    const NS_TERMINATE_CANCEL: usize = 0;
    const NS_TERMINATE_NOW: usize = 1;

    /// `applicationShouldTerminate:` as objc_msgSend calls it: `self`,
    /// `_cmd`, the sender, and an NSApplicationTerminateReply back.
    type ShouldTerminate = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;

    /// Give the application's delegate an `applicationShouldTerminate:`.
    /// Called from `setup`, once tao has made the delegate.
    pub fn ask_before_quitting(app: &AppHandle) {
        let app = app.clone();
        let asker: Box<dyn Fn(u64) + Send + Sync> = Box::new(move |id| {
            let quitter = app.clone();
            ask_webview(app.clone(), QUIT_REQUESTED, id, move || {
                eprintln!(
                    "[NexTerm] The page did not answer about unsaved changes within {ACK_TIMEOUT:?}; quitting anyway"
                );
                quitter.exit(0);
            });
        });
        if ASK.set(asker).is_err() {
            return;
        }

        let Some(application) = AnyClass::get(c"NSApplication") else {
            return;
        };
        // SAFETY: the main thread (`setup` runs there), plain getters, and the
        // class pointer comes from the runtime for a live object.
        let installed = unsafe {
            let shared: *mut AnyObject = msg_send![application, sharedApplication];
            let delegate: *mut AnyObject = if shared.is_null() {
                std::ptr::null_mut()
            } else {
                msg_send![shared, delegate]
            };
            !delegate.is_null()
                && give_should_terminate(ffi::object_getClass(delegate) as *mut AnyClass)
        };
        if !installed {
            // tao answering this itself one day is the likely reason. Quitting
            // then works as it did before this existed.
            eprintln!("[NexTerm] Could not ask about unsaved changes on quit: the app delegate already answers applicationShouldTerminate:, or there is none");
        }
    }

    /// Add `applicationShouldTerminate:` to `class`. False when the class
    /// already has one, which is then left alone.
    ///
    /// # Safety
    ///
    /// `class` must be a live, registered Objective-C class.
    pub(super) unsafe fn give_should_terminate(class: *mut AnyClass) -> bool {
        let reply: ShouldTerminate = should_terminate;
        // SAFETY: an IMP is called through objc_msgSend with exactly the
        // arguments the type string below declares, and `ShouldTerminate`
        // is that signature.
        let imp = unsafe { std::mem::transmute::<ShouldTerminate, Imp>(reply) };
        // Q: NSApplicationTerminateReply, an NSUInteger. @: self. :: _cmd. @: the sender.
        let types = c"Q@:@".as_ptr();
        unsafe { ffi::class_addMethod(class, sel!(applicationShouldTerminate:), imp, types) }
            .as_bool()
    }

    extern "C-unwind" fn should_terminate(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if may_quit_at(Instant::now()) {
            NS_TERMINATE_NOW
        } else {
            NS_TERMINATE_CANCEL
        }
    }

    /// AppKit's question: may the app quit at `now`? The gate decides. When
    /// it asks the webview, the quit is cancelled, and made again by
    /// `app_quit` once the user has answered — or by the asker, if the page
    /// never says it heard.
    fn may_quit_at(now: Instant) -> bool {
        let verdict = gate().request(now);
        match verdict {
            Verdict::Go => true,
            Verdict::Hold => false,
            Verdict::Ask(id) => match ASK.get() {
                Some(ask) => {
                    ask(id);
                    false
                }
                // Nobody to ask: an app that quits as before beats one that
                // cannot be quit at all.
                None => true,
            },
        }
    }

    #[cfg(test)]
    mod tests {
        use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
        use std::time::Instant;

        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject, ClassBuilder};

        use super::{give_should_terminate, may_quit_at, ASK, NS_TERMINATE_CANCEL, NS_TERMINATE_NOW};
        use crate::commands::app::{app_close_ack, app_set_unsaved, REPEAT_GRACE};

        /// The question asked the way AppKit asks it — through objc_msgSend,
        /// of an object whose class was given the method at run time, as the
        /// app delegate is — for each thing the webview may have said, or not
        /// said.
        ///
        /// The only test that touches the app's own gate: the rules
        /// themselves are tested on gates of their own, in the tests at the
        /// end of app.rs. What this cannot show is AppKit itself asking: that
        /// takes a running app and a real ⌘Q.
        #[test]
        fn a_quit_waits_only_for_a_page_that_says_it_heard() {
            static ASKED: AtomicUsize = AtomicUsize::new(0);
            static LAST_ID: AtomicU64 = AtomicU64::new(0);
            assert!(
                ASK.set(Box::new(|id| {
                    ASKED.fetch_add(1, Ordering::SeqCst);
                    LAST_ID.store(id, Ordering::SeqCst);
                }))
                .is_ok(),
                "only this test sets the asker"
            );

            let superclass = AnyClass::get(c"NSObject").expect("NSObject");
            let class = ClassBuilder::new(c"NexTermQuitGuardProbe", superclass)
                .expect("a class of that name already exists")
                .register();
            let class_ptr = class as *const AnyClass as *mut AnyClass;
            assert!(
                unsafe { give_should_terminate(class_ptr) },
                "the method was not added"
            );
            assert!(
                !unsafe { give_should_terminate(class_ptr) },
                "a class that already answers must be left alone"
            );

            let probe: Retained<AnyObject> = unsafe { msg_send![class, new] };
            let ask = || -> usize {
                unsafe {
                    msg_send![&*probe, applicationShouldTerminate: std::ptr::null_mut::<AnyObject>()]
                }
            };

            app_set_unsaved(false);
            assert_eq!(ask(), NS_TERMINATE_NOW, "nothing unsaved: quit as before");
            assert_eq!(ASKED.load(Ordering::SeqCst), 0);

            app_set_unsaved(true);
            assert_eq!(ask(), NS_TERMINATE_CANCEL, "an unsaved tab must stop the quit");
            assert_eq!(ASKED.load(Ordering::SeqCst), 1, "and the webview must be asked");

            assert_eq!(
                ask(),
                NS_TERMINATE_CANCEL,
                "⌘Q pressed twice: the second is part of the first"
            );
            assert_eq!(ASKED.load(Ordering::SeqCst), 1, "and is not asked about again");

            app_close_ack(LAST_ID.load(Ordering::SeqCst));
            assert_eq!(ask(), NS_TERMINATE_CANCEL, "a page that heard keeps the quit held");
            assert_eq!(
                ASKED.load(Ordering::SeqCst),
                2,
                "and is asked again, and has to answer again"
            );

            // That second question is never answered: the page has died
            // since. The next quit, once the moment has passed, goes.
            assert!(
                may_quit_at(Instant::now() + REPEAT_GRACE),
                "a page that does not answer must not stop a quit"
            );
            assert_eq!(ASKED.load(Ordering::SeqCst), 2);

            app_set_unsaved(false);
            assert_eq!(ask(), NS_TERMINATE_NOW, "saved since: quit");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{Gate, Verdict, ACK_TIMEOUT, REPEAT_GRACE};

    const MS: Duration = Duration::from_millis(1);

    fn unsaved() -> Gate {
        let mut gate = Gate::new();
        gate.set_unsaved(true);
        gate
    }

    #[test]
    fn nothing_unsaved_lets_every_close_through_without_asking() {
        let mut gate = Gate::new();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Go);
        assert_eq!(gate.request(t0 + MS), Verdict::Go, "nor the next");
        assert!(!Verdict::Go.holds(), "a close that goes is not prevented");
    }

    #[test]
    fn an_unsaved_tab_holds_the_close_and_asks_the_page() {
        let mut gate = unsaved();
        let verdict = gate.request(Instant::now());
        assert_eq!(verdict, Verdict::Ask(1));
        assert!(verdict.holds(), "the close must be prevented while the page is asked");
    }

    #[test]
    fn a_second_request_moments_later_is_held_and_not_asked_again() {
        // A double-click on ✕ that reaches the backend before the page could
        // say it heard the first click's question.
        let mut gate = unsaved();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Ask(1));
        let verdict = gate.request(t0 + REPEAT_GRACE - MS);
        assert_eq!(verdict, Verdict::Hold, "a double-click closed over unsaved edits");
        assert!(verdict.holds());
    }

    #[test]
    fn a_page_that_never_says_it_heard_cannot_keep_the_window() {
        let mut gate = unsaved();
        let t0 = Instant::now();
        let Verdict::Ask(id) = gate.request(t0) else {
            panic!("an unsaved tab must be asked about")
        };

        // Nothing heard: the close it held goes ahead when the time is up…
        assert!(!gate.unanswered(id, t0 + ACK_TIMEOUT - MS), "not before its time");
        assert!(gate.unanswered(id, t0 + ACK_TIMEOUT));
        // …and a request after the moment has passed goes ahead at once.
        assert_eq!(gate.request(t0 + REPEAT_GRACE), Verdict::Go);
    }

    #[test]
    fn a_page_that_said_it_heard_keeps_the_close_held() {
        let mut gate = unsaved();
        let t0 = Instant::now();
        let Verdict::Ask(id) = gate.request(t0) else {
            panic!("an unsaved tab must be asked about")
        };
        assert!(gate.heard(id));
        assert!(
            !gate.unanswered(id, t0 + ACK_TIMEOUT * 10),
            "the user is answering: no timer may close over them"
        );
    }

    #[test]
    fn a_page_that_heard_is_asked_again_each_time_and_must_answer_again() {
        let mut gate = unsaved();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Ask(1));
        assert!(gate.heard(1));

        // The user clicks ✕ again while the prompt is up — or after the page
        // behind it died.
        let t1 = t0 + 10 * ACK_TIMEOUT;
        assert_eq!(gate.request(t1), Verdict::Ask(2));
        assert!(!gate.unanswered(1, t1 + ACK_TIMEOUT), "the old question is not the one waited on");
        assert!(gate.unanswered(2, t1 + ACK_TIMEOUT), "the new one has to be heard too");
    }

    #[test]
    fn a_late_ack_for_an_older_question_does_not_count_for_a_newer_one() {
        let mut gate = unsaved();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Ask(1));
        assert!(gate.heard(1));
        assert_eq!(gate.request(t0 + ACK_TIMEOUT), Verdict::Ask(2));

        assert!(!gate.heard(1), "an ack for question 1 must not answer question 2");
        assert!(gate.unanswered(2, t0 + 2 * ACK_TIMEOUT));
        assert!(!gate.heard(3), "nor one for a question never asked");
    }

    #[test]
    fn saved_since_the_question_lets_the_next_close_through() {
        let mut gate = unsaved();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Ask(1));
        assert!(gate.heard(1));
        gate.set_unsaved(false);
        assert_eq!(gate.request(t0 + MS), Verdict::Go);
    }

    #[test]
    fn a_question_still_unanswered_when_everything_is_saved_closes_on_time() {
        // The page says "nothing unsaved" (its guard was torn down by a React
        // crash) but never heard the question. The window it held must still
        // close.
        let mut gate = unsaved();
        let t0 = Instant::now();
        assert_eq!(gate.request(t0), Verdict::Ask(1));
        gate.set_unsaved(false);
        assert!(gate.unanswered(1, t0 + ACK_TIMEOUT));
    }
}
