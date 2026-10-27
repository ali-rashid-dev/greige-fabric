import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { FabricServiceError } from "./errors";

export interface JournalLineInput {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  supplierId?: string;
}

function roundedDivision(numerator: bigint, denominator: bigint): number {
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FabricServiceError("VALIDATION", "The amount exceeds the supported accounting precision.");
  }
  return Number(result);
}

export function calculateMinorValue(quantityMm: number, unitCostMinor: number): number {
  return roundedDivision(BigInt(quantityMm) * BigInt(unitCostMinor), 1000n);
}

export function calculateProportionalValue(totalMinor: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  return roundedDivision(BigInt(totalMinor) * BigInt(part), BigInt(whole));
}

export function postJournal(
  database: Database.Database,
  transactionType: string,
  reference: string,
  createdAt: string,
  lines: JournalLineInput[],
  authorizedUser = "System",
): void {
  const debitMinor = lines.reduce((total, line) => total + (line.debitMinor ?? 0), 0);
  const creditMinor = lines.reduce((total, line) => total + (line.creditMinor ?? 0), 0);
  if (!Number.isSafeInteger(debitMinor) || !Number.isSafeInteger(creditMinor)) {
    throw new FabricServiceError("VALIDATION", "The journal entry exceeds the supported accounting precision.");
  }
  if (debitMinor !== creditMinor) {
    throw new Error(`Unbalanced ${transactionType} journal entry (${debitMinor} != ${creditMinor}).`);
  }
  if (debitMinor === 0) return;

  const transactionId = randomUUID();
  database.prepare(`
    INSERT INTO ledger_transactions (id, transaction_type, reference, authorized_user, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(transactionId, transactionType, reference, authorizedUser, createdAt);
  const insertPosting = database.prepare(`
    INSERT INTO ledger_postings (
      id, transaction_id, account_code, supplier_id, debit_minor, credit_minor
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const line of lines) {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (debit === 0 && credit === 0) continue;
    insertPosting.run(
      randomUUID(),
      transactionId,
      line.accountCode,
      line.supplierId ?? null,
      debit,
      credit,
    );
  }
}
