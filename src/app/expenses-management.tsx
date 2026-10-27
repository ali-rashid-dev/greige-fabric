"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import type { IpcResult } from "@/shared/contracts";
import type {
  AccountingPeriod,
  Expense,
  ExpenseCategory,
  ExpenseReport,
  GeneralLedger,
  PaymentAccount,
} from "@/shared/types";

type ExpenseView = "add" | "history" | "cashbook" | "bankbook" | "daily" | "report";

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatMoney(minor: number): string {
  return `${businessConfig.currency} ${new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium" }).format(new Date(`${date}T12:00:00`));
}

const views: Array<{ key: ExpenseView; label: string }> = [
  { key: "add", label: "Add expense" },
  { key: "history", label: "Expense history" },
  { key: "cashbook", label: "Cashbook" },
  { key: "bankbook", label: "Bankbook" },
  { key: "daily", label: "Daily cash summary" },
  { key: "report", label: "Expense report" },
];

function resultData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export default function ExpensesManagement() {
  const today = localDate();
  const [view, setView] = useState<ExpenseView>("add");
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [report, setReport] = useState<ExpenseReport | null>(null);
  const [cashbook, setCashbook] = useState<GeneralLedger | null>(null);
  const [bankbook, setBankbook] = useState<GeneralLedger | null>(null);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [expenseDate, setExpenseDate] = useState(today);
  const [range, setRange] = useState({ from: today, to: today });
  const [rangeInput, setRangeInput] = useState({ from: today, to: today });
  const [dailyDate, setDailyDate] = useState(today);
  const [categoryCode, setCategoryCode] = useState("");
  const [paymentAccountCode, setPaymentAccountCode] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryCode, setNewCategoryCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadData = useCallback(async () => {
    const [categoryResult, accountResult, expenseResult, reportResult, cashResult, bankResult, periodResult] =
      await Promise.all([
        getDesktopApi().expenses.categories(),
        getDesktopApi().customers.paymentAccounts(),
        getDesktopApi().expenses.list(range),
        getDesktopApi().expenses.report(range),
        getDesktopApi().accounting.generalLedger({ accountCode: "1000", from: range.from, to: range.to }),
        getDesktopApi().accounting.generalLedger({ accountCode: "1010", from: range.from, to: range.to }),
        getDesktopApi().accounting.periods(),
      ]);
    const categoryData = resultData(categoryResult);
    const accountData = resultData(accountResult);
    setCategories(categoryData);
    setAccounts(accountData);
    setExpenses(resultData(expenseResult));
    setReport(resultData(reportResult));
    setCashbook(resultData(cashResult));
    setBankbook(resultData(bankResult));
    setPeriods(resultData(periodResult));
    setCategoryCode((current) => current || categoryData[0]?.code || "");
    setPaymentAccountCode((current) => current || accountData[0]?.code || "");
  }, [range]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadData()
      .then(() => {
        if (active) setError("");
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load expense and cashbook data.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadData]);

  const selectedPeriod = useMemo(
    () => periods.find((period) => period.startsOn <= expenseDate && period.endsOn >= expenseDate),
    [periods, expenseDate],
  );
  async function saveExpense(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await getDesktopApi().expenses.record({
        categoryCode,
        paymentAccountCode,
        amount: Number(amount),
        expenseDate,
        description,
      });
      if (!result.ok) throw new Error(result.error.message);
      await loadData();
      setAmount("");
      setDescription("");
      setNotice(`${result.data.expenseNumber} recorded and posted.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to record this expense.");
    } finally {
      setSaving(false);
    }
  }

  async function addCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().expenses.addCategory({
        code: newCategoryCode,
        name: newCategoryName,
      });
      if (!result.ok) throw new Error(result.error.message);
      setNewCategoryCode("");
      setNewCategoryName("");
      await loadData();
      setCategoryCode(result.data.code);
      setNotice(`Expense category “${result.data.name}” added.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to add this expense category.");
    } finally {
      setSaving(false);
    }
  }

  const displayedLedger = view === "cashbook" ? cashbook : view === "bankbook" ? bankbook : null;
  const cashIn = (cashbook?.lines ?? []).reduce((sum, line) => sum + line.debitMinor, 0);
  const cashOut = (cashbook?.lines ?? []).reduce((sum, line) => sum + line.creditMinor, 0);
  return (
    <div className="expenses-page">
      <div className="panel-toolbar expense-tabs" role="tablist" aria-label="Expense and cashbook pages">
        {views.map((item) => (
          <button
            key={item.key}
            className={view === item.key ? "secondary-button active-tab" : "secondary-button"}
            role="tab"
            aria-selected={view === item.key}
            onClick={() => {
              setView(item.key);
              if (item.key === "daily") {
                const dailyRange = { from: dailyDate, to: dailyDate };
                setRange(dailyRange);
              } else if (view === "daily") {
                setRange(rangeInput);
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {view !== "add" && (
        <form className="panel-toolbar expense-range" onSubmit={(event) => {
          event.preventDefault();
          const nextRange = view === "daily" ? { from: dailyDate, to: dailyDate } : rangeInput;
          setRangeInput(nextRange);
          setRange(nextRange);
        }}>
          {view === "daily" ? (
            <label>Date <input type="date" value={dailyDate} onChange={(event) => setDailyDate(event.target.value)} /></label>
          ) : (
            <>
              <label>From <input type="date" value={rangeInput.from} onChange={(event) => setRangeInput({ ...rangeInput, from: event.target.value })} /></label>
              <label>To <input type="date" value={rangeInput.to} onChange={(event) => setRangeInput({ ...rangeInput, to: event.target.value })} /></label>
            </>
          )}
          <button className="secondary-button" type="submit">Apply dates</button>
        </form>
      )}

      {view === "add" && (
        <div className="expense-entry-grid">
          <section className="panel">
            <header className="panel-heading"><div><h2>Add expense</h2><p>Expense and payment account post together as a balanced journal entry.</p></div></header>
            {selectedPeriod?.status === "closed" && <div className="error-banner" role="alert">The accounting period for this date is closed.</div>}
            <form className="expense-form" onSubmit={(event) => void saveExpense(event)}>
              <label>Category
                <select required value={categoryCode} onChange={(event) => setCategoryCode(event.target.value)}>
                  {categories.map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
                </select>
              </label>
              <label>Payment account
                <select required value={paymentAccountCode} onChange={(event) => setPaymentAccountCode(event.target.value)}>
                  {accounts.map((account) => <option key={account.code} value={account.code}>{account.name} ({account.code})</option>)}
                </select>
              </label>
              <label>Amount
                <span className="input-prefix"><span>PKR</span><input required type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="2,000.00" /></span>
              </label>
              <label>Date <input required type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} /></label>
              <label className="expense-description">Description
                <input required maxLength={240} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the expense" />
              </label>
              <button className="primary-button" type="submit" disabled={saving || loading || selectedPeriod?.status === "closed" || !categories.length || !accounts.length}>
                {saving ? "Posting…" : "Record expense"}
              </button>
            </form>
          </section>
          <section className="panel">
            <header className="panel-heading"><div><h2>Other configurable costs</h2><p>New categories receive a dedicated expense ledger account.</p></div></header>
            <form className="expense-form category-form" onSubmit={(event) => void addCategory(event)}>
              <label>Category name <input required maxLength={120} value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="Repairs and maintenance" /></label>
              <label>Category code <input required maxLength={40} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" value={newCategoryCode} onChange={(event) => setNewCategoryCode(event.target.value)} placeholder="repairs" /></label>
              <button className="secondary-button" type="submit" disabled={saving}>Add category</button>
            </form>
            <div className="expense-category-list">
              {categories.map((category) => <div key={category.code}><span>{category.name}</span><small>{category.accountCode} · {category.accountName}</small></div>)}
            </div>
          </section>
        </div>
      )}

      {view === "history" && (
        <section className="panel">
          <header className="panel-heading"><div><h2>Expense history</h2><p>{loading ? "Loading…" : `${expenses.filter((expense) => !expense.isReversed).length} active expenses · ${formatMoney(expenses.reduce((sum, expense) => sum + (expense.isReversed ? 0 : expense.amountMinor), 0))}`}</p></div></header>
          <div className="table-scroll"><table><thead><tr><th>Date</th><th>Expense</th><th>Category</th><th>Payment account</th><th className="numeric">Amount</th></tr></thead>
            <tbody>{expenses.map((expense) => <tr key={expense.id}><td>{formatDate(expense.expenseDate)}</td><td><strong>{expense.expenseNumber}{expense.isReversed ? " · Reversed" : ""}</strong><small>{expense.description}</small></td><td>{expense.categoryName}</td><td>{expense.paymentAccountName}</td><td className="numeric">{formatMoney(expense.amountMinor)}</td></tr>)}</tbody>
          </table>{!loading && expenses.length === 0 && <p className="empty-state">No expenses in this date range.</p>}</div>
        </section>
      )}

      {(view === "cashbook" || view === "bankbook") && displayedLedger && (
        <section className="panel">
          <header className="panel-heading"><div><h2>{view === "cashbook" ? "Cashbook" : "Bankbook"}</h2><p>{displayedLedger.account.name} · opening balance {formatMoney(displayedLedger.openingBalanceMinor)}</p></div></header>
          <div className="summary-grid"><SummaryCard label="Money in" value={formatMoney(displayedLedger.lines.reduce((sum, line) => sum + line.debitMinor, 0))} /><SummaryCard label="Money out" value={formatMoney(displayedLedger.lines.reduce((sum, line) => sum + line.creditMinor, 0))} /><SummaryCard label="Closing balance" value={formatMoney(displayedLedger.closingBalanceMinor)} /></div>
          <div className="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th className="numeric">In</th><th className="numeric">Out</th><th className="numeric">Balance</th></tr></thead>
            <tbody>{displayedLedger.lines.map((line, index) => <tr key={`${line.transactionId}-${index}`}><td>{formatDate(line.createdAt.slice(0, 10))}</td><td>{line.transactionType.replaceAll("_", " ")}</td><td>{line.reference}</td><td className="numeric">{line.debitMinor ? formatMoney(line.debitMinor) : "—"}</td><td className="numeric">{line.creditMinor ? formatMoney(line.creditMinor) : "—"}</td><td className="numeric">{formatMoney(line.balanceMinor)}</td></tr>)}</tbody>
          </table>{!loading && displayedLedger.lines.length === 0 && <p className="empty-state">No postings in this date range.</p>}</div>
        </section>
      )}

      {view === "daily" && (
        <section className="panel">
          <header className="panel-heading"><div><h2>Daily cash summary</h2><p>{formatDate(range.from)} · ledger-sourced cash and bank movements</p></div></header>
          <div className="summary-grid">
            <SummaryCard label="Cash received" value={formatMoney(cashIn)} />
            <SummaryCard label="Cash paid" value={formatMoney(cashOut)} />
            <SummaryCard label="Cash closing balance" value={formatMoney(cashbook?.closingBalanceMinor ?? 0)} />
            <SummaryCard label="Bank closing balance" value={formatMoney(bankbook?.closingBalanceMinor ?? 0)} />
          </div>
          <div className="daily-summary-note">All inflows and outflows are derived from posted journal lines. Cash paid includes expenses, supplier payments and other cash postings.</div>
        </section>
      )}

      {view === "report" && report && (
        <section className="panel">
          <header className="panel-heading"><div><h2>Expense report by category</h2><p>{formatDate(report.from)} – {formatDate(report.to)}</p></div><strong>{formatMoney(report.totalMinor)}</strong></header>
          <div className="table-scroll"><table><thead><tr><th>Category</th><th>Expense account</th><th className="numeric">Entries</th><th className="numeric">Total</th></tr></thead>
            <tbody>{report.categories.map((category) => <tr key={category.categoryCode}><td>{category.categoryName}</td><td>{category.accountCode}</td><td className="numeric">{category.expenseCount}</td><td className="numeric">{formatMoney(category.amountMinor)}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <article className="summary-card"><span>{label}</span><strong>{value}</strong></article>;
}
