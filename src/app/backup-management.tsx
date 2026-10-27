"use client";

import { useEffect, useState } from "react";
import { getDesktopApi } from "@/lib/desktop-api";
import type { IpcResult } from "@/shared/contracts";
import type { BackupFrequency, BackupSettings, BackupVerification } from "@/shared/types";

function resultData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

export default function BackupManagement() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [verification, setVerification] = useState<BackupVerification | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [ownerPin, setOwnerPin] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void getDesktopApi().backups.settings().then((result) => {
      setSettings(resultData(result));
    }).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "Unable to load backup settings.");
    }).finally(() => setLoading(false));
  }, []);

  async function changeSchedule(frequency: BackupFrequency) {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      setSettings(resultData(await getDesktopApi().backups.setSchedule({ frequency, ownerPin })));
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "Unable to update the backup schedule.");
    } finally {
      setWorking(false);
    }
  }

  async function chooseDestination() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      setSettings(resultData(await getDesktopApi().backups.chooseDestination({ ownerPin })));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : "Unable to change the backup destination.");
    } finally {
      setWorking(false);
    }
  }

  async function createBackup() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const backup = resultData(await getDesktopApi().backups.create({ ownerPin }));
      setSettings(resultData(await getDesktopApi().backups.settings()));
      setNotice(`Backup created and verified: ${backup.path}`);
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : "Unable to create a database backup.");
    } finally {
      setWorking(false);
    }
  }

  async function verifyBackup() {
    setWorking(true);
    setError("");
    setNotice("");
    setVerification(null);
    try {
      const result = resultData(await getDesktopApi().backups.verify({ ownerPin }));
      if (!result) return;
      setVerification(result);
      setNotice("Backup passed SQLite integrity and foreign-key checks.");
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "Unable to verify this backup.");
    } finally {
      setWorking(false);
    }
  }

  async function restoreBackup() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = resultData(await getDesktopApi().backups.restore({ ownerPin }));
      if (result.restarting) setNotice("Restore staged. The application is restarting.");
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Unable to stage this database restore.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="backup-page">
      <section className="panel">
        <header className="panel-heading">
          <div>
            <h2>Backup & recovery</h2>
            <p>Owner authorization is required to create, schedule, verify, or restore database backups.</p>
          </div>
        </header>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
        {settings?.lastError && <div className="error-banner" role="alert">
          Latest scheduled backup failed: {settings.lastError}
        </div>}
        <label className="backup-owner-pin">Owner PIN
          <input type="password" inputMode="numeric" minLength={6} maxLength={64}
            autoComplete="current-password" value={ownerPin}
            onChange={(event) => setOwnerPin(event.target.value)} />
        </label>
        {loading ? <p className="empty-state">Loading backup settings…</p> : settings && (
          <div className="backup-settings">
            <div className="backup-setting">
              <div><strong>Backup destination</strong><span>{settings.destinationDirectory}</span></div>
              <button type="button" className="secondary-button" disabled={working || ownerPin.length < 6} onClick={() => void chooseDestination()}>
                Choose folder
              </button>
            </div>
            <div className="backup-setting">
              <div><strong>Scheduled backups</strong><span>Runs while the application is open; missed backups run on the next launch.</span></div>
              <select aria-label="Scheduled backup frequency" disabled={working || ownerPin.length < 6} value={settings.frequency}
                onChange={(event) => void changeSchedule(event.target.value as BackupFrequency)}>
                <option value="disabled">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="backup-setting">
              <div><strong>Last successful backup</strong><span>{formatDate(settings.lastBackupAt)}</span></div>
              <div><strong>Next scheduled backup</strong><span>{formatDate(settings.nextBackupAt)}</span></div>
            </div>
            <div className="backup-actions">
              <button type="button" className="primary-button" disabled={working || ownerPin.length < 6} onClick={() => void createBackup()}>
                {working ? "Working…" : "Back up now"}
              </button>
              <button type="button" className="secondary-button" disabled={working || ownerPin.length < 6} onClick={() => void verifyBackup()}>
                Verify a backup
              </button>
              <button type="button" className="danger-button" disabled={working || ownerPin.length < 6} onClick={() => void restoreBackup()}>
                Restore backup…
              </button>
            </div>
            {verification && <div className="backup-verification" role="status">
              <strong>Verified SQLite backup</strong>
              <span>{verification.path}</span>
              <span>Integrity: {verification.integrity} · Foreign-key violations: {verification.foreignKeyViolations} · Applied migrations: {verification.migrationCount}</span>
            </div>}
          </div>
        )}
      </section>
      <section className="panel backup-guidance">
        <h2>Recovery safeguards</h2>
        <ul>
          <li>Backups use SQLite&apos;s online backup API, so open transactions are included consistently.</li>
          <li>Restore requires confirmation and restarts the app. The current database is preserved before replacement.</li>
          <li>Database migrations are applied transactionally at startup; a pre-migration snapshot is also retained.</li>
          <li>Keep backup files on a separate drive or other protected location for disaster recovery.</li>
        </ul>
      </section>
    </div>
  );
}
