//! Quitting while an editor tab holds unsaved changes.
//!
//! Closing the window is answered in the webview: it listens for the window's
//! close request and holds it behind the same Save / Don't Save / Cancel
//! prompt as closing one tab (src/hooks/useUnsavedGuard.js). That covers every
//! way out on Windows and Linux, where the app is closed by closing its
//! window.
//!
//! Quitting a macOS app is not a window close. ⌘Q, the Dock's Quit and logging
//! out all send `terminate:` to the application, and tao, the windowing layer
//! under Tauri, does not implement `applicationShouldTerminate:` — so AppKit
//! goes straight on to `applicationWillTerminate:` and the process ends
//! without the window being asked anything. Tauri reports that as
//! `RunEvent::Exit`, which cannot be prevented: `RunEvent::ExitRequested`
//! only comes from `AppHandle::exit` and from the last window going away.
//!
//! So the webview keeps this module told whether anything is unsaved
//! (`app_set_unsaved`), and on macOS the app delegate is given an
//! `applicationShouldTerminate:` that reads it. Nothing unsaved, and the quit
//! goes ahead exactly as before. Otherwise the quit is cancelled and the
//! webview is asked (`QUIT_REQUESTED`); it shows the prompt and, once that is
//! answered, quits through `app_quit`. That is `AppHandle::exit`, which stops
//! the event loop rather than sending `terminate:` again, so the delegate is
//! not asked a second time.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// Whether an editor tab holds edits that are not on disk, as the webview
/// last said.
static UNSAVED: AtomicBool = AtomicBool::new(false);

/// The event the webview asks about a quit on. Mirrors `QUIT_REQUESTED_EVENT`
/// in src/hooks/useUnsavedGuard.js.
pub const QUIT_REQUESTED: &str = "app-quit-requested";

/// Whether any editor tab is unsaved. Sent when that changes, not per key.
#[tauri::command(rename_all = "snake_case")]
pub fn app_set_unsaved(unsaved: bool) {
    UNSAVED.store(unsaved, Ordering::SeqCst);
}

/// Quit, now that the user has answered about the unsaved tabs.
#[tauri::command(rename_all = "snake_case")]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "macos")]
pub use macos::ask_before_quitting;

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, msg_send, sel};
    use tauri::{AppHandle, Emitter};

    use super::{QUIT_REQUESTED, UNSAVED};

    /// How the webview is asked about a quit. Set once, by
    /// `ask_before_quitting`.
    static ASK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

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
        let asker: Box<dyn Fn() + Send + Sync> = Box::new(move || {
            let app = app.clone();
            // From a worker, not from here: this runs inside AppKit's
            // `terminate:`, in the middle of a menu action or an Apple Event,
            // and an emit made on the main thread goes straight into the event
            // loop's own state. From a worker it is queued like any other.
            tauri::async_runtime::spawn(async move {
                if let Err(e) = app.emit(QUIT_REQUESTED, ()) {
                    eprintln!("[NexTerm] Could not ask about unsaved changes before quitting: {e}");
                }
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
        if may_quit_now() {
            NS_TERMINATE_NOW
        } else {
            NS_TERMINATE_CANCEL
        }
    }

    /// AppKit's question: may the app quit right now? Yes, unless the webview
    /// last said something is unsaved — then no, and the webview is asked.
    fn may_quit_now() -> bool {
        if !UNSAVED.load(Ordering::SeqCst) {
            return true;
        }
        match ASK.get() {
            Some(ask) => {
                ask();
                false
            }
            // Nobody to ask: an app that quits as before beats one that
            // cannot be quit at all.
            None => true,
        }
    }

    #[cfg(test)]
    mod tests {
        use std::sync::atomic::{AtomicUsize, Ordering};

        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject, ClassBuilder};

        use super::{give_should_terminate, ASK, NS_TERMINATE_CANCEL, NS_TERMINATE_NOW};
        use crate::commands::app::app_set_unsaved;

        /// The question asked the way AppKit asks it — through objc_msgSend,
        /// of an object whose class was given the method at run time, as the
        /// app delegate is — for each thing the webview may have said.
        ///
        /// What this cannot show is AppKit itself asking: that takes a running
        /// app and a real ⌘Q.
        #[test]
        fn a_quit_waits_for_an_answer_only_while_something_is_unsaved() {
            static ASKED: AtomicUsize = AtomicUsize::new(0);
            assert!(
                ASK.set(Box::new(|| {
                    ASKED.fetch_add(1, Ordering::SeqCst);
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
            assert_eq!(
                ask(),
                NS_TERMINATE_CANCEL,
                "an unsaved tab must stop the quit"
            );
            assert_eq!(
                ASKED.load(Ordering::SeqCst),
                1,
                "and the webview must be asked"
            );

            app_set_unsaved(false);
            assert_eq!(ask(), NS_TERMINATE_NOW, "saved since: quit");
            assert_eq!(ASKED.load(Ordering::SeqCst), 1);
        }
    }
}
