use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use chrono::Utc;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::models::{
    AgentLogEntry, AgentState, AgentStatus, ChatMessage, ChatTokenPayload, CreateAgentInput,
};

pub struct AgentRuntime {
    agents: Arc<Mutex<HashMap<String, AgentState>>>,
    logs: Arc<Mutex<HashMap<String, Vec<AgentLogEntry>>>>,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntime {
    pub fn new() -> Self {
        let now = Utc::now();

        let architect_id = "agent-architect-01".to_string();
        let test_eng_id = "agent-test-eng-02".to_string();
        let code_rev_id = "agent-code-rev-03".to_string();

        let architect_logs = vec![
            AgentLogEntry {
                id: Some("log-1".to_string()),
                agent_id: architect_id.clone(),
                timestamp: now - chrono::Duration::seconds(60),
                level: "INFO".to_string(),
                message: "Analyzing project directory tree...".to_string(),
            },
            AgentLogEntry {
                id: Some("log-2".to_string()),
                agent_id: architect_id.clone(),
                timestamp: now - chrono::Duration::seconds(30),
                level: "INFO".to_string(),
                message: "Parsing IPC contract schemas (17 commands, 6 events).".to_string(),
            },
            AgentLogEntry {
                id: Some("log-3".to_string()),
                agent_id: architect_id.clone(),
                timestamp: now - chrono::Duration::seconds(10),
                level: "DEBUG".to_string(),
                message: "Architecture validation 78% completed.".to_string(),
            },
        ];

        let test_eng_logs = vec![AgentLogEntry {
            id: Some("log-4".to_string()),
            agent_id: test_eng_id.clone(),
            timestamp: now - chrono::Duration::seconds(50),
            level: "INFO".to_string(),
            message: "Queued waiting for Architect completion.".to_string(),
        }];

        let mut agents_map = HashMap::new();
        agents_map.insert(
            architect_id.clone(),
            AgentState {
                id: architect_id.clone(),
                name: "Architect".to_string(),
                role: "System Architect".to_string(),
                model: "Claude Opus 4.6".to_string(),
                status: AgentStatus::Active,
                current_task: Some("Analyzing system architecture, interface contracts, and module boundaries.".to_string()),
                progress: 78.0,
                tokens_used: 12431,
                tokens: Some(12431),
                cost: Some(0.186),
                dependency: None,
                system_prompt: Some("Analyze system architecture, interface contracts, and module boundaries.".to_string()),
                logs: Some(architect_logs.clone()),
                created_at: now - chrono::Duration::minutes(5),
                updated_at: now - chrono::Duration::seconds(10),
            },
        );

        agents_map.insert(
            test_eng_id.clone(),
            AgentState {
                id: test_eng_id.clone(),
                name: "Test Engineer".to_string(),
                role: "QA & E2E Specialist".to_string(),
                model: "Gemini 3.8 Flash".to_string(),
                status: AgentStatus::Waiting,
                current_task: Some("Waiting for architecture verification".to_string()),
                progress: 0.0,
                tokens_used: 3520,
                tokens: Some(3520),
                cost: Some(0.007),
                dependency: Some(architect_id.clone()),
                system_prompt: Some("Execute comprehensive 4-tier E2E testing suite and report defects.".to_string()),
                logs: Some(test_eng_logs.clone()),
                created_at: now - chrono::Duration::minutes(4),
                updated_at: now - chrono::Duration::seconds(50),
            },
        );

        agents_map.insert(
            code_rev_id.clone(),
            AgentState {
                id: code_rev_id.clone(),
                name: "Code Reviewer".to_string(),
                role: "Senior Reviewer".to_string(),
                model: "GPT-4o".to_string(),
                status: AgentStatus::Idle,
                current_task: Some("Awaiting code review tasks".to_string()),
                progress: 0.0,
                tokens_used: 0,
                tokens: Some(0),
                cost: Some(0.0),
                dependency: None,
                system_prompt: Some("Perform senior code review, check invariants, and audit security.".to_string()),
                logs: Some(Vec::new()),
                created_at: now - chrono::Duration::minutes(3),
                updated_at: now - chrono::Duration::minutes(1),
            },
        );

        let mut logs_map = HashMap::new();
        logs_map.insert(architect_id, architect_logs);
        logs_map.insert(test_eng_id, test_eng_logs);
        logs_map.insert(code_rev_id, Vec::new());

        Self {
            agents: Arc::new(Mutex::new(agents_map)),
            logs: Arc::new(Mutex::new(logs_map)),
        }
    }

    pub fn list_agents(&self) -> Vec<AgentState> {
        let agents = self.agents.lock();
        let mut list: Vec<AgentState> = agents.values().cloned().collect();
        list.sort_by_key(|a| a.created_at);
        list
    }

    pub fn create_agent_internal(
        &self,
        input: CreateAgentInput,
    ) -> Result<AgentState, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("Agent name is required".to_string());
        }
        let model = input.model.trim();
        if model.is_empty() {
            return Err("Agent model is required".to_string());
        }

        let id = format!("agent-{}", uuid::Uuid::new_v4().simple());
        let dependency = input
            .dependency
            .or_else(|| input.dependencies.and_then(|d| d.into_iter().next()))
            .filter(|s| !s.trim().is_empty());

        let status = if dependency.is_some() {
            AgentStatus::Waiting
        } else {
            AgentStatus::Active
        };

        let now = Utc::now();
        let new_agent = AgentState {
            id: id.clone(),
            name: name.to_string(),
            role: if input.role.trim().is_empty() {
                "Assistant".to_string()
            } else {
                input.role.trim().to_string()
            },
            model: model.to_string(),
            status,
            current_task: Some("Initialized and ready for task assignment".to_string()),
            progress: 0.0,
            tokens_used: 0,
            tokens: Some(0),
            cost: Some(0.0),
            dependency,
            system_prompt: input.system_prompt,
            logs: Some(Vec::new()),
            created_at: now,
            updated_at: now,
        };

        self.agents.lock().insert(id.clone(), new_agent.clone());
        self.logs.lock().insert(id, Vec::new());

        Ok(new_agent)
    }

    pub fn create_agent(
        &self,
        app_handle: &AppHandle,
        input: CreateAgentInput,
    ) -> Result<AgentState, String> {
        let new_agent = self.create_agent_internal(input)?;
        let _ = app_handle.emit("agent-updated", &new_agent);
        Ok(new_agent)
    }

    pub fn update_status_internal(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<(AgentState, Vec<AgentState>), String> {
        let mut unblocked_agents = Vec::new();
        let mut agents = self.agents.lock();
        let is_completed = status == AgentStatus::Completed;
        let agent = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent not found: {agent_id}"))?;

        agent.status = status;
        agent.updated_at = Utc::now();
        if is_completed {
            agent.progress = 100.0;
        }
        let updated = agent.clone();

        if is_completed {
            for (other_id, other) in agents.iter_mut() {
                if other_id != agent_id
                    && other.dependency.as_deref() == Some(agent_id)
                    && other.status == AgentStatus::Waiting
                {
                    other.status = AgentStatus::Active;
                    other.updated_at = Utc::now();
                    unblocked_agents.push(other.clone());
                }
            }
        }

        Ok((updated, unblocked_agents))
    }

    pub fn update_status(
        &self,
        app_handle: &AppHandle,
        agent_id: &str,
        status: AgentStatus,
    ) -> Result<AgentState, String> {
        let (updated, unblocked) = self.update_status_internal(agent_id, status)?;
        let _ = app_handle.emit("agent-updated", &updated);
        for u in unblocked {
            let _ = app_handle.emit("agent-updated", &u);
        }
        Ok(updated)
    }

    pub fn get_logs(&self, agent_id: &str) -> Vec<AgentLogEntry> {
        let logs = self.logs.lock();
        logs.get(agent_id).cloned().unwrap_or_default()
    }

    pub fn send_chat_message(
        &self,
        app_handle: &AppHandle,
        agent_id: &str,
        message: &str,
    ) -> Result<ChatMessage, String> {
        let reply_id = format!(
            "msg-{}-{}-asst",
            Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().simple().to_string()[..6]
        );
        let (agent_name, agent_role, agent_model) = {
            let agents = self.agents.lock();
            agents
                .get(agent_id)
                .map(|a| (a.name.clone(), a.role.clone(), a.model.clone()))
                .unwrap_or_else(|| ("Assistant".to_string(), "AI Specialist".to_string(), "Default".to_string()))
        };

        let (full_text, tokens) = generate_dynamic_agent_response(&agent_name, &agent_role, &agent_model, message);

        let app_handle_clone = app_handle.clone();
        let agent_id_clone = agent_id.to_string();
        let reply_id_clone = reply_id.clone();
        let tokens_clone = tokens.clone();

        thread::spawn(move || {
            for (idx, tok) in tokens_clone.iter().enumerate() {
                thread::sleep(Duration::from_millis(15));
                let done = idx == tokens_clone.len() - 1;
                let payload = ChatTokenPayload {
                    message_id: reply_id_clone.clone(),
                    agent_id: agent_id_clone.clone(),
                    token: tok.clone(),
                    done,
                };
                let _ = app_handle_clone.emit("chat-token", &payload);
            }
        });

        Ok(ChatMessage {
            id: reply_id,
            agent_id: agent_id.to_string(),
            role: "assistant".to_string(),
            content: full_text.clone(),
            timestamp: Utc::now(),
            sender: Some("assistant".to_string()),
            text: Some(full_text),
            agent_name: Some(agent_name),
        })
    }
}

fn generate_dynamic_agent_response(
    agent_name: &str,
    agent_role: &str,
    model: &str,
    message: &str,
) -> (String, Vec<String>) {
    let lower = message.to_lowercase();
    let mut text = String::new();

    if lower.contains("fail") || lower.contains("error") || lower.contains("diagnos") || lower.contains("bug") {
        text.push_str(&format!("### 🔍 Diagnostic Report by {agent_name} ({agent_role})\n\n"));
        if lower.contains("calculator") || lower.contains("expected 30") || lower.contains("calculatetotal") {
            text.push_str("I analyzed the failure in `src/calculator.js`.\n\n");
            text.push_str("**Root Cause:** The calculation logic in `calculateTotal` multiplies accumulator by item price starting at 0, resulting in 0 instead of sum.\n\n");
            text.push_str("**Recommended Fix:**\n```javascript\nexport function calculateTotal(items) {\n  return items.reduce((acc, item) => acc + item.price, 0);\n}\n```\n\n");
            text.push_str("Apply this correction to `src/calculator.js` and re-run your test suite.");
        } else {
            text.push_str("I analyzed the reported error. The failure indicates an assertion mismatch or unexpected state.\n\n");
            text.push_str("```bash\n# Re-run the test suite to inspect diagnostics\nnpm test\n```\n");
        }
    } else if lower.contains("optimize") || lower.contains("performance") || lower.contains("render") {
        text.push_str(&format!("### ⚡ Performance Optimization Plan ({agent_name})\n\n"));
        text.push_str("Recommended optimizations:\n1. Virtualize terminal block and line rendering.\n2. Wrap high-churn components in React.memo.\n3. Throttle PTY output dispatches.\n\n");
        text.push_str("```javascript\nconst throttled = debounce(fn, 16);\n```\n");
    } else if lower.contains("test") || lower.contains("runner") {
        text.push_str(&format!("### 🧪 Test Execution Guide ({agent_name})\n\n"));
        text.push_str("You can run tests with:\n\n```bash\nnode tests/e2e/runner.js\n```\n");
    } else {
        let summary = if message.len() > 60 {
            format!("{}...", &message[..60])
        } else {
            message.to_string()
        };
        text.push_str(&format!("### 💡 Response from {agent_name} ({agent_role} - {model})\n\n"));
        text.push_str(&format!("I have reviewed your request: \"{summary}\"\n\nReady to assist with development and system inspection.\n"));
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if ch == ' ' || ch == '\n' {
            tokens.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        tokens.push(text.clone());
    }

    (text, tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_baseline_agents_initialization() {
        let runtime = AgentRuntime::new();
        let agents = runtime.list_agents();
        assert!(agents.len() >= 3, "Must initialize with >= 3 baseline agents");

        let architect = agents.iter().find(|a| a.name == "Architect").unwrap();
        assert_eq!(architect.role, "System Architect");
        assert_eq!(architect.model, "Claude Opus 4.6");
        assert_eq!(architect.status, AgentStatus::Active);
        assert_eq!(architect.progress, 78.0);
        assert_eq!(architect.tokens_used, 12431);

        let test_eng = agents.iter().find(|a| a.name == "Test Engineer").unwrap();
        assert_eq!(test_eng.status, AgentStatus::Waiting);
        assert_eq!(test_eng.dependency, Some("agent-architect-01".to_string()));

        let code_rev = agents.iter().find(|a| a.name == "Code Reviewer").unwrap();
        assert_eq!(code_rev.status, AgentStatus::Idle);
    }

    #[test]
    fn test_agent_logs_retrieval() {
        let runtime = AgentRuntime::new();
        let logs = runtime.get_logs("agent-architect-01");
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[0].level, "INFO");
        assert!(logs[0].message.contains("Analyzing project directory tree"));

        let empty_logs = runtime.get_logs("unknown-agent");
        assert!(empty_logs.is_empty());
    }

    #[test]
    fn test_create_agent_lifecycle() {
        let runtime = AgentRuntime::new();

        // Independent agent -> Active
        let created = runtime.create_agent_internal(CreateAgentInput {
            name: "Performance Profiler".to_string(),
            role: "Benchmarking Expert".to_string(),
            model: "GPT-4o".to_string(),
            system_prompt: Some("Profile performance".to_string()),
            dependencies: None,
            dependency: None,
        }).unwrap();

        assert_eq!(created.name, "Performance Profiler");
        assert_eq!(created.status, AgentStatus::Active);
        assert_eq!(runtime.list_agents().len(), 4);

        // Dependent agent -> Waiting
        let dep_agent = runtime.create_agent_internal(CreateAgentInput {
            name: "Deployer".to_string(),
            role: "DevOps".to_string(),
            model: "GPT-4o".to_string(),
            system_prompt: None,
            dependencies: None,
            dependency: Some(created.id.clone()),
        }).unwrap();

        assert_eq!(dep_agent.status, AgentStatus::Waiting);
        assert_eq!(dep_agent.dependency, Some(created.id));
    }

    #[test]
    fn test_dependency_chaining_unblocks_waiting_agent() {
        let runtime = AgentRuntime::new();

        // Initially Test Engineer is waiting on Architect
        let test_eng_before = runtime.list_agents().into_iter().find(|a| a.name == "Test Engineer").unwrap();
        assert_eq!(test_eng_before.status, AgentStatus::Waiting);

        // Complete Architect
        let (updated_arch, unblocked) = runtime.update_status_internal("agent-architect-01", AgentStatus::Completed).unwrap();
        assert_eq!(updated_arch.status, AgentStatus::Completed);
        assert_eq!(updated_arch.progress, 100.0);
        assert_eq!(unblocked.len(), 1);
        assert_eq!(unblocked[0].name, "Test Engineer");
        assert_eq!(unblocked[0].status, AgentStatus::Active);

        // Verify state in pool
        let test_eng_after = runtime.list_agents().into_iter().find(|a| a.name == "Test Engineer").unwrap();
        assert_eq!(test_eng_after.status, AgentStatus::Active);
    }
}
