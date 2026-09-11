use tauri::{AppHandle, State};

use crate::models::{AgentLogEntry, AgentState, AgentStatus, ChatMessage, CreateAgentInput};
use crate::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn agent_list(state: State<AppState>) -> Result<Vec<AgentState>, String> {
    Ok(state.agent_runtime.list_agents())
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_create(
    app: AppHandle,
    state: State<AppState>,
    input: CreateAgentInput,
) -> Result<AgentState, String> {
    state.agent_runtime.create_agent(&app, input)
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_update_status(
    app: AppHandle,
    state: State<AppState>,
    agent_id: String,
    status: AgentStatus,
) -> Result<AgentState, String> {
    state.agent_runtime.update_status(&app, &agent_id, status)
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_get_logs(state: State<AppState>, agent_id: String) -> Result<Vec<AgentLogEntry>, String> {
    Ok(state.agent_runtime.get_logs(&agent_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn chat_send_message(
    app: AppHandle,
    state: State<AppState>,
    agent_id: String,
    message: String,
) -> Result<ChatMessage, String> {
    state.agent_runtime.send_chat_message(&app, &agent_id, &message)
}
