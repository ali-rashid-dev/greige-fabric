import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export function writeAuditLog(
  database: Database.Database,
  actor: string,
  action: string,
  sourceType: string,
  sourceId: string,
  reason: string,
  createdAt: string,
): void {
  database.prepare(`
    INSERT INTO audit_log (id, actor, action, source_type, source_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), actor, action, sourceType, sourceId, reason, createdAt);
}
