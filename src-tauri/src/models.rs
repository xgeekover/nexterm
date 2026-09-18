use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtyOutputPayload {
    pub session_id: String,
    pub data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtyExitPayload {
    pub session_id: String,
    pub exit_code: Option<u32>,
}

/// Emitted when the shell reports (via OSC 133's "C" marker) that a command
/// has begun running — the moment its output starts.
///
/// No command text: the marker carries none, and the backend deliberately does
/// not reconstruct it from the echoed prompt line. What this says is only
/// "something is running in this session", which is what a tab indicator needs.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtyCommandStartedPayload {
    pub session_id: String,
}

/// Emitted when the shell reports (via OSC 133) that a command finished.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtyCommandDonePayload {
    pub session_id: String,
    pub exit_code: Option<u32>,
}

/// Emitted when the shell reports (via OSC 7) its live working directory —
/// on every prompt, so this always reflects wherever the user last `cd`'d
/// to, not just where the session was originally spawned.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtyCwdPayload {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub session_id: String,
    pub shell: String,
    pub created_at: DateTime<Utc>,
    /// The directory the shell started in, as the backend chose it — the UI
    /// shows this rather than guessing from what it asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub children: Option<Vec<FileNode>>,
    pub extension: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FsChangePayload {
    pub path: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub default_shell: String,
    pub home_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tauri_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rust_version: Option<String>,
    /// The Windows build number (e.g. 19045). xterm.js needs it to tell a
    /// ConPTY that ends wrapped lines with a real line break (before 21376)
    /// from one that wraps natively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_build: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pty_payloads() {
        let out = PtyOutputPayload {
            session_id: "pty-1".to_string(),
            data: "hello\r\n".to_string(),
        };
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"session_id\":\"pty-1\""));
        assert!(json.contains("\"data\":\"hello\\r\\n\""));

        let exit = PtyExitPayload {
            session_id: "pty-1".to_string(),
            exit_code: Some(0),
        };
        let exit_json = serde_json::to_string(&exit).unwrap();
        assert!(exit_json.contains("\"exit_code\":0"));
    }

    #[test]
    fn test_pty_session_info() {
        let info = PtySessionInfo {
            id: "pty-1".to_string(),
            session_id: "pty-1".to_string(),
            shell: "/bin/zsh".to_string(),
            created_at: Utc::now(),
            cwd: Some("/Users/test".to_string()),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"id\":\"pty-1\""));
        assert!(json.contains("\"session_id\":\"pty-1\""));
        assert!(json.contains("\"shell\":\"/bin/zsh\""));
        assert!(json.contains("\"cwd\":\"/Users/test\""));
    }

    #[test]
    fn test_system_info() {
        let sys = SystemInfo {
            os: "macos".to_string(),
            default_shell: "/bin/zsh".to_string(),
            home_dir: "/Users/test".to_string(),
            arch: Some("aarch64".to_string()),
            app_version: Some("0.1.0".to_string()),
            tauri_version: Some("2.11.5".to_string()),
            rust_version: Some("1.97.1".to_string()),
            os_build: None,
        };
        let json = serde_json::to_string(&sys).unwrap();
        assert!(json.contains("\"os\":\"macos\""));
        assert!(json.contains("\"default_shell\":\"/bin/zsh\""));
    }
}
