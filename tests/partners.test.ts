import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/main/database";
import { AccountingService, postJournal } from "../src/main/services/accounting";
import { PartnerService } from "../src/main/services/partners";
import { partnerInputSchema } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

async function createService() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "greige-partners-"));
  temporaryDirectories.push(directory);
  const database = await openDatabase(
    path.join(directory, "pos.sqlite"),
    path.resolve("database/migrations"),
  );
  return {
    database,
    partners: new PartnerService(database),
    accounting: new AccountingService(database),
    close: () => database.close(),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function partnerInput(input: {
  code: string;
  name: string;
  structure?: "EQUITY" | "LOAN";
  share?: number;
}) {
  return partnerInputSchema.parse({
    code: input.code,
    fullName: input.name,
    partnerType: input.structure === "LOAN" ? "INVESTOR" : "PARTNER",
    investmentStructure: input.structure ?? "EQUITY",
    phone: "",
    email: "",
    address: "",
    joiningDate: "2026-10-01",
    ownershipBps: input.share ?? 10000,
    profitSharingBps: input.share ?? 10000,
    agreementStartDate: "2026-10-01",
    agreementNotes: "",
    active: true,
    internalNotes: "",
  });
}

describe("partnership accounting", () => {
  it("posts equity and loan movements to distinct subledgers and makes closed-period allocations once", async () => {
    const { database, partners, accounting, close } = await createService();
    try {
      const owner = partners.save(partnerInput({ code: "PT-01", name: "Equity Partner" }));
      const investor = partners.save(partnerInput({
        code: "IV-01", name: "Loan Investor", structure: "LOAN", share: 0,
      }));

      const contributionInput = {
        submissionId: "4f08c128-49fa-4f20-a2ec-54e2532fb655",
        partnerId: owner.id,
        transactionType: "CAPITAL_CONTRIBUTION" as const,
        transactionDate: "2026-10-10",
        amount: 1000,
        paymentMethod: "CASH" as const,
        paymentAccountCode: "1000",
        reference: "CAP-001",
        description: "Initial capital",
        supportingNotes: "",
      };
      const contribution = partners.postTransaction(contributionInput);
      expect(partners.postTransaction(contributionInput).id).toBe(contribution.id);

      const loanFunding = partners.postTransaction({
        submissionId: "aeeb4c49-9dbc-4df3-8981-6466bb9ee118",
        partnerId: investor.id,
        transactionType: "LOAN_DISBURSEMENT",
        transactionDate: "2026-10-11",
        amount: 500,
        paymentMethod: "CASH",
        paymentAccountCode: "1000",
        reference: "LOAN-001",
        description: "Partner loan funding",
        supportingNotes: "",
      });
      expect(loanFunding.transactionType).toBe("LOAN_DISBURSEMENT");
      partners.postTransaction({
        submissionId: "1b686012-7c42-48b3-a599-aa708f4e3789",
        partnerId: investor.id,
        transactionType: "LOAN_REPAYMENT",
        transactionDate: "2026-10-12",
        amount: 150,
        paymentMethod: "CASH",
        paymentAccountCode: "1000",
        reference: "LOAN-002",
        description: "Partial repayment",
        supportingNotes: "",
      });
      expect(partners.get(investor.id).balance).toMatchObject({
        capitalBalanceMinor: 0,
        loanBalanceMinor: 35000,
      });
      expect(() => partners.postTransaction({
        submissionId: "3eb617bc-130c-4c36-a6f1-8c46b50c9708",
        partnerId: investor.id,
        transactionType: "CAPITAL_CONTRIBUTION",
        transactionDate: "2026-10-12",
        amount: 1,
        paymentMethod: "CASH",
        paymentAccountCode: "1000",
        reference: "",
        description: "Invalid equity contribution",
        supportingNotes: "",
      })).toThrow(/loan-structured partner cannot post an equity contribution/i);

      postJournal(database, "test_revenue", "Test sales", "2026-10-15T12:00:00.000Z", [
        { accountCode: "1000", debitMinor: 100000 },
        { accountCode: "4000", creditMinor: 100000 },
      ], "Test", "test-revenue");
      postJournal(database, "test_expense", "Test expense", "2026-10-16T12:00:00.000Z", [
        { accountCode: "5200", debitMinor: 30000 },
        { accountCode: "1000", creditMinor: 30000 },
      ], "Test", "test-expense");
      const period = database.prepare(`
        SELECT id FROM accounting_periods WHERE starts_on <= '2026-10-15' AND ends_on >= '2026-10-15'
      `).get() as { id: string };
      expect(partners.allocationPreview(period.id)).toMatchObject({
        status: "open",
        finalizedNetProfitMinor: null,
        isEligibleToPost: false,
      });
      accounting.closePeriod(period.id);

      const preview = partners.allocationPreview(period.id);
      expect(preview).toMatchObject({
        finalizedNetProfitMinor: 70000,
        totalSharingBps: 10000,
        isEligibleToPost: true,
      });
      expect(preview.allocations).toEqual([
        expect.objectContaining({ partnerId: owner.id, amountMinor: 70000 }),
      ]);
      const posted = partners.postAllocation({
        periodId: period.id,
        allocationDate: "2026-11-01",
        confirmed: true,
      });
      expect(posted).toHaveLength(1);
      expect(partners.get(owner.id).balance.distributableProfitMinor).toBe(70000);
      expect(() => partners.postAllocation({
        periodId: period.id,
        allocationDate: "2026-11-01",
        confirmed: true,
      })).toThrow(/already has allocations/i);

      const distribution = partners.postTransaction({
        submissionId: "63a55995-bf11-4f8d-909b-7ca50e6517b7",
        partnerId: owner.id,
        transactionType: "PROFIT_DISTRIBUTION",
        transactionDate: "2026-11-02",
        amount: 100,
        paymentMethod: "CASH",
        paymentAccountCode: "1000",
        reference: "DIST-001",
        description: "Cash profit distribution",
        supportingNotes: "",
      });
      expect(distribution.transactionType).toBe("PROFIT_DISTRIBUTION");
      expect(partners.get(owner.id).balance).toMatchObject({
        capitalBalanceMinor: 100000,
        distributableProfitMinor: 60000,
      });
      expect(() => partners.postTransaction({
        submissionId: "64d9c4b8-f0b6-46ce-a0c3-51a870d5cc39",
        partnerId: owner.id,
        transactionType: "PROFIT_DISTRIBUTION",
        transactionDate: "2026-11-02",
        amount: 700,
        paymentMethod: "CASH",
        paymentAccountCode: "1000",
        reference: "",
        description: "Excess distribution",
        supportingNotes: "",
      })).toThrow(/exceeds the partner's available balance/i);

      const reversal = partners.reverse({
        id: contribution.id,
        date: "2026-11-03",
        reason: "Duplicate capital receipt correction",
      });
      expect(reversal.reversalOfTransactionId).toBe(contribution.id);
      expect(partners.get(owner.id).transactions.find((item) => item.id === contribution.id)?.status).toBe("REVERSED");
      expect(partners.get(owner.id).balance.capitalBalanceMinor).toBe(0);
      expect(() => partners.reverse({
        id: contribution.id,
        date: "2026-11-03",
        reason: "Attempt second reversal",
      })).toThrow(/already been reversed/i);

      const statement = partners.statement({
        partnerId: owner.id,
        from: "2026-10-10",
        to: "2026-11-03",
      });
      expect(statement).toMatchObject({
        openingCapitalMinor: 0,
        closingCapitalMinor: 0,
        closingDistributableProfitMinor: 60000,
      });
      expect(statement.lines.at(-1)?.balanceMinor).toBe(0);

      const postedEntries = database.prepare(`
        SELECT t.id, SUM(p.debit_minor) AS debits, SUM(p.credit_minor) AS credits
        FROM ledger_transactions t JOIN ledger_postings p ON p.transaction_id = t.id
        WHERE t.source_key LIKE 'partner_%'
        GROUP BY t.id
      `).all() as Array<{ id: string; debits: number; credits: number }>;
      expect(postedEntries.length).toBeGreaterThanOrEqual(5);
      expect(postedEntries.every((entry) => entry.debits === entry.credits)).toBe(true);
    } finally {
      close();
    }
  });
});
