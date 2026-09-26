// unix-only: Windows shells do not read LANG or LC_*.
#[cfg(unix)]
mod locale;
pub mod manager;
pub mod osc;
pub mod shell_integration;
pub mod shells;
pub mod startup_query;
pub use manager::PtyManager;
