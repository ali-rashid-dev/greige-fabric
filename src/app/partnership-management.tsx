"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useForm } from "react-hook-form";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import {
  partnerInputSchema,
  partnerTransactionInputSchema,
} from "@/shared/contracts";
import type {
  AccountingPeriod,
  BusinessPartner,
  PartnerAllocationPreview,
  PartnerBalance,
  PartnerDetails,
  PartnerStatement,
  PartnerTransaction,
  PartnerTransactionType,
  PartnershipDashboard,
  PaymentAccount,
} from "@/shared/types";
import PrintActions from "./print-actions";

type View = "overview" | "partners" | "transactions" | "allocation" | "statements";
type PartnerForm = {
  id?: string;
  code: string;
  fullName: string;
  partnerType: "PARTNER" | "INVESTOR";
  investmentStructure: "EQUITY" | "LOAN";
  phone: string;
  email: string;
  address: string;
  joiningDate: string;
  ownershipPercent: string;
  profitPercent: string;
  agreementStartDate: string;
  agreementNotes: string;
  active: boolean;
  internalNotes: string;
};

type TransactionForm = {
  partnerId: string;
  transactionType: PartnerTransactionType;
  transactionDate: string;
  amount: string;
  paymentMethod: "CASH" | "BANK_TRANSFER" | "OTHER";
  paymentAccountCode: string;
  reference: string;
  description: string;
  supportingNotes: string;
};

const EMPTY_PARTNER_FORM: PartnerForm = {
  code: "",
  fullName: "",
  partnerType: "PARTNER",
  investmentStructure: "EQUITY",
  phone: "",
  email: "",
  address: "",
  joiningDate: localDate(),
  ownershipPercent: "0",
  profitPercent: "0",
  agreementStartDate: localDate(),
  agreementNotes: "",
  active: true,
  internalNotes: "",
};

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthStart(): string {
  return `${localDate().slice(0, 7)}-01`;
}

function formatMoney(minor: number): string {
  return `${businessConfig.currency} ${new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" })
    .format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

function percent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-PK", { maximumFractionDigits: 2 })}%`;
}

function transactionLabel(type: PartnerTransactionType): string {
  return type.replaceAll("_", " ").toLocaleLowerCase().replace(/(^| )\w/g, (letter) => letter.toUpperCase());
}

function resultData<T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function partnerFormFrom(partner: BusinessPartner): PartnerForm {
  return {
    id: partner.id,
    code: partner.code,
    fullName: partner.fullName,
    partnerType: partner.partnerType,
    investmentStructure: partner.investmentStructure,
    phone: partner.phone,
    email: partner.email,
    address: partner.address,
    joiningDate: partner.joiningDate,
    ownershipPercent: String(partner.ownershipBps / 100),
    profitPercent: String(partner.profitSharingBps / 100),
    agreementStartDate: partner.agreementStartDate,
    agreementNotes: partner.agreementNotes,
    active: partner.active,
    internalNotes: partner.internalNotes,
  };
}

function exportStatement(statement: PartnerStatement, name: string): void {
  const rows = [
    ["Partner", name],
    ["Period", statement.from, statement.to],
    ["Opening capital (PKR)", (statement.openingCapitalMinor / 100).toFixed(2)],
    ["Closing capital (PKR)", (statement.closingCapitalMinor / 100).toFixed(2)],
    ["Opening loan balance (PKR)", (statement.openingLoanMinor / 100).toFixed(2)],
    ["Closing loan balance (PKR)", (statement.closingLoanMinor / 100).toFixed(2)],
    ["Opening distributable profit (PKR)", (statement.openingDistributableProfitMinor / 100).toFixed(2)],
    ["Closing distributable profit (PKR)", (statement.closingDistributableProfitMinor / 100).toFixed(2)],
    [],
    ["Date", "Transaction", "Description", "Journal entry", "Balance account", "Debit (PKR)", "Credit (PKR)", "Running balance (PKR)"],
    ...statement.lines.map((line) => [
      line.transaction.transactionDate,
      transactionLabel(line.transaction.transactionType),
      line.transaction.description,
      line.transaction.journalTransactionId,
      line.accountCode === "3200" ? "Partner capital" : line.accountCode === "2210" ? "Partner loan" : "Profit payable",
      (line.debitMinor / 100).toFixed(2),
      (line.creditMinor / 100).toFixed(2),
      (line.balanceMinor / 100).toFixed(2),
    ]),
  ];
  const csv = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-statement.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function SummaryCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return <article className="summary-card"><span className="summary-icon">₨</span><div><p>{label}</p><strong>{value}</strong>{note && <small>{note}</small>}</div></article>;
}

export default function PartnershipManagement() {
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState({ from: monthStart(), to: localDate() });
  const [rangeInput, setRangeInput] = useState(range);
  const [dashboard, setDashboard] = useState<PartnershipDashboard | null>(null);
  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  const [availablePartners, setAvailablePartners] = useState<BusinessPartner[]>([]);
  const [totalPartners, setTotalPartners] = useState(0);
  const [historyTransactions, setHistoryTransactions] = useState<PartnerTransaction[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [profile, setProfile] = useState<PartnerDetails | null>(null);
  const [statementPartnerId, setStatementPartnerId] = useState("");
  const [statement, setStatement] = useState<PartnerStatement | null>(null);
  const [statementRangeInput, setStatementRangeInput] = useState({ from: monthStart(), to: localDate() });
  const [statementRange, setStatementRange] = useState(statementRangeInput);
  const [allocationPeriodId, setAllocationPeriodId] = useState("");
  const [allocationDate, setAllocationDate] = useState(localDate());
  const [allocationPreview, setAllocationPreview] = useState<PartnerAllocationPreview | null>(null);
  const [partnerForm, setPartnerForm] = useState<PartnerForm | null>(null);
  const [transactionFormOpen, setTransactionFormOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("active");
  const [partnerType, setPartnerType] = useState<"all" | "PARTNER" | "INVESTOR">("all");
  const [sortBy, setSortBy] = useState<"name" | "code" | "joiningDate">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const partnerFormMethods = useForm<PartnerForm>({ defaultValues: EMPTY_PARTNER_FORM, mode: "onBlur" });
  const transactionFormMethods = useForm<TransactionForm>({
    defaultValues: {
      partnerId: "",
      transactionType: "CAPITAL_CONTRIBUTION",
      transactionDate: localDate(),
      amount: "",
      paymentMethod: "CASH",
      paymentAccountCode: "",
      reference: "",
      description: "",
      supportingNotes: "",
    },
    mode: "onBlur",
  });
  const {
    register: registerPartner,
    handleSubmit: handlePartnerSubmit,
    reset: resetPartner,
  } = partnerFormMethods;
  const {
    register: registerTransaction,
    handleSubmit: handleTransactionSubmit,
    getValues: getTransactionValues,
    setValue: setTransactionValue,
    watch: watchTransaction,
  } = transactionFormMethods;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const transactionRequestId = useRef("");

  const transaction = watchTransaction();
  const currentPartner = useMemo(
    () => availablePartners.find((partner) => partner.id === transaction.partnerId),
    [availablePartners, transaction.partnerId],
  );
  const transactionOptions: PartnerTransactionType[] = currentPartner?.investmentStructure === "LOAN"
    ? ["LOAN_DISBURSEMENT", "LOAN_REPAYMENT", "PROFIT_DISTRIBUTION"]
    : ["CAPITAL_CONTRIBUTION", "PARTNER_WITHDRAWAL", "PROFIT_DISTRIBUTION", "CAPITAL_SETTLEMENT"];

  const loadData = useCallback(async () => {
    const [dashboardResult, listResult, allPartnersResult, paymentAccountsResult, periodsResult] = await Promise.all([
      getDesktopApi().partners.dashboard(range),
      getDesktopApi().partners.list({
        query, status, partnerType, sortBy, sortDirection, page, pageSize,
      }),
      getDesktopApi().partners.list({
        query: "", status: "all", partnerType: "all", sortBy: "name",
        sortDirection: "asc", page: 1, pageSize: 100,
      }),
      getDesktopApi().partners.paymentAccounts(),
      getDesktopApi().accounting.periods(),
    ]);
    setDashboard(resultData(dashboardResult));
    const list = resultData(listResult);
    setPartners(list.partners);
    setTotalPartners(list.total);
    setAvailablePartners(resultData(allPartnersResult).partners);
    const paymentAccounts = resultData(paymentAccountsResult);
    setAccounts(paymentAccounts);
    setPeriods(resultData(periodsResult));
    const allPartners = resultData(allPartnersResult).partners;
    if (!getTransactionValues("partnerId")) {
      setTransactionValue("partnerId", allPartners.find((partner) => partner.active)?.id || "");
    }
    if (!getTransactionValues("paymentAccountCode") && paymentAccounts[0]) {
      setTransactionValue("paymentAccountCode", paymentAccounts[0].code);
    }
    setAllocationPeriodId((current) => current || resultData(periodsResult).find((period) => period.status === "closed")?.id || "");
  }, [getTransactionValues, page, pageSize, partnerType, query, range, setTransactionValue, sortBy, sortDirection, status]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadData()
      .then(() => { if (active) setError(""); })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load partnership records.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadData]);

  useEffect(() => {
    if (view !== "transactions") return;
    let active = true;
    void getDesktopApi().partners.transactions({
      ...range,
      page: historyPage,
      pageSize: 25,
    }).then((result) => {
      if (!active) return;
      const data = resultData(result);
      setHistoryTransactions(data.transactions);
      setHistoryTotal(data.total);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load transaction history.");
    });
    return () => { active = false; };
  }, [historyPage, range, view]);

  useEffect(() => {
    if (!profile) return;
    void getDesktopApi().partners.get({ id: profile.partner.id })
      .then((result) => setProfile(resultData(result)))
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Unable to load partner details."));
  }, [partners, profile?.partner.id]);

  useEffect(() => {
    if (view !== "statements" || !statementPartnerId) {
      setStatement(null);
      return;
    }
    let active = true;
    setStatement(null);
    void getDesktopApi().partners.statement({
      partnerId: statementPartnerId,
      ...statementRange,
    }).then((result) => {
      if (active) setStatement(resultData(result));
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load the partner statement.");
    });
    return () => { active = false; };
  }, [statementPartnerId, statementRange, view]);

  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rangeInput.from > rangeInput.to) {
      setError("The end date must be on or after the start date.");
      return;
    }
    setError("");
    setHistoryPage(1);
    setRange(rangeInput);
  }

  async function savePartner(values: PartnerForm) {
    if (!partnerForm) return;
    setSaving(true);
    setError("");
    try {
      const parsed = partnerInputSchema.safeParse({
        id: values.id,
        code: values.code,
        fullName: values.fullName,
        partnerType: values.partnerType,
        investmentStructure: values.investmentStructure,
        phone: values.phone,
        email: values.email,
        address: values.address,
        joiningDate: values.joiningDate,
        ownershipBps: Number(values.ownershipPercent) * 100,
        profitSharingBps: Number(values.profitPercent) * 100,
        agreementStartDate: values.agreementStartDate,
        agreementNotes: values.agreementNotes,
        active: values.active,
        internalNotes: values.internalNotes,
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the partner details.");
      const saved = resultData(await getDesktopApi().partners.save(parsed.data));
      setPartnerForm(null);
      setProfile(resultData(await getDesktopApi().partners.get({ id: saved.id })));
      setNotice(`${saved.fullName} saved.`);
      await loadData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this partner.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePartner(partner: BusinessPartner) {
    setSaving(true);
    setError("");
    try {
      const saved = resultData(await getDesktopApi().partners.setActive({ id: partner.id, active: !partner.active }));
      setNotice(`${saved.fullName} ${saved.active ? "reactivated" : "deactivated"}.`);
      await loadData();
      if (profile?.partner.id === partner.id) setProfile(resultData(await getDesktopApi().partners.get({ id: partner.id })));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Unable to update partner status.");
    } finally {
      setSaving(false);
    }
  }

  async function reverseTransaction(item: PartnerTransaction) {
    if (item.status !== "POSTED" || item.reversalOfTransactionId) return;
    const reason = window.prompt(`Why are you reversing ${transactionLabel(item.transactionType).toLocaleLowerCase()} ${item.reference || item.id.slice(0, 8)}?`);
    if (!reason?.trim()) return;
    const date = window.prompt("Reversal posting date (YYYY-MM-DD)", localDate());
    if (!date) return;
    if (!window.confirm(`Post a reversing journal for ${item.description}? The original transaction will remain in the audit history.`)) return;
    setSaving(true);
    setError("");
    try {
      const reversed = resultData(await getDesktopApi().partners.reverse({
        id: item.id,
        date,
        reason: reason.trim(),
      }));
      setNotice(`Reversal posted. Journal entry ${reversed.journalTransactionId}.`);
      await loadData();
      const history = resultData(await getDesktopApi().partners.transactions({
        ...range, page: historyPage, pageSize: 25,
      }));
      setHistoryTransactions(history.transactions);
      setHistoryTotal(history.total);
      if (profile?.partner.id === item.partnerId) {
        setProfile(resultData(await getDesktopApi().partners.get({ id: item.partnerId })));
      }
      if (statementPartnerId === item.partnerId && view === "statements") {
        setStatement(resultData(await getDesktopApi().partners.statement({
          partnerId: item.partnerId, ...statementRange,
        })));
      }
    } catch (reversalError) {
      setError(reversalError instanceof Error ? reversalError.message : "Unable to reverse this transaction.");
    } finally {
      setSaving(false);
    }
  }

  async function postTransaction(values: TransactionForm) {
    setSaving(true);
    setError("");
    try {
      const parsed = partnerTransactionInputSchema.safeParse({
        ...values,
        submissionId: transactionRequestId.current || (transactionRequestId.current = crypto.randomUUID()),
        amount: Number(values.amount),
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the transaction details.");
      const partner = availablePartners.find((item) => item.id === parsed.data.partnerId);
      const label = transactionLabel(parsed.data.transactionType);
      if (!window.confirm(`Post ${label.toLocaleLowerCase()} of ${formatMoney(Math.round(parsed.data.amount * 100))} for ${partner?.fullName ?? "this partner"}? This creates an immutable accounting journal entry.`)) return;
      const posted = resultData(await getDesktopApi().partners.postTransaction(parsed.data));
      transactionRequestId.current = "";
      setTransactionValue("amount", "");
      setTransactionValue("reference", "");
      setTransactionValue("description", "");
      setTransactionValue("supportingNotes", "");
      setNotice(`${label} posted. Journal entry ${posted.journalTransactionId}.`);
      setTransactionFormOpen(false);
      await loadData();
      if (profile?.partner.id === posted.partnerId) setProfile(resultData(await getDesktopApi().partners.get({ id: posted.partnerId })));
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Unable to post this partner transaction.");
    } finally {
      setSaving(false);
    }
  }

  async function previewAllocation() {
    if (!allocationPeriodId) {
      setError("Select an accounting period first.");
      return;
    }
    setError("");
    try {
      setAllocationPreview(resultData(await getDesktopApi().partners.allocationPreview({ periodId: allocationPeriodId })));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Unable to calculate the allocation preview.");
    }
  }

  async function postAllocation() {
    if (!allocationPreview?.isEligibleToPost) return;
    if (!window.confirm(`Post ${formatMoney(Math.abs(allocationPreview.finalizedNetProfitMinor ?? 0))} of ${allocationPreview.finalizedNetProfitMinor !== null && allocationPreview.finalizedNetProfitMinor < 0 ? "loss" : "profit"} allocations for ${allocationPreview.periodName}? This cannot be edited or deleted.`)) return;
    setSaving(true);
    setError("");
    try {
      const posted = resultData(await getDesktopApi().partners.postAllocation({
        periodId: allocationPreview.periodId,
        allocationDate,
        confirmed: true,
      }));
      setNotice(`${posted.length} partner allocation${posted.length === 1 ? "" : "s"} posted.`);
      setAllocationPreview(null);
      await loadData();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Unable to post these allocations.");
    } finally {
      setSaving(false);
    }
  }

  async function openProfile(partner: BusinessPartner) {
    setError("");
    try {
      setProfile(resultData(await getDesktopApi().partners.get({ id: partner.id })));
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : "Unable to open the partner profile.");
    }
  }

  const nav: Array<{ key: View; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "partners", label: "Partners & investors" },
    { key: "transactions", label: "Contributions & loans" },
    { key: "allocation", label: "Profit / loss allocation" },
    { key: "statements", label: "Statements" },
  ];

  return (
    <div className="partnership-page">
      <nav className="expense-tabs" aria-label="Partnership sections">
        {nav.map((item) => (
          <button key={item.key} className={view === item.key ? "active-tab" : ""} type="button" onClick={() => setView(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {loading && <p className="table-state" role="status">Loading partnership records…</p>}

      {view === "overview" && (
        <>
          <form className="expense-range" onSubmit={applyRange}>
            <label>From <input type="date" value={rangeInput.from} onChange={(event) => setRangeInput({ ...rangeInput, from: event.target.value })} /></label>
            <label>To <input type="date" value={rangeInput.to} onChange={(event) => setRangeInput({ ...rangeInput, to: event.target.value })} /></label>
            <button className="secondary-button" type="submit">Apply dates</button>
          </form>
          <div className="summary-grid partnership-summary">
            <SummaryCard label="Active partners" value={String(dashboard?.activePartners ?? 0)} />
            <SummaryCard label="Active investors" value={String(dashboard?.activeInvestors ?? 0)} />
            <SummaryCard label="Capital contributed" value={formatMoney(dashboard?.capitalContributedMinor ?? 0)} note="Equity contributions only" />
            <SummaryCard label="Outstanding partner loans" value={formatMoney(dashboard?.outstandingPartnerLoansMinor ?? 0)} note="Liability balance as of end date" />
            <SummaryCard label="Profit allocated" value={formatMoney(dashboard?.profitAllocatedMinor ?? 0)} note="Not a cash payment" />
            <SummaryCard label="Profit distributed" value={formatMoney(dashboard?.profitDistributedMinor ?? 0)} note="Cash paid against distributable balance" />
            <SummaryCard label="Partner withdrawals" value={formatMoney(dashboard?.partnerWithdrawalsMinor ?? 0)} note="Drawings; not business expenses" />
            <SummaryCard label="Partner capital balances" value={formatMoney(dashboard?.partnerCapitalBalancesMinor ?? 0)} note="Equity subledger balance as of end date" />
          </div>
          <div className="partnership-columns">
            <section className="panel">
              <header className="panel-heading"><div><h2>Capital contribution trend</h2><p>Equity contributions by month · loan funding excluded</p></div></header>
              <div className="partnership-bars">
                {(dashboard?.contributionTrends ?? []).map((item) => {
                  const peak = Math.max(1, ...(dashboard?.contributionTrends ?? []).map((trend) => trend.amountMinor));
                  return <div key={item.month}><span>{item.month}</span><div className="partnership-bar-track"><i style={{ width: `${Math.max(3, item.amountMinor / peak * 100)}%` }} /></div><strong>{formatMoney(item.amountMinor)}</strong></div>;
                })}
                {!loading && !dashboard?.contributionTrends.length && <p className="empty-state">No capital contributions in this date range.</p>}
              </div>
            </section>
            <section className="panel">
              <header className="panel-heading"><div><h2>Profit distribution summary</h2><p>Allocation remains distinct from cash distributions</p></div></header>
              <div className="table-wrap">
                <table><thead><tr><th>Partner</th><th className="numeric">Allocated</th><th className="numeric">Distributed</th></tr></thead>
                  <tbody>{dashboard?.profitSummary.map((item) => <tr key={item.partnerName}><td>{item.partnerName}</td><td className="numeric">{formatMoney(item.allocatedMinor)}</td><td className="numeric">{formatMoney(item.distributedMinor)}</td></tr>)}</tbody>
                </table>
                {!loading && !dashboard?.profitSummary.length && <p className="empty-state">No partner profit activity yet.</p>}
              </div>
            </section>
          </div>
          <section className="panel">
            <header className="panel-heading"><div><h2>Partner balances</h2><p>Equity capital, loan liabilities, and distributable profits shown separately</p></div></header>
            <BalanceTable balances={dashboard?.balances ?? []} onOpen={(id) => {
              const found = availablePartners.find((partner) => partner.id === id);
              if (found) void openProfile(found);
              setView("partners");
            }} />
          </section>
          <section className="panel">
            <header className="panel-heading"><div><h2>Recent partner transactions</h2><p>Posted financial activity for {range.from} – {range.to}</p></div></header>
            <TransactionTable transactions={dashboard?.recentTransactions ?? []} onReverse={(item) => void reverseTransaction(item)} />
          </section>
        </>
      )}

      {view === "partners" && (
        <>
          <section className="panel">
            <header className="panel-heading">
              <div><h2>{profile ? profile.partner.fullName : "Partners & investors"}</h2><p>{profile ? `${profile.partner.code} · ${profile.partner.partnerType} · ${profile.partner.active ? "Active" : "Inactive"}` : `${totalPartners} records · deactivation preserves history`}</p></div>
              <div className="topbar-actions">
                {profile && <button className="secondary-button" type="button" onClick={() => { setProfile(null); setPartnerForm(null); }}>All partners</button>}
                {!profile && <button className="primary-button" type="button" onClick={() => {
                  resetPartner({ ...EMPTY_PARTNER_FORM, joiningDate: localDate(), agreementStartDate: localDate() });
                  setPartnerForm({ ...EMPTY_PARTNER_FORM, joiningDate: localDate(), agreementStartDate: localDate() });
                }}>+ Add partner</button>}
              </div>
            </header>
            {profile ? (
              <div className="partner-profile">
                <div className="partner-profile-grid">
                  <p><span>Type</span><strong>{profile.partner.partnerType} · {profile.partner.investmentStructure}</strong></p>
                  <p><span>Phone / email</span><strong>{profile.partner.phone || "—"} · {profile.partner.email || "—"}</strong></p>
                  <p><span>Joining date</span><strong>{formatDate(profile.partner.joiningDate)}</strong></p>
                  <p><span>Agreement effective date</span><strong>{formatDate(profile.partner.agreementStartDate)}</strong></p>
                  <p><span>Ownership / profit share</span><strong>{percent(profile.partner.ownershipBps)} / {percent(profile.partner.profitSharingBps)}</strong></p>
                  <p><span>Capital balance</span><strong>{formatMoney(profile.balance.capitalBalanceMinor)}</strong></p>
                  <p><span>Loan payable</span><strong>{formatMoney(profile.balance.loanBalanceMinor)}</strong></p>
                  <p><span>Distributable profit</span><strong>{formatMoney(profile.balance.distributableProfitMinor)}</strong></p>
                  <p><span>Address</span><strong>{profile.partner.address || "—"}</strong></p>
                  <p className="profile-notes"><span>Agreement notes</span><strong>{profile.partner.agreementNotes || "—"}</strong></p>
                  <p className="profile-notes"><span>Internal notes</span><strong>{profile.partner.internalNotes || "—"}</strong></p>
                  <p className="profile-notes"><span>Created / updated</span><strong>{formatDateTime(profile.partner.createdAt)} · {formatDateTime(profile.partner.updatedAt)}</strong></p>
                </div>
                <div className="panel-toolbar">
                  <button className="secondary-button" type="button" onClick={() => {
                    const values = partnerFormFrom(profile.partner);
                    resetPartner(values);
                    setPartnerForm(values);
                  }}>Edit details</button>
                  <button className="secondary-button" type="button" onClick={() => {
                    setStatementPartnerId(profile.partner.id);
                    setView("statements");
                  }}>Open statement</button>
                  <button className={profile.partner.active ? "danger-button" : "secondary-button"} type="button" disabled={saving} onClick={() => void togglePartner(profile.partner)}>
                    {profile.partner.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
                <header className="panel-heading"><div><h3>Transaction history</h3><p>Each row is linked to an immutable journal entry</p></div></header>
                <TransactionTable transactions={profile.transactions} onReverse={(item) => void reverseTransaction(item)} />
              </div>
            ) : (
              <>
                <div className="panel-toolbar partner-list-toolbar">
                  <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search partners" placeholder="Search name, code, phone, or email" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
                  <select aria-label="Filter partner status" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All statuses</option></select>
                  <select aria-label="Filter partner type" value={partnerType} onChange={(event) => { setPartnerType(event.target.value as typeof partnerType); setPage(1); }}><option value="all">All types</option><option value="PARTNER">Partners</option><option value="INVESTOR">Investors</option></select>
                  <select aria-label="Sort partners" value={`${sortBy}:${sortDirection}`} onChange={(event) => { const [field, direction] = event.target.value.split(":"); setSortBy(field as typeof sortBy); setSortDirection(direction as typeof sortDirection); }}><option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option><option value="code:asc">Code A–Z</option><option value="joiningDate:desc">Newest first</option><option value="joiningDate:asc">Oldest first</option></select>
                </div>
                <div className="table-wrap"><table><thead><tr><th>Partner</th><th>Type / structure</th><th>Phone</th><th>Joined</th><th>Share</th><th>Status</th><th /></tr></thead>
                  <tbody>{partners.map((partner) => <tr key={partner.id}>
                    <td><button className="fabric-link" type="button" onClick={() => void openProfile(partner)}><strong>{partner.fullName}</strong><span>{partner.code}</span></button></td>
                    <td>{partner.partnerType} · {partner.investmentStructure}</td><td>{partner.phone || "—"}</td><td>{formatDate(partner.joiningDate)}</td><td>{percent(partner.profitSharingBps)}</td>
                    <td><span className={`partner-status ${partner.active ? "active" : ""}`}>{partner.active ? "Active" : "Inactive"}</span></td>
                    <td><button className="table-action" type="button" onClick={() => void openProfile(partner)}>View</button></td>
                  </tr>)}</tbody>
                </table>{!loading && !partners.length && <p className="empty-state">No partners match these filters. Add a partner or change the search.</p>}</div>
                <div className="partner-pagination"><span>{totalPartners ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalPartners)} of ${totalPartners}` : "0 partners"}</span><button className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="secondary-button" type="button" disabled={page * pageSize >= totalPartners} onClick={() => setPage((value) => value + 1)}>Next</button></div>
              </>
            )}
          </section>
          {partnerForm && (
            <section className="panel partner-form-panel">
              <header className="panel-heading"><div><h2>{partnerForm.id ? "Edit partner" : "Add partner or investor"}</h2><p>Agreement terms are retained as effective-dated history.</p></div></header>
              <form className="fabric-form" onSubmit={handlePartnerSubmit((values) => void savePartner(values))}>
                <div className="form-grid">
                  <Field label="Partner code"><input required maxLength={40} {...registerPartner("code")} /></Field>
                  <Field label="Full name"><input required maxLength={160} {...registerPartner("fullName")} /></Field>
                  <Field label="Partner type"><select {...registerPartner("partnerType")}><option value="PARTNER">Partner</option><option value="INVESTOR">Investor</option></select></Field>
                  <Field label="Investment structure"><select {...registerPartner("investmentStructure")}><option value="EQUITY">Equity</option><option value="LOAN">Loan</option></select></Field>
                  <Field label="Phone"><input maxLength={40} {...registerPartner("phone")} /></Field>
                  <Field label="Email"><input type="email" maxLength={160} {...registerPartner("email")} /></Field>
                  <Field label="Joining date"><input required type="date" {...registerPartner("joiningDate")} /></Field>
                  <Field label="Agreement start date"><input required type="date" {...registerPartner("agreementStartDate")} /></Field>
                  <Field label="Ownership percentage"><input required type="number" min="0" max="100" step="0.01" {...registerPartner("ownershipPercent")} /></Field>
                  <Field label="Profit / loss sharing percentage"><input required type="number" min="0" max="100" step="0.01" {...registerPartner("profitPercent")} /></Field>
                  <Field label="Address"><input maxLength={500} {...registerPartner("address")} /></Field>
                  <Field label="Agreement notes"><input maxLength={2000} {...registerPartner("agreementNotes")} /></Field>
                  <Field label="Internal notes"><input maxLength={4000} {...registerPartner("internalNotes")} /></Field>
                </div>
                <label className="partner-checkbox"><input type="checkbox" {...registerPartner("active")} /> Active</label>
                <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPartnerForm(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save partner"}</button></div>
              </form>
            </section>
          )}
        </>
      )}

      {view === "transactions" && (
        <section className="panel">
          <header className="panel-heading"><div><h2>Capital, loans, withdrawals & distributions</h2><p>Every posting moves cash/bank and a partner ledger balance in one database transaction.</p></div><button className="primary-button" type="button" onClick={() => setTransactionFormOpen((open) => !open)}>+ Record transaction</button></header>
          {transactionFormOpen && (
            <form className="expense-form partner-transaction-form" onSubmit={handleTransactionSubmit((values) => void postTransaction(values))}>
              <label>Partner<select required {...registerTransaction("partnerId", { onChange: (event) => {
                const partner = availablePartners.find((item) => item.id === event.target.value);
                setTransactionValue("transactionType", partner?.investmentStructure === "LOAN" ? "LOAN_DISBURSEMENT" : "CAPITAL_CONTRIBUTION");
              } })}>{availablePartners.filter((partner) => partner.active).map((partner) => <option key={partner.id} value={partner.id}>{partner.code} · {partner.fullName}</option>)}</select></label>
              <label>Transaction type<select required {...registerTransaction("transactionType")}>{transactionOptions.map((type) => <option key={type} value={type}>{transactionLabel(type)}</option>)}</select></label>
              <label>Date<input required type="date" {...registerTransaction("transactionDate")} /></label>
              <label>Amount (PKR)<input required type="number" min="0.01" max="1000000000" step="0.01" {...registerTransaction("amount")} /></label>
              <label>Payment method<select {...registerTransaction("paymentMethod", { onChange: (event) => {
                const paymentMethod = event.target.value as TransactionForm["paymentMethod"];
                const expected = paymentMethod === "CASH" ? "1000" : paymentMethod === "BANK_TRANSFER" ? "1010" : getTransactionValues("paymentAccountCode");
                const nextAccount = accounts.find((account) => account.code === expected);
                if (nextAccount) setTransactionValue("paymentAccountCode", nextAccount.code);
              } })}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other payment account</option></select></label>
              <label>Cash / bank account<select required {...registerTransaction("paymentAccountCode")}>{accounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label>
              <label>Reference<input maxLength={120} {...registerTransaction("reference")} /></label>
              <label>Description<input required maxLength={240} {...registerTransaction("description")} /></label>
              <label className="partner-transaction-notes">Supporting notes<input maxLength={2000} {...registerTransaction("supportingNotes")} /></label>
              <p className="form-footnote">Withdrawals are partner drawings, not business expenses. Loan repayments reduce the loan liability and never reduce equity capital.</p>
              <button className="primary-button" type="submit" disabled={saving || loading || !availablePartners.some((partner) => partner.active) || !accounts.length}>{saving ? "Posting…" : "Confirm and post"}</button>
            </form>
          )}
          <div className="panel-toolbar">
            <label>From <input type="date" value={rangeInput.from} onChange={(event) => setRangeInput({ ...rangeInput, from: event.target.value })} /></label>
            <label>To <input type="date" value={rangeInput.to} onChange={(event) => setRangeInput({ ...rangeInput, to: event.target.value })} /></label>
            <button className="secondary-button" type="button" onClick={() => {
              if (rangeInput.from <= rangeInput.to) {
                setHistoryPage(1);
                setRange(rangeInput);
              }
              else setError("The end date must be on or after the start date.");
            }}>Apply dates</button>
          </div>
          <TransactionTable transactions={historyTransactions} onReverse={(item) => void reverseTransaction(item)} />
          {!historyTransactions.length && <p className="empty-state">No partner transactions in this date range.</p>}
          <div className="partner-pagination"><span>{historyTotal ? `${(historyPage - 1) * 25 + 1}–${Math.min(historyPage * 25, historyTotal)} of ${historyTotal}` : "0 transactions"}</span><button className="secondary-button" type="button" disabled={historyPage <= 1} onClick={() => setHistoryPage((value) => value - 1)}>Previous</button><button className="secondary-button" type="button" disabled={historyPage * 25 >= historyTotal} onClick={() => setHistoryPage((value) => value + 1)}>Next</button></div>
        </section>
      )}

      {view === "allocation" && (
        <section className="panel">
          <header className="panel-heading"><div><h2>Profit / loss allocation</h2><p>Finalized P&amp;L comes from posted ledger income and expenses, never sales revenue alone.</p></div></header>
          <div className="partner-allocation-controls">
            <label>Closed accounting period<select value={allocationPeriodId} onChange={(event) => { setAllocationPeriodId(event.target.value); setAllocationPreview(null); }}><option value="">Select a period</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.status}</option>)}</select></label>
            <label>Allocation posting date<input type="date" value={allocationDate} onChange={(event) => setAllocationDate(event.target.value)} /></label>
            <button className="secondary-button" type="button" disabled={!allocationPeriodId} onClick={() => void previewAllocation()}>Calculate preview</button>
          </div>
          <div className="daily-summary-note">Allocations are permitted only after the accounting period is closed and the active applicable sharing terms total exactly 100%. Posting changes the retained-earnings, partner-equity, or partner-distribution-payable ledger balances; it does not pay cash.</div>
          {allocationPreview && (
            <>
              <div className="summary-grid partnership-allocation-summary"><SummaryCard label="Accounting period" value={allocationPreview.periodName} /><SummaryCard label="Finalized net profit / loss" value={allocationPreview.finalizedNetProfitMinor === null ? "Not finalized" : formatMoney(allocationPreview.finalizedNetProfitMinor)} /><SummaryCard label="Applicable sharing" value={percent(allocationPreview.totalSharingBps)} /><SummaryCard label="Status" value={allocationPreview.status.toLocaleUpperCase()} /></div>
              {allocationPreview.reason && <div className="error-banner" role="status">{allocationPreview.reason}</div>}
              <div className="table-wrap"><table><thead><tr><th>Partner</th><th className="numeric">Agreed share</th><th className="numeric">Allocation</th></tr></thead><tbody>
                {allocationPreview.allocations.map((line) => <tr key={line.partnerId}><td>{line.partnerCode} · {line.partnerName}</td><td className="numeric">{percent(line.sharingBps)}</td><td className="numeric">{formatMoney(line.amountMinor)}</td></tr>)}
              </tbody></table></div>
              <div className="panel-toolbar"><span>Amounts are calculated from the closed period and cannot be changed in the renderer.</span><button className="primary-button" type="button" disabled={!allocationPreview.isEligibleToPost || saving} onClick={() => void postAllocation()}>{saving ? "Posting…" : "Confirm and post allocations"}</button></div>
            </>
          )}
        </section>
      )}

      {view === "statements" && (
        <section className="panel statement-printable">
          <header className="panel-heading no-print"><div><h2>Partner financial statement</h2><p>Capital, loan, and distributable profit are shown as separate balances.</p></div></header>
          <form className="partner-statement-controls no-print" onSubmit={(event) => {
            event.preventDefault();
            if (statementRangeInput.from > statementRangeInput.to) setError("The end date must be on or after the start date.");
            else { setError(""); setStatementRange(statementRangeInput); }
          }}>
            <label>Partner<select required value={statementPartnerId} onChange={(event) => setStatementPartnerId(event.target.value)}><option value="">Select partner</option>{profile && !availablePartners.some((partner) => partner.id === profile.partner.id) && <option value={profile.partner.id}>{profile.partner.code} · {profile.partner.fullName}</option>}{availablePartners.map((partner) => <option key={partner.id} value={partner.id}>{partner.code} · {partner.fullName}</option>)}</select></label>
            <label>From<input required type="date" value={statementRangeInput.from} onChange={(event) => setStatementRangeInput({ ...statementRangeInput, from: event.target.value })} /></label>
            <label>To<input required type="date" value={statementRangeInput.to} onChange={(event) => setStatementRangeInput({ ...statementRangeInput, to: event.target.value })} /></label>
            <button className="secondary-button" type="submit">Apply dates</button>
            {statement && <><button className="secondary-button" type="button" onClick={() => exportStatement(statement, partners.find((item) => item.id === statement.partnerId)?.fullName ?? "partner")}>Export CSV</button><PrintActions label="Print statement" /></>}
          </form>
          {statement && (
            <>
              <div className="partner-statement-heading"><strong>{businessConfig.name}</strong><h2>{availablePartners.find((item) => item.id === statement.partnerId)?.fullName ?? profile?.partner.fullName} · Financial statement</h2><span>{statement.from} – {statement.to}</span></div>
              <div className="summary-grid partnership-statement-summary">
                <SummaryCard label="Opening capital" value={formatMoney(statement.openingCapitalMinor)} />
                <SummaryCard label="Closing capital" value={formatMoney(statement.closingCapitalMinor)} />
                <SummaryCard label="Opening loan balance" value={formatMoney(statement.openingLoanMinor)} />
                <SummaryCard label="Closing loan balance" value={formatMoney(statement.closingLoanMinor)} />
                <SummaryCard label="Opening distributable profit" value={formatMoney(statement.openingDistributableProfitMinor)} />
                <SummaryCard label="Closing distributable profit" value={formatMoney(statement.closingDistributableProfitMinor)} />
              </div>
              <div className="table-wrap"><table><thead><tr><th>Date</th><th>Transaction</th><th>Description / reference</th><th>Journal</th><th>Balance account</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Balance</th></tr></thead><tbody>
                {statement.lines.map((line) => <tr key={line.transaction.id}><td>{formatDate(line.transaction.transactionDate)}</td><td>{transactionLabel(line.transaction.transactionType)}</td><td>{line.transaction.description}<small>{line.transaction.reference}</small></td><td>{line.transaction.journalTransactionId.slice(0, 10)}</td><td>{line.accountCode === "3200" ? "Partner capital" : line.accountCode === "2210" ? "Partner loan" : "Profit payable"}</td><td className="numeric">{line.debitMinor ? formatMoney(line.debitMinor) : "—"}</td><td className="numeric">{line.creditMinor ? formatMoney(line.creditMinor) : "—"}</td><td className="numeric">{formatMoney(line.balanceMinor)}</td></tr>)}
              </tbody></table>{statement.lines.length === 0 && <p className="empty-state">No transactions in this statement period.</p>}</div>
              <div className="partner-statement-totals">
                <span>Contributions <strong>{formatMoney(statement.totals.contributionsMinor)}</strong></span>
                <span>Loan disbursements <strong>{formatMoney(statement.totals.loanDisbursementsMinor)}</strong></span>
                <span>Loan repayments <strong>{formatMoney(statement.totals.loanRepaymentsMinor)}</strong></span>
                <span>Profit allocated <strong>{formatMoney(statement.totals.profitAllocatedMinor)}</strong></span>
                <span>Loss allocated <strong>{formatMoney(statement.totals.lossAllocatedMinor)}</strong></span>
                <span>Distributions <strong>{formatMoney(statement.totals.profitDistributedMinor)}</strong></span>
                <span>Withdrawals <strong>{formatMoney(statement.totals.withdrawalsMinor)}</strong></span>
                <span>Settlements <strong>{formatMoney(statement.totals.settlementsMinor)}</strong></span>
              </div>
            </>
          )}
          {!statement && statementPartnerId && <p className="empty-state">Loading statement…</p>}
        </section>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}

function BalanceTable({ balances, onOpen }: { balances: PartnerBalance[]; onOpen: (id: string) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>Partner</th><th>Type</th><th className="numeric">Capital</th><th className="numeric">Loan liability</th><th className="numeric">Distributable profit</th></tr></thead><tbody>
    {balances.map((item) => <tr key={item.partnerId}><td><button type="button" className="table-action" onClick={() => onOpen(item.partnerId)}>{item.code} · {item.fullName}</button></td><td>{item.partnerType} · {item.investmentStructure}</td><td className="numeric">{formatMoney(item.capitalBalanceMinor)}</td><td className="numeric">{formatMoney(item.loanBalanceMinor)}</td><td className="numeric">{formatMoney(item.distributableProfitMinor)}</td></tr>)}
  </tbody></table>{!balances.length && <p className="empty-state">No partner balances yet.</p>}</div>;
}

function TransactionTable({
  transactions,
  onReverse,
}: {
  transactions: PartnerTransaction[];
  onReverse?: (transaction: PartnerTransaction) => void;
}) {
  return <div className="table-wrap"><table><thead><tr><th>Date</th><th>Partner</th><th>Type / description</th><th>Payment account</th><th>Reference / journal</th><th className="numeric">Amount</th><th>Status</th>{onReverse && <th />}</tr></thead><tbody>
    {transactions.map((transaction) => <tr key={transaction.id}><td>{formatDate(transaction.transactionDate)}</td><td>{transaction.partnerCode} · {transaction.partnerName}</td><td>{transactionLabel(transaction.transactionType)}{transaction.reversalOfTransactionId ? " · Reversal" : ""}<small>{transaction.description}</small></td><td>{transaction.paymentAccountName ?? "Journal allocation"}</td><td>{transaction.reference || "—"}<small>{transaction.journalTransactionId.slice(0, 10)}</small></td><td className="numeric">{formatMoney(transaction.amountMinor)}</td><td><span className={`partner-status ${transaction.status === "POSTED" ? "active" : ""}`}>{transaction.status}</span></td>{onReverse && <td>{transaction.status === "POSTED" && !transaction.reversalOfTransactionId && <button className="table-action" type="button" onClick={() => onReverse(transaction)}>Reverse</button>}</td>}</tr>)}
  </tbody></table>{!transactions.length && <p className="empty-state">No transactions to display.</p>}</div>;
}
