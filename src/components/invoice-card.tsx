import type { Invoice } from "@/shared/types";
import { formatDate, formatMeters, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";

export function InvoiceCard({ invoice, onPrint }: { invoice: Invoice; onPrint: (invoice: Invoice) => void }) {
  return (
    <article className="invoice-card">
      <header><div><strong>{invoice.invoiceNumber}</strong><span>{formatDate(invoice.createdAt)}{invoice.customerName ? ` · ${invoice.customerCode} ${invoice.customerName}` : " · Walk-in customer"}</span></div><strong className="invoice-total">{formatMoney(invoice.totalMinor)}</strong></header>
      <div className="invoice-lines">{invoice.items.map((item) => <div className="invoice-line" key={item.id}><span><strong>{item.sku}</strong> · {item.name}<small>{formatMeters(item.quantityMm)} × {formatMoney(item.unitPriceMinor)} / m</small></span><strong>{formatMoney(item.lineTotalMinor)}</strong></div>)}</div>
      <footer className="invoice-summary">
        <span>Subtotal <strong>{formatMoney(invoice.subtotalMinor)}</strong></span>
        <span>Discount <strong>{formatMoney(invoice.discountMinor)}</strong></span>
        <span>Received ({invoice.paymentAccount}) <strong>{formatMoney(invoice.amountReceivedMinor)}</strong></span>
        <span>Credit balance <strong>{formatMoney(invoice.dueMinor)}</strong></span>
      </footer>
      <Button type="button" variant="outline" size="sm" className="table-action no-print" onClick={() => onPrint(invoice)}>Preview / print invoice</Button>
    </article>
  );
}
