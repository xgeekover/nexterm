//! Tokens (spec D2): one per running shell, the authority of every request.
//!
//! A token is 256 bits from the system's random source (`getrandom`, the
//! same source uuid's v4 draws on, already in the tree), written as
//! base64url without padding: 43 characters of `A–Z a–z 0–9 - _`, safe in
//! an environment variable, a shell word and JSON alike. It is mapped to the
//! session it was issued for, and removed when that session ends; a shell
//! restarted in the same tab is a new session and gets a new token. Nothing
//! keeps one on disk.
//!
//! What is kept is the token's SHA-256, never the token, and a request's
//! token is looked up by its hash: a lookup that takes longer for a closer
//! guess can only ever say how close the guess came to a hash.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::limits::Budget;

/// A token's length in bytes before it is written out: 256 bits.
pub const TOKEN_BYTES: usize = 32;

type Hash = [u8; 32];

fn hash(token: &str) -> Hash {
    Sha256::digest(token.as_bytes()).into()
}

/// A fresh token, or `None` if the system has no randomness to give — then
/// the shell starts without one rather than with a guessable one.
pub fn fresh() -> Option<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

/// One token's session and what it has used of its limits.
#[derive(Debug)]
pub struct Entry {
    pub session_id: String,
    pub budget: Budget,
}

/// The tokens of one running listener.
#[derive(Debug, Default)]
pub struct Tokens {
    by_hash: HashMap<Hash, Entry>,
    by_session: HashMap<String, Hash>,
}

impl Tokens {
    /// A new token for `session_id`, replacing any it had.
    pub fn issue(&mut self, session_id: &str, now: Instant) -> Option<String> {
        let token = fresh()?;
        self.revoke(session_id);
        let key = hash(&token);
        self.by_hash.insert(key, Entry { session_id: session_id.to_string(), budget: Budget::new(now) });
        self.by_session.insert(session_id.to_string(), key);
        Some(token)
    }

    /// `session_id`'s token gone, if it had one.
    pub fn revoke(&mut self, session_id: &str) {
        if let Some(key) = self.by_session.remove(session_id) {
            self.by_hash.remove(&key);
        }
    }

    /// Every token gone.
    pub fn clear(&mut self) {
        self.by_hash.clear();
        self.by_session.clear();
    }

    /// The entry `token` stands for, if it is one of ours.
    pub fn lookup(&mut self, token: &str) -> Option<&mut Entry> {
        self.by_hash.get_mut(&hash(token))
    }

}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    impl Tokens {
        pub(crate) fn len(&self) -> usize {
            self.by_hash.len()
        }
    }

    #[test]
    fn a_token_is_256_random_bits_in_base64url_without_padding() {
        let token = fresh().unwrap();
        assert_eq!(token.len(), 43, "{token}");
        assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{token}");
        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), TOKEN_BYTES);
        let many: std::collections::HashSet<String> = (0..1000).map(|_| fresh().unwrap()).collect();
        assert_eq!(many.len(), 1000, "no two alike");
    }

    #[test]
    fn issue_lookup_revoke() {
        let now = Instant::now();
        let mut tokens = Tokens::default();
        let a = tokens.issue("pty-1", now).unwrap();
        let b = tokens.issue("pty-2", now).unwrap();
        assert_eq!(tokens.lookup(&a).map(|e| e.session_id.clone()).as_deref(), Some("pty-1"));
        assert_eq!(tokens.lookup(&b).map(|e| e.session_id.clone()).as_deref(), Some("pty-2"));
        assert!(tokens.lookup("").is_none());
        assert!(tokens.lookup(&a[..42]).is_none(), "a prefix is not the token");
        assert!(tokens.lookup(&format!("{a}x")).is_none());

        tokens.revoke("pty-1");
        assert!(tokens.lookup(&a).is_none(), "a closed session's token is gone");
        assert!(tokens.lookup(&b).is_some(), "and only that one");
        tokens.revoke("pty-1");
        tokens.revoke("pty-never");
        assert_eq!(tokens.len(), 1);

        tokens.clear();
        assert!(tokens.lookup(&b).is_none());
        assert_eq!(tokens.len(), 0);
    }

    #[test]
    fn a_session_issued_again_has_only_its_new_token() {
        let now = Instant::now();
        let mut tokens = Tokens::default();
        let old = tokens.issue("pty-3", now).unwrap();
        let new = tokens.issue("pty-3", now).unwrap();
        assert_ne!(old, new);
        assert!(tokens.lookup(&old).is_none());
        assert!(tokens.lookup(&new).is_some());
        assert_eq!(tokens.len(), 1);
    }
}
