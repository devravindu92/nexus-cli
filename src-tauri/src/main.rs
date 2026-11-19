// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `nexus agent-hook <adapter>`: tiny helper an agent CLI runs to report a
    // hook event. It must not start the app.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("agent-hook") {
        nexus_lib::run_agent_hook(&args.next().unwrap_or_default());
        return;
    }
    nexus_lib::run()
}
