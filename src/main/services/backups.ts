import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { BackupFrequency, BackupSettings, BackupVerification } from "../../shared/types";
import { FabricServiceError } from "./errors";

const settingsSchema = z.object({
  destinationDirectory: z.string(),
  frequency: z.enum(["disabled", "daily", "weekly"]),
  lastBackupAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable().optional(),
  lastError: z.string().nullable(),
}).strict();

const pendingRestoreSchema = z.object({
  stagedPath: z.string(),
  stagedSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const minute = 60_000;

function inspectBackup(backupPath: string): BackupVerification {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      throw new FabricServiceError("VALIDATION", `Backup integrity check failed: ${integrity}`);
    }
    const violations = backup.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new FabricServiceError("VALIDATION", `Backup has ${violations.length} foreign-key violation(s).`);
    }
    const hasMigrations = backup.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (!hasMigrations) throw new FabricServiceError("VALIDATION", "The selected file is not a Greige Fabric database backup.");
    const migrationCount = (backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number }).count;
    return {
      path: backupPath,
      integrity: "ok",
      foreignKeyViolations: 0,
      migrationCount,
    };
  } finally {
    backup.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function renameIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export class BackupService {
  private readonly settingsPath: string;
  private readonly pendingRestorePath: string;
  private settings: z.infer<typeof settingsSchema>;
  private runningScheduledBackup = false;
  private backupInProgress = false;

  private constructor(
    private readonly database: Database.Database,
    private readonly databasePath: string,
    private readonly userDataDirectory: string,
    private readonly applicationDirectory: string,
    settings: z.infer<typeof settingsSchema>,
  ) {
    this.settingsPath = path.join(userDataDirectory, "backup-settings.json");
    this.pendingRestorePath = path.join(userDataDirectory, "pending-database-restore.json");
    this.settings = settings;
  }

  static async create(
    database: Database.Database,
    databasePath: string,
    userDataDirectory: string,
    applicationDirectory: string,
  ): Promise<BackupService> {
    await mkdir(userDataDirectory, { recursive: true });
    const actualUserDataDirectory = await realpath(userDataDirectory);
    const defaultDirectory = path.join(actualUserDataDirectory, "backups");
    let settings: z.infer<typeof settingsSchema> = {
      destinationDirectory: defaultDirectory,
      frequency: "disabled" as BackupFrequency,
      lastBackupAt: null,
      lastAttemptAt: null,
      lastError: null,
    };
    let settingsError: string | null = null;
    try {
      settings = settingsSchema.parse(JSON.parse(
        await readFile(path.join(actualUserDataDirectory, "backup-settings.json"), "utf8"),
      ));
    } catch (error) {
      if (!isMissingFile(error)) {
        settingsError = error instanceof Error ? error.message : "Unknown backup settings error.";
      }
    }
    if (settingsError) settings.lastError = `Backup preferences could not be loaded: ${settingsError}`;
    const service = new BackupService(
      database, databasePath, actualUserDataDirectory, applicationDirectory, settings,
    );
    return service;
  }

  async getSettings(): Promise<BackupSettings> {
    const nextBackupAt = this.settings.frequency === "disabled"
      ? null
      : this.settings.lastError && this.settings.lastAttemptAt
        ? new Date(Date.parse(this.settings.lastAttemptAt) + minute).toISOString()
        : this.settings.lastBackupAt
          ? this.addInterval(this.settings.lastBackupAt, this.settings.frequency)
          : new Date().toISOString();
    return {
      destinationDirectory: this.settings.destinationDirectory,
      frequency: this.settings.frequency,
      lastBackupAt: this.settings.lastBackupAt,
      nextBackupAt,
      lastError: this.settings.lastError,
    };
  }

  async setDestination(directory: string): Promise<BackupSettings> {
    const destinationDirectory = await this.assertExternalDirectory(directory);
    await mkdir(destinationDirectory, { recursive: true });
    this.settings.destinationDirectory = destinationDirectory;
    this.settings.lastError = null;
    this.settings.lastAttemptAt = null;
    await this.saveSettings();
    return this.getSettings();
  }

  async setSchedule(frequency: BackupFrequency): Promise<BackupSettings> {
    this.settings.frequency = frequency;
    this.settings.lastError = null;
    this.settings.lastAttemptAt = null;
    await this.saveSettings();
    return this.getSettings();
  }

  async createBackup(): Promise<{ path: string; createdAt: string }> {
    if (this.backupInProgress) {
      throw new FabricServiceError("CONFLICT", "Another database backup is already in progress.");
    }
    this.backupInProgress = true;
    try {
      await this.assertExternalDirectory(this.settings.destinationDirectory);
      await mkdir(this.settings.destinationDirectory, { recursive: true });
      const createdAt = new Date().toISOString();
      const filename = `greige-fabric-${createdAt.replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`;
      const backupPath = path.join(this.settings.destinationDirectory, filename);
      try {
        await this.database.backup(backupPath);
        this.verifyBackup(backupPath);
      } catch (error) {
        await rm(backupPath, { force: true });
        throw error;
      }
      this.settings.lastBackupAt = createdAt;
      this.settings.lastAttemptAt = createdAt;
      this.settings.lastError = null;
      await this.saveSettings();
      return { path: backupPath, createdAt };
    } finally {
      this.backupInProgress = false;
    }
  }

  verifyBackup(backupPath: string): BackupVerification {
    try {
      return inspectBackup(backupPath);
    } catch (error) {
      if (error instanceof FabricServiceError) throw error;
      throw new FabricServiceError("VALIDATION", "The selected file is not a readable SQLite database backup.");
    }
  }

  async stageRestore(backupPath: string): Promise<void> {
    const sourcePath = await realpath(backupPath);
    if (sourcePath === await realpath(this.databasePath).catch((error: unknown) => {
      if (isMissingFile(error)) return "";
      throw error;
    })) {
      throw new FabricServiceError("VALIDATION", "The live database cannot be selected as its own restore source.");
    }
    this.verifyBackup(sourcePath);
    const stagedPath = path.join(this.userDataDirectory, `restore-staged-${randomUUID()}.sqlite`);
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(stagedPath);
    } finally {
      source.close();
    }
    this.verifyBackup(stagedPath);
    const stagedSha256 = createHash("sha256").update(await readFile(stagedPath)).digest("hex");
    await this.writeJsonAtomically(this.pendingRestorePath, { stagedPath, stagedSha256 });
  }

  async runScheduledBackupIfDue(now = new Date()): Promise<boolean> {
    if (this.settings.frequency === "disabled" || this.runningScheduledBackup || this.backupInProgress) return false;
    const settings = await this.getSettings();
    if (settings.nextBackupAt && now.getTime() < Date.parse(settings.nextBackupAt)) return false;
    this.runningScheduledBackup = true;
    try {
      this.settings.lastAttemptAt = now.toISOString();
      try {
        await this.createBackup();
      } catch (error) {
        this.settings.lastError = error instanceof Error ? error.message : "Scheduled backup failed.";
        await this.saveSettings();
        throw error;
      }
      return true;
    } finally {
      this.runningScheduledBackup = false;
    }
  }

  static async applyPendingRestore(
    databasePath: string,
    userDataDirectory: string,
  ): Promise<boolean> {
    const markerPath = path.join(userDataDirectory, "pending-database-restore.json");
    let rawMarker: string;
    try {
      rawMarker = await readFile(markerPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    const { stagedPath, stagedSha256 } = pendingRestoreSchema.parse(JSON.parse(rawMarker));
    const resolvedUserData = await realpath(userDataDirectory);
    const resolvedStaged = path.resolve(stagedPath);
    if (path.dirname(resolvedStaged) !== resolvedUserData || !path.basename(resolvedStaged).startsWith("restore-staged-")) {
      throw new Error("Pending restore points outside the application's user data directory.");
    }

    try {
      await stat(resolvedStaged);
    } catch (error) {
      if (isMissingFile(error)) {
        const installedHash = createHash("sha256").update(await readFile(databasePath)).digest("hex");
        if (installedHash !== stagedSha256) {
          throw new Error(
            "The staged restore file is missing and the current database does not match the requested backup.",
            { cause: error },
          );
        }
        inspectBackup(databasePath);
        await rm(markerPath);
        return true;
      }
      throw error;
    }

    inspectBackup(resolvedStaged);

    const restoreId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const beforeRestorePath = path.join(userDataDirectory, `before-restore-${restoreId}.sqlite`);
    await mkdir(path.dirname(databasePath), { recursive: true });
    let current: Database.Database | undefined;
    try {
      current = new Database(databasePath);
      current.pragma("wal_checkpoint(TRUNCATE)");
      await current.backup(beforeRestorePath);
    } finally {
      current?.close();
    }
    const previousPath = `${databasePath}.before-restore-${restoreId}`;
    const previousWalPath = `${databasePath}-wal.before-restore-${restoreId}`;
    const previousShmPath = `${databasePath}-shm.before-restore-${restoreId}`;
    let movedMain = false;
    let movedWal = false;
    let movedShm = false;
    try {
      movedMain = await renameIfPresent(databasePath, previousPath);
      movedWal = await renameIfPresent(`${databasePath}-wal`, previousWalPath);
      movedShm = await renameIfPresent(`${databasePath}-shm`, previousShmPath);
      await rename(resolvedStaged, databasePath);
    } catch (error) {
      if (movedMain) await renameIfPresent(previousPath, databasePath);
      if (movedWal) await renameIfPresent(previousWalPath, `${databasePath}-wal`);
      if (movedShm) await renameIfPresent(previousShmPath, `${databasePath}-shm`);
      throw error;
    }
    await rm(markerPath);
    return true;
  }

  private async assertExternalDirectory(directory: string): Promise<string> {
    const resolved = path.resolve(directory);
    const application = await realpath(this.applicationDirectory);
    if (resolved === application || resolved.startsWith(`${application}${path.sep}`)) {
      throw new FabricServiceError("VALIDATION", "Backup destinations must be outside the application installation directory.");
    }
    await mkdir(resolved, { recursive: true });
    const actual = await realpath(resolved);
    if (actual === application || actual.startsWith(`${application}${path.sep}`)) {
      throw new FabricServiceError("VALIDATION", "Backup destinations must be outside the application installation directory.");
    }
    return actual;
  }

  private addInterval(date: string, frequency: BackupFrequency): string {
    const next = new Date(date);
    next.setDate(next.getDate() + (frequency === "daily" ? 1 : 7));
    return next.toISOString();
  }

  private async saveSettings(): Promise<void> {
    await this.writeJsonAtomically(this.settingsPath, this.settings);
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }
}
