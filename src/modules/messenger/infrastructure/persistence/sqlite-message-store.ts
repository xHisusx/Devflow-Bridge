import { Database } from "bun:sqlite";
import type { IMessageStore } from "../../application/ports/message-store.port";

export class MessageStore implements IMessageStore {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.MESSAGE_DB_PATH ?? "data/messages.sqlite";

    // Ensure parent directory exists
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      try {
        require("fs").mkdirSync(dir, { recursive: true });
      } catch {}
    }

    this.db = new Database(path, { create: true });
    // NOTE: the `correlation_id` column is the generic key under which a message is correlated
    // (a Plane issue id today, but any upstream entity id in general). The legacy table name
    // `plane_issue_id` is migrated transparently below for existing databases.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sent_messages (
        correlation_id TEXT NOT NULL,
        target TEXT NOT NULL,
        pachka_message_id INTEGER NOT NULL,
        pachka_chat_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (correlation_id, target)
      )
    `);
    // Backward-compat: rename the old column name if an earlier-version DB is present.
    const cols = this.db.query("PRAGMA table_info(sent_messages)").all() as { name: string }[];
    if (cols.some((c) => c.name === "plane_issue_id")) {
      this.db.run("ALTER TABLE sent_messages RENAME COLUMN plane_issue_id TO correlation_id");
    }
  }

  get(correlationId: string, target: string): number | null {
    const row = this.db
      .query("SELECT pachka_message_id FROM sent_messages WHERE correlation_id = ? AND target = ?")
      .get(correlationId, target) as { pachka_message_id: number } | null;
    return row?.pachka_message_id ?? null;
  }

  set(correlationId: string, target: string, messageId: number, chatId: number): void {
    this.db
      .query(
        `INSERT INTO sent_messages (correlation_id, target, pachka_message_id, pachka_chat_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (correlation_id, target)
         DO UPDATE SET pachka_message_id = excluded.pachka_message_id,
                       pachka_chat_id = excluded.pachka_chat_id`
      )
      .run(correlationId, target, messageId, chatId);
  }

  delete(correlationId: string, target: string): void {
    this.db
      .query("DELETE FROM sent_messages WHERE correlation_id = ? AND target = ?")
      .run(correlationId, target);
  }

  getByPachkaMessageId(messageId: number): { correlationId: string; target: string } | null {
    const row = this.db
      .query("SELECT correlation_id, target FROM sent_messages WHERE pachka_message_id = ?")
      .get(messageId) as { correlation_id: string; target: string } | null;
    if (!row) return null;
    return { correlationId: row.correlation_id, target: row.target };
  }
}
