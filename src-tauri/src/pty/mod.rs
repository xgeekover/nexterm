// unix-only: Windows shells do not read LANG or LC_*.
#[cfg(unix)]
mod locale;
// unix-only: a ConPTY host cannot read its client's console input mode (see
// the module's own documentation).
#[cfg(unix)]
mod echo_watch;
pub mod manager;
pub mod osc;
pub mod shell_integration;
pub mod shells;
pub mod startup_query;
pub use manager::PtyManager;
