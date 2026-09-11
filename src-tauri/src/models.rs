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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub session_id: String,
    pub shell: String,
    pub created_at: DateTime<Utc>,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Active,
    Waiting,
    Completed,
    Failed,
    Paused,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentLogEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub agent_id: String,
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentState {
    pub id: String,
    pub name: String,
    pub role: String,
    pub model: String,
    pub status: AgentStatus,
    pub current_task: Option<String>,
    pub progress: f32,
    pub tokens_used: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logs: Option<Vec<AgentLogEntry>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateAgentInput {
    pub name: String,
    pub role: String,
    pub model: String,
    #[serde(default, alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    #[serde(default)]
    pub dependency: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub agent_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatTokenPayload {
    pub message_id: String,
    pub agent_id: String,
    pub token: String,
    pub done: bool,
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
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"id\":\"pty-1\""));
        assert!(json.contains("\"session_id\":\"pty-1\""));
        assert!(json.contains("\"shell\":\"/bin/zsh\""));
    }

    #[test]
    fn test_agent_status_lowercase() {
        let status = AgentStatus::Active;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"active\"");

        let waiting: AgentStatus = serde_json::from_str("\"waiting\"").unwrap();
        assert_eq!(waiting, AgentStatus::Waiting);

        let paused: AgentStatus = serde_json::from_str("\"paused\"").unwrap();
        assert_eq!(paused, AgentStatus::Paused);
    }

    #[test]
    fn test_create_agent_input_compatibility() {
        let json = r#"{"name":"Security Auditor","role":"Auditor","model":"GPT-4o","systemPrompt":"Audit dependencies","dependency":"agent-architect-01"}"#;
        let input: CreateAgentInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.name, "Security Auditor");
        assert_eq!(input.system_prompt, Some("Audit dependencies".to_string()));
        assert_eq!(input.dependency, Some("agent-architect-01".to_string()));
    }

    #[test]
    fn test_chat_message_serialization() {
        let msg = ChatMessage {
            id: "msg-1".to_string(),
            agent_id: "agent-1".to_string(),
            role: "assistant".to_string(),
            content: "Hello world".to_string(),
            timestamp: Utc::now(),
            sender: Some("assistant".to_string()),
            text: Some("Hello world".to_string()),
            agent_name: Some("Architect".to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"sender\":\"assistant\""));
        assert!(json.contains("\"text\":\"Hello world\""));
        assert!(json.contains("\"role\":\"assistant\""));
        assert!(json.contains("\"content\":\"Hello world\""));
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
        };
        let json = serde_json::to_string(&sys).unwrap();
        assert!(json.contains("\"os\":\"macos\""));
        assert!(json.contains("\"default_shell\":\"/bin/zsh\""));
    }
}
