import type {
  Customer,
  Fabric,
  InventoryMovement,
  InventoryReport,
  Supplier,
} from "@/shared/types";
import { formatDate, formatMeters, formatMoney } from "@/lib/format";
import { EmptyState, StatusBadge } from "@/components/management-ui";
import { Button } from "@/components/ui/button";

export function FabricTable({
  fabrics,
  loading,
  stockView = false,
  onDetails,
  onEdit,
  onAdjust,
}: {
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
                <td>
                  <div className="row-actions">
                    <Button type="button" variant="ghost" size="icon" title="Adjust stock" aria-label={`Adjust stock for ${fabric.sku}`} onClick={() => onAdjust(fabric)}>±</Button>
                    <Button type="button" variant="ghost" size="icon" title="Edit fabric" aria-label={`Edit ${fabric.sku}`} onClick={() => onEdit(fabric)}>···</Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MovementTable({ movements }: { movements: InventoryMovement[] }) {
  if (movements.length === 0) return <EmptyState title="No stock movements" copy="Opening stock, supplier receipts, sales and manual adjustments will appear here." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Fabric</th><th>Type</th><th>Quantity</th><th>Reference / reason</th><th>Recorded by</th></tr></thead>
        <tbody>{movements.map((movement) => <tr key={movement.id}>
          <td>{formatDate(movement.createdAt)}</td>
          <td><strong>{movement.sku}</strong><br /><span className="cell-muted">{movement.fabricName}</span></td>
          <td className="capitalize">{movement.movementType}</td>
          <td className={movement.quantityMm < 0 ? "movement-negative" : "movement-positive"}>{movement.quantityMm > 0 ? "+" : ""}{formatMeters(movement.quantityMm)}</td>
          <td><strong>{movement.reference}</strong><br /><span className="cell-muted">{movement.reason}</span></td>
          <td>{movement.authorizedUser}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export function ValuationTable({ report }: { report: InventoryReport | null }) {
  if (!report || report.valuation.length === 0) return <EmptyState title="No inventory to value" copy="Record opening stock or a supplier purchase to begin inventory valuation." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Fabric</th><th>On hand</th><th>Average cost / m</th><th>Inventory value</th><th>Reorder point</th></tr></thead>
        <tbody>{report.valuation.map((item) => <tr key={item.fabricId}>
          <td><strong>{item.sku}</strong><br /><span className="cell-muted">{item.name}</span></td>
          <td>{formatMeters(item.stockQtyMm)}</td>
          <td>{formatMoney(item.unitCostMinor)}</td>
          <td><strong>{formatMoney(item.valueMinor)}</strong></td>
          <td>{formatMeters(item.reorderThresholdMm)}{item.lowStock && <StatusBadge active low />}</td>
        </tr>)}</tbody>
      </table>
      <div className="report-total"><span>Active stock valuation</span><strong>{formatMoney(report.totalValuationMinor)}</strong></div>
    </div>
  );
}

export function SupplierTable({ suppliers, onOpen }: { suppliers: Supplier[]; onOpen: (supplier: Supplier) => void }) {
  if (suppliers.length === 0) return <EmptyState title="No suppliers found" copy="Add a fabric supplier to track purchases and outstanding balances." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Supplier</th><th>Phone / contact</th><th>Purchases</th><th>Payments</th><th>Outstanding balance</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{suppliers.map((supplier) => <tr key={supplier.id}>
          <td><button className="fabric-link" onClick={() => onOpen(supplier)}><strong>{supplier.name}</strong><span>{supplier.code}</span></button></td>
          <td>{supplier.phone}{supplier.contactName ? <><br /><span className="cell-muted">{supplier.contactName}</span></> : null}</td>
          <td>{supplier.purchaseCount}</td>
          <td>{supplier.paymentCount}</td>
          <td><strong>{formatMoney(supplier.outstandingMinor)}</strong></td>
          <td><Button type="button" variant="outline" size="sm" onClick={() => onOpen(supplier)}>View account</Button></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export function CustomerTable({ customers, onOpen }: { customers: Customer[]; onOpen: (customer: Customer) => void }) {
  if (customers.length === 0) return <EmptyState title="No customers found" copy="Add a customer to track credit sales, receipts and statements." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Customer</th><th>Phone</th><th>Sales</th><th>Receipts</th><th>Credit limit</th><th>Outstanding</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{customers.map((customer) => <tr key={customer.id}>
          <td><button className="fabric-link" onClick={() => onOpen(customer)}><strong>{customer.name}</strong><span>{customer.code}</span></button></td>
          <td>{customer.phone || "—"}</td>
          <td>{customer.salesCount}</td>
          <td>{customer.receiptCount}</td>
          <td>{formatMoney(customer.creditLimitMinor)}</td>
          <td><strong>{formatMoney(customer.outstandingMinor)}</strong></td>
          <td><Button type="button" variant="outline" size="sm" onClick={() => onOpen(customer)}>View account</Button></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}
