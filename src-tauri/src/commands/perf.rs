//! Performance mode's commands (src/perf.rs): how the run is set up, the
//! backend's counts, and writing the report. Each refuses when the app was
//! not started to be measured.

use std::io::Write;

use crate::perf::{self, PerfCounters, PerfInfo};

const OFF: &str = "performance mode is off (start the app with NEXTERM_PERF=1)";

#[tauri::command]
pub fn perf_info() -> PerfInfo {
    perf::info()
}

#[tauri::command]
pub fn perf_counters() -> Result<PerfCounters, String> {
    if !perf::enabled() {
        return Err(OFF.to_string());
    }
    Ok(perf::counters())
}

/// Write `text` as `name` in the run's folder; the path it went to. Only a
/// plain file name: the folder is the one the run was started with.
#[tauri::command]
pub fn perf_write(name: String, text: String) -> Result<String, String> {
    if !perf::enabled() {
        return Err(OFF.to_string());
    }
    if !perf::report_name_ok(&name) {
        return Err("not a plain file name".to_string());
    }
    let dir = perf::out_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let path = dir.join(&name);
    let mut file = std::fs::File::create(&path).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}
