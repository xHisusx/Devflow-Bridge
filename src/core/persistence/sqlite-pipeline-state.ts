import { Database } from "bun:sqlite";
import type { IPipelineStateStore, TaskLink } from "./pipeline-state.port";

/** SQLite-backed pipeline state (own file, so it never contends with the message store). */
export class PipelineStateStore implements IPipelineStateStore {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.PIPELINE_DB_PATH ?? "data/pipeline.sqlite";

    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      try {
        require("fs").mkdirSync(dir, { recursive: true });
      } catch {}
    }

    this.db = new Database(path, { create: true });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS once_keys (
        key TEXT PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_links (
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        mr_iid INTEGER,
        tracker TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_url TEXT NOT NULL DEFAULT '',
        task_identifier TEXT NOT NULL DEFAULT '',
        task_name TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (repo, branch)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS task_links_mr ON task_links (repo, mr_iid)");
  }

  markOnce(key: string): boolean {
    // INSERT OR IGNORE + changes(): one statement, so concurrent webhooks cannot both win.
    this.db.query("INSERT OR IGNORE INTO once_keys (key) VALUES (?)").run(key);
    const row = this.db.query("SELECT changes() AS changed").get() as { changed: number };
    return row.changed > 0;
  }

  forget(key: string): void {
    this.db.query("DELETE FROM once_keys WHERE key = ?").run(key);
  }

  rememberTaskLink(link: TaskLink): void {
    this.db
      .query(
        `INSERT INTO task_links (repo, branch, mr_iid, tracker, task_id, task_url, task_identifier, task_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, branch) DO UPDATE SET
           mr_iid = COALESCE(excluded.mr_iid, task_links.mr_iid),
           tracker = excluded.tracker,
           task_id = excluded.task_id,
           task_url = excluded.task_url,
           task_identifier = excluded.task_identifier,
           task_name = excluded.task_name`,
      )
      .run(
        link.repo,
        link.branch,
        link.mrIid,
        link.tracker,
        link.taskId,
        link.taskUrl,
        link.taskIdentifier,
        link.taskName,
      );
  }

  findTaskByMr(repo: string, mrIid: number): TaskLink | null {
    const row = this.db
      .query("SELECT * FROM task_links WHERE repo = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1")
      .get(repo, mrIid) as Row | null;
    return row ? toLink(row) : null;
  }

  findTaskByBranch(repo: string, branch: string): TaskLink | null {
    const row = this.db
      .query("SELECT * FROM task_links WHERE repo = ? AND branch = ?")
      .get(repo, branch) as Row | null;
    return row ? toLink(row) : null;
  }
}

interface Row {
  repo: string;
  branch: string;
  mr_iid: number | null;
  tracker: string;
  task_id: string;
  task_url: string;
  task_identifier: string;
  task_name: string;
}

function toLink(row: Row): TaskLink {
  return {
    repo: row.repo,
    branch: row.branch,
    mrIid: row.mr_iid,
    tracker: row.tracker,
    taskId: row.task_id,
    taskUrl: row.task_url,
    taskIdentifier: row.task_identifier,
    taskName: row.task_name,
  };
}
