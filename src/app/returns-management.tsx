"use client";

import { useMemo, useState } from "react";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import type { IpcResult } from "@/shared/contracts";
import type { PaymentAccount, ReturnData, ReturnRecord } from "@/shared/types";

type ReturnKind = "sales" | "purchases";
type Result<T> = IpcResult<T>;

function resultData<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function formatMoney(minor: number): string {
  return `${businessConfig.currency} ${new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`;
}

export default function ReturnsManagement() {
  const [data, setData] = useState<ReturnData | null>(null);
  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([]);
  const [kind, setKind] = useState<ReturnKind>("sales");
  const [invoiceId, setInvoiceId] = useState("");
  const [purchaseId, setPurchaseId] = useState("");
  const [salesQuantities, setSalesQuantities] = useState<Record<string, string>>({});
  const [saleable, setSaleable] = useState<Record<string, boolean>>({});
  const [purchaseQuantities, setPurchaseQuantities] = useState<Record<string, string>>({});
  const [salesSettlement, setSalesSettlement] = useState<"refund" | "customer_credit">("refund");
  const [purchaseSettlement, setPurchaseSettlement] = useState<"supplier_credit" | "refund">("supplier_credit");
  const [paymentAccountCode, setPaymentAccountCode] = useState("");
  const [reason, setReason] = useState("");
  const [reversing, setReversing] = useState<ReturnRecord | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedInvoice = useMemo(
    () => data?.sales.find((source) => source.invoiceId === invoiceId),
    [data, invoiceId],
  );
  const selectedPurchase = useMemo(
    () => data?.purchases.find((source) => source.purchaseId === purchaseId),
    [data, purchaseId],
  );

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [returnsResult, accountsResult] = await Promise.all([
        getDesktopApi().returns.data(),
        getDesktopApi().customers.paymentAccounts(),
      ]);
      const nextData = resultData(returnsResult);
      const accounts = resultData(accountsResult);
      setData(nextData);
      setPaymentAccounts(accounts);
      setPaymentAccountCode((current) => accounts.some((account) => account.code === current)
        ? current
        : accounts[0]?.code ?? "");
      setInvoiceId((current) => nextData.sales.some((source) => source.invoiceId === current)
        ? current
        : nextData.sales[0]?.invoiceId ?? "");
      setPurchaseId((current) => nextData.purchases.some((source) => source.purchaseId === current)
        ? current
        : nextData.purchases[0]?.purchaseId ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load return and audit records.");
    } finally {
      setLoading(false);
    }
  }

  async function submitSalesReturn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedInvoice) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const items = selectedInvoice.items.flatMap((item) => {
        const quantityMeters = Number(salesQuantities[item.sourceItemId] ?? "");
        return quantityMeters > 0
          ? [{ sourceItemId: item.sourceItemId, quantityMeters, saleable: saleable[item.sourceItemId] === true }]
          : [];
      });
      if (items.length === 0) throw new Error("Enter a return quantity for at least one invoice line.");
      const result = resultData(await getDesktopApi().returns.createSales({
        invoiceId,
        settlementType: salesSettlement,
        ...(salesSettlement === "refund" ? { paymentAccountCode } : {}),
        reason,
        items,
      }));
      setNotice(`Sales return ${result.returnNumber} posted for ${formatMoney(result.totalMinor)}.`);
      setReason("");
      setSalesQuantities({});
      await loadData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to post this sales return.");
    } finally {
      setSaving(false);
    }
  }

  async function submitPurchaseReturn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPurchase) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const items = selectedPurchase.items.flatMap((item) => {
        const quantityMeters = Number(purchaseQuantities[item.sourceItemId] ?? "");
        return quantityMeters > 0 ? [{ sourceItemId: item.sourceItemId, quantityMeters }] : [];
      });
      if (items.length === 0) throw new Error("Enter a return quantity for at least one purchase line.");
      const result = resultData(await getDesktopApi().returns.createPurchase({
        purchaseId,
        settlementType: purchaseSettlement,
        ...(purchaseSettlement === "refund" ? { paymentAccountCode } : {}),
        reason,
        items,
      }));
      setNotice(`Purchase return ${result.returnNumber} posted for ${formatMoney(result.totalMinor)}.`);
      setReason("");
      setPurchaseQuantities({});
      await loadData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to post this purchase return.");
    } finally {
      setSaving(false);
    }
  }

  async function reverseReturn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reversing) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = resultData(await getDesktopApi().returns.reverse({
        returnId: reversing.id,
        returnType: reversing.returnType,
        reason: reversalReason,
      }));
      setNotice(`${result.returnNumber} reversed.`);
      setReversing(null);
      setReversalReason("");
      await loadData();
    } catch (reverseError) {
      setError(reverseError instanceof Error ? reverseError.message : "Unable to reverse this return.");
    } finally {
      setSaving(false);
    }
  }

  const chosenSaleHasCustomer = Boolean(selectedInvoice?.customerId);

  return (
    <div className="returns-page">
      <section className="panel">
        <header className="panel-heading">
          <div><h2>Returns, corrections & audit</h2><p>Review and record sales or purchase returns, corrections, and audit history.</p></div>
        </header>
        <form className="expense-form" onSubmit={(event) => {
          event.preventDefault();
          void loadData();
        }}>
          <button className="secondary-button" disabled={loading}>
            {loading ? "Loading…" : "Load returns & audit"}
          </button>
        </form>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
      </section>

      {data && (
        <>
          <div className="panel-toolbar expense-tabs" role="tablist" aria-label="Return type">
            <button type="button" className={kind === "sales" ? "secondary-button active-tab" : "secondary-button"} role="tab"
              aria-selected={kind === "sales"} onClick={() => setKind("sales")}>Sales return</button>
            <button type="button" className={kind === "purchases" ? "secondary-button active-tab" : "secondary-button"} role="tab"
              aria-selected={kind === "purchases"} onClick={() => setKind("purchases")}>Purchase return</button>
          </div>

          {kind === "sales" ? (
            <form className="panel expense-form" onSubmit={(event) => void submitSalesReturn(event)}>
              <header className="panel-heading"><div><h2>Return against an invoice</h2><p>Each return line is capped at its eligible remaining quantity. Inspect fabric before marking it saleable.</p></div></header>
              <label>Original invoice
                <select required value={invoiceId} onChange={(event) => {
                  const selected = data.sales.find((source) => source.invoiceId === event.target.value);
                  setInvoiceId(event.target.value);
                  if (selected && !selected.customerId) setSalesSettlement("refund");
                  setSalesQuantities({});
                }}>
                  {data.sales.map((source) => <option key={source.invoiceId} value={source.invoiceId}>
                    {source.invoiceNumber} · {source.customerName ?? "Walk-in"} · {source.createdAt.slice(0, 10)}
                  </option>)}
                </select>
              </label>
              {selectedInvoice?.items.filter((item) => item.remainingQuantityMm > 0).map((item) => (
                <div className="return-line" key={item.sourceItemId}>
                  <strong>{item.sku} · {item.name}</strong>
                  <span>Sold {item.quantityMm / 1000} m · Already returned {item.returnedQuantityMm / 1000} m · Remaining {item.remainingQuantityMm / 1000} m</span>
                  <label>Return meters
                    <input type="number" min="0" max={item.remainingQuantityMm / 1000} step="0.001"
                      value={salesQuantities[item.sourceItemId] ?? ""}
                      onChange={(event) => setSalesQuantities({ ...salesQuantities, [item.sourceItemId]: event.target.value })} />
                  </label>
                  <label className="return-checkbox"><input type="checkbox" checked={saleable[item.sourceItemId] === true}
                    onChange={(event) => setSaleable({ ...saleable, [item.sourceItemId]: event.target.checked })} />
                    Inspected and saleable (restore to stock)</label>
                </div>
              ))}
              {(!selectedInvoice || selectedInvoice.items.every((item) => item.remainingQuantityMm === 0)) &&
                <p className="empty-state">No eligible invoice lines remain to return.</p>}
              <label>Settlement
                <select value={salesSettlement} onChange={(event) => setSalesSettlement(event.target.value as "refund" | "customer_credit")}>
                  <option value="refund">Refund to payment account</option>
                  {chosenSaleHasCustomer && <option value="customer_credit">Customer credit note</option>}
                </select>
              </label>
              {salesSettlement === "refund" && <label>Refund account
                <select required value={paymentAccountCode} onChange={(event) => setPaymentAccountCode(event.target.value)}>
                  {paymentAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
                </select>
              </label>}
              {salesSettlement === "customer_credit" && <p className="return-note">The credit reduces receivables first; any excess is held as a customer advance.</p>}
              <label>Reason
                <input required maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Quality issue, wrong fabric, etc." />
              </label>
              <button className="primary-button" disabled={saving || !selectedInvoice || !reason.trim()}>
                {saving ? "Posting…" : "Post sales return"}
              </button>
            </form>
          ) : (
            <form className="panel expense-form" onSubmit={(event) => void submitPurchaseReturn(event)}>
              <header className="panel-heading"><div><h2>Return against a supplier purchase</h2><p>Returned fabric is removed from stock at its current carrying cost and recorded as a debit note or refund.</p></div></header>
              <label>Original purchase
                <select required value={purchaseId} onChange={(event) => {
                  setPurchaseId(event.target.value);
                  setPurchaseQuantities({});
                }}>
                  {data.purchases.map((source) => <option key={source.purchaseId} value={source.purchaseId}>
                    {source.billNumber} · {source.supplierName} · {source.purchaseDate}
                  </option>)}
                </select>
              </label>
              {selectedPurchase?.items.filter((item) => item.remainingQuantityMm > 0).map((item) => (
                <div className="return-line" key={item.sourceItemId}>
                  <strong>{item.sku} · {item.name}</strong>
                  <span>Received {item.quantityMm / 1000} m · Already returned {item.returnedQuantityMm / 1000} m · Remaining {item.remainingQuantityMm / 1000} m</span>
                  <label>Return meters
                    <input type="number" min="0" max={item.remainingQuantityMm / 1000} step="0.001"
                      value={purchaseQuantities[item.sourceItemId] ?? ""}
                      onChange={(event) => setPurchaseQuantities({ ...purchaseQuantities, [item.sourceItemId]: event.target.value })} />
                  </label>
                </div>
              ))}
              {(!selectedPurchase || selectedPurchase.items.every((item) => item.remainingQuantityMm === 0)) &&
                <p className="empty-state">No eligible purchase lines remain to return.</p>}
              <label>Settlement
                <select value={purchaseSettlement} onChange={(event) => setPurchaseSettlement(event.target.value as "supplier_credit" | "refund")}>
                  <option value="supplier_credit">Supplier debit note / credit balance</option>
                  <option value="refund">Refund to payment account</option>
                </select>
              </label>
              {purchaseSettlement === "refund" && <label>Refund account
                <select required value={paymentAccountCode} onChange={(event) => setPaymentAccountCode(event.target.value)}>
                  {paymentAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
                </select>
              </label>}
              <label>Reason
                <input required maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Damaged goods, wrong quality, etc." />
              </label>
              <button className="primary-button" disabled={saving || !selectedPurchase || !reason.trim()}>
                {saving ? "Posting…" : "Post purchase return"}
              </button>
            </form>
          )}

          <section className="panel">
            <header className="panel-heading"><div><h2>Return history</h2><p>Posted entries are retained; reversals create compensating stock and ledger movements.</p></div></header>
            {data.history.length === 0 ? <p className="empty-state">No returns recorded.</p> : (
              <div className="table-scroll"><table><thead><tr><th>Date</th><th>Return</th><th>Source</th><th>Party</th><th>Settlement</th><th>Reason</th><th className="numeric">Amount</th><th>Action</th></tr></thead>
                <tbody>{data.history.map((item) => <tr key={`${item.returnType}-${item.id}`}>
                  <td>{item.createdAt.slice(0, 10)}</td><td><strong>{item.returnNumber}</strong>{item.reversedAt && <small>Reversed {item.reversedAt.slice(0, 10)} · {item.reversalReason}</small>}</td>
                  <td>{item.sourceReference}</td><td>{item.partyName}</td><td>{item.settlementType.replaceAll("_", " ")}</td><td>{item.reason}</td><td className="numeric">{formatMoney(item.totalMinor)}</td>
                  <td>{!item.reversedAt && <button type="button" className="table-action danger" onClick={() => {
                    setReversing(item);
                    setReversalReason("");
                  }}>Reverse</button>}</td>
                </tr>)}</tbody>
              </table></div>
            )}
            {reversing && (
              <form className="expense-form return-reversal-form" onSubmit={(event) => void reverseReturn(event)}>
                <strong>Reverse {reversing.returnNumber}</strong>
                <label>Reversal reason
                  <input required maxLength={240} value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} />
                </label>
                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={() => setReversing(null)}>Cancel</button>
                  <button className="primary-button" disabled={saving}>{saving ? "Reversing…" : "Confirm reversal"}</button>
                </div>
              </form>
            )}
          </section>

          <section className="panel">
            <header className="panel-heading"><div><h2>Audit log</h2><p>Recent sensitive actions with actor, timestamp, source record and reason. Secrets are never recorded.</p></div></header>
            {data.auditLog.length === 0 ? <p className="empty-state">No sensitive actions recorded yet.</p> : (
              <div className="table-scroll"><table><thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Source</th><th>Reason</th></tr></thead>
                <tbody>{data.auditLog.map((entry) => <tr key={entry.id}>
                  <td>{entry.createdAt}</td><td>{entry.actor}</td><td>{entry.action.replaceAll("_", " ")}</td>
                  <td>{entry.sourceType} · {entry.sourceId}</td><td>{entry.reason}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
