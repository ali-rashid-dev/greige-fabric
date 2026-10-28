import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  BusinessPartner,
  PartnerAllocationPreview,
  PartnerBalance,
  PartnerDetails,
  PartnerListResult,
  PartnerPaymentMethod,
  PartnerStatement,
  PartnerTransaction,
  PartnerTransactionHistoryResult,
  PartnerTransactionType,
  PartnershipDashboard,
} from "../../shared/types";
import type {
  PartnerAllocationPostInput,
  PartnerInput,
  PartnerListInput,
  PartnerStatementInput,
  PartnerTransactionInput,
  PartnerTransactionHistoryInput,
  PartnerTransactionReversalInput,
} from "../../shared/contracts";
import { postJournal } from "./accounting";
import { FabricServiceError } from "./errors";
import { writeAuditLog } from "./audit";
import { finalizedProfitForPeriod } from "./reports";

interface PartnerRow {
  id: string;
  code: string;
  full_name: string;
  partner_type: "PARTNER" | "INVESTOR";
  investment_structure: "EQUITY" | "LOAN" | null;
  phone: string;
  email: string;
  address: string;
  joining_date: string;
  ownership_bps: number;
  profit_sharing_bps: number;
  agreement_start_date: string;
  agreement_notes: string;
  active: number;
  internal_notes: string;
  created_at: string;
  updated_at: string;
}

interface PartnerTransactionRow {
  id: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  transaction_type: PartnerTransactionType;
  transaction_date: string;
  amount_minor: number;
  payment_method: PartnerPaymentMethod;
  payment_account_code: string | null;
  payment_account_name: string | null;
  reference: string;
  description: string;
  supporting_notes: string;
  status: "POSTED" | "REVERSED";
  journal_transaction_id: string;
  reversal_of_transaction_id: string | null;
  reversal_reason: string;
  created_at: string;
}

type AccountBalances = {
  capital: number;
  loan: number;
  distributableProfit: number;
};

const ACCOUNT_BY_TYPE: Record<PartnerTransactionType, string> = {
  CAPITAL_CONTRIBUTION: "3200",
  LOAN_DISBURSEMENT: "2210",
  LOAN_REPAYMENT: "2210",
  PROFIT_ALLOCATION: "2220",
  PROFIT_DISTRIBUTION: "2220",
  PARTNER_WITHDRAWAL: "3200",
  LOSS_ALLOCATION: "3200",
  CAPITAL_SETTLEMENT: "3200",
};

function mapPartner(row: PartnerRow): BusinessPartner {
  return {
    id: row.id,
    code: row.code,
    fullName: row.full_name,
    partnerType: row.partner_type,
    investmentStructure: row.investment_structure ?? "EQUITY",
    phone: row.phone,
    email: row.email,
    address: row.address,
    joiningDate: row.joining_date,
    ownershipBps: row.ownership_bps,
    profitSharingBps: row.profit_sharing_bps,
    agreementStartDate: row.agreement_start_date,
    agreementNotes: row.agreement_notes,
    active: row.active === 1,
    internalNotes: row.internal_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row: PartnerTransactionRow): PartnerTransaction {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    transactionType: row.transaction_type,
    transactionDate: row.transaction_date,
    amountMinor: row.amount_minor,
    paymentMethod: row.payment_method,
    ...(row.payment_account_code ? { paymentAccountCode: row.payment_account_code } : {}),
    ...(row.payment_account_name ? { paymentAccountName: row.payment_account_name } : {}),
    reference: row.reference,
    description: row.description,
    supportingNotes: row.supporting_notes,
    status: row.status,
    journalTransactionId: row.journal_transaction_id,
    ...(row.reversal_of_transaction_id ? { reversalOfTransactionId: row.reversal_of_transaction_id } : {}),
    ...(row.reversal_reason ? { reversalReason: row.reversal_reason } : {}),
    createdAt: row.created_at,
  };
}

function asSafeAmount(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new FabricServiceError("VALIDATION", `${label} exceeds supported accounting precision.`);
  }
  return value;
}

function signedTransactionAmount(row: { amount_minor: number; reversal_of_transaction_id: string | null }): number {
  return row.reversal_of_transaction_id ? -row.amount_minor : row.amount_minor;
}

function allocateProportionally(totalMinor: number, partners: Array<{ id: string; bps: number }>): number[] {
  const total = BigInt(Math.abs(totalMinor));
  const totalBps = partners.reduce((sum, item) => sum + item.bps, 0);
  if (totalBps <= 0) return partners.map(() => 0);
  const result = partners.map((partner, index) => {
    const numerator = total * BigInt(partner.bps);
    return { index, amount: numerator / BigInt(totalBps), remainder: numerator % BigInt(totalBps) };
  });
  let remainder = total - result.reduce((sum, item) => sum + item.amount, 0n);
  const order = [...result].sort((a, b) =>
    a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index,
  );
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    result[order[index].index].amount += 1n;
  }
  return result.map(({ amount }) => {
    const signed = totalMinor < 0 ? -amount : amount;
    if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new FabricServiceError("VALIDATION", "The allocation exceeds supported accounting precision.");
    }
    return Number(signed);
  });
}

export class PartnerService {
  constructor(private readonly database: Database.Database) {
    const requiredAccounts = [
      ["2210", "liability", "credit"],
      ["2220", "liability", "credit"],
      ["3100", "equity", "credit"],
      ["3200", "equity", "credit"],
    ] as const;
    for (const [code, type, normalBalance] of requiredAccounts) {
      const account = database.prepare(`
        SELECT account_type, normal_balance FROM ledger_accounts WHERE code = ?
      `).get(code) as { account_type: string; normal_balance: string } | undefined;
      if (!account || account.account_type !== type || account.normal_balance !== normalBalance) {
        throw new Error(`Partner ledger account ${code} must be configured as ${type} with a ${normalBalance} normal balance.`);
      }
    }
  }

  dashboard(range: { from: string; to: string }): PartnershipDashboard {
    const transactions = this.transactionRows(range.from, range.to);
    const signedTotal = (type: PartnerTransactionType) => asSafeAmount(
      transactions.filter((item) => item.transaction_type === type)
        .reduce((sum, item) => sum + signedTransactionAmount(item), 0),
      "Partner transaction total",
    );
    const balances = this.balanceRows(range.to);
    const active = this.database.prepare(`
      SELECT SUM(CASE WHEN partner_type = 'PARTNER' THEN 1 ELSE 0 END) AS partners,
        SUM(CASE WHEN partner_type = 'INVESTOR' THEN 1 ELSE 0 END) AS investors
      FROM business_partners WHERE active = 1
    `).get() as { partners: number; investors: number };

    const contributionTrends = this.database.prepare(`
      SELECT substr(transaction_date, 1, 7) AS month,
        SUM(CASE WHEN reversal_of_transaction_id IS NULL THEN amount_minor ELSE -amount_minor END) AS amount_minor
      FROM partner_transactions
      WHERE transaction_type = 'CAPITAL_CONTRIBUTION'
        AND transaction_date >= ? AND transaction_date <= ?
      GROUP BY substr(transaction_date, 1, 7) ORDER BY month
    `).all(range.from, range.to) as Array<{ month: string; amount_minor: number }>;

    const profitSummary = this.database.prepare(`
      SELECT p.full_name AS partner_name,
        COALESCE((
          SELECT SUM(CASE WHEN t.reversal_of_transaction_id IS NULL THEN t.amount_minor ELSE -t.amount_minor END)
          FROM partner_transactions t WHERE t.partner_id = p.id
            AND t.transaction_type = 'PROFIT_ALLOCATION'
            AND t.transaction_date >= ? AND t.transaction_date <= ?
        ), 0) AS allocated_minor,
        COALESCE((
          SELECT SUM(CASE WHEN t.reversal_of_transaction_id IS NULL THEN t.amount_minor ELSE -t.amount_minor END)
          FROM partner_transactions t WHERE t.partner_id = p.id
            AND t.transaction_type = 'PROFIT_DISTRIBUTION'
            AND t.transaction_date >= ? AND t.transaction_date <= ?
        ), 0) AS distributed_minor
      FROM business_partners p
      WHERE p.active = 1 ORDER BY p.full_name COLLATE NOCASE
    `).all(range.from, range.to, range.from, range.to) as Array<{
      partner_name: string;
      allocated_minor: number;
      distributed_minor: number;
    }>;

    const total = (key: "capitalBalanceMinor" | "loanBalanceMinor" | "distributableProfitMinor") =>
      asSafeAmount(balances.reduce((sum, row) => sum + row[key], 0), "Partner balance total");
    return {
      activePartners: active.partners ?? 0,
      activeInvestors: active.investors ?? 0,
      capitalContributedMinor: signedTotal("CAPITAL_CONTRIBUTION"),
      outstandingPartnerLoansMinor: total("loanBalanceMinor"),
      profitAllocatedMinor: signedTotal("PROFIT_ALLOCATION"),
      profitDistributedMinor: signedTotal("PROFIT_DISTRIBUTION"),
      partnerWithdrawalsMinor: signedTotal("PARTNER_WITHDRAWAL"),
      partnerCapitalBalancesMinor: total("capitalBalanceMinor"),
      from: range.from,
      to: range.to,
      recentTransactions: transactions.slice(0, 12).map(mapTransaction),
      contributionTrends: contributionTrends.map((row) => ({
        month: row.month,
        amountMinor: asSafeAmount(row.amount_minor, "Contribution trend"),
      })),
      profitSummary: profitSummary.map((row) => ({
        partnerName: row.partner_name,
        allocatedMinor: asSafeAmount(row.allocated_minor, "Profit allocation total"),
        distributedMinor: asSafeAmount(row.distributed_minor, "Profit distribution total"),
      })),
      balances,
    };
  }

  list(input: PartnerListInput): PartnerListResult {
    const query = input.query?.trim() ?? "";
    const status = input.status ?? "active";
    const partnerType = input.partnerType ?? "all";
    const sortColumn = input.sortBy === "code"
      ? "p.code"
      : input.sortBy === "joiningDate" ? "p.joining_date" : "p.full_name COLLATE NOCASE";
    const sortDirection = input.sortDirection === "desc" ? "DESC" : "ASC";
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const where = `
      WHERE (? = '' OR p.full_name LIKE '%' || ? || '%' COLLATE NOCASE
        OR p.code LIKE '%' || ? || '%' COLLATE NOCASE
        OR p.phone LIKE '%' || ? || '%' COLLATE NOCASE
        OR p.email LIKE '%' || ? || '%' COLLATE NOCASE)
      AND (? = 'all' OR (? = 'active' AND p.active = 1) OR (? = 'inactive' AND p.active = 0))
      AND (? = 'all' OR p.partner_type = ?)
    `;
    const params = [
      query, query, query, query, query,
      status, status, status, partnerType, partnerType,
    ];
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM business_partners p ${where}
    `).get(...params) as { count: number }).count;
    const rows = this.database.prepare(`
      SELECT p.* FROM business_partners p ${where}
      ORDER BY ${sortColumn} ${sortDirection}, p.id
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as PartnerRow[];
    return { partners: rows.map(mapPartner), total, page, pageSize };
  }

  get(id: string): PartnerDetails {
    const partner = this.partnerRow(id);
    const transactions = this.transactionRows(undefined, undefined, id);
    const balance = this.balanceRows(undefined, id)[0];
    if (!balance) throw new FabricServiceError("NOT_FOUND", "Partner not found.");
    return { partner: mapPartner(partner), transactions: transactions.map(mapTransaction), balance };
  }

  save(input: PartnerInput): BusinessPartner {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const save = this.database.transaction(() => {
      if (input.id) {
        const existing = this.database.prepare("SELECT id FROM business_partners WHERE id = ?").get(input.id);
        if (!existing) throw new FabricServiceError("NOT_FOUND", "Partner not found.");
        this.database.prepare(`
          UPDATE business_partners SET code = ?, full_name = ?, partner_type = ?,
            investment_structure = ?, phone = ?, email = ?, address = ?,
            joining_date = ?, ownership_bps = ?, profit_sharing_bps = ?,
            agreement_start_date = ?, agreement_notes = ?, active = ?,
            internal_notes = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.code, input.fullName, input.partnerType, input.investmentStructure,
          input.phone, input.email, input.address, input.joiningDate,
          input.ownershipBps, input.profitSharingBps, input.agreementStartDate,
          input.agreementNotes, input.active ? 1 : 0, input.internalNotes, now, id,
        );
            const latestAgreement = this.database.prepare(`
          SELECT effective_from, ownership_bps, profit_sharing_bps, notes
          FROM partner_agreements WHERE partner_id = ?
          ORDER BY effective_from DESC LIMIT 1
        `).get(id) as { effective_from: string; ownership_bps: number; profit_sharing_bps: number; notes: string } | undefined;
        if (
          !latestAgreement
          || latestAgreement.effective_from !== input.agreementStartDate
          || latestAgreement.ownership_bps !== input.ownershipBps
          || latestAgreement.profit_sharing_bps !== input.profitSharingBps
          || latestAgreement.notes !== input.agreementNotes
        ) {
          if (latestAgreement && input.agreementStartDate <= latestAgreement.effective_from) {
            throw new FabricServiceError("VALIDATION", "Use a new agreement start date after the latest recorded terms.");
          }
          this.insertAgreement(id, input, now);
        }
      } else {
        this.database.prepare(`
          INSERT INTO business_partners (
            id, code, full_name, partner_type, investment_structure, phone, email,
            address, joining_date, ownership_bps, profit_sharing_bps,
            agreement_start_date, agreement_notes, active, internal_notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.code, input.fullName, input.partnerType, input.investmentStructure,
          input.phone, input.email, input.address, input.joiningDate,
          input.ownershipBps, input.profitSharingBps, input.agreementStartDate,
          input.agreementNotes, input.active ? 1 : 0, input.internalNotes, now, now,
        );
        this.insertAgreement(id, input, now);
      }
      writeAuditLog(this.database, "Operator", input.id ? "partner_updated" : "partner_created",
        "business_partner", id, `${input.code} · ${input.fullName}`, now);
    });
    save.immediate();
    return mapPartner(this.partnerRow(id));
  }

  setActive(id: string, active: boolean): BusinessPartner {
    const now = new Date().toISOString();
    const update = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE business_partners SET active = ?, updated_at = ? WHERE id = ?
      `).run(active ? 1 : 0, now, id);
      if (result.changes === 0) throw new FabricServiceError("NOT_FOUND", "Partner not found.");
      writeAuditLog(this.database, "Operator", active ? "partner_reactivated" : "partner_deactivated",
        "business_partner", id, active ? "Reactivated partner" : "Deactivated partner", now);
    });
    update.immediate();
    return mapPartner(this.partnerRow(id));
  }

  paymentAccounts(): Array<{ code: string; name: string }> {
    return this.database.prepare(`
      SELECT code, name FROM ledger_accounts
      WHERE account_type = 'asset' AND is_payment_account = 1 ORDER BY code
    `).all() as Array<{ code: string; name: string }>;
  }

  postTransaction(input: PartnerTransactionInput): PartnerTransaction {
    const existing = this.database.prepare(
      "SELECT id FROM partner_transactions WHERE request_id = ?",
    ).get(input.submissionId) as { id: string } | undefined;
    if (existing) return mapTransaction(this.transactionRow(existing.id));
    const partner = this.partnerRow(input.partnerId);
    if (partner.active !== 1) throw new FabricServiceError("CONFLICT", "Reactivate this partner before posting transactions.");
    const amountMinor = Math.round(input.amount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new FabricServiceError("VALIDATION", "Enter a valid amount in PKR.");
    }
    const paymentAccount = this.database.prepare(`
      SELECT code, name FROM ledger_accounts
      WHERE code = ? AND account_type = 'asset' AND is_payment_account = 1
    `).get(input.paymentAccountCode) as { code: string; name: string } | undefined;
    if (!paymentAccount) throw new FabricServiceError("VALIDATION", "Choose a configured cash or bank account.");
    if (input.paymentMethod === "CASH" && paymentAccount.code !== "1000") {
      throw new FabricServiceError("VALIDATION", "Cash payments must use the configured Cash account.");
    }
    if (input.paymentMethod === "BANK_TRANSFER" && paymentAccount.code !== "1010") {
      throw new FabricServiceError("VALIDATION", "Bank transfers must use the configured Bank account.");
    }
    const isEquity = partner.investment_structure === "EQUITY";
    if (input.transactionType === "CAPITAL_CONTRIBUTION" && !isEquity) {
      throw new FabricServiceError("VALIDATION", "A loan-structured partner cannot post an equity contribution.");
    }
    if (["LOAN_DISBURSEMENT", "LOAN_REPAYMENT"].includes(input.transactionType) && isEquity) {
      throw new FabricServiceError("VALIDATION", "A loan transaction requires a loan-structured partner.");
    }
    if (["PARTNER_WITHDRAWAL", "CAPITAL_SETTLEMENT"].includes(input.transactionType) && !isEquity) {
      throw new FabricServiceError("VALIDATION", "Use loan repayment to settle a loan-structured investment.");
    }

    const accountCode = ACCOUNT_BY_TYPE[input.transactionType];
    const asOfBalance = this.accountBalance(input.partnerId, accountCode, input.transactionDate);
    if (
      ["LOAN_REPAYMENT", "PROFIT_DISTRIBUTION", "PARTNER_WITHDRAWAL", "CAPITAL_SETTLEMENT"]
        .includes(input.transactionType)
      && amountMinor > asOfBalance
    ) {
      throw new FabricServiceError("CONFLICT", "The transaction exceeds the partner's available balance.");
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const journalDate = `${input.transactionDate}T12:00:00.000Z`;
    const cashDebit = input.transactionType === "CAPITAL_CONTRIBUTION" || input.transactionType === "LOAN_DISBURSEMENT";
    if (!cashDebit && this.assetAccountBalance(paymentAccount.code, input.transactionDate) < amountMinor) {
      throw new FabricServiceError("CONFLICT", "The selected cash or bank account does not have enough balance for this payment.");
    }
    const journalLines = cashDebit
      ? [
        { accountCode: paymentAccount.code, debitMinor: amountMinor },
        { accountCode, creditMinor: amountMinor, partnerId: partner.id },
      ]
      : [
        { accountCode, debitMinor: amountMinor, partnerId: partner.id },
        { accountCode: paymentAccount.code, creditMinor: amountMinor },
      ];
    const journalType = `partner_${input.transactionType.toLowerCase()}`;
    const write = this.database.transaction(() => {
      postJournal(this.database, journalType,
        input.reference || `${partner.code}-${input.transactionType}`, journalDate, journalLines,
        "Operator", id);
      this.database.prepare(`
        INSERT INTO partner_transactions (
          id, request_id, partner_id, transaction_type, transaction_date, amount_minor,
          payment_method, payment_account_code, reference, description,
          supporting_notes, status, journal_transaction_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?)
      `).run(
        id, input.submissionId, partner.id, input.transactionType, input.transactionDate, amountMinor,
        input.paymentMethod, paymentAccount.code, input.reference, input.description,
        input.supportingNotes, this.journalIdForSource(journalType, id), createdAt,
      );
      writeAuditLog(this.database, "Operator", "partner_transaction_posted", "partner_transaction", id,
        input.description, createdAt);
    });
    write.immediate();
    return mapTransaction(this.transactionRow(id));
  }

  transactions(input: PartnerTransactionHistoryInput): PartnerTransactionHistoryResult {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM partner_transactions
      WHERE transaction_date >= ? AND transaction_date <= ?
    `).get(input.from, input.to) as { count: number }).count;
    const transactions = this.transactionRows(
      input.from, input.to, undefined, pageSize, (page - 1) * pageSize,
    ).map(mapTransaction);
    return { transactions, total, page, pageSize };
  }

  allocationPreview(periodId: string): PartnerAllocationPreview {
    const period = this.database.prepare(`
      SELECT id, name, starts_on, ends_on, status FROM accounting_periods WHERE id = ?
    `).get(periodId) as { id: string; name: string; starts_on: string; ends_on: string; status: "open" | "closed" } | undefined;
    if (!period) throw new FabricServiceError("NOT_FOUND", "Accounting period not found.");
    const terms = this.database.prepare(`
      SELECT p.id, p.code, p.full_name,
        COALESCE(a.ownership_bps, p.ownership_bps) AS ownership_bps,
        COALESCE(a.profit_sharing_bps, p.profit_sharing_bps) AS profit_sharing_bps
      FROM business_partners p
      LEFT JOIN partner_agreements a ON a.id = (
        SELECT current.id FROM partner_agreements current
        WHERE current.partner_id = p.id AND current.effective_from <= ?
        ORDER BY current.effective_from DESC LIMIT 1
      )
      WHERE p.active = 1 AND COALESCE(a.profit_sharing_bps, p.profit_sharing_bps) > 0
      ORDER BY p.code
    `).all(period.ends_on) as Array<{
      id: string; code: string; full_name: string; ownership_bps: number; profit_sharing_bps: number;
    }>;
    const totalSharingBps = terms.reduce((sum, item) => sum + item.profit_sharing_bps, 0);
    const alreadyAllocated = this.database.prepare(`
      SELECT COUNT(*) AS count FROM partner_profit_allocations WHERE period_id = ?
    `).get(period.id) as { count: number };

    if (period.status !== "closed") {
      return {
        periodId: period.id, periodName: period.name, startsOn: period.starts_on, endsOn: period.ends_on,
        status: period.status, finalizedNetProfitMinor: null, totalSharingBps,
        isEligibleToPost: false, reason: "Close the accounting period before calculating or posting an allocation.",
        allocations: [],
      };
    }

    const netProfitMinor = finalizedProfitForPeriod(this.database, period.starts_on, period.ends_on).netProfitMinor;
    const weights = terms.map((item) => ({ id: item.id, bps: item.profit_sharing_bps }));
    const amounts = allocateProportionally(netProfitMinor, weights);
    const allocations = terms.map((item, index) => ({
      partnerId: item.id,
      partnerCode: item.code,
      partnerName: item.full_name,
      sharingBps: item.profit_sharing_bps,
      amountMinor: amounts[index],
    }));
    let reason: string | undefined;
    if (terms.length === 0) reason = "There are no active partners with profit-sharing terms for this period.";
    else if (totalSharingBps !== 10000) reason = `Applicable sharing percentages total ${totalSharingBps / 100}%; they must equal 100%.`;
    else if (netProfitMinor === 0) reason = "The finalized period result is zero; there is nothing to allocate.";
    else if (alreadyAllocated.count > 0) reason = "This period already has allocations. Use a recorded reversal and adjustment instead.";
    else if (netProfitMinor < 0 && allocations.some((item) =>
      item.amountMinor < 0 && -item.amountMinor > this.accountBalance(item.partnerId, "3200"))) {
      reason = "At least one partner's capital balance cannot absorb its allocated share of the loss.";
    }
    return {
      periodId: period.id,
      periodName: period.name,
      startsOn: period.starts_on,
      endsOn: period.ends_on,
      status: period.status,
      finalizedNetProfitMinor: netProfitMinor,
      totalSharingBps,
      isEligibleToPost: !reason,
      ...(reason ? { reason } : {}),
      allocations,
    };
  }

  postAllocation(input: PartnerAllocationPostInput): PartnerTransaction[] {
    const preview = this.allocationPreview(input.periodId);
    if (!preview.isEligibleToPost) {
      throw new FabricServiceError("CONFLICT", preview.reason ?? "The allocation is not eligible to post.");
    }
    if (input.allocationDate <= preview.endsOn) {
      throw new FabricServiceError("VALIDATION", "Post the allocation on a date after the closed accounting period.");
    }
    const createdAt = new Date().toISOString();
    const createdIds: string[] = [];
    const write = this.database.transaction(() => {
      for (const line of preview.allocations) {
        const amountMinor = Math.abs(line.amountMinor);
        if (amountMinor === 0) continue;
        const isProfit = line.amountMinor > 0;
        const id = randomUUID();
        const journalLines = isProfit
          ? [
            { accountCode: "3100", debitMinor: amountMinor },
            { accountCode: "2220", creditMinor: amountMinor, partnerId: line.partnerId },
          ]
          : [
            { accountCode: "3200", debitMinor: amountMinor, partnerId: line.partnerId },
            { accountCode: "3100", creditMinor: amountMinor },
          ];
        postJournal(this.database, "partner_profit_allocation", `${preview.periodName}-${line.partnerCode}`,
          `${input.allocationDate}T12:00:00.000Z`, journalLines, "Operator", id);
        const journalTransactionId = this.journalIdForSource("partner_profit_allocation", id);
        this.database.prepare(`
          INSERT INTO partner_transactions (
            id, request_id, partner_id, transaction_type, transaction_date, amount_minor,
            payment_method, payment_account_code, reference, description,
            supporting_notes, status, journal_transaction_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'JOURNAL', NULL, ?, ?, ?, 'POSTED', ?, ?)
        `).run(
          id, `allocation:${preview.periodId}:${line.partnerId}`,
          line.partnerId, isProfit ? "PROFIT_ALLOCATION" : "LOSS_ALLOCATION",
          input.allocationDate, amountMinor, preview.periodName,
          `${isProfit ? "Profit" : "Loss"} allocation for ${preview.periodName}`,
          `Agreed sharing: ${line.sharingBps / 100}%`, journalTransactionId, createdAt,
        );
        this.database.prepare(`
          INSERT INTO partner_profit_allocations (
            id, partner_id, period_id, allocation_date, sharing_bps,
            amount_minor, transaction_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), line.partnerId, preview.periodId, input.allocationDate,
          line.sharingBps, line.amountMinor, id, createdAt);
        writeAuditLog(this.database, "Operator", "partner_profit_allocation_posted",
          "partner_transaction", id, `Allocation for ${preview.periodName}`, createdAt);
        createdIds.push(id);
      }
    });
    write.immediate();
    return createdIds.map((id) => mapTransaction(this.transactionRow(id)));
  }

  statement(input: PartnerStatementInput): PartnerStatement {
    this.partnerRow(input.partnerId);
    const opening = this.accountBalances(input.partnerId, input.from > "0000-01-01" ? this.previousDate(input.from) : undefined);
    const closing = this.accountBalances(input.partnerId, input.to);
    const rows = this.transactionRows(input.from, input.to, input.partnerId).reverse();
    const running: AccountBalances = { ...opening };
    const totals = {
      contributionsMinor: 0,
      loanDisbursementsMinor: 0,
      loanRepaymentsMinor: 0,
      profitAllocatedMinor: 0,
      lossAllocatedMinor: 0,
      profitDistributedMinor: 0,
      withdrawalsMinor: 0,
      settlementsMinor: 0,
    };
    const lines = rows.map((row) => {
      const accountCode = ACCOUNT_BY_TYPE[row.transaction_type];
      const journalLine = this.database.prepare(`
        SELECT debit_minor, credit_minor FROM ledger_postings
        WHERE transaction_id = ? AND account_code = ? AND partner_id = ?
      `).get(row.journal_transaction_id, accountCode, input.partnerId) as {
        debit_minor: number; credit_minor: number;
      } | undefined;
      const debitMinor = journalLine?.debit_minor ?? 0;
      const creditMinor = journalLine?.credit_minor ?? 0;
      const balanceKey: keyof AccountBalances = accountCode === "3200"
        ? "capital"
        : accountCode === "2210" ? "loan" : "distributableProfit";
      running[balanceKey] += creditMinor - debitMinor;
      const netAmount = signedTransactionAmount(row);
      switch (row.transaction_type) {
        case "CAPITAL_CONTRIBUTION": totals.contributionsMinor += netAmount; break;
        case "LOAN_DISBURSEMENT": totals.loanDisbursementsMinor += netAmount; break;
        case "LOAN_REPAYMENT": totals.loanRepaymentsMinor += netAmount; break;
        case "PROFIT_ALLOCATION": totals.profitAllocatedMinor += netAmount; break;
        case "LOSS_ALLOCATION": totals.lossAllocatedMinor += netAmount; break;
        case "PROFIT_DISTRIBUTION": totals.profitDistributedMinor += netAmount; break;
        case "PARTNER_WITHDRAWAL": totals.withdrawalsMinor += netAmount; break;
        case "CAPITAL_SETTLEMENT": totals.settlementsMinor += netAmount; break;
      }
      return {
        transaction: mapTransaction(row),
        accountCode,
        debitMinor,
        creditMinor,
        balanceMinor: running[balanceKey],
      };
    });
    return {
      partnerId: input.partnerId,
      from: input.from,
      to: input.to,
      openingCapitalMinor: opening.capital,
      closingCapitalMinor: closing.capital,
      openingLoanMinor: opening.loan,
      closingLoanMinor: closing.loan,
      openingDistributableProfitMinor: opening.distributableProfit,
      closingDistributableProfitMinor: closing.distributableProfit,
      lines,
      totals,
    };
  }

  reverse(input: PartnerTransactionReversalInput): PartnerTransaction {
    const original = this.transactionRow(input.id);
    if (original.reversal_of_transaction_id) {
      throw new FabricServiceError("CONFLICT", "A reversal entry cannot be reversed directly.");
    }
    const hasReversal = this.database.prepare(
      "SELECT id FROM partner_transactions WHERE reversal_of_transaction_id = ?",
    ).get(input.id);
    if (hasReversal) throw new FabricServiceError("CONFLICT", "This partner transaction has already been reversed.");
    const originalLines = this.database.prepare(`
      SELECT account_code, partner_id, debit_minor, credit_minor
      FROM ledger_postings WHERE transaction_id = ?
    `).all(original.journal_transaction_id) as Array<{
      account_code: string; partner_id: string | null; debit_minor: number; credit_minor: number;
    }>;
    for (const line of originalLines) {
      const reverseDebit = line.credit_minor;
      if (reverseDebit <= 0) continue;
      if (line.partner_id && this.accountBalance(line.partner_id, line.account_code, input.date) < reverseDebit) {
        throw new FabricServiceError("CONFLICT", "The reversal would make a partner capital, loan, or distributable balance negative.");
      }
      const accountType = this.database.prepare(
        "SELECT account_type FROM ledger_accounts WHERE code = ?",
      ).get(line.account_code) as { account_type: string } | undefined;
      if (
        accountType?.account_type === "asset"
        && this.assetAccountBalance(line.account_code, input.date) < reverseDebit
      ) {
        throw new FabricServiceError("CONFLICT", "The reversal would make the cash or bank account balance negative.");
      }
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const reverse = this.database.transaction(() => {
      postJournal(this.database, "partner_reversal", `REV-${original.reference || original.id}`,
        `${input.date}T12:00:00.000Z`, originalLines.map((line) => ({
          accountCode: line.account_code,
          debitMinor: line.credit_minor,
          creditMinor: line.debit_minor,
          ...(line.partner_id ? { partnerId: line.partner_id } : {}),
        })), "Operator", id, original.journal_transaction_id, input.reason);
      const journalId = this.journalIdForSource("partner_reversal", id);
      this.database.prepare(`
        INSERT INTO partner_transactions (
          id, request_id, partner_id, transaction_type, transaction_date, amount_minor,
          payment_method, payment_account_code, reference, description,
          supporting_notes, status, journal_transaction_id, reversal_of_transaction_id,
          reversal_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'JOURNAL', NULL, ?, ?, ?, 'POSTED', ?, ?, ?, ?)
      `).run(
        id, `reversal:${original.id}`, original.partner_id, original.transaction_type, input.date, original.amount_minor,
        `REV-${original.reference || original.id}`, `Reversal: ${original.description}`,
        input.reason, journalId, original.id, input.reason, createdAt,
      );
      writeAuditLog(this.database, "Operator", "partner_transaction_reversed", "partner_transaction",
        original.id, input.reason, createdAt);
    });
    reverse.immediate();
    return mapTransaction(this.transactionRow(id));
  }

  private insertAgreement(id: string, input: PartnerInput, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO partner_agreements (
        id, partner_id, effective_from, ownership_bps, profit_sharing_bps, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), id, input.agreementStartDate, input.ownershipBps,
      input.profitSharingBps, input.agreementNotes, createdAt);
  }

  private partnerRow(id: string): PartnerRow {
    const row = this.database.prepare("SELECT * FROM business_partners WHERE id = ?").get(id) as PartnerRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Partner not found.");
    return row;
  }

  private transactionRows(
    from?: string,
    to?: string,
    partnerId?: string,
    limit?: number,
    offset = 0,
  ): PartnerTransactionRow[] {
    return this.database.prepare(`
      SELECT t.id, t.partner_id, p.code AS partner_code, p.full_name AS partner_name,
        t.transaction_type, t.transaction_date, t.amount_minor, t.payment_method,
        t.payment_account_code, a.name AS payment_account_name, t.reference,
        t.description, t.supporting_notes,
        CASE WHEN EXISTS (
          SELECT 1 FROM partner_transactions reversal
          WHERE reversal.reversal_of_transaction_id = t.id
        ) THEN 'REVERSED' ELSE t.status END AS status,
        t.journal_transaction_id, t.reversal_of_transaction_id, t.reversal_reason, t.created_at
      FROM partner_transactions t
      JOIN business_partners p ON p.id = t.partner_id
      LEFT JOIN ledger_accounts a ON a.code = t.payment_account_code
      WHERE (? IS NULL OR t.transaction_date >= ?)
        AND (? IS NULL OR t.transaction_date <= ?)
        AND (? IS NULL OR t.partner_id = ?)
      ORDER BY t.transaction_date DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(from ?? null, from ?? null, to ?? null, to ?? null,
      partnerId ?? null, partnerId ?? null, limit ?? -1, offset) as PartnerTransactionRow[];
  }

  private transactionRow(id: string): PartnerTransactionRow {
    const row = this.database.prepare(`
      SELECT t.id, t.partner_id, p.code AS partner_code, p.full_name AS partner_name,
        t.transaction_type, t.transaction_date, t.amount_minor, t.payment_method,
        t.payment_account_code, a.name AS payment_account_name, t.reference,
        t.description, t.supporting_notes,
        CASE WHEN EXISTS (
          SELECT 1 FROM partner_transactions reversal
          WHERE reversal.reversal_of_transaction_id = t.id
        ) THEN 'REVERSED' ELSE t.status END AS status,
        t.journal_transaction_id, t.reversal_of_transaction_id, t.reversal_reason, t.created_at
      FROM partner_transactions t
      JOIN business_partners p ON p.id = t.partner_id
      LEFT JOIN ledger_accounts a ON a.code = t.payment_account_code
      WHERE t.id = ?
    `).get(id) as PartnerTransactionRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Partner transaction not found.");
    return row;
  }

  private balanceRows(asOf?: string, partnerId?: string): PartnerBalance[] {
    const rows = this.database.prepare(`
      SELECT p.id, p.code, p.full_name, p.partner_type, p.investment_structure,
        COALESCE(SUM(CASE WHEN lp.account_code = '3200' THEN lp.credit_minor - lp.debit_minor ELSE 0 END), 0) AS capital_minor,
        COALESCE(SUM(CASE WHEN lp.account_code = '2210' THEN lp.credit_minor - lp.debit_minor ELSE 0 END), 0) AS loan_minor,
        COALESCE(SUM(CASE WHEN lp.account_code = '2220' THEN lp.credit_minor - lp.debit_minor ELSE 0 END), 0) AS distributable_minor
      FROM business_partners p
      LEFT JOIN ledger_postings lp ON lp.partner_id = p.id
        AND lp.account_code IN ('3200', '2210', '2220')
      LEFT JOIN ledger_transactions lt ON lt.id = lp.transaction_id
        AND (? IS NULL OR substr(lt.created_at, 1, 10) <= ?)
      WHERE (? IS NULL OR p.id = ?)
        AND (lp.id IS NULL OR lt.id IS NOT NULL)
      GROUP BY p.id ORDER BY p.full_name COLLATE NOCASE
    `).all(asOf ?? null, asOf ?? null, partnerId ?? null, partnerId ?? null) as Array<{
      id: string; code: string; full_name: string; partner_type: "PARTNER" | "INVESTOR";
      investment_structure: "EQUITY" | "LOAN" | null; capital_minor: number; loan_minor: number; distributable_minor: number;
    }>;
    return rows.map((row) => ({
      partnerId: row.id,
      code: row.code,
      fullName: row.full_name,
      partnerType: row.partner_type,
      investmentStructure: row.investment_structure ?? "EQUITY",
      capitalBalanceMinor: asSafeAmount(row.capital_minor, "Partner capital balance"),
      loanBalanceMinor: asSafeAmount(row.loan_minor, "Partner loan balance"),
      distributableProfitMinor: asSafeAmount(row.distributable_minor, "Partner distributable balance"),
    }));
  }

  private accountBalances(partnerId: string, asOf?: string): AccountBalances {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN p.account_code = '3200' THEN p.credit_minor - p.debit_minor ELSE 0 END), 0) AS capital,
        COALESCE(SUM(CASE WHEN p.account_code = '2210' THEN p.credit_minor - p.debit_minor ELSE 0 END), 0) AS loan,
        COALESCE(SUM(CASE WHEN p.account_code = '2220' THEN p.credit_minor - p.debit_minor ELSE 0 END), 0) AS profit
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.partner_id = ? AND p.account_code IN ('3200', '2210', '2220')
        AND (? IS NULL OR substr(t.created_at, 1, 10) <= ?)
    `).get(partnerId, asOf ?? null, asOf ?? null) as { capital: number; loan: number; profit: number };
    return {
      capital: asSafeAmount(row.capital, "Partner capital balance"),
      loan: asSafeAmount(row.loan, "Partner loan balance"),
      distributableProfit: asSafeAmount(row.profit, "Partner distributable balance"),
    };
  }

  private accountBalance(partnerId: string, accountCode: string, asOf?: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(p.credit_minor - p.debit_minor), 0) AS balance_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.partner_id = ? AND p.account_code = ?
        AND (? IS NULL OR substr(t.created_at, 1, 10) <= ?)
    `).get(partnerId, accountCode, asOf ?? null, asOf ?? null) as { balance_minor: number };
    return asSafeAmount(row.balance_minor, "Partner balance");
  }

  private assetAccountBalance(accountCode: string, asOf?: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = ?
        AND (? IS NULL OR substr(t.created_at, 1, 10) <= ?)
    `).get(accountCode, asOf ?? null, asOf ?? null) as { balance_minor: number };
    return asSafeAmount(row.balance_minor, "Cash or bank balance");
  }

  private journalIdForSource(transactionType: string, sourceId: string): string {
    const row = this.database.prepare(`
      SELECT id FROM ledger_transactions WHERE source_key = ?
    `).get(`${transactionType}:${sourceId}`) as { id: string } | undefined;
    if (!row) throw new Error("The partner journal entry was not created.");
    return row.id;
  }

  private previousDate(date: string): string {
    return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
      ? new Date(new Date(`${date}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
      : date;
  }

}
