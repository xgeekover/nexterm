// unix-only: Windows shells do not read LANG or LC_*.
#[cfg(unix)]
mod locale;
// unix-only: a ConPTY host cannot read its client's console input mode (see
// the module's own documentation).
#[cfg(unix)]
mod echo_watch;
// Who runs what is in a terminal's foreground: its process group on unix,
// the shell and what it started on Windows.
mod owner;
pub mod manager;
pub mod flow_gate;
pub mod osc;
pub mod output_batch;
pub mod shell_integration;
pub mod shells;
pub mod startup_query;
pub use manager::PtyManager;
