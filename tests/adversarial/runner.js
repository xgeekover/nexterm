/**
 * Adversarial & Stress Test Runner
 */

import { runnerContext } from '../e2e/harness/testFramework.js';
import { writeSync } from 'node:fs';

// A run that dies says how, synchronously: on Windows the console is written
// to asynchronously, and the message of an uncaught error was lost with it.
process.on('uncaughtException', (err) => {
  writeSync(2, `\nUncaught exception: ${err?.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  writeSync(2, `\nUnhandled rejection: ${err?.stack ?? err}\n`);
  process.exit(1);
});
process.on('exit', (code) => {
  if (process.env.NEXTERM_TEST_TRACE) writeSync(1, `\n(runner exiting with code ${code})\n`);
});
import './stress_agent_chat_palette.test.js';
import './shell_integration.test.js';
import './terminal_groups.test.js';
import './terminal_layout.test.js';
import './tab_reorder.test.js';
import './tab_reorder_ui.test.js';
import './layout_gaps.test.js';
import './windows_paths.test.js';
import './status_bar.test.js';
import './persist_robustness.test.js';
import './editor_layout.test.js';
import './workbench_layout.test.js';
import './workbench_active.test.js';
import './workbench_restore.test.js';
import './workbench_editors.test.js';
import './workbench_editor_area.test.js';
import './workbench_render.test.js';
import './workbench_drag.test.js';
import './workbench_prompts_mounted.test.js';
import './editor_tab_reorder.test.js';
import './editor_tab_reorder_ui.test.js';
import './explorer_actions.test.js';
import './app_menu.test.js';
import './settings.test.js';
// Marks for the messages sent to Claude Code: the recorded runs replayed through xterm headless.
import './agent_message_marks.test.js';
import './opencode_mini_marks.test.js';
import './opencode_mini_launch.test.js';
import './terminal_intellisense.test.js';
import './suggestion_layer.test.js';
import './ipc_contract.test.js';
import './editor_unsaved.test.js';
import './unsaved_guard.test.js';
import './editor_windows_paths.test.js';
import './keybindings_platform.test.js';
import './menu_contract.test.js';
import './init_once.test.js';
import './terminal_compat.test.js';
import './hangul_inline_ime.test.js';
import './modify_other_keys.test.js';
import './unicode_widths.test.js';
import './no_folder.test.js';
import './keybinding_table.test.js';
import './pty_reload_leak.test.js';
import './fit_reports_size.test.js';
import './webgl_lifecycle.test.js';
import './atlas_repair.test.js';
import './webgl_engine_model.test.js';
import './tab_names.test.js';
import './backend_tree_contract.test.js';
import './configurable_keybindings.test.js';
import './chords_input_source.test.js';
import './native_menu.test.js';
import './git_status.test.js';
import './sticky_command.test.js';
import './open_recent.test.js';
import './search_contract.test.js';
import './command_history.test.js';
import './terminal_profiles.test.js';
import './explorer_filter.test.js';
import './terminal_links.test.js';
import './tab_activity.test.js';
import './find_and_zoom.test.js';
import './agents.test.js';
import './held_start_marker.test.js';
import './agent_lifecycle.test.js';
import './suggest_geometry.test.js';
import './mouse_reporting.test.js';
import './mouse_reporting_drag.test.js';
import './mouse_reporting_headless.test.js';
import './clipboard_keys.test.js';
import './sync_output.test.js';
import './wheel_headless.test.js';
import './program_notifications.test.js';
import './focus_report.test.js';
import './pane_zoom.test.js';
import './layout_templates.test.js';
import './pty_output_bus.test.js';
import './shell_restart.test.js';
import './terminal_right_click.test.js';
import './terminal_right_click_headless.test.js';
import './agent_resume_opencode.test.js';
import './agent_resume_banner_mounted.test.js';
import './confirm_dialog.test.js';
import './settings_window.test.js';
import './activity_bar.test.js';
import './workspace_names.test.js';
import './startup_restore.test.js';
import './hyperlinks.test.js';
import './palette_results.test.js';
import './explorer_deep_folders.test.js';
import './palette_mounted.test.js';
import './editor_panel_logic.test.js';
import './editor_read_failures.test.js';
import './drop_paths.test.js';
import './drop_paths_spec.test.js';
import './terminal_file_drop.test.js';
import './output_paths.test.js';
import './output_context.test.js';
import './reveal_links.test.js';
import './reveal_links_headless.test.js';
import './paste_warning.test.js';
import './batch_job_reply.test.js';
import './explorer_trash.test.js';
import './explorer_row_menu.test.js';
// A context menu taller than the window: bounded, scrolling, open while it scrolls.
import './context_menu_mounted.test.js';
// The AGENT SESSIONS inline editor, mounted with its own stores and mock (C-03).
import './agent_sessions_rename_mounted.test.js';
import './editor_session_restore.test.js';
import './terminal_progress.test.js';
import './attention.test.js';
import './terminal_status.test.js';
// Claude Code's working and idle state and its completion entry; its own teardown (AA-99).
import './agent_activity.test.js';
import './branch_store.test.js';
import './theme_import.test.js';
import './theme_gallery.test.js';
import './split_polish.test.js';
import './secret_input.test.js';
import './split_lock_headless.test.js';
import './output_path_headless.test.js';
import './strip_overlay_mounted.test.js';
import './perf_mode.test.js';
import './flow_control.test.js';
import './output_pacing.test.js';
import './project_commands_backend_mock.test.js';
import './project_commands.test.js';
import './project_commands_store.test.js';
import './project_commands_palette.test.js';
import './project_commands_run.test.js';
import './project_commands_dialog_mounted.test.js';
import './scrollback_backend_mock.test.js';
import './scrollback_snapshot.test.js';
import './scrollback_saver.test.js';
import './scrollback_restore.test.js';
import './scrollback_exit.test.js';
import './scrollback_store.test.js';
import './control_backend_mock.test.js';
import './control_keys.test.js';
import './control_scope.test.js';
import './control_dispatcher.test.js';
import './claude_startup_headless.test.js';
// Last: it puts the mock's agent session history and the page storage back (AH-99).
import './agent_history_contract.test.js';
// After it, each with its own teardown (AHR-99, AHS-99): the recorder, and resuming from the history.
import './agent_history_recording.test.js';
import './agent_history_resume.test.js';
// The palette's pick and the question before Clear; its own teardown (AHP-99).
import './agent_history_palette.test.js';
// Claude Code's own titles and the never-saved rule; its own teardown (AHC-99).
import './agent_history_claude_titles.test.js';
// What the user curates: pin, rename, groups, archive, delete; its own teardown (AHG-99).
import './agent_history_curation.test.js';
// Live Claude Code titles from the terminal's title; its own teardown (AHT-99).
import './agent_history_live_titles.test.js';
import './agent_sessions_menus.test.js';
// Prompt marks on the terminal's scrollbar: the tracker against xterm headless, then the real ruler in a browser.
import './prompt_marks.test.js';
import './prompt_marks_headless.test.js';
// One Monaco model per open file: the rules against the store, then the real editor in a browser.
import './editor_models.test.js';
import './editor_models_headless.test.js';
// One drag for both kinds across the workbench, and the pixel minimums, in a real browser (sibling C, AC-C4).
import './workbench_drag_headless.test.js';
import './workbench_commands.test.js';
import './workbench_focus_headless.test.js';
import './workbench_features.test.js';
import './monaco_chunk.test.js';
// Fork Conversation (bundle 1, A1): a new terminal, one fork line, the history linked; FK-99 tears down.
import './agent_fork.test.js';
// Copy Context (bundle 1, A3): the last N lines, plain, secrets masked, copied in the gesture; CC-99 tears down.
import './copy_context.test.js';
// Keep-awake (bundle 1, A4): the backend told only when a Claude Code terminal starts or stops Working; KA-99 tears down.
import './keep_awake.test.js';
// Next/Previous Tab and Go to Tab 1-8/Last (bundle 2, A5-1/A5-2) over a focused terminal; TN-99 tears down.
import './tab_navigation.test.js';
// Reopen Closed Terminal (bundle 2, A5-4): closed terminals back as fresh shells, memory only; RC-99 tears down.
import './reopen_closed_terminal.test.js';
// The Ctrl+Tab switcher (bundle 2, A5-3): the terminals most recently used, every group's, memory only; MRU-99 tears down.
import './tab_mru.test.js';
// macOS text-editing keys (bundle 2, A6): ⌘←/→/Backspace/Delete as Ctrl+A/E/U/K, normal screen only; ME-99 tears down.
import './mac_editing_keys.test.js';
// Option as Meta (bundle 2, A7): macOptionIsMeta on macOS only, new and live terminals; OM-99 tears down.
import './option_as_meta.test.js';
// OSC 52 (bundle 2, A8): programs setting the clipboard, writes only and off by default, one notice per terminal; O52-99 tears down.
import './osc52.test.js';
// Explorer Reveal and Open Terminal Here (bundle 2, A12-1/A12-2): fs_reveal_path and a strict createTab; EXO-99 tears down.
import './explorer_open_actions.test.js';
// A split divider let go after a press (bundle 3, U2-F2/F3): a window pointerdown and a document pointerup/pointercancel blur only the separator the press focused; DV-99 tears down.
import './separator_focus.test.js';
// The fade at the edge of an overflowing tab strip (bundle 3, U3-F1/F2): edgeFadeSides, the watcher, the hook's per-render step, the masks.
import './edge_fade.test.js';
// How long a TERMINALS agent row's state has held (bundle 3, U5-F1/F2): elapsedLabel, elapsedSince, the minute clock and useMinuteNow.
import './elapsed_time.test.js';
// Toasts (bundle 3, U6-F1/F2): the store on fake timers (TOAST_MS, three at most, a repeat replaces) and ToastHost mounted; TO-99 tears down.
import './toast_store.test.js';
// Copy feedback (bundle 3, U6-F3): Copy Path, Copy Context and Copy Session ID say what they did in a toast; CF-99 tears down.
import './copy_feedback.test.js';

async function run() {
  console.log('====================================================');
  console.log('  NexTerm — Multi-Agent & Chat Adversarial Suite    ');
  console.log('====================================================');

  const { stats, results } = await runnerContext.run();

  for (const suite of results) {
    console.log(`\n▶ ${suite.name}`);
    for (const t of suite.tests) {
      if (t.status === 'passed') {
        console.log(`  ✔ ${t.name} (${t.durationMs}ms)`);
      } else if (t.status === 'skipped') {
        // Loud on purpose: a skipped case checked nothing, and reading it as a
        // tick is how a suite comes to report green while testing nothing.
        console.log(`  ○ ${t.name} — SKIPPED${t.reason ? `: ${t.reason}` : ''}`);
      } else {
        console.log(`  ✖ ${t.name} (${t.durationMs}ms)`);
        if (t.error) {
          console.log(`    Error: ${t.error.stack || t.error.message}`);
        }
      }
    }
  }

  console.log('\n----------------------------------------------------');
  console.log('Adversarial Test Execution Summary:');
  console.log(`  Suites:   ${stats.totalSuites} executed`);
  console.log(`  Tests:    ${stats.totalTests} total`);
  console.log(`  Passed:   ${stats.passed}`);
  if (stats.skipped > 0) console.log(`  Skipped:  ${stats.skipped}   <- checked nothing`);
  console.log(`  Failed:   ${stats.failed}`);
  console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log('----------------------------------------------------');

  if (stats.failed > 0) {
    console.log('\n❌ ADVERSARIAL STRESS TEST DETECTED DEFECTS!\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL ADVERSARIAL STRESS TESTS PASSED!\n');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Runner failure:', err);
  process.exit(1);
});
