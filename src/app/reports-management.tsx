"use client";

import { useState } from "react";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import type { AnalyticsReportInput } from "@/shared/contracts";
import type { AnalyticsReport, AnalyticsReportType, ChartOfAccount } from "@/shared/types";

const reportOptions: Array<{ value: AnalyticsReportType; label: string }> = [
  { value: "daily_sales", label: "Daily sales" },
  { value: "purchases", label: "Purchases" },
  { value: "stock_summary", label: "Stock summary and valuation" },
  { value: "gross_profit", label: "Gross profit" },
  { value: "profit_loss", label: "Profit and loss" },
  { value: "customer_balances", label: "Customer balances" },
  { value: "supplier_balances", label: "Supplier balances" },
  { value: "trial_balance", label: "Trial balance" },
  { value: "cashbook", label: "Cashbook" },
  { value: "general_ledger", label: "General ledger" },
];

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function formatMoney(minor: number): string {
  return `${businessConfig.currency} ${new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`;
}

function formatQuantity(value: number, key: string): string {
  return new Intl.NumberFormat("en-PK", {
    maximumFractionDigits: key.includes("meters") ? 3 : 0,
  }).format(value);
}

function escapeCsv(value: string, text: boolean): string {
  const safeValue = text && /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll("\"", "\"\"")}"`;
}

function totalLabels(reportType: AnalyticsReportType): Array<{ key: string; label: string }> {
  switch (reportType) {
    case "daily_sales": return [
      { key: "grossSalesMinor", label: "Gross sales" },
      { key: "returnsMinor", label: "Returns" },
      { key: "netSalesMinor", label: "Net sales" },
      { key: "balanceMinor", label: "Credit at sale" },
    ];
    case "purchases": return [
      { key: "quantityMeters", label: "Purchased quantity (m)" },
      { key: "purchaseCostMinor", label: "Purchase cost" },
      { key: "dueMinor", label: "Purchase balance" },
    ];
    case "stock_summary": return [
      { key: "quantityMeters", label: "Available (m)" },
      { key: "stockValueMinor", label: "Stock valuation" },
    ];
    case "gross_profit": return [
      { key: "revenueMinor", label: "Net sales" },
      { key: "costOfGoodsSoldMinor", label: "Cost of goods sold" },
      { key: "grossProfitMinor", label: "Gross profit" },
    ];
    case "profit_loss": return [
      { key: "revenueMinor", label: "Revenue" },
      { key: "costOfGoodsSoldMinor", label: "Cost of goods sold" },
      { key: "operatingExpensesMinor", label: "Operating expenses" },
      { key: "netProfitMinor", label: "Net profit" },
    ];
    case "customer_balances": return [
      { key: "receivableMinor", label: "Accounts receivable" },
      { key: "overdueMinor", label: "Overdue" },
    ];
    case "supplier_balances": return [{ key: "payableMinor", label: "Accounts payable" }];
    case "trial_balance": return [
      { key: "debitMinor", label: "Total debits" },
      { key: "creditMinor", label: "Total credits" },
    ];
    case "cashbook":
    case "general_ledger": return [
      { key: "openingBalanceMinor", label: "Opening balance" },
      { key: "debitMinor", label: "Debits" },
      { key: "creditMinor", label: "Credits" },
      { key: "closingBalanceMinor", label: "Closing balance" },
    ];
  }
}

export default function ReportsManagement() {
  const today = localDate();
  const [reportType, setReportType] = useState<AnalyticsReportType>("daily_sales");
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [accountCode, setAccountCode] = useState("1000");
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loadedInput, setLoadedInput] = useState<Omit<AnalyticsReportInput, "page"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  async function loadAccounts(): Promise<ChartOfAccount[]> {
    if (accounts.length > 0) return accounts;
    const result = await getDesktopApi().accounting.accounts();
    if (!result.ok) throw new Error(result.error.message);
    setAccounts(result.data);
    return result.data;
  }

  async function runReport(event?: React.FormEvent<HTMLFormElement>, requestedPage = 1) {
    event?.preventDefault();
    const isFreshRequest = event !== undefined;
    setLoading(true);
    setError("");
    try {
      let parameters = loadedInput;
      if (isFreshRequest) {
        let selectedAccount = accountCode;
        if (reportType === "general_ledger") {
          const chart = await loadAccounts();
          if (!chart.some((account) => account.code === selectedAccount)) {
            selectedAccount = chart[0]?.code ?? "";
            setAccountCode(selectedAccount);
          }
        }
        parameters = {
          reportType,
          from,
          to,
          search,
          pageSize,
          ownerPin,
          ...(reportType === "general_ledger" ? { accountCode: selectedAccount } : {}),
        };
      }
      if (!parameters) return;
      const input: AnalyticsReportInput = {
        ...parameters,
        page: requestedPage,
      };
      const result = await getDesktopApi().reports.run(input);
      if (!result.ok) throw new Error(result.error.message);
      setReport(result.data);
      if (isFreshRequest) setLoadedInput(parameters);
      setPage(requestedPage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to generate this report.");
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    if (!report || !loadedInput) return;
    setExporting(true);
    setError("");
    try {
      const firstPage = await getDesktopApi().reports.run({
        ...loadedInput,
        page: 1,
        pageSize: 500,
      });
      if (!firstPage.ok) throw new Error(firstPage.error.message);
      const rows = [...firstPage.data.rows];
      const pages = Math.ceil(firstPage.data.totalRows / 500);
      for (let exportPage = 2; exportPage <= pages; exportPage += 1) {
        const result = await getDesktopApi().reports.run({
          ...loadedInput,
          page: exportPage,
          pageSize: 500,
        });
        if (!result.ok) throw new Error(result.error.message);
        rows.push(...result.data.rows);
      }
      const content = [
        report.columns.map((column) => escapeCsv(column.label, true)).join(","),
        ...rows.map((row) =>
          report.columns.map((column) => {
            const value = row[column.key] ?? "";
            const formatted = column.format === "money" && typeof value === "number"
              ? (value / 100).toFixed(2)
              : String(value);
            return escapeCsv(formatted, column.format === "text");
          }).join(","),
        ),
      ].join("\r\n");
      const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${report.reportType}-${report.from}-${report.to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Unable to export this report.");
    } finally {
      setExporting(false);
    }
  }

  const pageCount = report ? Math.max(1, Math.ceil(report.totalRows / report.pageSize)) : 1;
  const canRun = ownerPin.length >= 6 && from <= to && !loading;

  return (
    <div className="reports-page">
      <section className="panel report-access-panel">
        <header className="panel-heading">
          <div><h2>Owner-only financial reports</h2><p>Financial report access is verified with the owner PIN for every request.</p></div>
        </header>
        <form className="report-filters" onSubmit={(event) => void runReport(event)}>
          <label>Report
            <select value={reportType} onChange={(event) => {
              const next = reportOptions.find((option) => option.value === event.target.value);
              if (next) {
                setReportType(next.value);
                setReport(null);
                setLoadedInput(null);
                setPage(1);
              }
            }}>
              {reportOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>From <input type="date" required value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To <input type="date" required value={to} onChange={(event) => setTo(event.target.value)} /></label>
          {reportType === "general_ledger" && (
            <label>Account
              <select value={accountCode} onFocus={() => void loadAccounts().catch((loadError: unknown) => {
                setError(loadError instanceof Error ? loadError.message : "Unable to load ledger accounts.");
              })} onChange={(event) => setAccountCode(event.target.value)}>
                {accounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
              </select>
            </label>
          )}
          <label>Search <input value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} placeholder="Filter report rows" /></label>
          <label>Rows per page
            <select value={pageSize} onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}>
              {[25, 50, 100, 250, 500].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label>Owner PIN <input required type="password" inputMode="numeric" minLength={6} maxLength={64} value={ownerPin} onChange={(event) => setOwnerPin(event.target.value)} /></label>
          <button className="primary-button" disabled={!canRun}>{loading ? "Generating…" : "Run report"}</button>
        </form>
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>

      {report && (
        <>
          {reportType === "daily_sales" && <p className="report-note">Returns are shown as zero because sales returns are not yet recorded in this application.</p>}
          {reportType === "stock_summary" && <p className="report-note">Stock quantity and valuation show the current inventory snapshot. The ledger reconciliation uses the current date.</p>}
          <div className="summary-grid report-summary-grid">
            {totalLabels(report.reportType).map(({ key, label }) => {
              const value = report.totals[key] ?? 0;
              return <article className="summary-card" key={key}>
                <span>{label}</span>
                <strong>{key.toLowerCase().includes("minor") ? formatMoney(value) : formatQuantity(value, key)}</strong>
              </article>;
            })}
          </div>
          {report.reconciliations.length > 0 && (
            <section className="panel report-reconciliation">
              <h3>Reconciliation checks · as of {report.reportType === "stock_summary" ? today : report.to}</h3>
              {report.reconciliations.map((check) => (
                <div className="report-reconciliation-row" key={check.name}>
                  <strong>{check.name}</strong>
                  <span>Subledger / valuation {formatMoney(check.expectedMinor)}</span>
                  <span>Control account {formatMoney(check.actualMinor)}</span>
                  <b className={check.isBalanced ? "reconciliation-balanced" : "reconciliation-unbalanced"}>
                    {check.isBalanced ? "Balanced" : `Difference ${formatMoney(check.differenceMinor)}`}
                  </b>
                </div>
              ))}
            </section>
          )}
          <section className="panel report-table-panel">
            <header className="panel-heading">
              <div><h2>{reportOptions.find((option) => option.value === report.reportType)?.label}</h2><p>{report.from} – {report.to} · {report.totalRows} matching rows</p></div>
              <button className="secondary-button" onClick={() => void exportCsv()} disabled={report.rows.length === 0 || exporting}>
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            </header>
            <div className="table-scroll">
              <table>
                <thead><tr>{report.columns.map((column) => <th key={column.key} className={column.format === "money" || column.format === "number" ? "numeric" : ""}>{column.label}</th>)}</tr></thead>
                <tbody>
                  {report.rows.map((row, rowIndex) => (
                    <tr key={`${report.reportType}-${rowIndex}`}>
                      {report.columns.map((column) => {
                        const value = row[column.key] ?? "";
                        return <td className={column.format === "money" || column.format === "number" ? "numeric" : ""} key={column.key}>
                          {column.format === "money" && typeof value === "number"
                            ? formatMoney(value)
                            : column.format === "number" && typeof value === "number"
                              ? formatQuantity(value, column.key)
                              : String(value)}
                        </td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.rows.length === 0 && <p className="empty-state">No rows match these filters.</p>}
            </div>
            <footer className="report-pagination">
              <span>Page {report.page} of {pageCount}</span>
              <div>
                <button className="secondary-button" disabled={loading || page <= 1} onClick={() => void runReport(undefined, page - 1)}>Previous</button>
                <button className="secondary-button" disabled={loading || page >= pageCount} onClick={() => void runReport(undefined, page + 1)}>Next</button>
              </div>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
