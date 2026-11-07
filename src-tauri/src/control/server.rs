//! One connection, and the loop that accepts them — the same on every
//! platform: the socket (unix.rs) and the pipe (windows.rs) only hand over
//! streams of a caller already known to be this user.
//!
//! **Framing.** A connection reads one line, answers it, then reads the
//! next: one request at a time, in order, however many arrive together. A
//! caller that wants several at once opens several connections.
//!
//! **Caps and timeouts** (spec D3):
//! - A request line longer than MAX_REQUEST_BYTES is answered `too_large`,
//!   and the connection closed: the rest of it is not waited for.
//! - A connection is *authenticated* once one of its requests has carried a
//!   good token. Until then it has FIRST_LINE_TIMEOUT for each line, from
//!   the accept or its last answer: a caller with a token sends it at once,
//!   and nobody else gets to sit on a connection.
//! - Once authenticated, a line, once its first byte is in, has LINE_TIMEOUT
//!   to reach its LF; then it is answered `bad_request` and the connection
//!   closed (a slow drip of bytes holds nothing for long). A connection with
//!   no line begun closes after IDLE_TIMEOUT.
//! - An answer has WRITE_TIMEOUT to be taken by a caller that does not read.
//! - One terminal's token may hold MAX_CONNECTIONS_PER_TOKEN connections at
//!   once: the request that would prove a fifth is answered `rate_limited`,
//!   and that connection stays unproven (review: one token could otherwise
//!   hold every slot, a request every 29 s on each).
//! - At most MAX_CONNECTIONS are open at once. One more makes room by
//!   closing the oldest connection not authenticated yet, so idle or
//!   tokenless connections cannot keep every terminal's hooks out (review);
//!   failing that, the oldest idle one — waiting for a line, none begun — of
//!   the terminal holding the most, when it holds more than one. Only when
//!   there is neither is the new one answered `rate_limited` (id null) and
//!   closed — "try again", not "not allowed".
//!
//! **Order of checks** (`dispatch`): the API is on; the token is one of
//! ours (the connection is authenticated from here on); the token is within
//! 20 requests a second; the command exists; typing and reading are allowed,
//! for `send`, `read-screen` and a `new-split` with a `command`; `send`'s
//! text is a string of at most 16 KiB and its keys a list; the token is
//! within its per-minute budget for the command (a key counts KEY_BYTES of
//! `send`'s 64 KiB); a `new-split` is within the 20 a minute of all tokens
//! together. Only then is the page asked. A caller without a token learns
//! nothing — not even which commands there are.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::{timeout, timeout_at, Instant};

use super::bridge::Asked;
use super::limits::KEY_BYTES;
use super::protocol::{self, Code, Command, Failure, MAX_REQUEST_BYTES, MAX_SEND_TEXT_BYTES};
use super::Shared;

pub const MAX_CONNECTIONS: usize = 16;
/// The most connections one terminal's token may hold open at once.
pub const MAX_CONNECTIONS_PER_TOKEN: usize = 4;
/// How long a connection not authenticated yet has for each line.
pub const FIRST_LINE_TIMEOUT: Duration = Duration::from_secs(1);
pub const LINE_TIMEOUT: Duration = Duration::from_secs(5);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a refused connection is given to take its one line.
const REFUSAL_TIMEOUT: Duration = Duration::from_secs(1);
/// The pause after a failed accept, so that a persistent failure (no file
/// descriptors left) is not a busy loop.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// Where connections come from: the socket, the pipe, or a test's channel.
/// Each stream is of a caller already checked to be this user.
pub(crate) trait Incoming: Send + 'static {
    type Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    /// The next connection, or `None` when there will be no more.
    fn accept(&mut self) -> impl Future<Output = io::Result<Option<Self::Stream>>> + Send;
}

/// A connection being served, as the accept loop keeps track of it.
struct Open {
    /// In the order accepted: the oldest goes first.
    order: u64,
    conn: Arc<Conn>,
    task: AbortHandle,
}

/// One connection, as both the accept loop and the task serving it see it.
#[derive(Default)]
pub(crate) struct Conn {
    /// The session whose token first proved it: none until a good token
    /// came. Counted in `Shared::held` while it is open.
    session: Mutex<Option<String>>,
    /// Waiting for a line, none of it begun: closing it now loses nothing.
    idle: AtomicBool,
}

impl Conn {
    fn proven(&self) -> bool {
        self.session.lock().is_some()
    }
}

/// The connection to close to make room for one more, if any may be closed
/// (see the module's doc).
fn to_close(open: &HashMap<tokio::task::Id, Open>) -> Option<tokio::task::Id> {
    let oldest = |candidates: Vec<(&tokio::task::Id, &Open)>| candidates.into_iter().min_by_key(|(_, c)| c.order).map(|(id, _)| *id);
    let unproven: Vec<_> = open.iter().filter(|(_, c)| !c.conn.proven()).collect();
    if !unproven.is_empty() {
        return oldest(unproven);
    }
    let mut held: HashMap<String, usize> = HashMap::new();
    for c in open.values() {
        if let Some(session) = c.conn.session.lock().clone() {
            *held.entry(session).or_default() += 1;
        }
    }
    let most = held.values().copied().max().filter(|&most| most > 1)?;
    oldest(
        open.iter()
            .filter(|(_, c)| {
                c.conn.idle.load(Ordering::Acquire) && c.conn.session.lock().as_ref().is_some_and(|s| held.get(s) == Some(&most))
            })
            .collect(),
    )
}

/// Accept and serve connections until `stop` is sent (or its sender
/// dropped) or `incoming` has no more. Every connection is ended and waited
/// for before this returns, and `incoming` — the socket or the pipe — is let
/// go as it does: once it has returned, nothing of this listener answers.
/// Aborting the task running this ends them all too, without the wait.
pub(crate) async fn accept_loop<I: Incoming>(mut incoming: I, shared: Arc<Shared>, mut stop: oneshot::Receiver<()>) {
    let mut tasks = JoinSet::new();
    let mut open: HashMap<tokio::task::Id, Open> = HashMap::new();
    let mut accepted_so_far = 0u64;
    loop {
        let accepted = tokio::select! {
            biased;
            _ = &mut stop => break,
            accepted = incoming.accept() => accepted,
        };
        let stream = match accepted {
            Ok(Some(stream)) => stream,
            Ok(None) => break,
            Err(e) => {
                eprintln!("[NexTerm] The control API could not accept a connection: {e}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        // What has finished is let go of here, not waited for.
        while let Some(done) = tasks.try_join_next_with_id() {
            let id = match done {
                Ok((id, ())) => id,
                Err(e) => e.id(),
            };
            open.remove(&id);
        }
        if open.len() >= MAX_CONNECTIONS {
            match to_close(&open).and_then(|id| open.remove(&id)) {
                Some(closed) => closed.task.abort(),
                None => {
                    tasks.spawn(refuse(stream));
                    continue;
                }
            }
        }
        let conn = Arc::new(Conn::default());
        let task = tasks.spawn({
            let shared = shared.clone();
            let conn = conn.clone();
            async move { serve(stream, &shared, &conn).await }
        });
        accepted_so_far += 1;
        open.insert(task.id(), Open { order: accepted_so_far, conn, task });
    }
    tasks.shutdown().await;
}

/// One line for a connection over the cap, then closed.
async fn refuse<S: AsyncWrite + Unpin>(mut stream: S) {
    let line = protocol::encode_error(
        None,
        &Failure::new(
            Code::RateLimited,
            format!("NexTerm is already serving {MAX_CONNECTIONS} connections from its terminals; try again in a moment"),
        ),
    );
    let _ = timeout(REFUSAL_TIMEOUT, async {
        stream.write_all(&line).await?;
        stream.flush().await?;
        stream.shutdown().await
    })
    .await;
}

/// Write `line` within WRITE_TIMEOUT. False when the caller is gone or did
/// not take it.
async fn send<W: AsyncWrite + Unpin>(writer: &mut W, line: &[u8]) -> bool {
    matches!(
        timeout(WRITE_TIMEOUT, async {
            writer.write_all(line).await?;
            writer.flush().await
        })
        .await,
        Ok(Ok(()))
    )
}

/// While a connection is open, the one it is counted against in
/// `Shared::held` — whatever ends it, an abort included.
struct Holding<'a> {
    shared: &'a Shared,
    conn: &'a Conn,
}

impl Drop for Holding<'_> {
    fn drop(&mut self) {
        let Some(session) = self.conn.session.lock().clone() else { return };
        let mut held = self.shared.held.lock();
        if let Some(count) = held.get_mut(&session) {
            *count -= 1;
            if *count == 0 {
                held.remove(&session);
            }
        }
    }
}

/// Serve one connection until it closes, breaks a rule or times out. `conn`
/// is proven once a request of its carries a good token.
pub(crate) async fn serve<S: AsyncRead + AsyncWrite + Unpin>(stream: S, shared: &Shared, conn: &Conn) {
    let _holding = Holding { shared, conn };
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut pending: Vec<u8> = Vec::new();
    // How far `pending` has been searched for a LF: a line dripped in a byte
    // at a time is searched once, not once per byte.
    let mut searched = 0;
    let mut chunk = vec![0u8; 8192];
    let mut idle_from = Instant::now();
    let mut line_from: Option<Instant> = None;
    let too_large = || {
        protocol::encode_error(
            None,
            &Failure::new(Code::TooLarge, format!("a request line is at most {MAX_REQUEST_BYTES} bytes")),
        )
    };
    loop {
        if let Some(at) = pending[searched..].iter().position(|&b| b == b'\n') {
            let end = searched + at;
            if end > MAX_REQUEST_BYTES {
                let _ = send(&mut writer, &too_large()).await;
                return;
            }
            conn.idle.store(false, Ordering::Release);
            let answer = answer(shared, &pending[..end], conn).await;
            pending.drain(..=end);
            searched = 0;
            if !send(&mut writer, &answer).await {
                return;
            }
            // What came after that line was not read while it was being
            // answered: its time starts now.
            let now = Instant::now();
            idle_from = now;
            line_from = (!pending.is_empty()).then_some(now);
            continue;
        }
        searched = pending.len();
        if pending.len() > MAX_REQUEST_BYTES {
            let _ = send(&mut writer, &too_large()).await;
            return;
        }
        let proven = conn.proven();
        conn.idle.store(line_from.is_none(), Ordering::Release);
        let deadline = match line_from {
            _ if !proven => idle_from + FIRST_LINE_TIMEOUT,
            Some(started) => started + LINE_TIMEOUT,
            None => idle_from + IDLE_TIMEOUT,
        };
        match timeout_at(deadline, reader.read(&mut chunk)).await {
            Err(_) => {
                if line_from.is_some() && proven {
                    let failure = Failure::new(
                        Code::BadRequest,
                        format!("the request line was not finished within {} s", LINE_TIMEOUT.as_secs()),
                    );
                    let _ = send(&mut writer, &protocol::encode_error(None, &failure)).await;
                }
                return;
            }
            Ok(Ok(0)) | Ok(Err(_)) => return,
            Ok(Ok(n)) => {
                conn.idle.store(false, Ordering::Release);
                if line_from.is_none() {
                    line_from = Some(Instant::now());
                }
                pending.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// The answer to one request line, LF included. `conn` is proven when it
/// carried a good token.
pub(crate) async fn answer(shared: &Shared, line: &[u8], conn: &Conn) -> Vec<u8> {
    match protocol::parse(line) {
        Err((id, failure)) => protocol::encode_error(id, &failure),
        Ok(request) => {
            let id = request.id;
            match dispatch(shared, request, conn).await {
                Ok(result) => protocol::encode_result(id, &result),
                Err(failure) => protocol::encode_error(Some(id), &failure),
            }
        }
    }
}

/// Check a request and hand it to the page (see the module's doc for the order).
async fn dispatch(shared: &Shared, request: protocol::Request, conn: &Conn) -> Result<Value, Failure> {
    let settings = *shared.settings.lock();
    if !settings.enabled {
        return Err(Failure::new(Code::Disabled, "the control API is off (Settings \u{25b8} Terminal \u{25b8} Control)"));
    }
    let now = Instant::now();
    let (session_id, cmd) = {
        let mut tokens = shared.tokens.lock();
        let Some(entry) = tokens.lookup(&request.token) else {
            return Err(Failure::new(
                Code::Unauthorized,
                "this token is not NexTerm's, or its terminal has closed (a restarted shell has a new one)",
            ));
        };
        // The first good token on this connection: counted against that
        // terminal's connections, of which it may hold so many.
        if !conn.proven() {
            let mut held = shared.held.lock();
            let count = held.entry(entry.session_id.clone()).or_insert(0);
            if *count >= MAX_CONNECTIONS_PER_TOKEN {
                return Err(Failure::new(
                    Code::RateLimited,
                    format!("this terminal already has {MAX_CONNECTIONS_PER_TOKEN} connections open to NexTerm"),
                ));
            }
            *count += 1;
            *conn.session.lock() = Some(entry.session_id.clone());
        }
        if !entry.budget.request(now) {
            return Err(Failure::new(Code::RateLimited, "more than 20 requests a second from this terminal"));
        }
        let Some(cmd) = Command::parse(&request.cmd) else {
            return Err(Failure::new(Code::UnknownCommand, format!("unknown command {}", protocol::shown(&request.cmd))));
        };
        if cmd.needs_type_and_read(&request.args) && !settings.type_and_read {
            return Err(Failure::new(
                Code::Disabled,
                "typing into and reading terminals is off (Settings \u{25b8} Terminal \u{25b8} Control)",
            ));
        }
        match cmd {
            Command::Send => {
                let bytes = match request.args.get("text") {
                    None => 0,
                    Some(Value::String(text)) => text.len(),
                    Some(_) => return Err(Failure::new(Code::BadRequest, "send: text must be a string")),
                };
                if bytes > MAX_SEND_TEXT_BYTES {
                    return Err(Failure::new(
                        Code::TooLarge,
                        format!("send: text is {bytes} bytes; at most {MAX_SEND_TEXT_BYTES} go at once"),
                    ));
                }
                // Keys type too: each counts as much as any key can encode to.
                let keys = match request.args.get("keys") {
                    None => 0,
                    Some(Value::Array(keys)) => keys.len(),
                    Some(_) => return Err(Failure::new(Code::BadRequest, "send: keys must be a list of key names")),
                };
                if !entry.budget.send(bytes + keys * KEY_BYTES, now) {
                    return Err(Failure::new(Code::RateLimited, "more than 64 KiB sent from this terminal in a minute"));
                }
            }
            Command::ReadScreen => {
                if !entry.budget.read(now) {
                    return Err(Failure::new(Code::RateLimited, "more than 30 screen reads from this terminal in a minute"));
                }
            }
            Command::NewSplit => {
                // This terminal's own ten asked first, so that one caller
                // firing twenty at once cannot use up everyone's — but only
                // taken once the shared twenty has let it through: a split
                // refused costs nothing, as everywhere else (limits.rs).
                if !entry.budget.split_fits(now) {
                    return Err(Failure::new(Code::RateLimited, "more than 10 splits from this terminal in a minute"));
                }
                if !shared.splits.lock().take(now) {
                    return Err(Failure::new(Code::RateLimited, "more than 20 splits opened by programs in a minute"));
                }
                entry.budget.split(now);
            }
            _ => {}
        }
        (entry.session_id.clone(), cmd)
    };
    shared
        .bridge
        .ask(
            cmd,
            Asked {
                session_id,
                args: request.args,
                type_and_read: settings.type_and_read,
                other_terminals: settings.other_terminals,
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::super::bridge::tests::fake_page;
    use super::super::bridge::PageRequest;
    use super::super::{Settings, Shared};
    use super::*;
    use serde_json::json;
    use tokio::io::{duplex, AsyncBufReadExt, BufReader, DuplexStream};
    use tokio::sync::mpsc;

    /// A server half for one connection, its client half, and the page's
    /// requests — with a token for session pty-1.
    struct Setup {
        shared: Arc<Shared>,
        requests: mpsc::UnboundedReceiver<PageRequest>,
        token: String,
    }

    fn setup(settings: Settings) -> Setup {
        let shared = Arc::new(Shared::new());
        *shared.settings.lock() = settings;
        let (page, requests) = fake_page();
        shared.bridge.set_page(page);
        let token = shared.tokens.lock().issue("pty-1", Instant::now()).unwrap();
        Setup { shared, requests, token }
    }

    fn on() -> Settings {
        Settings { enabled: true, type_and_read: true, other_terminals: false }
    }

    /// A connection to `shared`, served on a task of its own.
    fn connect(shared: &Arc<Shared>) -> BufReader<DuplexStream> {
        let (client, server) = duplex(256 * 1024);
        let shared = shared.clone();
        tokio::spawn(async move { serve(server, &shared, &Conn::default()).await });
        BufReader::new(client)
    }

    /// A connection that has shown a good token (with a page answering).
    async fn authenticated(shared: &Arc<Shared>, token: &str) -> BufReader<DuplexStream> {
        let mut client = connect(shared);
        client.get_mut().write_all(&request(0, token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
        client
    }

    async fn read_answer(client: &mut BufReader<DuplexStream>) -> Option<Value> {
        let mut line = String::new();
        match client.read_line(&mut line).await {
            Ok(0) => None,
            Ok(_) => Some(serde_json::from_str(&line).expect("an answer is JSON")),
            Err(e) => panic!("reading the answer: {e}"),
        }
    }

    fn request(id: u64, token: &str, cmd: &str, args: Value) -> Vec<u8> {
        let mut line = serde_json::to_vec(&json!({"v":1,"id":id,"token":token,"cmd":cmd,"args":args})).unwrap();
        line.push(b'\n');
        line
    }

    /// The page answers every request `ok` with its own payload as the result.
    fn echo_page(mut requests: mpsc::UnboundedReceiver<PageRequest>, shared: Arc<Shared>) {
        tokio::spawn(async move {
            while let Some(request) = requests.recv().await {
                let echoed = serde_json::to_value(&request).unwrap();
                shared.bridge.reply(request.id, true, Some(echoed), None);
            }
        });
    }

    async fn code_of(client: &mut BufReader<DuplexStream>) -> String {
        let answer = read_answer(client).await.expect("an answer");
        answer["error"]["code"].as_str().unwrap_or("ok").to_string()
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_goes_to_the_page_with_its_session_and_never_its_token() {
        let Setup { shared, mut requests, token } = setup(on());
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(11, &token, "notify", json!({"title":"Done"}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        assert_eq!(asked.session_id, "pty-1");
        assert_eq!(asked.cmd, "notify");
        assert_eq!(asked.args, json!({"title":"Done"}).as_object().unwrap().clone());
        assert!(asked.type_and_read && !asked.other_terminals, "the settings of the moment");
        let payload = serde_json::to_string(&asked).unwrap();
        assert!(!payload.contains(&token), "the page is never handed the token: {payload}");
        assert_eq!(
            serde_json::to_value(&asked).unwrap().as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
            ["args", "cmd", "deadline_at", "id", "other_terminals", "session_id", "type_and_read"],
        );
        shared.bridge.reply(asked.id, true, Some(json!({"shown":true})), None);
        let answer = read_answer(&mut client).await.unwrap();
        assert_eq!(answer, json!({"v":1,"id":11,"ok":true,"result":{"shown":true}}));
    }

    #[tokio::test(start_paused = true)]
    async fn the_settings_reach_the_page_as_they_are_now() {
        let Setup { shared, mut requests, token } = setup(on());
        let mut client = connect(&shared);
        for (type_and_read, other_terminals) in [(true, false), (true, true)] {
            *shared.settings.lock() = Settings { enabled: true, type_and_read, other_terminals };
            client.get_mut().write_all(&request(1, &token, "focus", json!({}))).await.unwrap();
            let asked = requests.recv().await.unwrap();
            assert_eq!((asked.type_and_read, asked.other_terminals), (type_and_read, other_terminals));
            shared.bridge.reply(asked.id, true, None, None);
            read_answer(&mut client).await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn no_token_or_an_unknown_one_is_unauthorized_and_the_page_is_not_asked() {
        let Setup { shared, mut requests, token } = setup(on());
        let mut client = connect(&shared);
        client.get_mut().write_all(b"{\"v\":1,\"id\":1,\"cmd\":\"list\"}\n").await.unwrap();
        assert_eq!(code_of(&mut client).await, "unauthorized");
        for wrong in ["", "x", &token[..42], &format!("{token}A"), &token.to_lowercase()] {
            client.get_mut().write_all(&request(2, wrong, "list", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "unauthorized", "token {wrong:?}");
        }
        // Not even an unknown command is told apart without a token.
        client.get_mut().write_all(&request(3, "x", "no-such", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "unauthorized");
        assert!(requests.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_session_s_token_is_refused_and_another_session_s_is_its_own() {
        let Setup { shared, mut requests, token } = setup(on());
        let other = shared.tokens.lock().issue("pty-2", Instant::now()).unwrap();
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(1, &other, "list", json!({}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        assert_eq!(asked.session_id, "pty-2", "a token acts as its own session, whoever sends it");
        shared.bridge.reply(asked.id, true, None, None);
        read_answer(&mut client).await.unwrap();

        shared.tokens.lock().revoke("pty-1");
        client.get_mut().write_all(&request(2, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "unauthorized");
        assert!(requests.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unknown_command_or_version_is_an_error_not_ignored() {
        let Setup { shared, requests, token } = setup(on());
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(1, &token, "run-anything", json!({}))).await.unwrap();
        let answer = read_answer(&mut client).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("unknown_command"));
        assert_eq!(answer["id"], json!(1));
        client.get_mut().write_all(b"{\"v\":2,\"id\":2,\"token\":\"t\",\"cmd\":\"list\"}\n").await.unwrap();
        let answer = read_answer(&mut client).await.unwrap();
        assert_eq!((answer["error"]["code"].clone(), answer["id"].clone()), (json!("bad_request"), json!(2)));
        drop(requests);
    }

    #[tokio::test(start_paused = true)]
    async fn bad_lines_are_answered_and_the_connection_goes_on() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        for bad in [&b"\xff\xfe\n"[..], b"not json\n", b"[]\n", b"\n", b"{\"v\":1}\n"] {
            client.get_mut().write_all(bad).await.unwrap();
            let answer = read_answer(&mut client).await.expect("still open");
            assert_eq!(answer["error"]["code"], json!("bad_request"), "{:?}", String::from_utf8_lossy(bad));
            assert_eq!(answer["id"], Value::Null);
        }
        client.get_mut().write_all(&request(5, &token, "list", json!({}))).await.unwrap();
        assert_eq!(read_answer(&mut client).await.unwrap()["ok"], json!(true));
    }

    #[tokio::test(start_paused = true)]
    async fn a_line_dripped_a_byte_at_a_time_and_lines_sent_together_are_each_answered_in_order() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        for byte in request(1, &token, "list", json!({})) {
            client.get_mut().write_all(&[byte]).await.unwrap();
        }
        assert_eq!(read_answer(&mut client).await.unwrap()["id"], json!(1));
        let mut together = Vec::new();
        for id in 2..=6 {
            together.extend(request(id, &token, "list", json!({})));
        }
        // And half of one more, finished afterwards.
        let last = request(7, &token, "list", json!({}));
        together.extend(&last[..10]);
        client.get_mut().write_all(&together).await.unwrap();
        for id in 2..=6 {
            assert_eq!(read_answer(&mut client).await.unwrap()["id"], json!(id));
        }
        client.get_mut().write_all(&last[10..]).await.unwrap();
        assert_eq!(read_answer(&mut client).await.unwrap()["id"], json!(7));
    }

    #[tokio::test(start_paused = true)]
    async fn a_line_over_64_kib_is_too_large_and_the_connection_closes() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        // 64 KiB of line and its LF: read (and refused as not JSON).
        let mut client = connect(&shared);
        let mut at_cap = vec![b'x'; MAX_REQUEST_BYTES];
        at_cap.push(b'\n');
        client.get_mut().write_all(&at_cap).await.unwrap();
        assert_eq!(code_of(&mut client).await, "bad_request");
        client.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "and the connection goes on");

        // One byte more, with its LF in the same write.
        let mut client = connect(&shared);
        let mut over = vec![b'x'; MAX_REQUEST_BYTES + 1];
        over.push(b'\n');
        client.get_mut().write_all(&over).await.unwrap();
        assert_eq!(code_of(&mut client).await, "too_large");
        assert!(read_answer(&mut client).await.is_none(), "closed");

        // And without any LF: refused as soon as the cap is passed.
        let mut client = connect(&shared);
        client.get_mut().write_all(&vec![b'{'; MAX_REQUEST_BYTES + 1]).await.unwrap();
        assert_eq!(code_of(&mut client).await, "too_large");
        assert!(read_answer(&mut client).await.is_none(), "closed");
    }

    #[tokio::test(start_paused = true)]
    async fn a_line_unfinished_after_five_seconds_is_dropped_and_one_finished_in_time_is_answered() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let line = request(1, &token, "list", json!({}));

        // `sleep`, not `advance`: the clock moves on through the server's
        // timers in order, so one that fires too early is seen to fire.
        let mut client = authenticated(&shared, &token).await;
        client.get_mut().write_all(&line[..5]).await.unwrap();
        tokio::time::sleep(LINE_TIMEOUT - Duration::from_millis(1)).await;
        client.get_mut().write_all(&line[5..]).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "just in time");

        let mut client = authenticated(&shared, &token).await;
        let started = Instant::now();
        client.get_mut().write_all(&line[..5]).await.unwrap();
        let answer = read_answer(&mut client).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("bad_request"));
        assert_eq!(started.elapsed(), LINE_TIMEOUT);
        assert!(read_answer(&mut client).await.is_none(), "closed");

        // A drip of a byte a second does not keep a line alive.
        let mut client = authenticated(&shared, &token).await;
        let started = Instant::now();
        for byte in &line[..line.len() - 1] {
            if client.get_mut().write_all(&[*byte]).await.is_err() {
                break;
            }
            tokio::time::advance(Duration::from_secs(1)).await;
            if started.elapsed() > LINE_TIMEOUT {
                break;
            }
        }
        assert_eq!(code_of(&mut client).await, "bad_request");
        assert!(read_answer(&mut client).await.is_none(), "closed");
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_connection_closes_after_thirty_seconds_and_not_before() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = authenticated(&shared, &token).await;
        tokio::time::sleep(IDLE_TIMEOUT - Duration::from_millis(1)).await;
        client.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
        // An answer starts the idle time again.
        let started = Instant::now();
        assert!(read_answer(&mut client).await.is_none());
        assert_eq!(started.elapsed(), IDLE_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_does_not_read_its_answers_is_let_go() {
        let Setup { shared, requests, token } = setup(on());
        // A page answering with half a megabyte, to a connection whose
        // buffer holds a few bytes.
        let big = "y".repeat(512 * 1024);
        tokio::spawn({
            let shared = shared.clone();
            let mut requests = requests;
            async move {
                while let Some(request) = requests.recv().await {
                    shared.bridge.reply(request.id, true, Some(json!(big)), None);
                }
            }
        });
        let (mut client, server) = duplex(64);
        let served = tokio::spawn({
            let shared = shared.clone();
            async move { serve(server, &shared, &Conn::default()).await }
        });
        client.write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        let started = Instant::now();
        served.await.unwrap();
        assert!(started.elapsed() >= WRITE_TIMEOUT && started.elapsed() < WRITE_TIMEOUT + Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn the_api_off_answers_disabled_and_type_and_read_off_refuses_send_and_read_screen() {
        let Setup { shared, mut requests, token } = setup(Settings { enabled: false, ..on() });
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(1, &token, "notify", json!({"title":"x"}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "disabled");

        *shared.settings.lock() = Settings { enabled: true, type_and_read: false, other_terminals: true };
        for cmd in ["send", "read-screen"] {
            client.get_mut().write_all(&request(2, &token, cmd, json!({"text":"ls\n"}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "disabled", "{cmd}");
        }
        // A split that types a command is typing.
        client.get_mut().write_all(&request(2, &token, "new-split", json!({"command":"rm -rf build"}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "disabled", "new-split with a command");
        assert!(requests.try_recv().is_err(), "the backend refused them; the page never heard");
        // One without is not.
        client.get_mut().write_all(&request(2, &token, "new-split", json!({"direction":"down"}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        assert_eq!(asked.cmd, "new-split");
        shared.bridge.reply(asked.id, true, None, None);
        assert_eq!(code_of(&mut client).await, "ok");

        // Everything else still goes.
        client.get_mut().write_all(&request(3, &token, "set-status", json!({"text":"Running"}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        assert_eq!(asked.cmd, "set-status");
        shared.bridge.reply(asked.id, true, None, None);
        assert_eq!(code_of(&mut client).await, "ok");

        *shared.settings.lock() = on();
        client.get_mut().write_all(&request(4, &token, "send", json!({"text":"ls\n"}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        assert_eq!(asked.cmd, "send");
        shared.bridge.reply(asked.id, true, None, None);
        assert_eq!(code_of(&mut client).await, "ok");
    }

    #[tokio::test(start_paused = true)]
    async fn send_text_is_a_string_of_at_most_16_kib() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(1, &token, "send", json!({"text":"x".repeat(MAX_SEND_TEXT_BYTES + 1)}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "too_large");
        // Counted in bytes: 한 is three.
        client.get_mut().write_all(&request(2, &token, "send", json!({"text":"한".repeat(MAX_SEND_TEXT_BYTES / 3 + 1)}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "too_large");
        for text in [json!(1), json!(null), json!(["ls"])] {
            client.get_mut().write_all(&request(3, &token, "send", json!({"text":text}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "bad_request", "text {text}");
        }
        client.get_mut().write_all(&request(4, &token, "send", json!({"text":"x".repeat(MAX_SEND_TEXT_BYTES)}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
        client.get_mut().write_all(&request(5, &token, "send", json!({"keys":["Enter"]}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
    }

    #[tokio::test(start_paused = true)]
    async fn twenty_a_second_with_a_burst_of_forty_per_token() {
        let Setup { shared, requests, token } = setup(on());
        let other = shared.tokens.lock().issue("pty-2", Instant::now()).unwrap();
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        for i in 0..40 {
            client.get_mut().write_all(&request(i, &token, "set-progress", json!({"state":"normal"}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "request {i}");
        }
        client.get_mut().write_all(&request(40, &token, "set-progress", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
        // Refused requests count too: an unknown command is no way round it.
        client.get_mut().write_all(&request(41, &token, "nothing", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
        client.get_mut().write_all(&request(42, &other, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "another token has its own");
        tokio::time::advance(Duration::from_millis(50)).await;
        client.get_mut().write_all(&request(43, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "one more after 50 ms");
    }

    #[tokio::test(start_paused = true)]
    async fn send_is_held_to_64_kib_a_minute_and_read_screen_to_30() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        let text = "x".repeat(MAX_SEND_TEXT_BYTES);
        for i in 0..4 {
            client.get_mut().write_all(&request(i, &token, "send", json!({"text":text}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "send {i}");
        }
        client.get_mut().write_all(&request(4, &token, "send", json!({"text":"x"}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
        for i in 0..30 {
            // Two a second, within the request rate.
            tokio::time::advance(Duration::from_millis(500)).await;
            client.get_mut().write_all(&request(10 + i, &token, "read-screen", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "read {i}");
        }
        client.get_mut().write_all(&request(40, &token, "read-screen", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
        // A minute after the sends, they are free again.
        tokio::time::advance(Duration::from_secs(46)).await;
        client.get_mut().write_all(&request(41, &token, "send", json!({"text":text}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
    }

    #[tokio::test(start_paused = true)]
    async fn keys_count_against_the_send_budget() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        // 64 KiB a minute is 4096 keys of 16 bytes: 64 sends of 64 keys.
        let keys = json!(vec!["Enter"; 64]);
        for i in 0..(64 * 1024 / (64 * KEY_BYTES)) {
            tokio::time::advance(Duration::from_millis(60)).await;
            client.get_mut().write_all(&request(i as u64, &token, "send", json!({"keys":keys}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "send {i}");
        }
        client.get_mut().write_all(&request(99, &token, "send", json!({"keys":["Enter"]}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
        client.get_mut().write_all(&request(100, &token, "send", json!({"keys":"Enter"}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "bad_request", "keys must be a list");
    }

    #[tokio::test(start_paused = true)]
    async fn twenty_splits_a_minute_from_all_terminals_together() {
        let Setup { shared, requests, token } = setup(on());
        let others: Vec<String> = (2..=5).map(|n| shared.tokens.lock().issue(&format!("pty-{n}"), Instant::now()).unwrap()).collect();
        echo_page(requests, shared.clone());
        let mut client = connect(&shared);
        // Each split's own shell would have a token of its own; five tokens
        // take turns here.
        for i in 0..20usize {
            let who = if i % 5 == 0 { &token } else { &others[i % 5 - 1] };
            client.get_mut().write_all(&request(i as u64, who, "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "split {i}");
        }
        for who in std::iter::once(&token).chain(&others) {
            client.get_mut().write_all(&request(20, who, "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "rate_limited", "the 21st, from any of them");
        }
        client.get_mut().write_all(&request(21, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "only splits are held back");
        tokio::time::advance(Duration::from_secs(60)).await;
        client.get_mut().write_all(&request(22, &others[0], "new-split", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok", "a minute later");
    }

    /// One terminal firing splits gets its own ten a minute, and leaves the
    /// rest of the shared twenty for the others.
    #[tokio::test(start_paused = true)]
    async fn one_terminal_gets_ten_splits_a_minute_and_leaves_the_rest_to_others() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let others = tokens_for(&shared, 2);
        let mut client = connect(&shared);
        for i in 0..15u64 {
            client.get_mut().write_all(&request(i, &token, "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, if i < 10 { "ok" } else { "rate_limited" }, "split {i}");
        }
        for i in 0..10u64 {
            client.get_mut().write_all(&request(i, &others[0], "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "another terminal's split {i}");
        }
        // Twenty in all now: the shared limit holds for a third terminal.
        client.get_mut().write_all(&request(99, &others[1], "new-split", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "rate_limited");
    }

    /// A split the shared twenty refuses costs the terminal none of its own
    /// ten: a minute on, it has all ten again.
    #[tokio::test(start_paused = true)]
    async fn a_split_refused_by_the_shared_limit_costs_the_terminal_nothing() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let others = tokens_for(&shared, 2);
        // Two other terminals take all twenty at once.
        let mut client = connect(&shared);
        for (i, other) in others.iter().flat_map(|o| std::iter::repeat_n(o, 10)).enumerate() {
            client.get_mut().write_all(&request(i as u64, other, "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "split {i}");
        }
        // Thirty seconds on, this terminal asks three times: refused, by the shared limit.
        tokio::time::advance(Duration::from_secs(30)).await;
        let mut client = connect(&shared);
        for i in 0..3u64 {
            client.get_mut().write_all(&request(i, &token, "new-split", json!({}))).await.unwrap();
            let answer = read_answer(&mut client).await.unwrap();
            assert_eq!(answer["error"]["code"], json!("rate_limited"));
            assert!(answer["error"]["message"].as_str().unwrap().contains("20 splits"), "{answer}");
        }
        // A minute after the twenty, they are free again — and this
        // terminal still has all ten of its own.
        tokio::time::advance(Duration::from_secs(31)).await;
        let mut client = connect(&shared);
        for i in 0..10u64 {
            client.get_mut().write_all(&request(i, &token, "new-split", json!({}))).await.unwrap();
            assert_eq!(code_of(&mut client).await, "ok", "its own split {i}");
        }
        client.get_mut().write_all(&request(10, &token, "new-split", json!({}))).await.unwrap();
        let answer = read_answer(&mut client).await.unwrap();
        assert!(answer["error"]["message"].as_str().unwrap().contains("10 splits"), "and then its own limit: {answer}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_does_not_answer_is_not_responding_and_the_next_request_still_works() {
        let Setup { shared, mut requests, token } = setup(on());
        let mut client = connect(&shared);
        client.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        let started = Instant::now();
        let answer = read_answer(&mut client).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("not_responding"));
        assert_eq!(started.elapsed(), super::super::bridge::REPLY_TIMEOUT);
        let ignored = requests.recv().await.unwrap();
        assert!(!shared.bridge.reply(ignored.id, true, None, None), "too late to count");
        client.get_mut().write_all(&request(2, &token, "list", json!({}))).await.unwrap();
        let asked = requests.recv().await.unwrap();
        shared.bridge.reply(asked.id, true, Some(json!("late but fine")), None);
        assert_eq!(read_answer(&mut client).await.unwrap()["result"], json!("late but fine"));
    }

    /// Connections from a channel, as the accept loop sees them.
    struct Channel(mpsc::UnboundedReceiver<DuplexStream>);
    impl Incoming for Channel {
        type Stream = DuplexStream;
        async fn accept(&mut self) -> io::Result<Option<DuplexStream>> {
            Ok(self.0.recv().await)
        }
    }

    /// An accept loop on a channel, and a way to open connections to it.
    fn listening(shared: &Arc<Shared>) -> (impl Fn() -> BufReader<DuplexStream>, oneshot::Sender<()>) {
        let (incoming, connections) = mpsc::unbounded_channel();
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(accept_loop(Channel(connections), shared.clone(), stopped));
        let open = move || {
            let (client, server) = duplex(4096);
            incoming.send(server).unwrap();
            BufReader::new(client)
        };
        (open, stop)
    }

    async fn ok_on(client: &mut BufReader<DuplexStream>, token: &str) {
        client.get_mut().write_all(&request(1, token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(client).await, "ok");
    }

    /// Tokens for sessions `pty-100`, `pty-101`, …: one terminal each. A
    /// second call issues those sessions new tokens, and the first call's
    /// are no longer good.
    fn tokens_for(shared: &Shared, how_many: usize) -> Vec<String> {
        (0..how_many).map(|n| shared.tokens.lock().issue(&format!("pty-{}", 100 + n), Instant::now()).unwrap()).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn sixteen_authenticated_connections_are_served_and_more_are_rate_limited_until_one_closes() {
        let Setup { shared, requests, token: _ } = setup(on());
        echo_page(requests, shared.clone());
        let (open, _stop) = listening(&shared);
        // Sixteen terminals, one connection each: none holds more than one,
        // so none is closed for a newcomer.
        let tokens = tokens_for(&shared, MAX_CONNECTIONS);
        let token = tokens[0].clone();
        let mut served = Vec::new();
        for token in &tokens {
            let mut client = open();
            ok_on(&mut client, token).await;
            served.push(client);
        }
        // A thousand more, all at once: "try again", with no id to answer.
        let mut refused = Vec::new();
        for _ in 0..1000 {
            refused.push(open());
        }
        for client in &mut refused {
            let answer = read_answer(client).await.expect("one line");
            assert_eq!(answer["error"]["code"], json!("rate_limited"));
            assert_eq!(answer["id"], Value::Null);
            assert!(read_answer(client).await.is_none(), "then closed");
        }
        // The sixteen are untouched.
        for (client, token) in served.iter_mut().zip(&tokens) {
            ok_on(client, token).await;
        }
        // One gone: room for one, and only one.
        drop(served.remove(0));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let mut again = open();
        ok_on(&mut again, &token).await;
        let mut extra = open();
        assert_eq!(code_of(&mut extra).await, "rate_limited");
    }

    /// Sixteen connections that never say anything cannot keep a terminal's
    /// hook out: each new one closes the oldest of them, at once.
    #[tokio::test(start_paused = true)]
    async fn at_the_cap_the_oldest_connection_without_a_token_makes_room() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let (open, _stop) = listening(&shared);
        let mut idle: Vec<_> = (0..MAX_CONNECTIONS).map(|_| open()).collect();
        let mut hooks = Vec::new();
        for round in 0..3 {
            let mut hook = open();
            ok_on(&mut hook, &token).await;
            let started = Instant::now();
            assert!(read_answer(&mut idle[round]).await.is_none(), "the oldest idle one is closed");
            assert_eq!(started.elapsed(), Duration::ZERO, "made room for, not timed out");
            hooks.push(hook);
        }
        // The rest are still open: one of them is served.
        ok_on(&mut idle[3], &token).await;

        // One that sent a bad token has proven nothing either; one with a
        // good token is kept over it.
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let (open, _stop) = listening(&shared);
        let tokens = tokens_for(&shared, MAX_CONNECTIONS);
        let mut proven = Vec::new();
        for token in &tokens[..MAX_CONNECTIONS - 1] {
            let mut client = open();
            ok_on(&mut client, token).await;
            proven.push(client);
        }
        let mut stranger = open();
        stranger.get_mut().write_all(&request(1, "wrong", "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut stranger).await, "unauthorized");
        let mut hook = open();
        ok_on(&mut hook, &tokens[MAX_CONNECTIONS - 1]).await;
        assert!(read_answer(&mut stranger).await.is_none(), "the tokenless one went");
        for (client, token) in proven.iter_mut().zip(&tokens) {
            ok_on(client, token).await;
        }
        let _ = token;
        let mut late = open();
        assert_eq!(code_of(&mut late).await, "rate_limited", "all sixteen proven, one each: none is closed for it");
    }

    /// One terminal holds at most four connections: a fifth is refused when
    /// it shows the token, and stays unproven.
    #[tokio::test(start_paused = true)]
    async fn one_token_holds_at_most_four_connections() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let other = tokens_for(&shared, 1).remove(0);
        let mut four = Vec::new();
        for _ in 0..MAX_CONNECTIONS_PER_TOKEN {
            four.push(authenticated(&shared, &token).await);
        }
        let mut fifth = connect(&shared);
        fifth.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        let answer = read_answer(&mut fifth).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("rate_limited"));
        let started = Instant::now();
        assert!(read_answer(&mut fifth).await.is_none(), "still unproven: a second for its next line");
        assert_eq!(started.elapsed(), FIRST_LINE_TIMEOUT);
        // Another terminal is not held back by this one's four.
        authenticated(&shared, &other).await;
        // One of the four gone: room for one more of this terminal's.
        drop(four.pop());
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let _again = authenticated(&shared, &token).await;
        for client in &mut four {
            ok_on(client, &token).await;
        }
        let mut sixth = connect(&shared);
        sixth.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut sixth).await, "rate_limited", "four again");
    }

    /// At the cap with every connection proven, the terminal holding the
    /// most gives up its oldest idle connection — never one in the middle
    /// of a request, never a terminal's only one.
    #[tokio::test(start_paused = true)]
    async fn at_the_cap_the_terminal_holding_the_most_gives_up_its_oldest_idle_connection() {
        let Setup { shared, mut requests, token } = setup(on());
        let (open, _stop) = listening(&shared);
        async fn answer_next(requests: &mut mpsc::UnboundedReceiver<PageRequest>, shared: &Shared) {
            let request = requests.recv().await.expect("a request for the page");
            shared.bridge.reply(request.id, true, None, None);
        }
        // This terminal: four connections, the oldest in the middle of a
        // request the page has not answered.
        let mut busy = open();
        busy.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        let held_request = requests.recv().await.unwrap();
        let mut mine = Vec::new();
        for _ in 0..3 {
            let mut client = open();
            client.get_mut().write_all(&request(2, &token, "list", json!({}))).await.unwrap();
            requests.recv().await.map(|r| shared.bridge.reply(r.id, true, None, None)).unwrap();
            assert_eq!(code_of(&mut client).await, "ok");
            mine.push(client);
        }
        // Twelve other terminals, one each: sixteen in all.
        let others = tokens_for(&shared, MAX_CONNECTIONS - 4);
        let mut theirs = Vec::new();
        for other in &others {
            let mut client = open();
            client.get_mut().write_all(&request(3, other, "list", json!({}))).await.unwrap();
            requests.recv().await.map(|r| shared.bridge.reply(r.id, true, None, None)).unwrap();
            assert_eq!(code_of(&mut client).await, "ok");
            theirs.push(client);
        }
        // A newcomer: this terminal's oldest IDLE connection makes room.
        let newcomer_token = shared.tokens.lock().issue("pty-new", Instant::now()).unwrap();
        let mut newcomer = open();
        newcomer.get_mut().write_all(&request(4, &newcomer_token, "list", json!({}))).await.unwrap();
        let started = Instant::now();
        assert!(read_answer(&mut mine[0]).await.is_none(), "the oldest idle one of the biggest holder went");
        assert_eq!(started.elapsed(), Duration::ZERO);
        answer_next(&mut requests, &shared).await;
        assert_eq!(code_of(&mut newcomer).await, "ok");
        // The busy one was kept, and still gets its answer.
        shared.bridge.reply(held_request.id, true, Some(json!("kept")), None);
        assert_eq!(read_answer(&mut busy).await.unwrap()["result"], json!("kept"));
        for client in &mut theirs {
            client.get_mut().write_all(&request(5, &others[0], "focus", json!({}))).await.unwrap();
            answer_next(&mut requests, &shared).await;
            assert_eq!(code_of(client).await, "ok", "every lone connection kept");
        }
    }

    /// Until it shows a good token a connection has a second for each line;
    /// after, the usual five and thirty.
    #[tokio::test(start_paused = true)]
    async fn a_connection_without_a_good_token_has_one_second_for_each_line() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());

        let mut silent = connect(&shared);
        let started = Instant::now();
        assert!(read_answer(&mut silent).await.is_none(), "closed, nothing said");
        assert_eq!(started.elapsed(), FIRST_LINE_TIMEOUT);

        let mut dripping = connect(&shared);
        let started = Instant::now();
        dripping.get_mut().write_all(b"{\"v\":1,").await.unwrap();
        assert!(read_answer(&mut dripping).await.is_none());
        assert_eq!(started.elapsed(), FIRST_LINE_TIMEOUT, "half a line does not buy the five seconds");

        let mut wrong = connect(&shared);
        wrong.get_mut().write_all(&request(1, "wrong", "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut wrong).await, "unauthorized");
        let started = Instant::now();
        assert!(read_answer(&mut wrong).await.is_none(), "a bad token proves nothing");
        assert_eq!(started.elapsed(), FIRST_LINE_TIMEOUT);

        // `sleep`, not `advance`, as above.
        let mut hook = connect(&shared);
        tokio::time::sleep(FIRST_LINE_TIMEOUT - Duration::from_millis(1)).await;
        ok_on(&mut hook, &token).await;
        tokio::time::sleep(IDLE_TIMEOUT - Duration::from_millis(1)).await;
        ok_on(&mut hook, &token).await;
    }

    #[tokio::test(start_paused = true)]
    async fn aborting_the_accept_loop_ends_every_connection() {
        let Setup { shared, requests, token } = setup(on());
        echo_page(requests, shared.clone());
        let (incoming, connections) = mpsc::unbounded_channel();
        let (_stop, stopped) = oneshot::channel();
        let running = tokio::spawn(accept_loop(Channel(connections), shared.clone(), stopped));
        let (client, server) = duplex(4096);
        incoming.send(server).unwrap();
        let mut client = BufReader::new(client);
        client.get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
        assert_eq!(code_of(&mut client).await, "ok");
        running.abort();
        let _ = running.await;
        assert!(read_answer(&mut client).await.is_none(), "closed with the loop");
    }

    /// Stopped, the loop returns only once every connection is gone — one
    /// waiting for the page among them — so that nothing is answered after.
    /// Run here and not on a task of its own: what this test sees the moment
    /// it returns is what `Control::apply` sees, and a connection only
    /// aborted, not yet dropped, would still be there to see.
    #[tokio::test(start_paused = true)]
    async fn a_stopped_accept_loop_returns_once_every_connection_is_gone() {
        let Setup { shared, mut requests, token } = setup(on());
        let (incoming, connections) = mpsc::unbounded_channel();
        let (stop, stopped) = oneshot::channel();
        let driver = tokio::spawn({
            let shared = shared.clone();
            async move {
                let mut clients = Vec::new();
                for _ in 0..3 {
                    let (client, server) = duplex(4096);
                    incoming.send(server).unwrap();
                    clients.push(BufReader::new(client));
                }
                clients[0].get_mut().write_all(&request(1, &token, "list", json!({}))).await.unwrap();
                let asked = requests.recv().await.unwrap();
                assert_eq!(shared.bridge.waiting(), 1);
                stop.send(()).unwrap();
                // `incoming` goes back too: dropped, it would end the loop by itself.
                (clients, asked, incoming)
            }
        });
        let started = Instant::now();
        accept_loop(Channel(connections), shared.clone(), stopped).await;
        assert_eq!(shared.bridge.waiting(), 0, "the request waiting for the page went with its connection");
        assert_eq!(started.elapsed(), Duration::ZERO, "no timeout waited for");
        let (mut clients, asked, _incoming) = driver.await.unwrap();
        assert!(!shared.bridge.reply(asked.id, true, None, None));
        for client in &mut clients {
            assert!(read_answer(client).await.is_none(), "every connection closed, none answered");
        }
        // Its sender dropped is a stop too.
        let (_incoming, connections) = mpsc::unbounded_channel::<DuplexStream>();
        let (stop, stopped) = oneshot::channel::<()>();
        drop(stop);
        accept_loop(Channel(connections), shared.clone(), stopped).await;
    }
}
