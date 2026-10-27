"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import { fabricInputSchema } from "@/shared/contracts";
import type { Fabric, FabricDetails, Invoice, StockSummary } from "@/shared/types";

type Section = "fabrics" | "stock" | "invoices";
type StatusFilter = "active" | "all" | "inactive" | "low-stock";

interface FabricFormValues {
  sku: string;
  name: string;
  construction: string;
  composition: string;
  widthInches: string;
  gsm: string;
  purchaseCost: string;
  sellingRate: string;
  reorderThresholdMeters: string;
}

const emptyFabric: FabricFormValues = {
  sku: "",
  name: "",
  construction: "",
  composition: "",
  widthInches: "",
  gsm: "",
  purchaseCost: "",
  sellingRate: "",
  reorderThresholdMeters: "",
};

function formatMoney(minor: number): string {
  const amount = new Intl.NumberFormat("en-PK", {
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return `${businessConfig.currency} ${amount}`;
}

function formatMeters(millimeters: number): string {
  return `${(millimeters / 1000).toLocaleString("en-PK", {
    maximumFractionDigits: 3,
  })} m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toFormValues(fabric: Fabric): FabricFormValues {
  return {
    sku: fabric.sku,
    name: fabric.name,
    construction: fabric.construction,
    composition: fabric.composition,
    widthInches: String(fabric.widthInches),
    gsm: String(fabric.gsm),
    purchaseCost: String(fabric.purchaseCostMinor / 100),
    sellingRate: String(fabric.sellingRateMinor / 100),
    reorderThresholdMeters: String(fabric.reorderThresholdMm / 1000),
  };
}

export default function Home() {
  const [section, setSection] = useState<Section>("fabrics");
  const [fabrics, setFabrics] = useState<Fabric[]>([]);
  const [stock, setStock] = useState<StockSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Fabric | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formValues, setFormValues] = useState<FabricFormValues>(emptyFabric);
  const [saving, setSaving] = useState(false);
  const [details, setDetails] = useState<FabricDetails | null>(null);
  const [saleQuantity, setSaleQuantity] = useState("");
  const [adjustment, setAdjustment] = useState<Fabric | null>(null);
  const [adjustmentDirection, setAdjustmentDirection] = useState<"add" | "remove">("add");
  const [adjustmentQuantity, setAdjustmentQuantity] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const loadCatalog = useCallback(async () => {
    const [fabricResult, stockResult, invoiceResult] = await Promise.all([
      getDesktopApi().fabrics.list({ query: search, status: statusFilter }),
      getDesktopApi().stock.summary(),
      getDesktopApi().invoices.list(),
    ]);
    if (!fabricResult.ok) throw new Error(fabricResult.error.message);
    if (!stockResult.ok) throw new Error(stockResult.error.message);
    if (!invoiceResult.ok) throw new Error(invoiceResult.error.message);
    setFabrics(fabricResult.data);
    setStock(stockResult.data);
    setInvoices(invoiceResult.data);
  }, [search, statusFilter]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadCatalog()
      .then(() => {
        if (active) setError("");
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load the fabric catalog.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadCatalog]);

  const lowStockFabrics = useMemo(
    () => stock?.fabrics.filter((fabric) => fabric.active && fabric.stockMm <= fabric.reorderThresholdMm) ?? [],
    [stock],
  );

  async function refreshCatalog() {
    await loadCatalog();
  }

  function openCreateForm() {
    setEditing(null);
    setFormOpen(true);
    setFormValues(emptyFabric);
    setError("");
  }

  function openEditForm(fabric: Fabric) {
    setEditing(fabric);
    setFormOpen(true);
    setFormValues(toFormValues(fabric));
    setDetails(null);
    setError("");
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    setError("");
  }

  function openAdjustment(fabric: Fabric) {
    setAdjustment(fabric);
    setAdjustmentDirection("add");
    setAdjustmentQuantity("");
    setAdjustmentReason("");
    setError("");
  }

  async function saveFabric(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const parsed = fabricInputSchema.safeParse({
        ...formValues,
        widthInches: Number(formValues.widthInches),
        gsm: Number(formValues.gsm),
        purchaseCost: Number(formValues.purchaseCost),
        sellingRate: Number(formValues.sellingRate),
        reorderThresholdMeters: Number(formValues.reorderThresholdMeters),
      });
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Enter valid fabric details.");
      }
      const input = parsed.data;
      const result = editing
        ? await getDesktopApi().fabrics.update({ ...input, id: editing.id })
        : await getDesktopApi().fabrics.create(input);
      if (!result.ok) throw new Error(result.error.message);
      await refreshCatalog();
      setFormOpen(false);
      setEditing(null);
      setNotice(editing ? "Fabric details updated." : "Fabric quality added to the catalog.");
      setTimeout(() => setNotice(""), 3000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this fabric.");
    } finally {
      setSaving(false);
    }
  }

  async function openDetails(fabric: Fabric) {
    setError("");
    try {
      const result = await getDesktopApi().fabrics.get({ id: fabric.id });
      if (!result.ok) throw new Error(result.error.message);
      setDetails(result.data);
      setSaleQuantity("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load fabric details.");
    }
  }

  async function setFabricActive(fabric: Fabric) {
    setError("");
    try {
      const result = await getDesktopApi().fabrics.setActive({
        id: fabric.id,
        active: !fabric.active,
      });
      if (!result.ok) throw new Error(result.error.message);
      await refreshCatalog();
      setDetails((current) => current ? { ...current, fabric: result.data } : current);
      setNotice(fabric.active ? "Fabric deactivated and kept in sales history." : "Fabric activated.");
      setTimeout(() => setNotice(""), 3000);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update fabric status.");
    }
  }

  async function recordSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().invoices.create({
        items: [{
          fabricId: details.fabric.id,
          quantityMeters: Number(saleQuantity),
        }],
      });
      if (!result.ok) throw new Error(result.error.message);
      await refreshCatalog();
      await openDetails(details.fabric);
      setNotice(`Invoice ${result.data.invoiceNumber} recorded.`);
      setTimeout(() => setNotice(""), 3500);
    } catch (saleError) {
      setError(saleError instanceof Error ? saleError.message : "Unable to record this sale.");
    } finally {
      setSaving(false);
    }
  }

  async function saveStockAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustment) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().stock.adjust({
        fabricId: adjustment.id,
        direction: adjustmentDirection,
        quantityMeters: Number(adjustmentQuantity),
        reason: adjustmentReason,
      });
      if (!result.ok) throw new Error(result.error.message);
      await refreshCatalog();
      setAdjustment(null);
      setNotice("Stock movement recorded.");
      setTimeout(() => setNotice(""), 3000);
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : "Unable to adjust stock.");
    } finally {
      setSaving(false);
    }
  }

  const pageTitle = section === "fabrics"
    ? "Fabric qualities"
    : section === "stock"
      ? "Stock summary"
      : "Sales history";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p className="brand-name">{businessConfig.name}</p>
            <p className="brand-caption">FABRIC POS</p>
          </div>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={section === "fabrics" ? "nav-item active" : "nav-item"} onClick={() => setSection("fabrics")}>
            <span className="nav-icon">▤</span> Fabric catalog
          </button>
          <button className={section === "stock" ? "nav-item active" : "nav-item"} onClick={() => setSection("stock")}>
            <span className="nav-icon">▥</span> Stock summary
            {lowStockFabrics.length > 0 && <span className="nav-count">{lowStockFabrics.length}</span>}
          </button>
          <button className={section === "invoices" ? "nav-item active" : "nav-item"} onClick={() => setSection("invoices")}>
            <span className="nav-icon">▧</span> Sales history
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className="connection-dot" />
          <span>Saved on this device</span>
          <span className="currency-small">{businessConfig.currency}</span>
        </div>
      </aside>

      <section className="main-content">
        <header className="topbar">
          <div>
            <p className="breadcrumb">Greige Fabric <span>/</span> {pageTitle}</p>
            <h1>{pageTitle}</h1>
          </div>
          {section === "fabrics" && (
            <button className="primary-button" onClick={openCreateForm}><span>+</span> Add fabric</button>
          )}
        </header>

        <div className="content-scroll">
          {notice && <div className="notice" role="status">{notice}</div>}
          {error && !editing && <div className="error-banner" role="alert">{error}</div>}
          {lowStockFabrics.length > 0 && (
            <div className="low-stock-banner">
              <span className="alert-icon">!</span>
              <span><strong>{lowStockFabrics.length} fabric{lowStockFabrics.length === 1 ? "" : "s"}</strong> at or below reorder threshold</span>
              <button onClick={() => { setSection("fabrics"); setStatusFilter("low-stock"); }}>Review low stock</button>
            </div>
          )}

          {section === "fabrics" && (
            <>
              <div className="summary-grid">
                <SummaryCard label="Fabric qualities" value={stock?.totalProducts ?? "—"} icon="▤" />
                <SummaryCard label="Active qualities" value={stock?.activeProducts ?? "—"} icon="✓" />
                <SummaryCard label="Low stock" value={stock?.lowStockCount ?? "—"} icon="!" warning={Boolean(stock?.lowStockCount)} />
                <SummaryCard label="Stock on hand" value={formatMeters(stock?.totalStockMm ?? 0)} icon="▥" />
              </div>
              <div className="panel">
                <div className="panel-toolbar">
                  <label className="search-field">
                    <span aria-hidden="true">⌕</span>
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU, name, construction…" aria-label="Search fabrics" />
                  </label>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} aria-label="Filter fabric status">
                    <option value="active">Active fabrics</option>
                    <option value="all">All fabrics</option>
                    <option value="inactive">Inactive fabrics</option>
                    <option value="low-stock">Low stock</option>
                  </select>
                </div>
                <FabricTable fabrics={fabrics} loading={loading} onDetails={openDetails} onEdit={openEditForm} onAdjust={openAdjustment} />
              </div>
            </>
          )}

          {section === "stock" && (
            <>
              <div className="summary-grid stock-summary-grid">
                <SummaryCard label="Active qualities" value={stock?.activeProducts ?? "—"} icon="✓" />
                <SummaryCard label="Low stock" value={stock?.lowStockCount ?? "—"} icon="!" warning={Boolean(stock?.lowStockCount)} />
                <SummaryCard label="Total stock" value={formatMeters(stock?.totalStockMm ?? 0)} icon="▥" />
              </div>
              <div className="section-heading">
                <div><h2>Stock by fabric</h2><p>Quantities are tracked in metres.</p></div>
              </div>
              <div className="panel">
                <FabricTable fabrics={stock?.fabrics ?? []} loading={loading} stockView onDetails={openDetails} onEdit={openEditForm} onAdjust={openAdjustment} />
              </div>
            </>
          )}

          {section === "invoices" && (
            <>
              <div className="section-heading">
                <div><h2>Completed invoices</h2><p>Each line keeps the name, SKU and rate from when it was sold.</p></div>
                <span className="history-count">{invoices.length} invoices</span>
              </div>
              {invoices.length === 0 ? (
                <EmptyState title="No invoices yet" copy="Record a sale from a fabric's details to start building sales history." />
              ) : (
                <div className="invoice-list">
                  {invoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} />)}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {formOpen && (
        <Modal title={editing ? "Edit fabric quality" : "Add fabric quality"} onClose={closeForm} wide>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="fabric-form" onSubmit={(event) => void saveFabric(event)}>
            <div className="form-grid">
              <FormField label="SKU" required hint="Unique product code, e.g. GF-0001">
                <input required autoFocus value={formValues.sku} onChange={(event) => setFormValues({ ...formValues, sku: event.target.value })} placeholder="GF-0001" maxLength={40} />
              </FormField>
              <FormField label="Fabric name" required>
                <input required value={formValues.name} onChange={(event) => setFormValues({ ...formValues, name: event.target.value })} placeholder="Greige Cotton Fabric" maxLength={120} />
              </FormField>
              <FormField label="Construction" required>
                <input required value={formValues.construction} onChange={(event) => setFormValues({ ...formValues, construction: event.target.value })} placeholder="60 × 60" maxLength={80} />
              </FormField>
              <FormField label="Composition" required>
                <input required value={formValues.composition} onChange={(event) => setFormValues({ ...formValues, composition: event.target.value })} placeholder="100% cotton" maxLength={120} />
              </FormField>
              <FormField label="Width" required>
                <div className="input-suffix"><input required type="number" min="0.01" step="0.01" value={formValues.widthInches} onChange={(event) => setFormValues({ ...formValues, widthInches: event.target.value })} placeholder="63" /><span>in</span></div>
              </FormField>
              <FormField label="GSM" required>
                <div className="input-suffix"><input required type="number" min="0.01" step="0.01" value={formValues.gsm} onChange={(event) => setFormValues({ ...formValues, gsm: event.target.value })} placeholder="110" /><span>g/m²</span></div>
              </FormField>
              <FormField label="Purchase cost" required>
                <div className="input-prefix"><span>PKR</span><input required type="number" min="0" step="0.01" value={formValues.purchaseCost} onChange={(event) => setFormValues({ ...formValues, purchaseCost: event.target.value })} placeholder="145.00" /></div>
              </FormField>
              <FormField label="Selling rate" required>
                <div className="input-prefix"><span>PKR</span><input required type="number" min="0.01" step="0.01" value={formValues.sellingRate} onChange={(event) => setFormValues({ ...formValues, sellingRate: event.target.value })} placeholder="180.00" /></div>
              </FormField>
              <FormField label="Reorder threshold" required>
                <div className="input-suffix"><input required type="number" min="0" step="0.001" value={formValues.reorderThresholdMeters} onChange={(event) => setFormValues({ ...formValues, reorderThresholdMeters: event.target.value })} placeholder="500" /><span>m</span></div>
              </FormField>
            </div>
            <p className="form-footnote">Stock is adjusted separately so every movement is recorded.</p>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={closeForm}>Cancel</button>
              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add fabric"}</button>
            </div>
          </form>
        </Modal>
      )}

      {details && (
        <Modal title="Fabric details" onClose={() => setDetails(null)} wide>
          <div className="detail-head">
            <div><span className="sku-label">{details.fabric.sku}</span><h2>{details.fabric.name}</h2><p>{details.fabric.construction} · {details.fabric.composition} · {details.fabric.widthInches} in · {details.fabric.gsm} GSM</p></div>
            <StatusBadge active={details.fabric.active} />
          </div>
          <div className="detail-metrics">
            <Metric label="Selling rate" value={`${formatMoney(details.fabric.sellingRateMinor)} / m`} />
            <Metric label="Purchase cost" value={`${formatMoney(details.fabric.purchaseCostMinor)} / m`} />
            <Metric label="Available stock" value={formatMeters(details.fabric.stockMm)} />
            <Metric label="Reorder at" value={formatMeters(details.fabric.reorderThresholdMm)} />
          </div>
          <div className="detail-actions">
            <button className="secondary-button" onClick={() => openEditForm(details.fabric)}>Edit fabric</button>
            <button className="secondary-button" onClick={() => void setFabricActive(details.fabric)}>{details.fabric.active ? "Deactivate" : "Activate"}</button>
          </div>
          {details.fabric.active && (
            <form className="sale-form" onSubmit={(event) => void recordSale(event)}>
              <div><h3>Record sale</h3><p>Creates an invoice at the current selling rate and reduces stock.</p></div>
              <div className="sale-controls">
                <label><span>Quantity (m)</span><input type="number" min="0.001" step="0.001" required value={saleQuantity} onChange={(event) => setSaleQuantity(event.target.value)} placeholder="2.500" /></label>
                <button className="primary-button" type="submit" disabled={saving}>{saving ? "Recording…" : "Create invoice"}</button>
              </div>
            </form>
          )}
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <div className="history-block">
            <div className="section-heading compact"><div><h3>Historical invoice lines</h3><p>Prices shown are the saved invoice prices.</p></div></div>
            {details.invoices.length === 0 ? <p className="muted-message">No sales recorded for this fabric.</p> : details.invoices.map((invoice) => {
              const items = invoice.items.filter((item) => item.fabricId === details.fabric.id);
              return items.map((item) => <div className="history-row" key={item.id}><div><strong>{invoice.invoiceNumber}</strong><span>{formatDate(invoice.createdAt)} · {item.sku} · {item.name}</span></div><div className="history-price"><strong>{formatMoney(item.unitPriceMinor)} / m</strong><span>{formatMeters(item.quantityMm)} · {formatMoney(item.lineTotalMinor)}</span></div></div>);
            })}
          </div>
        </Modal>
      )}

      {adjustment && (
        <Modal title="Adjust stock" onClose={() => setAdjustment(null)}>
          <p className="adjustment-product"><strong>{adjustment.sku}</strong> · {adjustment.name}<br />Current on hand: {formatMeters(adjustment.stockMm)}</p>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void saveStockAdjustment(event)}>
            <FormField label="Movement">
              <select value={adjustmentDirection} onChange={(event) => setAdjustmentDirection(event.target.value as "add" | "remove")}><option value="add">Add stock</option><option value="remove">Remove stock</option></select>
            </FormField>
            <FormField label="Quantity" required>
              <div className="input-suffix"><input autoFocus type="number" min="0.001" step="0.001" required value={adjustmentQuantity} onChange={(event) => setAdjustmentQuantity(event.target.value)} placeholder="100" /><span>m</span></div>
            </FormField>
            <FormField label="Reason" required>
              <input required value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} maxLength={160} placeholder="Opening stock, correction…" />
            </FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setAdjustment(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save movement"}</button></div>
          </form>
        </Modal>
      )}
    </main>
  );
}

function SummaryCard({ label, value, icon, warning = false }: { label: string; value: string | number; icon: string; warning?: boolean }) {
  return <article className="summary-card"><span className={warning ? "summary-icon warning" : "summary-icon"}>{icon}</span><div><p>{label}</p><strong>{value}</strong></div></article>;
}

function FabricTable({ fabrics, loading, stockView = false, onDetails, onEdit, onAdjust }: {
  fabrics: Fabric[];
  loading: boolean;
  stockView?: boolean;
  onDetails: (fabric: Fabric) => void;
  onEdit: (fabric: Fabric) => void;
  onAdjust: (fabric: Fabric) => void;
}) {
  if (loading && fabrics.length === 0) return <div className="table-state">Loading fabric catalog…</div>;
  if (fabrics.length === 0) return <EmptyState title="No fabrics found" copy="Try another search or add your first fabric quality." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Fabric quality</th><th>Construction</th><th>Width / GSM</th><th>Rate / metre</th><th>Stock</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {fabrics.map((fabric) => {
            const low = fabric.active && fabric.stockMm <= fabric.reorderThresholdMm;
            return (
              <tr key={fabric.id} className="fabric-row">
                <td><button className="fabric-link" onClick={() => onDetails(fabric)}><strong>{fabric.name}</strong><span>{fabric.sku} · {fabric.composition}</span></button></td>
                <td>{fabric.construction}</td>
                <td>{fabric.widthInches} in <span className="cell-muted">/</span> {fabric.gsm} GSM</td>
                <td className="rate-cell">{formatMoney(fabric.sellingRateMinor)}<span> / m</span></td>
                <td><span className={low ? "stock-value low" : "stock-value"}>{formatMeters(fabric.stockMm)}</span>{stockView && <small className="threshold-copy">Reorder {formatMeters(fabric.reorderThresholdMm)}</small>}</td>
                <td><StatusBadge active={fabric.active} low={low} /></td>
                <td><div className="row-actions"><button title="Adjust stock" aria-label={`Adjust stock for ${fabric.sku}`} onClick={() => onAdjust(fabric)}>±</button><button title="Edit fabric" aria-label={`Edit ${fabric.sku}`} onClick={() => onEdit(fabric)}>···</button></div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ active, low = false }: { active: boolean; low?: boolean }) {
  return <span className={active ? low ? "status-badge low" : "status-badge active" : "status-badge inactive"}><span />{active ? low ? "Low stock" : "Active" : "Inactive"}</span>;
}

function InvoiceCard({ invoice }: { invoice: Invoice }) {
  return (
    <article className="invoice-card">
      <header><div><strong>{invoice.invoiceNumber}</strong><span>{formatDate(invoice.createdAt)}</span></div><strong className="invoice-total">{formatMoney(invoice.totalMinor)}</strong></header>
      <div className="invoice-lines">{invoice.items.map((item) => <div className="invoice-line" key={item.id}><span><strong>{item.sku}</strong> · {item.name}<small>{formatMeters(item.quantityMm)} × {formatMoney(item.unitPriceMinor)} / m</small></span><strong>{formatMoney(item.lineTotalMinor)}</strong></div>)}</div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function FormField({ label, required = false, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return <label className="form-field"><span>{label}{required && <b> *</b>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header"><h2>{title}</h2><button className="close-button" onClick={onClose} aria-label="Close dialog">×</button></header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><span className="empty-mark">▤</span><strong>{title}</strong><p>{copy}</p></div>;
}
