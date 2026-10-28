"use client";

import type { FormEvent } from "react";
import { businessConfig } from "@/config/business";
import { EmptyState, FormField, Metric, StatusBadge } from "@/components/management-ui";
import { InvoiceCard } from "@/components/invoice-card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatMoney } from "@/lib/format";
import PrintActions from "@/components/print-actions";
import type {
  CustomerDetails,
  CustomerReceipt,
  CustomerStatement,
  Invoice,
  SupplierStatement,
} from "@/shared/types";

export type CustomerTab = "overview" | "sales" | "payments" | "ledger";

export function CustomerDetailPage({
  details,
  tab,
  onTabChange,
  onEdit,
  onReceive,
  onReverseReceipt,
  onPrintReceipt,
  onPrintInvoice,
  statement,
  statementDates,
  onStatementDatesChange,
  onStatementSubmit,
}: {
  details: CustomerDetails;
  tab: CustomerTab;
  onTabChange: (tab: CustomerTab) => void;
  onEdit: () => void;
  onReceive: () => void;
  onReverseReceipt: (receipt: CustomerReceipt) => void;
  onPrintReceipt: (receipt: CustomerReceipt) => void;
  onPrintInvoice: (invoice: Invoice) => void;
  statement: CustomerStatement | null;
  statementDates: { from: string; to: string };
  onStatementDatesChange: (dates: { from: string; to: string }) => void;
  onStatementSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { customer } = details;
  const availableCreditMinor = Math.max(0, customer.creditLimitMinor - customer.outstandingMinor);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "overview" || value === "sales" || value === "payments" || value === "ledger") {
          onTabChange(value);
        }
      }}
      className="customer-detail-page"
    >
      <div className="detail-head">
        <div><span className="sku-label">{customer.code}</span><h2>{customer.name}</h2><p>{customer.phone || "No phone recorded"}{customer.address ? ` · ${customer.address}` : ""}</p></div>
        <StatusBadge active={customer.active} />
      </div>
      <div className="detail-metrics">
        <Metric label="Outstanding receivable" value={formatMoney(customer.outstandingMinor)} />
        <Metric label="Customer advances" value={formatMoney(customer.advanceMinor)} />
        <Metric label="Credit limit" value={formatMoney(customer.creditLimitMinor)} />
        <Metric label="Available credit" value={formatMoney(availableCreditMinor)} />
        <Metric label="Payment terms" value={`${customer.paymentTermsDays} days`} />
      </div>
      <div className="detail-actions customer-actions">
        <Button type="button" variant="outline" onClick={onEdit}>Edit customer</Button>
        <Button type="button" onClick={onReceive}>Record receipt / advance</Button>
      </div>
      <TabsList className="inventory-tabs customer-tabs" aria-label="Customer account details">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="sales">Sales</TabsTrigger>
        <TabsTrigger value="payments">Payments</TabsTrigger>
        <TabsTrigger value="ledger">Ledger</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="customer-tab-panel">
        <div className="customer-overview">
          <section className="panel customer-contact">
            <div className="section-heading panel-section-heading"><div><h2>Account overview</h2><p>Receivables and unallocated advances are tracked separately.</p></div></div>
            <dl><div><dt>Customer code</dt><dd>{customer.code}</dd></div><div><dt>Phone</dt><dd>{customer.phone || "—"}</dd></div><div><dt>Address</dt><dd>{customer.address || "—"}</dd></div><div><dt>Sales invoices</dt><dd>{customer.salesCount}</dd></div><div><dt>Receipts</dt><dd>{customer.receiptCount}</dd></div></dl>
          </section>
          <section className="panel customer-recent">
            <div className="section-heading panel-section-heading"><div><h2>Recent activity</h2><p>Latest sales and receipts for this account.</p></div></div>
            {details.sales.length === 0 && details.receipts.length === 0 ? <p className="muted-message">No customer transactions recorded.</p> : (
              <div className="history-block">
                {details.sales.slice(0, 3).map((invoice) => <div className="history-row" key={invoice.id}><div><strong>{invoice.invoiceNumber} · Sale</strong><span>{formatDate(invoice.createdAt)}</span></div><div className="history-price"><strong>{formatMoney(invoice.totalMinor)}</strong></div></div>)}
                {details.receipts.slice(0, 3).map((receipt) => <div className="history-row" key={receipt.id}><div><strong>{receipt.receiptNumber} · Receipt</strong><span>{formatDate(receipt.createdAt)} · {receipt.account.toUpperCase()}</span></div><div className="history-price"><strong>{formatMoney(receipt.amountMinor)}</strong></div></div>)}
              </div>
            )}
          </section>
        </div>
      </TabsContent>
      <TabsContent value="sales" className="customer-tab-panel">
        <div className="customer-tab-content">
          <div className="section-heading"><div><h2>Sales history</h2><p>Invoice totals and line prices are preserved as recorded.</p></div><span className="history-count">{details.sales.length} invoices</span></div>
          {details.sales.length === 0 ? <EmptyState title="No sales recorded" copy="Credit invoices for this customer will appear here." /> : <div className="invoice-list">{details.sales.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} onPrint={onPrintInvoice} />)}</div>}
        </div>
      </TabsContent>
      <TabsContent value="payments" className="customer-tab-panel">
        <div className="customer-tab-content">
          <div className="section-heading"><div><h2>Payments received</h2><p>Receipts are allocated to invoices or recorded as customer advances.</p></div><span className="history-count">{details.receipts.length} receipts</span></div>
          {details.receipts.length === 0 ? <EmptyState title="No receipts recorded" copy="Customer payments will appear here." /> : (
            <div className="panel"><div className="table-wrap"><table>
              <thead><tr><th>Receipt</th><th>Date</th><th>Payment method</th><th>Applied to</th><th>Reference / note</th><th>Amount</th><th>Actions</th></tr></thead>
              <tbody>{details.receipts.map((receipt) => <tr key={receipt.id}>
                <td><strong>{receipt.receiptNumber}</strong>{receipt.reversedAt && <small className="reversed-label">Reversed</small>}</td>
                <td>{formatDate(receipt.createdAt)}</td><td>{receipt.paymentMethod}</td><td>{receipt.invoiceNumber ?? "Advance"}</td>
                <td>{receipt.reference || receipt.note || "—"}{receipt.reversalReason && <small className="reversed-label">Reason: {receipt.reversalReason}</small>}</td>
                <td><strong>{formatMoney(receipt.amountMinor)}</strong></td>
                <td><div className="payment-history-actions"><Button type="button" variant="outline" size="sm" className="table-action" onClick={() => onPrintReceipt(receipt)}>Print</Button>{!receipt.reversedAt && <Button type="button" variant="destructive" size="sm" className="table-action danger" onClick={() => onReverseReceipt(receipt)}>Reverse</Button>}</div></td>
              </tr>)}</tbody>
            </table></div></div>
          )}
        </div>
      </TabsContent>
      <TabsContent value="ledger" className="customer-tab-panel">
        <div className="customer-statement-print">
          <div className="section-heading"><div><h2>Customer ledger statement</h2><p>Opening and closing balances are calculated from customer-linked AR postings.</p></div>
            {statement && <PrintActions label="Print statement" beforePrint={() => {
              document.body.classList.add("print-customer-statement");
              return () => document.body.classList.remove("print-customer-statement");
            }} />}
          </div>
          <form className="statement-filter" onSubmit={(event) => onStatementSubmit(event)}>
            <FormField label="From"><input type="date" required value={statementDates.from} onChange={(event) => onStatementDatesChange({ ...statementDates, from: event.target.value })} /></FormField>
            <FormField label="To"><input type="date" required value={statementDates.to} onChange={(event) => onStatementDatesChange({ ...statementDates, to: event.target.value })} /></FormField>
            <Button>Generate statement</Button>
          </form>
          {statement ? <StatementTable
            statement={statement}
            partyLabel={`Customer: ${customer.name} (${customer.code})`}
            partyDetails={`${customer.phone}${customer.address ? ` · ${customer.address}` : ""}`}
          /> : <p className="muted-message">Choose a date range to generate the customer ledger.</p>}
        </div>
      </TabsContent>
    </Tabs>
  );
}

export function StatementTable({
  statement,
  partyLabel,
  partyDetails,
}: {
  statement: SupplierStatement | CustomerStatement;
  partyLabel: string;
  partyDetails: string;
}) {
  return (
    <div className="statement-panel statement-printable">
      <header className="statement-document-heading">
        <h2>{businessConfig.name}</h2>
        <p>{businessConfig.contactInformation} · {businessConfig.address}</p>
        <strong>{partyLabel}</strong>
        {partyDetails && <span>{partyDetails}</span>}
        <span>Statement period: {statement.from} to {statement.to}</span>
      </header>
      <div className="statement-balances">
        <Metric label="Opening balance" value={formatMoney(statement.openingBalanceMinor)} />
        <Metric label="Closing balance" value={formatMoney(statement.closingBalanceMinor)} />
      </div>
      {statement.lines.length === 0 ? <p className="muted-message">No postings in this date range.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Posting</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
            <tbody>{statement.lines.map((line, index) => <tr key={`${line.createdAt}-${index}`}>
              <td>{formatDate(line.createdAt)}</td>
              <td className="capitalize">{line.transactionType.replaceAll("_", " ")}</td>
              <td>{line.reference}</td>
              <td>{line.debitMinor ? formatMoney(line.debitMinor) : "—"}</td>
              <td>{line.creditMinor ? formatMoney(line.creditMinor) : "—"}</td>
              <td><strong>{formatMoney(line.balanceMinor)}</strong></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="print-authorized">{businessConfig.authorizedFooter}</p>
    </div>
  );
}
