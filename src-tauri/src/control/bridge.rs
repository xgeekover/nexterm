//! The bridge to the page (spec D3): an authenticated request goes to the
//! page as the event `control-request`, and the page answers through the
//! command `control_reply`.
//!
//! The page is told `{ id, session_id, cmd, args, type_and_read,
//! other_terminals, deadline_at }`: the bridge's own id for this request
//! (not the caller's, which is only unique on its connection), the session
//! the token was issued to, the command and its arguments as they were
//! checked, the settings at that moment — so the page never acts on a value
//! of its own that is out of date — and when the backend stops waiting, in
//! milliseconds since the Unix epoch. A page that gets to a request after
//! that must not carry it out: its caller has been told `not_responding`,
//! and a script that tries again would otherwise type twice (review). Never
//! the token.
//!
//! At most MAX_WAITING requests wait for the page at once; one more is
//! `rate_limited` at once. Each waits REPLY_TIMEOUT, and then the caller is
//! told `not_responding` and its slot is free again. A request whose caller
//! has gone (the connection closed, the listener stopped) frees its slot as
//! it goes. A reply for an id that is not waiting — too late, never asked,
//! answered already — is dropped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use super::protocol::{page_failure, Code, Command, Failure};

/// The event a request is handed to the page on. Mirrored by the page's
/// listener and by the browser mock (src/lib/ipc.js).
pub const REQUEST_EVENT: &str = "control-request";

/// The most requests waiting for the page at once.
pub const MAX_WAITING: usize = 64;

/// How long the page has to answer one.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// What the page is handed.
#[derive(Clone, Debug, Serialize)]
pub struct PageRequest {
    pub id: u64,
    pub session_id: String,
    pub cmd: &'static str,
    pub args: Map<String, Value>,
    pub type_and_read: bool,
    pub other_terminals: bool,
    /// When the backend stops waiting for the answer: milliseconds since the
    /// Unix epoch, as the page's `Date.now()` counts them.
    pub deadline_at: u64,
}

/// Milliseconds since the Unix epoch, now.
fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Where requests go: the webview in the app (`TauriPage`, mod.rs), a fake
/// in the tests.
pub trait Page: Send + Sync + 'static {
    /// Hand `request` over. An error is the page not being there to ask.
    fn deliver(&self, request: PageRequest) -> Result<(), String>;
}

/// What the page said.
#[derive(Debug)]
struct Reply {
    ok: bool,
    result: Option<Value>,
    error: Option<Value>,
}

#[derive(Default)]
pub struct Bridge {
    page: RwLock<Option<Arc<dyn Page>>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
}

/// A request's slot, given up however its wait ends.
struct Slot<'a> {
    bridge: &'a Bridge,
    id: u64,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.bridge.waiting.lock().remove(&self.id);
    }
}

/// What a request the page is asked comes with, besides its command.
pub struct Asked {
    pub session_id: String,
    pub args: Map<String, Value>,
    pub type_and_read: bool,
    pub other_terminals: bool,
}

impl Bridge {
    pub fn set_page(&self, page: Arc<dyn Page>) {
        *self.page.write() = Some(page);
    }

    /// Ask the page to carry out `cmd`, and wait for its answer.
    pub async fn ask(&self, cmd: Command, asked: Asked) -> Result<Value, Failure> {
        let Some(page) = self.page.read().clone() else {
            return Err(Failure::new(Code::NotResponding, "NexTerm's window is not ready yet"));
        };
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut waiting = self.waiting.lock();
            if waiting.len() >= MAX_WAITING {
                return Err(Failure::new(
                    Code::RateLimited,
                    format!("{MAX_WAITING} requests are already waiting for NexTerm; try again in a moment"),
                ));
            }
            // From 1: the page may take 0 for "none".
            let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            waiting.insert(id, tx);
            id
        };
        let _slot = Slot { bridge: self, id };
        let request = PageRequest {
            id,
            session_id: asked.session_id,
            cmd: cmd.name(),
            args: asked.args,
            type_and_read: asked.type_and_read,
            other_terminals: asked.other_terminals,
            deadline_at: epoch_ms() + REPLY_TIMEOUT.as_millis() as u64,
        };
        if let Err(e) = page.deliver(request) {
            return Err(Failure::new(Code::NotResponding, format!("NexTerm's window could not be asked: {e}")));
        }
        match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
            Err(_) => Err(Failure::new(
                Code::NotResponding,
                format!("NexTerm is not responding (no answer within {} s)", REPLY_TIMEOUT.as_secs()),
            )),
            // The sender dropped without a reply: the slot was taken away.
            Ok(Err(_)) => Err(Failure::new(Code::NotResponding, "NexTerm stopped before it answered")),
            Ok(Ok(reply)) if reply.ok => Ok(reply.result.unwrap_or(Value::Null)),
            Ok(Ok(reply)) => Err(page_failure(reply.error.as_ref())),
        }
    }

    /// The page's answer to request `id`. Whether anyone was waiting for it.
    pub fn reply(&self, id: u64, ok: bool, result: Option<Value>, error: Option<Value>) -> bool {
        let Some(tx) = self.waiting.lock().remove(&id) else {
            return false;
        };
        tx.send(Reply { ok, result, error }).is_ok()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc;

    impl Bridge {
        /// How many requests are waiting for the page right now.
        pub(crate) fn waiting(&self) -> usize {
            self.waiting.lock().len()
        }
    }

    /// A page that hands every request to the test.
    pub(crate) struct FakePage(pub mpsc::UnboundedSender<PageRequest>);
    impl Page for FakePage {
        fn deliver(&self, request: PageRequest) -> Result<(), String> {
            self.0.send(request).map_err(|_| "the test's page is gone".to_string())
        }
    }

    pub(crate) fn fake_page() -> (Arc<dyn Page>, mpsc::UnboundedReceiver<PageRequest>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(FakePage(tx)), rx)
    }

    fn asked() -> Asked {
        Asked { session_id: "pty-1".into(), args: Map::new(), type_and_read: false, other_terminals: true }
    }

    #[tokio::test(start_paused = true)]
    async fn the_page_is_asked_and_its_answer_returned() {
        let bridge = Arc::new(Bridge::default());
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        let asking = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.ask(Command::List, asked()).await }
        });
        let before = epoch_ms();
        let request = requests.recv().await.unwrap();
        let after = epoch_ms();
        assert_eq!(request.cmd, "list");
        assert_eq!(request.session_id, "pty-1");
        assert!(request.other_terminals);
        assert!(!request.type_and_read);
        // Three seconds from when the page was asked, on the page's clock.
        let wait = REPLY_TIMEOUT.as_millis() as u64;
        assert!(
            request.deadline_at >= before.saturating_sub(5) + wait && request.deadline_at <= after + wait,
            "deadline_at {} is not {wait} ms after {before}..{after}",
            request.deadline_at
        );
        assert!(bridge.reply(request.id, true, Some(json!([1, 2])), None));
        assert_eq!(asking.await.unwrap(), Ok(json!([1, 2])));
        assert_eq!(bridge.waiting(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_never_answers_is_not_responding_after_three_seconds() {
        let bridge = Bridge::default();
        let (page, _requests) = fake_page();
        bridge.set_page(page);
        let started = tokio::time::Instant::now();
        let failure = bridge.ask(Command::Notify, asked()).await.unwrap_err();
        assert_eq!(failure.code, Code::NotResponding);
        assert_eq!(started.elapsed(), REPLY_TIMEOUT, "exactly the timeout on the paused clock");
        assert_eq!(bridge.waiting(), 0, "and its slot is free again");
    }

    #[tokio::test(start_paused = true)]
    async fn a_reply_after_the_timeout_or_for_no_request_is_dropped() {
        let bridge = Bridge::default();
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        let _ = bridge.ask(Command::Notify, asked()).await;
        let late = requests.recv().await.unwrap();
        assert!(!bridge.reply(late.id, true, None, None), "too late");
        assert!(!bridge.reply(0, true, None, None), "never asked");
        assert!(!bridge.reply(u64::MAX, false, None, Some(json!({"code":"internal"}))));
    }

    #[tokio::test(start_paused = true)]
    async fn sixty_four_wait_and_the_sixty_fifth_is_rate_limited_at_once() {
        let bridge = Arc::new(Bridge::default());
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        let mut asking = Vec::new();
        for _ in 0..MAX_WAITING {
            let bridge = bridge.clone();
            asking.push(tokio::spawn(async move { bridge.ask(Command::Notify, asked()).await }));
        }
        let mut ids = Vec::new();
        for _ in 0..MAX_WAITING {
            ids.push(requests.recv().await.unwrap().id);
        }
        assert_eq!(bridge.waiting(), MAX_WAITING);
        let started = tokio::time::Instant::now();
        let over = bridge.ask(Command::Notify, asked()).await.unwrap_err();
        assert_eq!(over.code, Code::RateLimited);
        assert_eq!(started.elapsed(), Duration::ZERO, "refused without waiting");
        assert!(requests.try_recv().is_err(), "and the page was not asked");
        // One answered: room for one more.
        assert!(bridge.reply(ids[0], true, None, None));
        asking.remove(0).await.unwrap().unwrap();
        assert_eq!(bridge.waiting(), MAX_WAITING - 1);
        for id in &ids[1..] {
            bridge.reply(*id, true, None, None);
        }
        for task in asking {
            task.await.unwrap().unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_goes_away_frees_its_slot() {
        let bridge = Arc::new(Bridge::default());
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        let task = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.ask(Command::Focus, asked()).await }
        });
        let request = requests.recv().await.unwrap();
        assert_eq!(bridge.waiting(), 1);
        task.abort();
        let _ = task.await;
        assert_eq!(bridge.waiting(), 0);
        assert!(!bridge.reply(request.id, true, None, None));
    }

    #[tokio::test(start_paused = true)]
    async fn the_page_s_refusal_is_passed_on_within_the_set_of_codes() {
        let bridge = Arc::new(Bridge::default());
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        for (error, code) in [
            (json!({"code":"forbidden","message":"not yours"}), Code::Forbidden),
            (json!({"code":"not_rendered","message":"never shown"}), Code::NotRendered),
            (json!({"code":"sudo","message":"x"}), Code::Internal),
            (json!(null), Code::Internal),
        ] {
            let task = tokio::spawn({
                let bridge = bridge.clone();
                async move { bridge.ask(Command::ReadScreen, asked()).await }
            });
            let request = requests.recv().await.unwrap();
            bridge.reply(request.id, false, None, Some(error));
            assert_eq!(task.await.unwrap().unwrap_err().code, code);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn no_page_yet_is_not_responding_and_ids_are_never_reused() {
        let bridge = Arc::new(Bridge::default());
        assert_eq!(bridge.ask(Command::List, asked()).await.unwrap_err().code, Code::NotResponding);
        let (page, mut requests) = fake_page();
        bridge.set_page(page);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..5 {
            let task = tokio::spawn({
                let bridge = bridge.clone();
                async move { bridge.ask(Command::List, asked()).await }
            });
            let request = requests.recv().await.unwrap();
            assert!(request.id > 0);
            assert!(seen.insert(request.id));
            bridge.reply(request.id, true, None, None);
            assert_eq!(task.await.unwrap(), Ok(Value::Null), "ok with no result is null");
        }
    }
}
