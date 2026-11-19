//! SQLite persistence: the local source of truth for workspace, session and
//! layout metadata. Terminal output is never written here.
use crate::models::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

type DbResult<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    format!("database error: {err}")
}

/// Ordered, append-only migrations. Index + 1 == schema version.
const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '',
        accent TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
    );
    CREATE TABLE session (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        profile_id TEXT,
        program TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        cwd TEXT NOT NULL,
        accent TEXT,
        host TEXT NOT NULL DEFAULT 'local',
        state TEXT NOT NULL,
        exit_code INTEGER,
        restored INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
    );
    CREATE INDEX session_workspace ON session(workspace_id, state);
    CREATE INDEX session_closed ON session(closed_at);
    CREATE TABLE layout (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE preference (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        workspace_id TEXT,
        session_id TEXT
    );
    "#];

const SESSION_COLS: &str = "id, workspace_id, name, kind, profile_id, program, args, cwd, accent, host, state, exit_code, restored, created_at, closed_at";

fn row_to_session(r: &Row) -> rusqlite::Result<Session> {
    let args: String = r.get(6)?;
    Ok(Session {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        profile_id: r.get(4)?,
        program: r.get(5)?,
        args: serde_json::from_str(&args).unwrap_or_default(),
        cwd: r.get(7)?,
        accent: r.get(8)?,
        host: r.get(9)?,
        state: r.get(10)?,
        exit_code: r.get(11)?,
        restored: r.get::<_, i64>(12)? != 0,
        created_at: r.get(13)?,
        closed_at: r.get(14)?,
    })
}

fn row_to_workspace(r: &Row) -> rusqlite::Result<Workspace> {
    let tags: String = r.get(7)?;
    let root_path: String = r.get(2)?;
    let path_exists = Path::new(&root_path).is_dir();
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        root_path,
        icon: r.get(3)?,
        accent: r.get(4)?,
        description: r.get(5)?,
        pinned: r.get::<_, i64>(6)? != 0,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        created_at: r.get(8)?,
        last_opened_at: r.get(9)?,
        path_exists,
    })
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        let conn = Connection::open(path).map_err(e)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> DbResult<Self> {
        Self::init(Connection::open_in_memory().map_err(e)?)
    }

    fn init(mut conn: Connection) -> DbResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(e)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(e)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(e)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(e)?;
        if version as usize > MIGRATIONS.len() {
            return Err(format!(
                "database schema version {version} is newer than this build of NEXUS supports"
            ));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction().map_err(e)?;
            tx.execute_batch(sql).map_err(e)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)
                .map_err(e)?;
            tx.commit().map_err(e)?;
        }
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Called once at startup. No local process survives an app exit, so any
    /// session still marked `running` is downgraded to `recoverable`.
    pub fn mark_orphans_recoverable(&self) -> DbResult<usize> {
        self.lock()
            .execute(
                "UPDATE session SET state = 'recoverable', restored = 0 WHERE state = 'running'",
                [],
            )
            .map_err(e)
    }

    // ---- workspaces -------------------------------------------------------

    pub fn workspace_list(&self) -> DbResult<Vec<Workspace>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, root_path, icon, accent, description, pinned, tags, created_at, last_opened_at
                 FROM workspace ORDER BY pinned DESC, last_opened_at DESC",
            )
            .map_err(e)?;
        let rows = stmt.query_map([], row_to_workspace).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn workspace_get(&self, id: &str) -> DbResult<Workspace> {
        self.lock()
            .query_row(
                "SELECT id, name, root_path, icon, accent, description, pinned, tags, created_at, last_opened_at
                 FROM workspace WHERE id = ?1",
                [id],
                row_to_workspace,
            )
            .optional()
            .map_err(e)?
            .ok_or_else(|| "workspace not found".to_string())
    }

    pub fn workspace_insert(&self, w: &Workspace) -> DbResult<()> {
        self.lock()
            .execute(
                "INSERT INTO workspace (id, name, root_path, icon, accent, description, pinned, tags, created_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    w.id,
                    w.name,
                    w.root_path,
                    w.icon,
                    w.accent,
                    w.description,
                    w.pinned as i64,
                    serde_json::to_string(&w.tags).map_err(e)?,
                    w.created_at,
                    w.last_opened_at
                ],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn workspace_update(&self, w: &Workspace) -> DbResult<()> {
        self.lock()
            .execute(
                "UPDATE workspace SET name = ?2, root_path = ?3, icon = ?4, accent = ?5, description = ?6,
                 pinned = ?7, tags = ?8, last_opened_at = ?9 WHERE id = ?1",
                params![
                    w.id,
                    w.name,
                    w.root_path,
                    w.icon,
                    w.accent,
                    w.description,
                    w.pinned as i64,
                    serde_json::to_string(&w.tags).map_err(e)?,
                    w.last_opened_at
                ],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn workspace_delete(&self, id: &str) -> DbResult<()> {
        self.lock()
            .execute("DELETE FROM workspace WHERE id = ?1", [id])
            .map_err(e)?;
        Ok(())
    }

    // ---- sessions ---------------------------------------------------------

    pub fn session_insert(&self, s: &Session) -> DbResult<()> {
        self.lock()
            .execute(
                &format!("INSERT INTO session ({SESSION_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
                params![
                    s.id,
                    s.workspace_id,
                    s.name,
                    s.kind,
                    s.profile_id,
                    s.program,
                    serde_json::to_string(&s.args).map_err(e)?,
                    s.cwd,
                    s.accent,
                    s.host,
                    s.state,
                    s.exit_code,
                    s.restored as i64,
                    s.created_at,
                    s.closed_at
                ],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn session_get(&self, id: &str) -> DbResult<Session> {
        self.lock()
            .query_row(
                &format!("SELECT {SESSION_COLS} FROM session WHERE id = ?1"),
                [id],
                row_to_session,
            )
            .optional()
            .map_err(e)?
            .ok_or_else(|| "session not found".to_string())
    }

    /// All sessions that are not closed (running, exited, recoverable).
    pub fn session_list_open(&self) -> DbResult<Vec<Session>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLS} FROM session WHERE state != 'closed' ORDER BY created_at"
            ))
            .map_err(e)?;
        let rows = stmt.query_map([], row_to_session).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn session_list_closed(&self, search: &str, limit: i64) -> DbResult<Vec<Session>> {
        let conn = self.lock();
        let pattern = format!("%{}%", search.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLS} FROM session
                 WHERE state = 'closed' AND (name LIKE ?1 ESCAPE '\\' OR program LIKE ?1 ESCAPE '\\' OR cwd LIKE ?1 ESCAPE '\\')
                 ORDER BY closed_at DESC LIMIT ?2"
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params![pattern, limit], row_to_session)
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn session_set_running(&self, id: &str, restored: bool) -> DbResult<()> {
        self.lock()
            .execute(
                "UPDATE session SET state = 'running', exit_code = NULL, restored = ?2, closed_at = NULL WHERE id = ?1",
                params![id, restored as i64],
            )
            .map_err(e)?;
        Ok(())
    }

    /// Only transitions a `running` session, so a late exit notification can
    /// never overwrite `closed`.
    pub fn session_set_exited(&self, id: &str, exit_code: Option<i64>) -> DbResult<bool> {
        let n = self
            .lock()
            .execute(
                "UPDATE session SET state = 'exited', exit_code = ?2 WHERE id = ?1 AND state = 'running'",
                params![id, exit_code],
            )
            .map_err(e)?;
        Ok(n > 0)
    }

    pub fn session_set_closed(&self, id: &str, at: i64) -> DbResult<()> {
        self.lock()
            .execute(
                "UPDATE session SET state = 'closed', closed_at = ?2 WHERE id = ?1",
                params![id, at],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn session_update_meta(
        &self,
        id: &str,
        name: Option<&str>,
        accent: Option<Option<&str>>,
    ) -> DbResult<()> {
        let conn = self.lock();
        if let Some(name) = name {
            conn.execute("UPDATE session SET name = ?2 WHERE id = ?1", params![id, name])
                .map_err(e)?;
        }
        if let Some(accent) = accent {
            conn.execute(
                "UPDATE session SET accent = ?2 WHERE id = ?1",
                params![id, accent],
            )
            .map_err(e)?;
        }
        Ok(())
    }

    pub fn session_delete(&self, id: &str) -> DbResult<()> {
        self.lock()
            .execute("DELETE FROM session WHERE id = ?1", [id])
            .map_err(e)?;
        Ok(())
    }

    /// Retention: keep only the most recent `keep` closed sessions.
    pub fn prune_closed_sessions(&self, keep: i64) -> DbResult<()> {
        self.lock()
            .execute(
                "DELETE FROM session WHERE state = 'closed' AND id NOT IN
                 (SELECT id FROM session WHERE state = 'closed' ORDER BY closed_at DESC LIMIT ?1)",
                [keep],
            )
            .map_err(e)?;
        Ok(())
    }

    // ---- layouts ----------------------------------------------------------

    pub fn layout_get(&self, workspace_id: &str) -> DbResult<Option<String>> {
        self.lock()
            .query_row(
                "SELECT data FROM layout WHERE workspace_id = ?1",
                [workspace_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)
    }

    pub fn layout_save(&self, workspace_id: &str, data: &str, at: i64) -> DbResult<()> {
        self.lock()
            .execute(
                "INSERT INTO layout (workspace_id, data, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                params![workspace_id, data, at],
            )
            .map_err(e)?;
        Ok(())
    }

    // ---- preferences ------------------------------------------------------

    pub fn prefs_all(&self) -> DbResult<std::collections::HashMap<String, String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM preference").map_err(e)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn pref_set(&self, key: &str, value: &str) -> DbResult<()> {
        self.lock()
            .execute(
                "INSERT INTO preference (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(e)?;
        Ok(())
    }

    // ---- activity ---------------------------------------------------------

    pub fn activity_add(
        &self,
        kind: &str,
        message: &str,
        workspace_id: Option<&str>,
        session_id: Option<&str>,
    ) -> DbResult<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO activity (ts, kind, message, workspace_id, session_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now_ms(), kind, message, workspace_id, session_id],
        )
        .map_err(e)?;
        conn.execute(
            "DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - 500",
            [],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn activity_list(&self, limit: i64) -> DbResult<Vec<ActivityEvent>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT id, ts, kind, message, workspace_id, session_id FROM activity ORDER BY id DESC LIMIT ?1")
            .map_err(e)?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(ActivityEvent {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    kind: r.get(2)?,
                    message: r.get(3)?,
                    workspace_id: r.get(4)?,
                    session_id: r.get(5)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str) -> Workspace {
        Workspace {
            id: id.into(),
            name: "Demo".into(),
            root_path: "/".into(),
            icon: "".into(),
            accent: "#8b9cff".into(),
            description: "".into(),
            pinned: false,
            tags: vec!["client".into()],
            created_at: 1,
            last_opened_at: 1,
            path_exists: true,
        }
    }

    fn sess(id: &str, state: &str) -> Session {
        Session {
            id: id.into(),
            workspace_id: "w1".into(),
            name: "zsh".into(),
            kind: "shell".into(),
            profile_id: Some("zsh".into()),
            program: "/bin/zsh".into(),
            args: vec!["-l".into()],
            cwd: "/".into(),
            accent: None,
            host: "local".into(),
            state: state.into(),
            exit_code: None,
            restored: false,
            created_at: 1,
            closed_at: None,
        }
    }

    #[test]
    fn workspace_roundtrip_and_cascade() {
        let db = Db::open_in_memory().unwrap();
        db.workspace_insert(&ws("w1")).unwrap();
        db.session_insert(&sess("s1", "running")).unwrap();
        db.layout_save("w1", "{}", 1).unwrap();
        let list = db.workspace_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].tags, vec!["client".to_string()]);
        db.workspace_delete("w1").unwrap();
        assert!(db.session_list_open().unwrap().is_empty());
        assert!(db.layout_get("w1").unwrap().is_none());
    }

    #[test]
    fn running_sessions_become_recoverable_on_startup() {
        let db = Db::open_in_memory().unwrap();
        db.workspace_insert(&ws("w1")).unwrap();
        db.session_insert(&sess("s1", "running")).unwrap();
        db.session_insert(&sess("s2", "exited")).unwrap();
        assert_eq!(db.mark_orphans_recoverable().unwrap(), 1);
        assert_eq!(db.session_get("s1").unwrap().state, "recoverable");
        assert_eq!(db.session_get("s2").unwrap().state, "exited");
    }

    #[test]
    fn late_exit_does_not_overwrite_closed() {
        let db = Db::open_in_memory().unwrap();
        db.workspace_insert(&ws("w1")).unwrap();
        db.session_insert(&sess("s1", "running")).unwrap();
        db.session_set_closed("s1", 5).unwrap();
        assert!(!db.session_set_exited("s1", Some(0)).unwrap());
        assert_eq!(db.session_get("s1").unwrap().state, "closed");
        let closed = db.session_list_closed("zsh", 10).unwrap();
        assert_eq!(closed.len(), 1);
        assert!(db.session_list_closed("nomatch", 10).unwrap().is_empty());
    }

    #[test]
    fn prefs_and_layout_upsert() {
        let db = Db::open_in_memory().unwrap();
        db.workspace_insert(&ws("w1")).unwrap();
        db.pref_set("theme", "dark").unwrap();
        db.pref_set("theme", "light").unwrap();
        assert_eq!(db.prefs_all().unwrap()["theme"], "light");
        db.layout_save("w1", "a", 1).unwrap();
        db.layout_save("w1", "b", 2).unwrap();
        assert_eq!(db.layout_get("w1").unwrap().unwrap(), "b");
    }
}
