//! Local terminal runtime: owns PTYs and child processes.
//!
//! This is the "local ephemeral PTY provider". Processes live exactly as long
//! as this application process; nothing here claims persistence.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Bytes of recent output kept per session so a (re)attaching view can be
/// repainted. In memory only - never persisted.
const REPLAY_BYTES: usize = 512 * 1024;

/// Receives output chunks. Return `false` to unsubscribe.
pub type Sink = Box<dyn Fn(&[u8]) -> bool + Send>;

pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

struct Output {
    ring: VecDeque<u8>,
    sinks: Vec<Sink>,
}

struct Runtime {
    run_id: u64,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<Mutex<Output>>,
}

#[derive(Default)]
struct Inner {
    map: Mutex<HashMap<String, Arc<Runtime>>>,
    next_run: AtomicU64,
}

#[derive(Clone, Default)]
pub struct SessionManager {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(2),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a process attached to a new PTY. `on_exit` fires once, with the
    /// exit code, only if the process ends on its own (not via [`kill`]).
    pub fn spawn(
        &self,
        id: &str,
        spec: SpawnSpec,
        on_exit: Box<dyn FnOnce(Option<i64>) + Send>,
    ) -> Result<(), String> {
        if self.is_live(id) {
            return Err("session already has a running process".into());
        }
        let pair = native_pty_system()
            .openpty(size(spec.cols, spec.rows))
            .map_err(|e| format!("could not open a terminal (PTY): {e}"))?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start `{}`: {e}", spec.program))?;
        // Close our copy of the slave so the reader sees EOF when the child exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("terminal reader error: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("terminal writer error: {e}"))?;
        let killer = child.clone_killer();

        let output = Arc::new(Mutex::new(Output {
            ring: VecDeque::with_capacity(8192),
            sinks: Vec::new(),
        }));
        let run_id = self.inner.next_run.fetch_add(1, Ordering::Relaxed) + 1;
        let runtime = Arc::new(Runtime {
            run_id,
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            output: output.clone(),
        });
        lock(&self.inner.map).insert(id.to_string(), runtime);

        // Reader: PTY -> replay ring + subscribers.
        std::thread::Builder::new()
            .name(format!("pty-read-{run_id}"))
            .spawn(move || {
                let mut buf = vec![0u8; 32 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            let mut out = lock(&output);
                            out.ring.extend(chunk);
                            let excess = out.ring.len().saturating_sub(REPLAY_BYTES);
                            if excess > 0 {
                                out.ring.drain(..excess);
                            }
                            out.sinks.retain(|sink| sink(chunk));
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        // Waiter: reports natural exit and releases the PTY.
        let inner = self.inner.clone();
        let id = id.to_string();
        std::thread::Builder::new()
            .name(format!("pty-wait-{run_id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i64);
                let was_current = {
                    let mut map = lock(&inner.map);
                    match map.get(&id) {
                        Some(rt) if rt.run_id == run_id => {
                            map.remove(&id);
                            true
                        }
                        _ => false,
                    }
                };
                if was_current {
                    on_exit(code);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    fn get(&self, id: &str) -> Option<Arc<Runtime>> {
        lock(&self.inner.map).get(id).cloned()
    }

    pub fn is_live(&self, id: &str) -> bool {
        lock(&self.inner.map).contains_key(id)
    }

    pub fn live_ids(&self) -> Vec<String> {
        lock(&self.inner.map).keys().cloned().collect()
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let rt = self.get(id).ok_or("session is not running")?;
        let mut w = lock(&rt.writer);
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let Some(rt) = self.get(id) else {
            return Ok(());
        };
        let result = lock(&rt.master)
            .resize(size(cols, rows))
            .map_err(|e| e.to_string());
        result
    }

    /// Attach a subscriber. It first receives the replay buffer, then live
    /// output, with no gap or duplication. Returns false if not running.
    pub fn subscribe(&self, id: &str, sink: Sink) -> bool {
        let Some(rt) = self.get(id) else {
            return false;
        };
        let mut out = lock(&rt.output);
        if !out.ring.is_empty() {
            let (a, b) = out.ring.as_slices();
            let mut replay = Vec::with_capacity(a.len() + b.len());
            replay.extend_from_slice(a);
            replay.extend_from_slice(b);
            if !sink(&replay) {
                return true;
            }
        }
        out.sinks.push(sink);
        true
    }

    /// Terminate the process. Does not invoke `on_exit`.
    pub fn kill(&self, id: &str) {
        let rt = lock(&self.inner.map).remove(id);
        if let Some(rt) = rt {
            let _ = lock(&rt.killer).kill();
        }
    }

    pub fn kill_all(&self) {
        for id in self.live_ids() {
            self.kill(&id);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn spec(script: &str) -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: "/".into(),
            env: vec![("TERM".into(), "xterm-256color".into())],
            cols: 80,
            rows: 24,
        }
    }

    fn collect_until(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
        let mut acc = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !acc.contains(needle) && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                acc.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        acc
    }

    #[test]
    fn interactive_io_and_natural_exit() {
        let mgr = SessionManager::new();
        let (exit_tx, exit_rx) = mpsc::channel();
        mgr.spawn(
            "s1",
            spec("read line; echo \"got:$line\"; exit 7"),
            Box::new(move |code| {
                let _ = exit_tx.send(code);
            }),
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        assert!(mgr.subscribe("s1", Box::new(move |b| tx.send(b.to_vec()).is_ok())));
        mgr.write("s1", b"hello\n").unwrap();
        let out = collect_until(&rx, "got:hello");
        assert!(out.contains("got:hello"), "output was: {out:?}");
        assert_eq!(exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(), Some(7));
        assert!(!mgr.is_live("s1"));
    }

    #[test]
    fn late_subscriber_gets_replay() {
        let mgr = SessionManager::new();
        mgr.spawn("s1", spec("echo early-output; sleep 30"), Box::new(|_| {}))
            .unwrap();
        // Wait for the output to land in the ring before subscribing.
        let (tx0, rx0) = mpsc::channel();
        mgr.subscribe("s1", Box::new(move |b| tx0.send(b.to_vec()).is_ok()));
        collect_until(&rx0, "early-output");
        let (tx, rx) = mpsc::channel();
        mgr.subscribe("s1", Box::new(move |b| tx.send(b.to_vec()).is_ok()));
        let out = collect_until(&rx, "early-output");
        assert!(out.contains("early-output"));
        mgr.kill("s1");
        assert!(!mgr.is_live("s1"));
    }

    #[test]
    fn kill_does_not_report_exit_and_resize_works() {
        let mgr = SessionManager::new();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i64>>();
        mgr.spawn(
            "s1",
            spec("sleep 30"),
            Box::new(move |c| {
                let _ = exit_tx.send(c);
            }),
        )
        .unwrap();
        mgr.resize("s1", 120, 40).unwrap();
        mgr.kill("s1");
        assert!(exit_rx.recv_timeout(Duration::from_millis(800)).is_err());
        assert!(mgr.write("s1", b"x").is_err());
    }

    #[test]
    fn missing_program_is_an_error() {
        let mgr = SessionManager::new();
        let mut s = spec("true");
        s.program = "/definitely/not/a/program".into();
        // Depending on platform the failure surfaces at spawn or as an
        // immediate exit; either way the session must not stay live.
        let _ = mgr.spawn("s1", s, Box::new(|_| {}));
        std::thread::sleep(Duration::from_millis(500));
        assert!(!mgr.is_live("s1"));
    }
}
