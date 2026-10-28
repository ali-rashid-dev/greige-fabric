"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { businessConfig } from "@/config/business";
import PrintActions from "./print-actions";
import { getDesktopApi } from "@/lib/desktop-api";
import type { Customer, Fabric, Invoice } from "@/shared/types";

interface CartLine {
  fabric: Fabric;
  quantityMeters: string;
  unitRate: string;
}

interface SalesPosProps {
  customers: Customer[];
  onPosted: (invoice: Invoice) => Promise<void>;
}

function formatMoney(minor: number): string {
  const amount = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 }).format(minor / 100);
  return `${businessConfig.currency} ${amount}`;
}

function formatMeters(millimeters: number): string {
  return `${(millimeters / 1000).toLocaleString("en-PK", { maximumFractionDigits: 3 })} m`;
}

function lineTotal(line: CartLine): number {
  const quantityMm = Math.round(Number(line.quantityMeters) * 1000);
  const unitRateMinor = Math.round(Number(line.unitRate) * 100);
  if (!Number.isSafeInteger(quantityMm) || !Number.isSafeInteger(unitRateMinor) || quantityMm <= 0 || unitRateMinor <= 0) {
    return 0;
  }
  const total = (BigInt(quantityMm) * BigInt(unitRateMinor) + 500n) / 1000n;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : 0;
}

export default function SalesPos({ customers, onPosted }: SalesPosProps) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Fabric[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState("0");
  const [customerId, setCustomerId] = useState("");
  const [paymentAccount, setPaymentAccount] = useState<"cash" | "bank">("cash");
  const [receivedAmount, setReceivedAmount] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const pendingQuantityFocus = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void Promise.resolve()
        .then(() => getDesktopApi().fabrics.list({ query: query.trim(), status: "active" }))
        .then((result) => {
          if (!active) return;
          if (!result.ok) throw new Error(result.error.message);
          setProducts(result.data);
          setHighlighted(0);
          setError("");
        })
        .catch((searchError: unknown) => {
          if (!active) return;
          setProducts([]);
          setError(searchError instanceof Error ? searchError.message : "Unable to search the fabric catalog.");
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 100);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (pendingQuantityFocus.current) {
      document.getElementById(`sale-quantity-${pendingQuantityFocus.current}`)?.focus();
      pendingQuantityFocus.current = null;
    }
  }, [cart]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener("keydown", handleShortcut);
    searchInput.current?.focus();
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const subtotalMinor = useMemo(
    () => cart.reduce((total, line) => total + lineTotal(line), 0),
    [cart],
  );
  const discountMinor = Number.isFinite(Number(discount)) ? Math.round(Number(discount) * 100) : 0;
  const totalMinor = Math.max(0, subtotalMinor - discountMinor);
  const receivedMinor = Number.isFinite(Number(receivedAmount)) ? Math.round(Number(receivedAmount) * 100) : 0;
  const dueMinor = totalMinor - receivedMinor;
  const results = products.slice(0, 8);

  function addProduct(fabric: Fabric) {
    setError("");
    setQuery("");
    const existing = cart.find((line) => line.fabric.id === fabric.id);
    if (existing) {
      window.requestAnimationFrame(() => document.getElementById(`sale-quantity-${fabric.id}`)?.focus());
      return;
    }
    if (fabric.stockMm <= 0) {
      setError(`${fabric.sku} is out of stock.`);
      return;
    }
    const defaultQuantity = Math.min(1, fabric.stockMm / 1000);
    setCart((current) => [...current, {
      fabric,
      quantityMeters: defaultQuantity.toFixed(3).replace(/\.?0+$/, ""),
      unitRate: (fabric.sellingRateMinor / 100).toFixed(2),
    }]);
    pendingQuantityFocus.current = fabric.id;
  }

  function updateLine(fabricId: string, field: "quantityMeters" | "unitRate", value: string) {
    setCart((current) => current.map((line) =>
      line.fabric.id === fabricId ? { ...line, [field]: value } : line,
    ));
  }

  function resetSale() {
    setCart([]);
    setDiscount("0");
    setCustomerId("");
    setPaymentAccount("cash");
    setReceivedAmount("0");
    setError("");
    setNotice("");
    setInvoice(null);
    setQuery("");
    searchInput.current?.focus();
  }

  async function postSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (cart.length === 0) {
      setError("Add at least one fabric line before posting.");
      return;
    }
    if (discountMinor < 0 || discountMinor > subtotalMinor) {
      setError("Discount must be between zero and the subtotal.");
      return;
    }
    if (receivedMinor < 0 || receivedMinor > totalMinor) {
      setError("Amount received cannot exceed the sale total.");
      return;
    }
    if (dueMinor > 0 && !customerId) {
      setError("Select a customer for a sale with an outstanding balance.");
      document.getElementById("sale-customer")?.focus();
      return;
    }
    for (const line of cart) {
      const quantity = Number(line.quantityMeters);
      const rate = Number(line.unitRate);
      if (!Number.isFinite(quantity) || quantity <= 0 || Math.round(quantity * 1000) > line.fabric.stockMm) {
        setError(`Enter a valid quantity within the ${formatMeters(line.fabric.stockMm)} available for ${line.fabric.sku}.`);
        document.getElementById(`sale-quantity-${line.fabric.id}`)?.focus();
        return;
      }
      if (!Number.isFinite(rate) || rate <= 0) {
        setError(`Enter a valid selling rate for ${line.fabric.sku}.`);
        document.getElementById(`sale-rate-${line.fabric.id}`)?.focus();
        return;
      }
    }

    setSaving(true);
    try {
      const result = await getDesktopApi().invoices.create({
        ...(customerId ? { customerId } : {}),
        items: cart.map((line) => ({
          fabricId: line.fabric.id,
          quantityMeters: Number(line.quantityMeters),
          unitRate: Number(line.unitRate),
        })),
        discount: Number(discount || 0),
        receivedAmount: Number(receivedAmount || 0),
        paymentAccount,
      });
      if (!result.ok) throw new Error(result.error.message);
      setInvoice(result.data);
      setCart([]);
      setDiscount("0");
      setCustomerId("");
      setReceivedAmount("0");
      setNotice(`Invoice ${result.data.invoiceNumber} posted.`);
      try {
        await onPosted(result.data);
      } catch (refreshError) {
        setError(`Invoice ${result.data.invoiceNumber} was posted, but the latest stock or account balances could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "refresh failed"}`);
      }
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Unable to post this sale.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pos-page">
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="pos-heading">
        <div>
          <span className="pos-eyebrow">WHOLESALE CHECKOUT</span>
          <h2>New Sale</h2>
          <p>Search, add fabric, confirm the quantity and rate, then post the sale.</p>
        </div>
        <div className="pos-heading-actions">
          <span className="draft-badge"><span /> Draft</span>
          <button type="button" className="secondary-button" onClick={resetSale} disabled={cart.length === 0 && !invoice}>Clear sale</button>
        </div>
      </div>

      <div className="pos-layout">
        <section className="pos-workspace">
          <div className="pos-search-wrap">
            <label className="pos-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => {
                  setProducts([]);
                  setHighlighted(0);
                  setError("");
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setHighlighted((index) => Math.min(index + 1, results.length - 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setHighlighted((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter" && results[highlighted]) {
                    event.preventDefault();
                    addProduct(results[highlighted]);
                  } else if (event.key === "Escape") {
                    setQuery("");
                  }
                }}
                placeholder="Search fabric by SKU or fabric quality…"
                aria-label="Search fabric by SKU or quality"
                aria-controls="pos-search-results"
                aria-autocomplete="list"
                aria-expanded={query.trim().length > 0}
              />
              <kbd>/</kbd>
            </label>
            {query.trim() && (
              <div className="pos-search-results" id="pos-search-results" role="listbox" aria-label="Fabric search results">
                {searching ? <p className="pos-search-message">Searching catalog…</p> : results.length === 0 ? (
                  <p className="pos-search-message">No active fabrics match that search.</p>
                ) : results.map((fabric, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={highlighted === index}
                    className={highlighted === index ? "pos-result highlighted" : "pos-result"}
                    key={fabric.id}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => addProduct(fabric)}
                    disabled={fabric.stockMm <= 0}
                  >
                    <span className="pos-result-symbol">▤</span>
                    <span className="pos-result-name">
                      <strong>{fabric.name}</strong>
                      <small>{fabric.sku} · {fabric.construction} · {formatMeters(fabric.stockMm)} available</small>
                    </span>
                    <strong className="pos-result-rate">{formatMoney(fabric.sellingRateMinor)}<small> / m</small></strong>
                  </button>
                ))}
                <p className="pos-search-hint">↑ ↓ to choose · Enter to add</p>
              </div>
            )}
          </div>

          <div className="pos-cart">
            <div className="pos-cart-header">
              <div><h3>Sale items</h3><span>{cart.length} {cart.length === 1 ? "line" : "lines"}</span></div>
              <span>Prices in {businessConfig.currency}</span>
            </div>
            {cart.length === 0 ? (
              <div className="pos-empty-cart">
                <span className="pos-empty-icon">▤</span>
                <strong>Your sale is empty</strong>
                <p>Search by fabric SKU or quality to add a line.</p>
              </div>
            ) : (
              <div className="pos-cart-lines">
                {cart.map((line) => (
                  <article className="pos-cart-line" key={line.fabric.id}>
                    <div className="pos-line-product">
                      <span className="pos-product-icon">▤</span>
                      <div><strong>{line.fabric.name}</strong><small>{line.fabric.sku} · Available {formatMeters(line.fabric.stockMm)}</small></div>
                      <button type="button" className="pos-remove" aria-label={`Remove ${line.fabric.sku}`} onClick={() => setCart((current) => current.filter((item) => item.fabric.id !== line.fabric.id))}>×</button>
                    </div>
                    <div className="pos-line-inputs">
                      <label>Quantity
                        <div className="pos-input-unit"><input id={`sale-quantity-${line.fabric.id}`} type="number" min="0.001" max={line.fabric.stockMm / 1000} step="0.001" required value={line.quantityMeters} onChange={(event) => updateLine(line.fabric.id, "quantityMeters", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); document.getElementById(`sale-rate-${line.fabric.id}`)?.focus(); } }} /><span>m</span></div>
                      </label>
                      <label>Rate
                        <div className="pos-input-unit pos-rate-input"><span>PKR</span><input id={`sale-rate-${line.fabric.id}`} type="number" min="0.01" step="0.01" required value={line.unitRate} onChange={(event) => updateLine(line.fabric.id, "unitRate", event.target.value)} /></div>
                      </label>
                      <div className="pos-line-total"><small>Line total</small><strong>{formatMoney(lineTotal(line))}</strong></div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="pos-keyboard-hint"><span>Keyboard flow</span><kbd>/</kbd> search <span>→</span> <kbd>↑↓</kbd> select <span>→</span> <kbd>Enter</kbd> add <span>→</span> quantity & rate
          </div>
        </section>

        <form className="pos-checkout" onSubmit={(event) => void postSale(event)}>
          <div className="pos-checkout-title"><div><h3>Sale summary</h3><span>Review before posting</span></div><span className="pos-item-count">{cart.length}</span></div>
          <label className="pos-field-label" htmlFor="sale-customer">Customer <span>Optional for paid-in-full sales</span></label>
          <select id="sale-customer" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Walk-in / select customer</option>
            {customers.filter((customer) => customer.active).map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.code} · {customer.name}</option>
            ))}
          </select>

          <label className="pos-field-label" htmlFor="sale-discount">Discount</label>
          <div className="pos-money-input"><span>PKR</span><input id="sale-discount" type="number" min="0" max={subtotalMinor / 100} step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} /></div>

          <div className="pos-summary-rows">
            <div><span>Subtotal</span><strong>{formatMoney(subtotalMinor)}</strong></div>
            <div><span>Discount</span><strong className="pos-discount">− {formatMoney(discountMinor)}</strong></div>
            <div className="pos-total-row"><strong>Total</strong><strong>{formatMoney(totalMinor)}</strong></div>
          </div>

          <div className="pos-payment-title"><h4>Payment summary</h4><span>Choose how much is received now</span></div>
          <label className="pos-field-label" htmlFor="sale-payment-account">Payment method</label>
          <select id="sale-payment-account" value={paymentAccount} onChange={(event) => setPaymentAccount(event.target.value as "cash" | "bank")}>
            <option value="cash">Cash</option><option value="bank">Bank transfer</option>
          </select>
          <label className="pos-field-label" htmlFor="sale-received">Received</label>
          <div className="pos-money-input"><span>PKR</span><input id="sale-received" type="number" min="0" max={totalMinor / 100} step="0.01" value={receivedAmount} onChange={(event) => setReceivedAmount(event.target.value)} /></div>
          <div className="pos-credit-row"><span>Credit balance</span><strong>{formatMoney(Math.max(0, dueMinor))}</strong></div>
          {dueMinor > 0 && !customerId && <p className="pos-validation-note">Choose a customer to post this outstanding balance.</p>}

          <button className="primary-button pos-post-button" type="submit" disabled={saving || cart.length === 0 || dueMinor < 0}>
            {saving ? "Posting sale…" : "Post sale"} <span>→</span>
          </button>
          <p className="pos-post-footnote">Stock and accounts update together when this sale is posted.</p>
        </form>
      </div>

      {invoice && (
        <div className="modal-backdrop pos-invoice-backdrop" role="presentation">
          <section className="modal wide pos-invoice-modal" role="dialog" aria-modal="true" aria-label="Invoice preview">
            <header className="modal-header"><h2>Invoice preview</h2><button className="close-button no-print" onClick={() => setInvoice(null)} aria-label="Close invoice preview">×</button></header>
            <div className="modal-content">
              <article className="invoice-printable">
                <header className="print-invoice-heading">
                  <div>
                    <p>{businessConfig.name}</p>
                    <small>{businessConfig.contactInformation} · {businessConfig.address}</small>
                    <h2>Sales invoice</h2>
                  </div>
                  <div><strong>{invoice.invoiceNumber}</strong><span>{new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(invoice.createdAt))}</span></div>
                </header>
                <div className="print-customer">
                  <strong>{invoice.customerName ? `${invoice.customerCode} · ${invoice.customerName}` : "Walk-in customer"}</strong>
                  {invoice.customerPhone && <span>{invoice.customerPhone}</span>}
                  {invoice.customerAddress && <span>{invoice.customerAddress}</span>}
                </div>
                <div className="print-invoice-lines">
                  <div className="print-line print-line-head"><span>Fabric</span><span>Quantity</span><span>Rate</span><span>Amount</span></div>
                  {invoice.items.map((item) => (
                    <div className="print-line" key={item.id}>
                      <span><strong>{item.name}</strong><small>{item.sku}</small></span>
                      <span>{formatMeters(item.quantityMm)}</span>
                      <span>{formatMoney(item.unitPriceMinor)} / m</span>
                      <strong>{formatMoney(item.lineTotalMinor)}</strong>
                    </div>
                  ))}
                </div>
                <div className="print-invoice-totals">
                  <div><span>Subtotal</span><strong>{formatMoney(invoice.subtotalMinor)}</strong></div>
                  <div><span>Discount</span><strong>{formatMoney(invoice.discountMinor)}</strong></div>
                  <div className="print-grand-total"><span>Total</span><strong>{formatMoney(invoice.totalMinor)}</strong></div>
                  <div><span>Received ({invoice.paymentAccount})</span><strong>{formatMoney(invoice.amountReceivedMinor)}</strong></div>
                  <div><span>Credit balance</span><strong>{formatMoney(invoice.dueMinor)}</strong></div>
                  <div><span>Payment terms</span><strong>{invoice.paymentTermsDays === undefined || invoice.paymentTermsDays === 0 ? "Due on receipt" : `${invoice.paymentTermsDays} days`}</strong></div>
                </div>
                <p className="print-thank-you">Thank you for your business.</p>
                <p className="print-authorized">{businessConfig.authorizedFooter}</p>
              </article>
              <div className="modal-actions no-print">
                <button className="secondary-button" onClick={() => setInvoice(null)}>Close</button>
                <PrintActions label="Print invoice" />
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
