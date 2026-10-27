"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { businessConfig } from "@/config/business";
import { getDesktopApi } from "@/lib/desktop-api";
import { fabricInputSchema } from "@/shared/contracts";
import PrintActions from "./print-actions";
import SalesPos from "./sales-pos";
import ExpensesManagement from "./expenses-management";
import ReportsManagement from "./reports-management";
import ReturnsManagement from "./returns-management";
import BackupManagement from "./backup-management";
import type {
  Fabric,
  FabricDetails,
  InventoryMovement,
  InventoryReport,
  Invoice,
  Customer,
  CustomerDetails,
  CustomerReceipt,
  CustomerStatement,
  PaymentAccount,
  StockSummary,
  Supplier,
  SupplierDetails,
  SupplierPayment,
  SupplierPurchase,
  SupplierStatement,
} from "@/shared/types";

type Section = "pos" | "fabrics" | "stock" | "suppliers" | "customers" | "invoices" | "expenses" | "reports" | "returns" | "backups";
type StatusFilter = "active" | "all" | "inactive" | "low-stock";
type InventoryView = "overview" | "movements" | "low-stock" | "valuation";
type CustomerTab = "overview" | "sales" | "payments" | "ledger";

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

function getLocalDateInputValue(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  const [section, setSection] = useState<Section>("pos");
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
  const [adjustmentPin, setAdjustmentPin] = useState("");
  const [inventoryReport, setInventoryReport] = useState<InventoryReport | null>(null);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [inventoryView, setInventoryView] = useState<InventoryView>("overview");
  const [openingStockOpen, setOpeningStockOpen] = useState(false);
  const [openingValues, setOpeningValues] = useState({
    fabricId: "",
    quantityMeters: "",
    unitCost: "",
    reference: "",
    reason: "",
    ownerPin: "",
  });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierDetails, setSupplierDetails] = useState<SupplierDetails | null>(null);
  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierFormOpen, setSupplierFormOpen] = useState(false);
  const [supplierEditing, setSupplierEditing] = useState<Supplier | null>(null);
  const [supplierValues, setSupplierValues] = useState({
    code: "",
    name: "",
    phone: "",
    address: "",
    contactName: "",
    email: "",
    openingBalance: "",
    ownerPin: "",
  });
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseValues, setPurchaseValues] = useState({
    billNumber: "",
    reference: "",
    purchaseDate: getLocalDateInputValue(),
    additionalCosts: "",
    additionalCostsDescription: "",
    paymentMode: "credit" as "credit" | "cash" | "bank",
    amountPaid: "",
    paymentAccount: "cash" as "cash" | "bank",
  });
  const [purchaseItems, setPurchaseItems] = useState([{ fabricId: "", quantityMeters: "", unitCost: "" }]);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentValues, setPaymentValues] = useState({
    amount: "",
    accountCode: "1000",
    reference: "",
    note: "",
    purchaseId: "",
  });
  const [paymentPreview, setPaymentPreview] = useState<SupplierPayment | null>(null);
  const [purchasePreview, setPurchasePreview] = useState<SupplierPurchase | null>(null);
  const [supplierAdjustmentOpen, setSupplierAdjustmentOpen] = useState(false);
  const [supplierAdjustmentValues, setSupplierAdjustmentValues] = useState({
    direction: "increase" as "increase" | "decrease",
    amount: "",
    reason: "",
    ownerPin: "",
  });
  const [statement, setStatement] = useState<SupplierStatement | null>(null);
  const [statementDates, setStatementDates] = useState({
    from: new Date().toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });
  const [pinConfigured, setPinConfigured] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinSetupValues, setPinSetupValues] = useState({ pin: "", confirmation: "" });
  const [apReconciliation, setApReconciliation] = useState<{ controlMinor: number; subledgerMinor: number; differenceMinor: number } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerDetails, setCustomerDetails] = useState<CustomerDetails | null>(null);
  const [customerTab, setCustomerTab] = useState<CustomerTab>("overview");
  const [customerFormOpen, setCustomerFormOpen] = useState(false);
  const [customerEditing, setCustomerEditing] = useState<Customer | null>(null);
  const [customerValues, setCustomerValues] = useState({
    code: "",
    name: "",
    phone: "",
    address: "",
    openingBalance: "",
    creditLimit: "",
    paymentTermsDays: "0",
    ownerPin: "",
  });
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptValues, setReceiptValues] = useState({
    amount: "",
    accountCode: "1000",
    invoiceId: "",
    reference: "",
    note: "",
  });
  const [receiptPreview, setReceiptPreview] = useState<CustomerReceipt | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<Invoice | null>(null);
  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([]);
  const [customerStatement, setCustomerStatement] = useState<CustomerStatement | null>(null);
  const [customerStatementDates, setCustomerStatementDates] = useState({
    from: new Date().toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });
  const [saleCustomerId, setSaleCustomerId] = useState("");

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

  async function refreshManagement() {
    const [reportResult, movementResult, supplierResult, reconciliationResult, customerResult, accountResult] = await Promise.all([
      getDesktopApi().inventory.report(),
      getDesktopApi().inventory.movements(),
      getDesktopApi().suppliers.list({ query: supplierSearch, includeInactive: true }),
      getDesktopApi().suppliers.reconcile(),
      getDesktopApi().customers.list({ query: "", includeInactive: true }),
      getDesktopApi().customers.paymentAccounts(),
    ]);
    if (!reportResult.ok) throw new Error(reportResult.error.message);
    if (!movementResult.ok) throw new Error(movementResult.error.message);
    if (!supplierResult.ok) throw new Error(supplierResult.error.message);
    if (!reconciliationResult.ok) throw new Error(reconciliationResult.error.message);
    if (!customerResult.ok) throw new Error(customerResult.error.message);
    if (!accountResult.ok) throw new Error(accountResult.error.message);
    setInventoryReport(reportResult.data);
    setMovements(movementResult.data);
    setSuppliers(supplierResult.data);
    setApReconciliation(reconciliationResult.data);
    setCustomers(customerResult.data);
    setPaymentAccounts(accountResult.data);

    const pinResult = await getDesktopApi().auth.pinStatus();
    if (pinResult.ok) setPinConfigured(pinResult.data.configured);
    else {
      setPinConfigured(false);
      setError(pinResult.error.message);
    }
  }

  useEffect(() => {
    void refreshManagement().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "Unable to load inventory and supplier information.");
    });
  }, [supplierSearch]);

  const visibleCustomers = useMemo(() => {
    const query = customerSearch.trim().toLocaleLowerCase();
    if (!query) return customers;
    return customers.filter((customer) =>
      [customer.code, customer.name, customer.phone].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [customers, customerSearch]);

  async function handleSalePosted(invoice: Invoice) {
    setInvoices((current) => [invoice, ...current.filter((item) => item.id !== invoice.id)]);
    await Promise.all([refreshCatalog(), refreshManagement()]);
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
    setAdjustmentPin("");
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
    const customerId = saleCustomerId;
    try {
      const result = await getDesktopApi().invoices.create({
        ...(customerId ? { customerId } : {}),
        items: [{
          fabricId: details.fabric.id,
          quantityMeters: Number(saleQuantity),
        }],
      });
      if (!result.ok) throw new Error(result.error.message);
      await Promise.all([
        refreshCatalog(),
        ...(customerId ? [refreshManagement()] : []),
      ]);
      await openDetails(details.fabric);
      setNotice(`Invoice ${result.data.invoiceNumber} recorded.`);
      setSaleCustomerId("");
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
        ownerPin: adjustmentPin,
      });
      if (!result.ok) throw new Error(result.error.message);
      await Promise.all([refreshCatalog(), refreshManagement()]);
      setAdjustment(null);
      setAdjustmentPin("");
      setNotice("Stock movement recorded.");
      setTimeout(() => setNotice(""), 3000);
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : "Unable to adjust stock.");
    } finally {
      setSaving(false);
    }
  }

  async function saveOpeningStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().inventory.opening({
        fabricId: openingValues.fabricId,
        quantityMeters: Number(openingValues.quantityMeters),
        unitCost: Number(openingValues.unitCost),
        reference: openingValues.reference,
        reason: openingValues.reason,
        ownerPin: openingValues.ownerPin,
      });
      if (!result.ok) throw new Error(result.error.message);
      await Promise.all([refreshCatalog(), refreshManagement()]);
      setOpeningStockOpen(false);
      setOpeningValues({ fabricId: "", quantityMeters: "", unitCost: "", reference: "", reason: "", ownerPin: "" });
      setNotice("Opening stock and inventory value recorded.");
    } catch (openingError) {
      setError(openingError instanceof Error ? openingError.message : "Unable to record opening stock.");
    } finally {
      setSaving(false);
    }
  }

  async function openSupplier(supplier: Supplier) {
    setError("");
    try {
      const result = await getDesktopApi().suppliers.get({ id: supplier.id });
      if (!result.ok) throw new Error(result.error.message);
      setSupplierDetails(result.data);
      setStatement(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load supplier details.");
    }
  }

  function openSupplierForm(supplier?: Supplier) {
    setSupplierEditing(supplier ?? null);
    setSupplierValues(supplier ? {
      code: supplier.code,
      name: supplier.name,
      phone: supplier.phone,
      address: supplier.address,
      contactName: supplier.contactName,
      email: supplier.email,
      openingBalance: "",
      ownerPin: "",
    } : {
      code: "",
      name: "",
      phone: "",
      address: "",
      contactName: "",
      email: "",
      openingBalance: "",
      ownerPin: "",
    });
    setSupplierFormOpen(true);
    setError("");
  }

  async function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = supplierEditing
        ? await getDesktopApi().suppliers.update({
          id: supplierEditing.id,
          code: supplierValues.code,
          name: supplierValues.name,
          phone: supplierValues.phone,
          address: supplierValues.address,
          contactName: supplierValues.contactName,
          email: supplierValues.email,
        })
        : await getDesktopApi().suppliers.create({
          code: supplierValues.code,
          name: supplierValues.name,
          phone: supplierValues.phone,
          address: supplierValues.address,
          contactName: supplierValues.contactName,
          email: supplierValues.email,
          openingBalance: Number(supplierValues.openingBalance || 0),
          ownerPin: supplierValues.ownerPin,
        });
      if (!result.ok) throw new Error(result.error.message);
      await refreshManagement();
      setSupplierFormOpen(false);
      setNotice(supplierEditing ? "Supplier details updated." : "Supplier added.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save supplier.");
    } finally {
      setSaving(false);
    }
  }

  function openCustomerForm(customer?: Customer) {
    setCustomerEditing(customer ?? null);
    setCustomerValues(customer ? {
      code: customer.code,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      openingBalance: "",
      creditLimit: String(customer.creditLimitMinor / 100),
      paymentTermsDays: String(customer.paymentTermsDays),
      ownerPin: "",
    } : {
      code: "",
      name: "",
      phone: "",
      address: "",
      openingBalance: "",
      creditLimit: "",
      paymentTermsDays: "0",
      ownerPin: "",
    });
    setCustomerFormOpen(true);
    setError("");
  }

  async function saveCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const customerInput = {
        code: customerValues.code,
        name: customerValues.name,
        phone: customerValues.phone,
        address: customerValues.address,
        creditLimit: Number(customerValues.creditLimit || 0),
        paymentTermsDays: Number(customerValues.paymentTermsDays),
      };
      const result = customerEditing
        ? await getDesktopApi().customers.update({ ...customerInput, id: customerEditing.id })
        : await getDesktopApi().customers.create({
          ...customerInput,
          openingBalance: Number(customerValues.openingBalance || 0),
          ownerPin: customerValues.ownerPin,
        });
      if (!result.ok) throw new Error(result.error.message);
      await refreshManagement();
      setCustomerFormOpen(false);
      if (customerEditing) {
        const detailResult = await getDesktopApi().customers.get({ id: customerEditing.id });
        if (!detailResult.ok) throw new Error(detailResult.error.message);
        setCustomerDetails(detailResult.data);
      }
      setNotice(customerEditing ? "Customer details updated." : "Customer added.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save customer.");
    } finally {
      setSaving(false);
    }
  }

  async function openCustomer(customer: Customer) {
    setError("");
    setCustomerTab("overview");
    setCustomerStatement(null);
    try {
      const result = await getDesktopApi().customers.get({ id: customer.id });
      if (!result.ok) throw new Error(result.error.message);
      setCustomerDetails(result.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load customer details.");
    }
  }

  async function saveCustomerReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerDetails) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().customers.receive({
        customerId: customerDetails.customer.id,
        ...(receiptValues.invoiceId ? { invoiceId: receiptValues.invoiceId } : {}),
        amount: Number(receiptValues.amount),
        accountCode: receiptValues.accountCode,
        reference: receiptValues.reference,
        note: receiptValues.note,
      });
      if (!result.ok) throw new Error(result.error.message);
      setCustomerDetails(result.data);
      setReceiptPreview(result.data.receipts[0] ?? null);
      setCustomerStatement(null);
      setReceiptOpen(false);
      setReceiptValues({ amount: "", accountCode: "1000", invoiceId: "", reference: "", note: "" });
      setNotice("Customer receipt posted and saved.");
      try {
        await Promise.all([refreshCatalog(), refreshManagement()]);
      } catch (refreshError) {
        setError(`Receipt ${result.data.receipts[0]?.receiptNumber ?? ""} was saved, but balances could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "refresh failed"}`);
      }
    } catch (receiptError) {
      setError(receiptError instanceof Error ? receiptError.message : "Unable to record customer receipt.");
    } finally {
      setSaving(false);
    }
  }

  async function reverseCustomerReceipt(receipt: CustomerReceipt) {
    const reason = window.prompt(`Why are you reversing receipt ${receipt.receiptNumber}?`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError("A reversal reason is required.");
      return;
    }
    const ownerPin = window.prompt("Enter the owner PIN to authorize this reversal.");
    if (ownerPin === null) return;
    if (!/^\d{6,64}$/.test(ownerPin)) {
      setError("Enter a valid owner PIN.");
      return;
    }
    if (!customerDetails) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().customers.reverseReceipt({
        receiptId: receipt.id,
        reason,
        ownerPin,
      });
      if (!result.ok) throw new Error(result.error.message);
      setCustomerDetails(result.data);
      setCustomerStatement(null);
      setNotice(`Receipt ${receipt.receiptNumber} reversed.`);
      try {
        await Promise.all([refreshCatalog(), refreshManagement()]);
      } catch (refreshError) {
        setError(`Receipt ${receipt.receiptNumber} was reversed, but balances could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "refresh failed"}`);
      }
    } catch (reversalError) {
      setError(reversalError instanceof Error ? reversalError.message : "Unable to reverse this customer receipt.");
    } finally {
      setSaving(false);
    }
  }

  async function loadCustomerStatement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerDetails) return;
    setError("");
    try {
      const result = await getDesktopApi().customers.statement({
        customerId: customerDetails.customer.id,
        from: customerStatementDates.from,
        to: customerStatementDates.to,
      });
      if (!result.ok) throw new Error(result.error.message);
      setCustomerStatement(result.data);
    } catch (statementError) {
      setError(statementError instanceof Error ? statementError.message : "Unable to generate customer ledger.");
    }
  }

  async function savePurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierDetails) return;
    setSaving(true);
    setError("");
    try {
      const additionalCosts = Number(purchaseValues.additionalCosts || 0);
      const purchaseTotal = purchaseItems.reduce((sum, item) => {
        const quantityMm = Math.round(Number(item.quantityMeters) * 1000);
        const unitCostMinor = Math.round(Number(item.unitCost) * 100);
        return sum + Math.round(quantityMm * unitCostMinor / 1000);
      }, Math.round(additionalCosts * 100));
      const result = await getDesktopApi().suppliers.receive({
        supplierId: supplierDetails.supplier.id,
        billNumber: purchaseValues.billNumber,
        reference: purchaseValues.reference,
        purchaseDate: purchaseValues.purchaseDate,
        additionalCosts: Number(purchaseValues.additionalCosts || 0),
        additionalCostsDescription: purchaseValues.additionalCostsDescription,
        paymentMode: purchaseValues.paymentMode,
        amountPaid: purchaseValues.paymentMode === "credit"
          ? Number(purchaseValues.amountPaid || 0)
          : purchaseTotal / 100,
        paymentAccount: purchaseValues.paymentAccount,
        items: purchaseItems.map((item) => ({
          fabricId: item.fabricId,
          quantityMeters: Number(item.quantityMeters),
          unitCost: Number(item.unitCost),
        })),
      });
      if (!result.ok) throw new Error(result.error.message);
      setSupplierDetails(result.data);
      await Promise.all([refreshCatalog(), refreshManagement()]);
      setPurchaseOpen(false);
      setPurchaseValues({
        billNumber: "",
        reference: "",
        purchaseDate: getLocalDateInputValue(),
        additionalCosts: "",
        additionalCostsDescription: "",
        paymentMode: "credit",
        amountPaid: "",
        paymentAccount: "cash",
      });
      setPurchaseItems([{ fabricId: "", quantityMeters: "", unitCost: "" }]);
      setNotice("Supplier bill and stock receipt posted together.");
    } catch (purchaseError) {
      setError(purchaseError instanceof Error ? purchaseError.message : "Unable to receive supplier purchase.");
    } finally {
      setSaving(false);
    }
  }

  async function savePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierDetails) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().suppliers.pay({
        supplierId: supplierDetails.supplier.id,
        ...(paymentValues.purchaseId ? { purchaseId: paymentValues.purchaseId } : {}),
        amount: Number(paymentValues.amount),
        accountCode: paymentValues.accountCode,
        reference: paymentValues.reference,
        note: paymentValues.note,
      });
      if (!result.ok) throw new Error(result.error.message);
      setSupplierDetails(result.data);
      setPaymentPreview(result.data.payments[0] ?? null);
      setPaymentOpen(false);
      setPaymentValues({ amount: "", accountCode: "1000", reference: "", note: "", purchaseId: "" });
      setNotice("Supplier payment and Accounts Payable posting recorded.");
      try {
        await refreshManagement();
      } catch (refreshError) {
        setError(`Payment ${result.data.payments[0]?.paymentNumber ?? ""} was recorded, but balances could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "refresh failed"}`);
      }
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "Unable to record supplier payment.");
    } finally {
      setSaving(false);
    }
  }

  async function reverseSupplierPayment(payment: SupplierPayment) {
    const reason = window.prompt(`Why are you reversing payment ${payment.paymentNumber}?`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError("A reversal reason is required.");
      return;
    }
    const ownerPin = window.prompt("Enter the owner PIN to authorize this reversal.");
    if (ownerPin === null) return;
    if (!/^\d{6,64}$/.test(ownerPin)) {
      setError("Enter a valid owner PIN.");
      return;
    }
    if (!supplierDetails) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().suppliers.reversePayment({
        paymentId: payment.id,
        reason,
        ownerPin,
      });
      if (!result.ok) throw new Error(result.error.message);
      setSupplierDetails(result.data);
      setNotice(`Payment ${payment.paymentNumber} reversed.`);
      try {
        await refreshManagement();
      } catch (refreshError) {
        setError(`Payment ${payment.paymentNumber} was reversed, but balances could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "refresh failed"}`);
      }
    } catch (reversalError) {
      setError(reversalError instanceof Error ? reversalError.message : "Unable to reverse this supplier payment.");
    } finally {
      setSaving(false);
    }
  }

  async function saveSupplierAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierDetails) return;
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().suppliers.adjust({
        supplierId: supplierDetails.supplier.id,
        direction: supplierAdjustmentValues.direction,
        amount: Number(supplierAdjustmentValues.amount),
        reason: supplierAdjustmentValues.reason,
        ownerPin: supplierAdjustmentValues.ownerPin,
      });
      if (!result.ok) throw new Error(result.error.message);
      setSupplierDetails(result.data);
      await refreshManagement();
      setSupplierAdjustmentOpen(false);
      setSupplierAdjustmentValues({ direction: "increase", amount: "", reason: "", ownerPin: "" });
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : "Unable to adjust supplier balance.");
    } finally {
      setSaving(false);
    }
  }

  async function loadSupplierStatement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierDetails) return;
    setError("");
    try {
      const result = await getDesktopApi().suppliers.statement({
        supplierId: supplierDetails.supplier.id,
        from: statementDates.from,
        to: statementDates.to,
      });
      if (!result.ok) setError(result.error.message);
      else setStatement(result.data);
    } catch (statementError) {
      setError(statementError instanceof Error ? statementError.message : "Unable to generate supplier statement.");
    }
  }

  async function saveOwnerPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await getDesktopApi().auth.setPin(pinSetupValues);
      if (!result.ok) throw new Error(result.error.message);
      setPinConfigured(result.data.configured);
      setPinSetupOpen(false);
      setPinSetupValues({ pin: "", confirmation: "" });
      setNotice("Owner PIN set up using secure device storage.");
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "Unable to set up owner PIN.");
    } finally {
      setSaving(false);
    }
  }

  const pageTitle = section === "pos"
    ? "New sale"
    : section === "fabrics"
    ? "Fabric qualities"
    : section === "stock"
      ? "Inventory"
      : section === "suppliers"
        ? "Suppliers"
        : section === "customers"
          ? customerDetails?.customer.name ?? "Customers"
          : section === "expenses"
            ? "Expenses & cashbook"
            : section === "reports"
              ? "Reports & analytics"
              : section === "returns"
                ? "Returns & audit"
                : section === "backups"
                  ? "Backup & recovery"
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
          <button className={section === "pos" ? "nav-item active" : "nav-item"} onClick={() => setSection("pos")}>
            <span className="nav-icon">＋</span> New sale
          </button>
          <button className={section === "fabrics" ? "nav-item active" : "nav-item"} onClick={() => setSection("fabrics")}>
            <span className="nav-icon">▤</span> Fabric catalog
          </button>
          <button className={section === "stock" ? "nav-item active" : "nav-item"} onClick={() => setSection("stock")}>
            <span className="nav-icon">▥</span> Inventory
            {lowStockFabrics.length > 0 && <span className="nav-count">{lowStockFabrics.length}</span>}
          </button>
          <button className={section === "suppliers" ? "nav-item active" : "nav-item"} onClick={() => setSection("suppliers")}>
            <span className="nav-icon">♧</span> Suppliers
          </button>
          <button className={section === "customers" ? "nav-item active" : "nav-item"} onClick={() => setSection("customers")}>
            <span className="nav-icon">♙</span> Customers
          </button>
          <button className={section === "invoices" ? "nav-item active" : "nav-item"} onClick={() => setSection("invoices")}>
            <span className="nav-icon">▧</span> Sales history
          </button>
          <button className={section === "expenses" ? "nav-item active" : "nav-item"} onClick={() => setSection("expenses")}>
            <span className="nav-icon">₨</span> Expenses & cashbook
          </button>
          <button className={section === "reports" ? "nav-item active" : "nav-item"} onClick={() => setSection("reports")}>
            <span className="nav-icon">▤</span> Reports & analytics
          </button>
          <button className={section === "returns" ? "nav-item active" : "nav-item"} onClick={() => setSection("returns")}>
            <span className="nav-icon">↶</span> Returns & audit
          </button>
          <button className={section === "backups" ? "nav-item active" : "nav-item"} onClick={() => setSection("backups")}>
            <span className="nav-icon">⤓</span> Backup & recovery
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
          {section === "stock" && (
            <div className="topbar-actions">
              {!pinConfigured && <button className="secondary-button" onClick={() => setPinSetupOpen(true)}>Set up owner PIN</button>}
              <button className="primary-button" onClick={() => {
                setOpeningValues({ fabricId: "", quantityMeters: "", unitCost: "", reference: "", reason: "", ownerPin: "" });
                setOpeningStockOpen(true);
              }}><span>+</span> Opening stock</button>
            </div>
          )}
          {section === "suppliers" && (
            <div className="topbar-actions">
              {!pinConfigured && <button className="secondary-button" onClick={() => setPinSetupOpen(true)}>Set up owner PIN</button>}
              <button className="primary-button" onClick={() => openSupplierForm()}><span>+</span> Add supplier</button>
            </div>
          )}
          {section === "customers" && (
            <div className="topbar-actions">
              {customerDetails && <button className="secondary-button" onClick={() => { setCustomerDetails(null); setCustomerStatement(null); }}>Back to customers</button>}
              {!customerDetails && !pinConfigured && <button className="secondary-button" onClick={() => setPinSetupOpen(true)}>Set up owner PIN</button>}
              {!customerDetails && <button className="primary-button" onClick={() => openCustomerForm()}><span>+</span> Add customer</button>}
            </div>
          )}
          {section === "pos" && (
            <button className="secondary-button" onClick={() => setSection("invoices")}>Sales history</button>
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

          {section === "pos" && <SalesPos customers={customers} onPosted={handleSalePosted} />}
          {section === "expenses" && <ExpensesManagement />}
          {section === "reports" && <ReportsManagement />}
          {section === "returns" && <ReturnsManagement />}
          {section === "backups" && <BackupManagement />}

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
                <SummaryCard label="Low stock" value={inventoryReport?.lowStockCount ?? stock?.lowStockCount ?? "—"} icon="!" warning={Boolean(inventoryReport?.lowStockCount)} />
                <SummaryCard label="Total stock" value={formatMeters(inventoryReport?.totalStockMm ?? stock?.totalStockMm ?? 0)} icon="▥" />
                <SummaryCard label="Inventory valuation" value={formatMoney(inventoryReport?.totalValuationMinor ?? 0)} icon="₨" />
              </div>
              <div className="inventory-tabs" role="tablist" aria-label="Inventory reports">
                {([
                  ["overview", "Overview"],
                  ["movements", "Movement history"],
                  ["low-stock", "Low stock"],
                  ["valuation", "Valuation"],
                ] as Array<[InventoryView, string]>).map(([view, label]) => (
                  <button key={view} className={inventoryView === view ? "active" : ""} onClick={() => setInventoryView(view)}>{label}</button>
                ))}
              </div>
              {inventoryView === "overview" && (
                <>
                  {!pinConfigured && <div className="error-banner" role="status">Manual stock changes require an owner PIN stored in the operating system keychain.</div>}
                  <div className="section-heading"><div><h2>Stock by fabric</h2><p>All quantities are stored in millimeters and displayed in meters.</p></div></div>
                  <div className="panel"><FabricTable fabrics={stock?.fabrics ?? []} loading={loading} stockView onDetails={openDetails} onEdit={openEditForm} onAdjust={openAdjustment} /></div>
                </>
              )}
              {inventoryView === "movements" && (
                <div className="panel">
                  <div className="section-heading panel-section-heading"><div><h2>Stock movement history</h2><p>Each entry records its reference, actor and timestamp.</p></div></div>
                  <MovementTable movements={movements} />
                </div>
              )}
              {inventoryView === "low-stock" && (
                <div className="panel">
                  <div className="section-heading panel-section-heading"><div><h2>Low-stock report</h2><p>Active fabrics at or below their reorder threshold.</p></div></div>
                  <FabricTable fabrics={stock?.fabrics.filter((fabric) => fabric.active && fabric.stockMm <= fabric.reorderThresholdMm) ?? []} loading={loading} stockView onDetails={openDetails} onEdit={openEditForm} onAdjust={openAdjustment} />
                </div>
              )}
              {inventoryView === "valuation" && (
                <div className="panel">
                  <div className="section-heading panel-section-heading"><div><h2>Inventory valuation</h2><p>Based on recorded stock value using weighted-average purchase cost.</p></div></div>
                  <ValuationTable report={inventoryReport} />
                </div>
              )}
            </>
          )}

          {section === "suppliers" && (
            <>
              <div className="summary-grid stock-summary-grid">
                <SummaryCard label="Suppliers" value={suppliers.length} icon="♧" />
                <SummaryCard label="Accounts Payable" value={formatMoney(suppliers.reduce((sum, supplier) => sum + supplier.outstandingMinor, 0))} icon="₨" />
                <SummaryCard label="AP reconciliation" value={apReconciliation?.differenceMinor === 0 ? "Balanced" : formatMoney(apReconciliation?.differenceMinor ?? 0)} icon={apReconciliation?.differenceMinor === 0 ? "✓" : "!"} warning={Boolean(apReconciliation?.differenceMinor)} />
              </div>
              {apReconciliation && apReconciliation.differenceMinor !== 0 && <div className="error-banner" role="alert">Supplier subledger differs from the Accounts Payable control account by {formatMoney(apReconciliation.differenceMinor)}.</div>}
              <div className="panel">
                <div className="panel-toolbar">
                  <label className="search-field"><span aria-hidden="true">⌕</span><input value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} placeholder="Search supplier code, name, phone…" aria-label="Search suppliers" /></label>
                  <span className="history-count">{suppliers.length} suppliers</span>
                </div>
                <SupplierTable suppliers={suppliers} onOpen={(supplier) => void openSupplier(supplier)} />
              </div>
            </>
          )}

          {section === "customers" && (
            customerDetails ? (
              <CustomerDetailPage
                details={customerDetails}
                tab={customerTab}
                onTabChange={(tab) => setCustomerTab(tab)}
                onEdit={() => openCustomerForm(customerDetails.customer)}
                onReverseReceipt={(receipt) => void reverseCustomerReceipt(receipt)}
                onPrintReceipt={(receipt) => setReceiptPreview(receipt)}
                onPrintInvoice={(invoice) => setInvoicePreview(invoice)}
                onReceive={() => {
                  setReceiptValues({
                    amount: "",
                    accountCode: paymentAccounts[0]?.code ?? "1000",
                    invoiceId: "",
                    reference: "",
                    note: "",
                  });
                  setReceiptOpen(true);
                }}
                statement={customerStatement}
                statementDates={customerStatementDates}
                onStatementDatesChange={(dates) => {
                  setCustomerStatementDates(dates);
                  setCustomerStatement(null);
                }}
                onStatementSubmit={(event) => void loadCustomerStatement(event)}
              />
            ) : (
              <>
                <div className="summary-grid stock-summary-grid">
                  <SummaryCard label="Customers" value={customers.length} icon="♙" />
                  <SummaryCard label="Accounts Receivable" value={formatMoney(customers.reduce((sum, customer) => sum + customer.outstandingMinor, 0))} icon="₨" />
                  <SummaryCard label="Credit customers" value={customers.filter((customer) => customer.creditLimitMinor > 0).length} icon="↗" />
                  <SummaryCard label="Open balances" value={customers.filter((customer) => customer.outstandingMinor > 0).length} icon="◷" />
                </div>
                <div className="panel">
                  <div className="panel-toolbar">
                    <label className="search-field">
                      <span aria-hidden="true">⌕</span>
                      <input value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Search customer code, name, phone…" aria-label="Search customers" />
                    </label>
                    <span className="history-count">{customers.length} customers</span>
                  </div>
                  <CustomerTable customers={visibleCustomers} onOpen={(customer) => void openCustomer(customer)} />
                </div>
              </>
            )
          )}

          {section === "invoices" && (
            <>
              <div className="section-heading">
                <div><h2>Completed invoices</h2><p>Each line keeps the name, SKU and rate from when it was sold.</p></div>
                <div className="topbar-actions"><span className="history-count">{invoices.length} invoices</span><button className="primary-button" onClick={() => setSection("pos")}>+ New sale</button></div>
              </div>
              {invoices.length === 0 ? (
                <EmptyState title="No invoices yet" copy="Start a new sale to build your sales history." />
              ) : (
                <div className="invoice-list">
                  {invoices.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} onPrint={setInvoicePreview} />)}
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

      {receiptPreview && customerDetails && (
        <Modal title="Receipt preview" onClose={() => setReceiptPreview(null)}>
          <article className="payment-printable">
            <header><span>{businessConfig.name}</span><small>{businessConfig.contactInformation} · {businessConfig.address}</small><h2>Customer receipt</h2></header>
            <div className="payment-document-row"><span>Receipt</span><strong>{receiptPreview.receiptNumber}</strong></div>
            <div className="payment-document-row"><span>Date</span><strong>{formatDate(receiptPreview.createdAt)}</strong></div>
            <div className="payment-document-row"><span>Received from</span><strong>{customerDetails.customer.name} ({customerDetails.customer.code})</strong></div>
            <div className="payment-document-row"><span>Customer contact</span><strong>{customerDetails.customer.phone}{customerDetails.customer.address ? ` · ${customerDetails.customer.address}` : ""}</strong></div>
            <div className="payment-document-row"><span>Payment method</span><strong>{receiptPreview.paymentMethod}</strong></div>
            <div className="payment-document-row"><span>Applied to</span><strong>{receiptPreview.invoiceNumber ?? "Advance payment"}</strong></div>
            <div className="payment-document-row"><span>Reference / note</span><strong>{receiptPreview.reference || receiptPreview.note || "—"}</strong></div>
            <div className="payment-document-total"><span>Amount received</span><strong>{formatMoney(receiptPreview.amountMinor)}</strong></div>
            {receiptPreview.reversedAt && <p className="payment-reversed-note">Reversed: {receiptPreview.reversalReason}</p>}
            <p className="print-authorized">{businessConfig.authorizedFooter}</p>
          </article>
          <div className="modal-actions no-print"><button className="secondary-button" onClick={() => setReceiptPreview(null)}>Close</button><PrintActions label="Print receipt" /></div>
        </Modal>
      )}

      {paymentPreview && supplierDetails && (
        <Modal title="Payment voucher preview" onClose={() => setPaymentPreview(null)}>
          <article className="payment-printable">
            <header><span>{businessConfig.name}</span><small>{businessConfig.contactInformation} · {businessConfig.address}</small><h2>Supplier payment voucher</h2></header>
            <div className="payment-document-row"><span>Voucher</span><strong>{paymentPreview.paymentNumber}</strong></div>
            <div className="payment-document-row"><span>Date</span><strong>{formatDate(paymentPreview.createdAt)}</strong></div>
            <div className="payment-document-row"><span>Paid to</span><strong>{supplierDetails.supplier.name} ({supplierDetails.supplier.code})</strong></div>
            <div className="payment-document-row"><span>Supplier contact</span><strong>{supplierDetails.supplier.phone}{supplierDetails.supplier.address ? ` · ${supplierDetails.supplier.address}` : ""}</strong></div>
            <div className="payment-document-row"><span>Payment method</span><strong>{paymentPreview.paymentMethod}</strong></div>
            <div className="payment-document-row"><span>Reference / note</span><strong>{paymentPreview.reference || paymentPreview.note || "—"}</strong></div>
            <div className="payment-document-total"><span>Amount paid</span><strong>{formatMoney(paymentPreview.amountMinor)}</strong></div>
            {paymentPreview.reversedAt && <p className="payment-reversed-note">Reversed: {paymentPreview.reversalReason}</p>}
            <p className="print-authorized">{businessConfig.authorizedFooter}</p>
          </article>
          <div className="modal-actions no-print"><button className="secondary-button" onClick={() => setPaymentPreview(null)}>Close</button><PrintActions label="Print voucher" /></div>
        </Modal>
      )}

      {invoicePreview && (
        <Modal title="Sales invoice preview" onClose={() => setInvoicePreview(null)} wide>
          <article className="invoice-printable">
            <header className="print-invoice-heading">
              <div><p>{businessConfig.name}</p><small>{businessConfig.contactInformation} · {businessConfig.address}</small><h2>Sales invoice</h2></div>
              <div><strong>{invoicePreview.invoiceNumber}</strong><span>{formatDate(invoicePreview.createdAt)}</span></div>
            </header>
            <div className="print-customer">
              <strong>{invoicePreview.customerName ? `${invoicePreview.customerCode} · ${invoicePreview.customerName}` : "Walk-in customer"}</strong>
              {invoicePreview.customerPhone && <span>{invoicePreview.customerPhone}</span>}
              {invoicePreview.customerAddress && <span>{invoicePreview.customerAddress}</span>}
            </div>
            <div className="print-invoice-lines">
              <div className="print-line print-line-head"><span>Fabric</span><span>Quantity</span><span>Rate</span><span>Amount</span></div>
              {invoicePreview.items.map((item) => <div className="print-line" key={item.id}>
                <span><strong>{item.name}</strong><small>{item.sku}</small></span>
                <span>{formatMeters(item.quantityMm)}</span>
                <span>{formatMoney(item.unitPriceMinor)} / m</span>
                <strong>{formatMoney(item.lineTotalMinor)}</strong>
              </div>)}
            </div>
            <div className="print-invoice-totals">
              <div><span>Subtotal</span><strong>{formatMoney(invoicePreview.subtotalMinor)}</strong></div>
              <div><span>Discount</span><strong>{formatMoney(invoicePreview.discountMinor)}</strong></div>
              <div className="print-grand-total"><span>Total</span><strong>{formatMoney(invoicePreview.totalMinor)}</strong></div>
              <div><span>Received ({invoicePreview.paymentAccount})</span><strong>{formatMoney(invoicePreview.amountReceivedMinor)}</strong></div>
              <div><span>Balance due</span><strong>{formatMoney(invoicePreview.dueMinor)}</strong></div>
              <div><span>Payment terms</span><strong>{invoicePreview.paymentTermsDays === undefined || invoicePreview.paymentTermsDays === 0 ? "Due on receipt" : `${invoicePreview.paymentTermsDays} days`}</strong></div>
            </div>
            <p className="print-thank-you">Thank you for your business.</p>
            <p className="print-authorized">{businessConfig.authorizedFooter}</p>
          </article>
          <div className="modal-actions no-print"><button className="secondary-button" onClick={() => setInvoicePreview(null)}>Close</button><PrintActions label="Print invoice" /></div>
        </Modal>
      )}

      {purchasePreview && supplierDetails && (
        <Modal title="Purchase voucher preview" onClose={() => setPurchasePreview(null)}>
          <article className="payment-printable purchase-voucher-printable">
            <header>
              <span>{businessConfig.name}</span>
              <small>{businessConfig.contactInformation} · {businessConfig.address}</small>
              <h2>Purchase voucher</h2>
            </header>
            <div className="payment-document-row"><span>Supplier bill</span><strong>{purchasePreview.billNumber}</strong></div>
            <div className="payment-document-row"><span>Purchase date</span><strong>{purchasePreview.purchaseDate}</strong></div>
            <div className="payment-document-row"><span>Supplier</span><strong>{supplierDetails.supplier.name} ({supplierDetails.supplier.code})</strong></div>
            <div className="payment-document-row"><span>Contact</span><strong>{supplierDetails.supplier.phone}{supplierDetails.supplier.address ? ` · ${supplierDetails.supplier.address}` : ""}</strong></div>
            <div className="purchase-voucher-lines">
              <div><strong>Fabric / SKU</strong><strong>Quantity</strong><strong>Rate</strong><strong>Line total</strong></div>
              {purchasePreview.items.map((item) => (
                <div key={item.id}>
                  <span>{item.fabricName}<small>{item.sku}</small></span>
                  <span>{formatMeters(item.quantityMm)}</span>
                  <span>{formatMoney(item.unitCostMinor)}</span>
                  <strong>{formatMoney(item.lineTotalMinor - item.allocatedCostMinor)}</strong>
                </div>
              ))}
            </div>
            {purchasePreview.additionalCostsMinor > 0 && (
              <div className="payment-document-row"><span>Additional costs {purchasePreview.additionalCostsDescription}</span><strong>{formatMoney(purchasePreview.additionalCostsMinor)}</strong></div>
            )}
            <div className="payment-document-total"><span>Total purchase</span><strong>{formatMoney(purchasePreview.totalMinor)}</strong></div>
            <div className="payment-document-row"><span>Paid ({purchasePreview.paymentMode})</span><strong>{formatMoney(purchasePreview.paidMinor)}</strong></div>
            <div className="payment-document-row"><span>Balance due</span><strong>{formatMoney(purchasePreview.dueMinor)}</strong></div>
            <p className="print-authorized">{businessConfig.authorizedFooter}</p>
          </article>
          <div className="modal-actions no-print"><button className="secondary-button" onClick={() => setPurchasePreview(null)}>Close</button><PrintActions label="Print voucher" /></div>
        </Modal>
      )}

      {customerFormOpen && (
        <Modal title={customerEditing ? "Edit customer" : "Add customer"} onClose={() => setCustomerFormOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void saveCustomer(event)}>
            <div className="form-grid">
              <FormField label="Customer code" required><input required autoFocus maxLength={40} value={customerValues.code} onChange={(event) => setCustomerValues({ ...customerValues, code: event.target.value })} placeholder="CUS-0001" /></FormField>
              <FormField label="Customer name" required><input required maxLength={120} value={customerValues.name} onChange={(event) => setCustomerValues({ ...customerValues, name: event.target.value })} placeholder="Customer name" /></FormField>
              <FormField label="Phone"><input maxLength={40} value={customerValues.phone} onChange={(event) => setCustomerValues({ ...customerValues, phone: event.target.value })} /></FormField>
              <FormField label="Address"><input maxLength={240} value={customerValues.address} onChange={(event) => setCustomerValues({ ...customerValues, address: event.target.value })} /></FormField>
              <FormField label="Credit limit" required hint="Set to 0 to disallow credit sales."><div className="input-prefix"><span>PKR</span><input required type="number" min="0" step="0.01" value={customerValues.creditLimit} onChange={(event) => setCustomerValues({ ...customerValues, creditLimit: event.target.value })} /></div></FormField>
              <FormField label="Payment terms" required><div className="input-suffix"><input required type="number" min="0" max="3650" step="1" value={customerValues.paymentTermsDays} onChange={(event) => setCustomerValues({ ...customerValues, paymentTermsDays: event.target.value })} /><span>days</span></div></FormField>
              {!customerEditing && <FormField label="Opening receivable" hint="Posted to Accounts Receivable and Opening Balance Equity."><div className="input-prefix"><span>PKR</span><input type="number" min="0" step="0.01" value={customerValues.openingBalance} onChange={(event) => setCustomerValues({ ...customerValues, openingBalance: event.target.value })} /></div></FormField>}
              {!customerEditing && Number(customerValues.openingBalance) > 0 && <FormField label="Owner PIN" required hint={pinConfigured ? "Authorizes this opening receivable." : "Set up an owner PIN before recording an opening balance."}><input required type="password" inputMode="numeric" minLength={6} value={customerValues.ownerPin} onChange={(event) => setCustomerValues({ ...customerValues, ownerPin: event.target.value })} /></FormField>}
            </div>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setCustomerFormOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : customerEditing ? "Save changes" : "Add customer"}</button></div>
          </form>
        </Modal>
      )}

      {receiptOpen && customerDetails && (
        <Modal title="Record customer receipt" onClose={() => setReceiptOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <p className="adjustment-product">Outstanding receivable: <strong>{formatMoney(customerDetails.customer.outstandingMinor)}</strong></p>
          <form className="adjustment-form" onSubmit={(event) => void saveCustomerReceipt(event)}>
            <FormField label="Amount" required><div className="input-prefix"><span>PKR</span><input required type="number" min="0.01" max={receiptValues.invoiceId ? (customerDetails.sales.find((invoice) => invoice.id === receiptValues.invoiceId)?.dueMinor ?? 0) / 100 : undefined} step="0.01" value={receiptValues.amount} onChange={(event) => setReceiptValues({ ...receiptValues, amount: event.target.value })} /></div></FormField>
            <FormField label="Apply to" required><select value={receiptValues.invoiceId} onChange={(event) => {
              const invoiceId = event.target.value;
              const invoice = customerDetails.sales.find((item) => item.id === invoiceId);
              setReceiptValues({ ...receiptValues, invoiceId, amount: invoice ? (invoice.dueMinor / 100).toFixed(2) : "" });
            }}><option value="">Advance payment (unallocated)</option>{customerDetails.sales.filter((invoice) => invoice.dueMinor > 0).map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoiceNumber} · Due {formatMoney(invoice.dueMinor)}</option>)}</select></FormField>
            <FormField label="Received into" required><select value={receiptValues.accountCode} onChange={(event) => setReceiptValues({ ...receiptValues, accountCode: event.target.value })}>{paymentAccounts.map((account) => <option key={account.code} value={account.code}>{account.name}</option>)}</select></FormField>
            <FormField label="Reference"><input maxLength={100} value={receiptValues.reference} onChange={(event) => setReceiptValues({ ...receiptValues, reference: event.target.value })} /></FormField>
            <FormField label="Note"><input maxLength={160} value={receiptValues.note} onChange={(event) => setReceiptValues({ ...receiptValues, note: event.target.value })} /></FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setReceiptOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Posting…" : "Record receipt"}</button></div>
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
                <label className="sale-customer-field"><span>Customer (optional)</span><select value={saleCustomerId} onChange={(event) => setSaleCustomerId(event.target.value)}><option value="">Walk-in sale</option>{customers.filter((customer) => customer.active).map((customer) => <option key={customer.id} value={customer.id}>{customer.code} · {customer.name} · Limit {formatMoney(customer.creditLimitMinor)}</option>)}</select></label>
                <button className="primary-button" type="submit" disabled={saving}>{saving ? "Recording…" : "Create invoice"}</button>
              </div>
              {saleCustomerId && <p className="form-footnote">Customer sales are posted to Accounts Receivable and must fit within that customer’s credit limit. A zero limit permits no credit sales.</p>}
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
            <FormField label="Owner PIN" required hint="Required for all manual inventory adjustments.">
              <input required type="password" inputMode="numeric" autoComplete="current-password" value={adjustmentPin} onChange={(event) => setAdjustmentPin(event.target.value)} />
            </FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setAdjustment(null)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save movement"}</button></div>
          </form>
        </Modal>
      )}

      {openingStockOpen && (
        <Modal title="Record opening stock" onClose={() => setOpeningStockOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void saveOpeningStock(event)}>
            <FormField label="Fabric" required>
              <select required value={openingValues.fabricId} onChange={(event) => setOpeningValues({ ...openingValues, fabricId: event.target.value })}>
                <option value="">Select fabric</option>
                {(stock?.fabrics ?? []).filter((fabric) => fabric.active).map((fabric) => <option key={fabric.id} value={fabric.id}>{fabric.sku} · {fabric.name}</option>)}
              </select>
            </FormField>
            <FormField label="Quantity" required><div className="input-suffix"><input required type="number" min="0.001" step="0.001" value={openingValues.quantityMeters} onChange={(event) => setOpeningValues({ ...openingValues, quantityMeters: event.target.value })} /><span>m</span></div></FormField>
            <FormField label="Purchase cost" required><div className="input-prefix"><span>PKR</span><input required type="number" min="0" step="0.01" value={openingValues.unitCost} onChange={(event) => setOpeningValues({ ...openingValues, unitCost: event.target.value })} /></div></FormField>
            <FormField label="Reference" required><input required maxLength={100} value={openingValues.reference} onChange={(event) => setOpeningValues({ ...openingValues, reference: event.target.value })} placeholder="Opening stock entry" /></FormField>
            <FormField label="Reason" required><input required maxLength={160} value={openingValues.reason} onChange={(event) => setOpeningValues({ ...openingValues, reason: event.target.value })} /></FormField>
            <FormField label="Owner PIN" required><input required type="password" inputMode="numeric" value={openingValues.ownerPin} onChange={(event) => setOpeningValues({ ...openingValues, ownerPin: event.target.value })} /></FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setOpeningStockOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Record stock"}</button></div>
          </form>
        </Modal>
      )}

      {pinSetupOpen && (
        <Modal title="Set up owner PIN" onClose={() => setPinSetupOpen(false)}>
          <p className="muted-message">Choose a numeric PIN of at least 6 digits. It is encrypted with the operating system keychain and is never stored in the renderer or database.</p>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void saveOwnerPin(event)}>
            <FormField label="Owner PIN" required><input required type="password" inputMode="numeric" autoComplete="new-password" minLength={6} value={pinSetupValues.pin} onChange={(event) => setPinSetupValues({ ...pinSetupValues, pin: event.target.value })} /></FormField>
            <FormField label="Confirm PIN" required><input required type="password" inputMode="numeric" autoComplete="new-password" minLength={6} value={pinSetupValues.confirmation} onChange={(event) => setPinSetupValues({ ...pinSetupValues, confirmation: event.target.value })} /></FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPinSetupOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Set owner PIN"}</button></div>
          </form>
        </Modal>
      )}

      {supplierFormOpen && (
        <Modal title={supplierEditing ? "Edit supplier" : "Add supplier"} onClose={() => setSupplierFormOpen(false)} wide>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="fabric-form" onSubmit={(event) => void saveSupplier(event)}>
            <div className="form-grid">
              <FormField label="Supplier code" required><input required maxLength={40} value={supplierValues.code} onChange={(event) => setSupplierValues({ ...supplierValues, code: event.target.value })} /></FormField>
              <FormField label="Supplier name" required><input required maxLength={120} value={supplierValues.name} onChange={(event) => setSupplierValues({ ...supplierValues, name: event.target.value })} /></FormField>
              <FormField label="Phone" required><input required maxLength={40} value={supplierValues.phone} onChange={(event) => setSupplierValues({ ...supplierValues, phone: event.target.value })} /></FormField>
              <FormField label="Contact person"><input maxLength={120} value={supplierValues.contactName} onChange={(event) => setSupplierValues({ ...supplierValues, contactName: event.target.value })} /></FormField>
              <FormField label="Email"><input type="email" maxLength={160} value={supplierValues.email} onChange={(event) => setSupplierValues({ ...supplierValues, email: event.target.value })} /></FormField>
              <FormField label="Address"><input maxLength={240} value={supplierValues.address} onChange={(event) => setSupplierValues({ ...supplierValues, address: event.target.value })} /></FormField>
              {!supplierEditing && <FormField label="Opening balance" hint="Credit payable, posted to the AP control account."><div className="input-prefix"><span>PKR</span><input type="number" min="0" step="0.01" value={supplierValues.openingBalance} onChange={(event) => setSupplierValues({ ...supplierValues, openingBalance: event.target.value })} /></div></FormField>}
              {!supplierEditing && Number(supplierValues.openingBalance) > 0 && <FormField label="Owner PIN" required hint="Required to authorize an opening payable balance."><input required type="password" inputMode="numeric" minLength={6} value={supplierValues.ownerPin} onChange={(event) => setSupplierValues({ ...supplierValues, ownerPin: event.target.value })} /></FormField>}
            </div>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setSupplierFormOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : supplierEditing ? "Save changes" : "Add supplier"}</button></div>
          </form>
        </Modal>
      )}

      {supplierDetails && (
        <Modal title="Supplier account" onClose={() => setSupplierDetails(null)} wide>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <div className="detail-head">
            <div><span className="sku-label">{supplierDetails.supplier.code}</span><h2>{supplierDetails.supplier.name}</h2><p>{supplierDetails.supplier.phone}{supplierDetails.supplier.contactName ? ` · ${supplierDetails.supplier.contactName}` : ""}{supplierDetails.supplier.address ? ` · ${supplierDetails.supplier.address}` : ""}</p></div>
            <strong className="supplier-balance">{formatMoney(supplierDetails.supplier.outstandingMinor)} due</strong>
          </div>
          <div className="detail-actions supplier-actions">
            <button className="secondary-button" onClick={() => openSupplierForm(supplierDetails.supplier)}>Edit supplier</button>
            <button className="secondary-button" onClick={() => {
              setPurchaseValues({
                billNumber: "",
                reference: "",
                purchaseDate: getLocalDateInputValue(),
                additionalCosts: "",
                additionalCostsDescription: "",
                paymentMode: "credit",
                amountPaid: "",
                paymentAccount: "cash",
              });
              setPurchaseItems([{ fabricId: "", quantityMeters: "", unitCost: "" }]);
              setPurchaseOpen(true);
            }}>Receive purchase</button>
            <button className="secondary-button" onClick={() => {
              setPaymentValues({ amount: "", accountCode: paymentAccounts[0]?.code ?? "1000", reference: "", note: "", purchaseId: "" });
              setPaymentOpen(true);
            }}>Record payment</button>
            <button className="secondary-button" onClick={() => setSupplierAdjustmentOpen(true)}>Adjust balance</button>
          </div>
          <form className="statement-filter" onSubmit={(event) => void loadSupplierStatement(event)}>
            <FormField label="From"><input type="date" required value={statementDates.from} onChange={(event) => setStatementDates({ ...statementDates, from: event.target.value })} /></FormField>
            <FormField label="To"><input type="date" required value={statementDates.to} onChange={(event) => setStatementDates({ ...statementDates, to: event.target.value })} /></FormField>
            <button className="primary-button">Generate statement</button>
          </form>
          {statement && (
            <div className="supplier-statement-print">
              <div className="section-heading compact"><div><h3>Supplier statement</h3></div><PrintActions label="Print statement" beforePrint={() => {
                document.body.classList.add("print-supplier-statement");
                return () => document.body.classList.remove("print-supplier-statement");
              }} /></div>
              <StatementTable
                statement={statement}
                partyLabel={`Supplier: ${supplierDetails.supplier.name} (${supplierDetails.supplier.code})`}
                partyDetails={`${supplierDetails.supplier.phone}${supplierDetails.supplier.address ? ` · ${supplierDetails.supplier.address}` : ""}`}
              />
            </div>
          )}
          <div className="history-block">
            <div className="section-heading compact"><div><h3>Purchase history</h3><p>Supplier receipts update inventory and AP in the same transaction.</p></div></div>
            {supplierDetails.purchases.length === 0 ? <p className="muted-message">No purchases recorded.</p> : supplierDetails.purchases.map((purchase) => <div className="history-row" key={purchase.id}><div><strong>{purchase.billNumber} · {purchase.purchaseDate}</strong><span>{purchase.reference || purchase.paymentMode.toUpperCase()} · {purchase.items.map((item) => `${item.sku} ${formatMeters(item.quantityMm)}`).join(", ")}{purchase.additionalCostsMinor > 0 ? ` · Acquisition costs ${formatMoney(purchase.additionalCostsMinor)}` : ""}</span></div><div className="history-price"><strong>{formatMoney(purchase.totalMinor)}</strong><span>Paid {formatMoney(purchase.paidMinor)} · Due {formatMoney(purchase.dueMinor)}</span><button type="button" className="table-action" onClick={() => setPurchasePreview(purchase)}>Print voucher</button></div></div>)}
            <div className="section-heading compact"><div><h3>Payment vouchers</h3><p>Payments use configured payment accounts and support invoice-level partial settlement.</p></div></div>
            {supplierDetails.payments.length === 0 ? <p className="muted-message">No payments recorded.</p> : supplierDetails.payments.map((payment) => <div className="history-row" key={payment.id}><div><strong>{payment.paymentNumber}{payment.reversedAt ? " · REVERSED" : ""}</strong><span>{formatDate(payment.createdAt)} · {payment.paymentMethod}{payment.reference ? ` · ${payment.reference}` : ""}{payment.note ? ` · ${payment.note}` : ""}{payment.reversalReason ? ` · Reversal: ${payment.reversalReason}` : ""}</span></div><div className="history-price"><strong>{formatMoney(payment.amountMinor)}</strong><div className="payment-history-actions"><button type="button" className="table-action" onClick={() => setPaymentPreview(payment)}>Print voucher</button>{!payment.reversedAt && <button type="button" className="table-action danger" disabled={saving} onClick={() => void reverseSupplierPayment(payment)}>Reverse</button>}</div></div></div>)}
          </div>
        </Modal>
      )}

      {purchaseOpen && supplierDetails && (
        <Modal title="Receive supplier purchase" onClose={() => setPurchaseOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form purchase-form" onSubmit={(event) => void savePurchase(event)}>
            <div className="form-grid">
              <FormField label="Supplier invoice" required><input required maxLength={80} value={purchaseValues.billNumber} onChange={(event) => setPurchaseValues({ ...purchaseValues, billNumber: event.target.value })} /></FormField>
              <FormField label="Purchase date" required><input required type="date" value={purchaseValues.purchaseDate} onChange={(event) => setPurchaseValues({ ...purchaseValues, purchaseDate: event.target.value })} /></FormField>
              <FormField label="Invoice reference"><input maxLength={100} value={purchaseValues.reference} onChange={(event) => setPurchaseValues({ ...purchaseValues, reference: event.target.value })} placeholder="Supplier invoice / delivery note" /></FormField>
            </div>
            <div className="purchase-lines-heading"><strong>Fabric lines</strong><button className="secondary-button table-button" type="button" onClick={() => setPurchaseItems([...purchaseItems, { fabricId: "", quantityMeters: "", unitCost: "" }])}>+ Add fabric</button></div>
            {purchaseItems.map((item, index) => (
              <div className="purchase-line" key={index}>
                <FormField label={`Fabric ${index + 1}`} required><select required value={item.fabricId} onChange={(event) => setPurchaseItems(purchaseItems.map((row, rowIndex) => rowIndex === index ? { ...row, fabricId: event.target.value } : row))}><option value="">Select fabric</option>{(stock?.fabrics ?? []).filter((fabric) => fabric.active && (fabric.id === item.fabricId || !purchaseItems.some((row, rowIndex) => rowIndex !== index && row.fabricId === fabric.id))).map((fabric) => <option key={fabric.id} value={fabric.id}>{fabric.sku} · {fabric.name}</option>)}</select></FormField>
                <FormField label="Quantity" required><div className="input-suffix"><input required type="number" min="0.001" step="0.001" value={item.quantityMeters} onChange={(event) => setPurchaseItems(purchaseItems.map((row, rowIndex) => rowIndex === index ? { ...row, quantityMeters: event.target.value } : row))} /><span>m</span></div></FormField>
                <FormField label="Unit cost" required><div className="input-prefix"><span>PKR/m</span><input required type="number" min="0" step="0.01" value={item.unitCost} onChange={(event) => setPurchaseItems(purchaseItems.map((row, rowIndex) => rowIndex === index ? { ...row, unitCost: event.target.value } : row))} /></div></FormField>
                {purchaseItems.length > 1 && <button className="remove-line-button" type="button" aria-label={`Remove fabric line ${index + 1}`} onClick={() => setPurchaseItems(purchaseItems.filter((_, rowIndex) => rowIndex !== index))}>×</button>}
              </div>
            ))}
            <div className="form-grid">
              <FormField label="Freight / loading / other costs"><div className="input-prefix"><span>PKR</span><input type="number" min="0" step="0.01" value={purchaseValues.additionalCosts} onChange={(event) => setPurchaseValues({ ...purchaseValues, additionalCosts: event.target.value })} /></div></FormField>
              <FormField label="Cost description"><input maxLength={120} value={purchaseValues.additionalCostsDescription} onChange={(event) => setPurchaseValues({ ...purchaseValues, additionalCostsDescription: event.target.value })} placeholder="Freight, loading, handling…" /></FormField>
              <FormField label="Purchase type" required><select value={purchaseValues.paymentMode} onChange={(event) => setPurchaseValues({ ...purchaseValues, paymentMode: event.target.value as "credit" | "cash" | "bank" })}><option value="credit">Credit</option><option value="cash">Cash</option><option value="bank">Bank</option></select></FormField>
              {purchaseValues.paymentMode === "credit" && <FormField label="Paid now" hint="Leave zero to keep the full invoice payable."><div className="input-prefix"><span>PKR</span><input type="number" min="0" step="0.01" value={purchaseValues.amountPaid} onChange={(event) => setPurchaseValues({ ...purchaseValues, amountPaid: event.target.value })} /></div></FormField>}
              {purchaseValues.paymentMode === "credit" && Number(purchaseValues.amountPaid) > 0 && <FormField label="Pay from" required><select value={purchaseValues.paymentAccount} onChange={(event) => setPurchaseValues({ ...purchaseValues, paymentAccount: event.target.value as "cash" | "bank" })}><option value="cash">Cash</option><option value="bank">Bank</option></select></FormField>}
            </div>
            <p className="form-footnote">Additional acquisition costs are allocated to fabric lines in proportion to material cost (or quantity when material cost is zero), with rounding remainders assigned deterministically. Weighted-average stock cost is recalculated on receipt.</p>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPurchaseOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Posting…" : "Post purchase"}</button></div>
          </form>
        </Modal>
      )}

      {paymentOpen && supplierDetails && (
        <Modal title="Record supplier payment" onClose={() => setPaymentOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void savePayment(event)}>
            <FormField label="Purchase invoice"><select value={paymentValues.purchaseId} onChange={(event) => {
              const purchaseId = event.target.value;
              const purchase = supplierDetails.purchases.find((item) => item.id === purchaseId);
              setPaymentValues({
                ...paymentValues,
                purchaseId,
                amount: purchase && purchase.dueMinor > 0 ? (purchase.dueMinor / 100).toFixed(2) : paymentValues.amount,
              });
            }}><option value="">Unallocated supplier payment</option>{supplierDetails.purchases.filter((purchase) => purchase.dueMinor > 0).map((purchase) => <option key={purchase.id} value={purchase.id}>{purchase.billNumber} · Due {formatMoney(purchase.dueMinor)}</option>)}</select></FormField>
            <FormField label="Amount" required><div className="input-prefix"><span>PKR</span><input required type="number" min="0.01" step="0.01" value={paymentValues.amount} onChange={(event) => setPaymentValues({ ...paymentValues, amount: event.target.value })} /></div></FormField>
            <FormField label="Paid from" required><select value={paymentValues.accountCode} onChange={(event) => setPaymentValues({ ...paymentValues, accountCode: event.target.value })}>{paymentAccounts.map((account) => <option key={account.code} value={account.code}>{account.name}</option>)}</select></FormField>
            <FormField label="Reference"><input maxLength={100} value={paymentValues.reference} onChange={(event) => setPaymentValues({ ...paymentValues, reference: event.target.value })} /></FormField>
            <FormField label="Note"><input maxLength={160} value={paymentValues.note} onChange={(event) => setPaymentValues({ ...paymentValues, note: event.target.value })} /></FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPaymentOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Posting…" : "Record payment"}</button></div>
          </form>
        </Modal>
      )}

      {supplierAdjustmentOpen && supplierDetails && (
        <Modal title="Adjust supplier balance" onClose={() => setSupplierAdjustmentOpen(false)}>
          {error && <div className="error-banner modal-error" role="alert">{error}</div>}
          <form className="adjustment-form" onSubmit={(event) => void saveSupplierAdjustment(event)}>
            <FormField label="Adjustment" required><select value={supplierAdjustmentValues.direction} onChange={(event) => setSupplierAdjustmentValues({ ...supplierAdjustmentValues, direction: event.target.value as "increase" | "decrease" })}><option value="increase">Increase payable</option><option value="decrease">Decrease payable</option></select></FormField>
            <FormField label="Amount" required><div className="input-prefix"><span>PKR</span><input required type="number" min="0.01" step="0.01" value={supplierAdjustmentValues.amount} onChange={(event) => setSupplierAdjustmentValues({ ...supplierAdjustmentValues, amount: event.target.value })} /></div></FormField>
            <FormField label="Reason" required><input required maxLength={160} value={supplierAdjustmentValues.reason} onChange={(event) => setSupplierAdjustmentValues({ ...supplierAdjustmentValues, reason: event.target.value })} /></FormField>
            <FormField label="Owner PIN" required><input required type="password" inputMode="numeric" value={supplierAdjustmentValues.ownerPin} onChange={(event) => setSupplierAdjustmentValues({ ...supplierAdjustmentValues, ownerPin: event.target.value })} /></FormField>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setSupplierAdjustmentOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Posting…" : "Post adjustment"}</button></div>
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

function MovementTable({ movements }: { movements: InventoryMovement[] }) {
  if (movements.length === 0) return <EmptyState title="No stock movements" copy="Opening stock, supplier receipts, sales and authorized adjustments will appear here." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Fabric</th><th>Type</th><th>Quantity</th><th>Reference / reason</th><th>Authorized user</th></tr></thead>
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

function ValuationTable({ report }: { report: InventoryReport | null }) {
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
          <td>{formatMeters(item.reorderThresholdMm)}{item.lowStock && <span className="status-badge low valuation-low">Low</span>}</td>
        </tr>)}</tbody>
      </table>
      <div className="report-total"><span>Active stock valuation</span><strong>{formatMoney(report.totalValuationMinor)}</strong></div>
    </div>
  );
}

function SupplierTable({ suppliers, onOpen }: { suppliers: Supplier[]; onOpen: (supplier: Supplier) => void }) {
  if (suppliers.length === 0) return <EmptyState title="No suppliers found" copy="Add a fabric supplier to track purchases and outstanding balances." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Supplier</th><th>Phone / contact</th><th>Purchases</th><th>Payments</th><th>Outstanding balance</th><th /></tr></thead>
        <tbody>{suppliers.map((supplier) => <tr key={supplier.id}>
          <td><button className="fabric-link" onClick={() => onOpen(supplier)}><strong>{supplier.name}</strong><span>{supplier.code}</span></button></td>
          <td>{supplier.phone}{supplier.contactName ? <><br /><span className="cell-muted">{supplier.contactName}</span></> : null}</td>
          <td>{supplier.purchaseCount}</td>
          <td>{supplier.paymentCount}</td>
          <td><strong>{formatMoney(supplier.outstandingMinor)}</strong></td>
          <td><button className="secondary-button table-button" onClick={() => onOpen(supplier)}>View account</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function CustomerTable({ customers: customerRows, onOpen }: { customers: Customer[]; onOpen: (customer: Customer) => void }) {
  if (customerRows.length === 0) return <EmptyState title="No customers found" copy="Add a customer to track credit sales, receipts and statements." />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Customer</th><th>Phone</th><th>Sales</th><th>Receipts</th><th>Credit limit</th><th>Outstanding</th><th /></tr></thead>
        <tbody>{customerRows.map((customer) => <tr key={customer.id}>
          <td><button className="fabric-link" onClick={() => onOpen(customer)}><strong>{customer.name}</strong><span>{customer.code}</span></button></td>
          <td>{customer.phone || "—"}</td>
          <td>{customer.salesCount}</td>
          <td>{customer.receiptCount}</td>
          <td>{formatMoney(customer.creditLimitMinor)}</td>
          <td><strong>{formatMoney(customer.outstandingMinor)}</strong></td>
          <td><button className="secondary-button table-button" onClick={() => onOpen(customer)}>View account</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function CustomerDetailPage({
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
    <div className="customer-detail-page">
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
        <button className="secondary-button" onClick={onEdit}>Edit customer</button>
        <button className="primary-button" onClick={onReceive}>Record receipt / advance</button>
      </div>
      <div className="inventory-tabs customer-tabs" role="tablist" aria-label="Customer account details">
        {([
          ["overview", "Overview"],
          ["sales", "Sales"],
          ["payments", "Payments"],
          ["ledger", "Ledger"],
        ] as Array<[CustomerTab, string]>).map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => onTabChange(value)}>{label}</button>
        ))}
      </div>
      {tab === "overview" && (
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
      )}
      {tab === "sales" && (
        <div className="customer-tab-content">
          <div className="section-heading"><div><h2>Sales history</h2><p>Invoice totals and line prices are preserved as recorded.</p></div><span className="history-count">{details.sales.length} invoices</span></div>
          {details.sales.length === 0 ? <EmptyState title="No sales recorded" copy="Credit invoices for this customer will appear here." /> : <div className="invoice-list">{details.sales.map((invoice) => <InvoiceCard key={invoice.id} invoice={invoice} onPrint={onPrintInvoice} />)}</div>}
        </div>
      )}
      {tab === "payments" && (
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
                <td><div className="payment-history-actions"><button type="button" className="table-action" onClick={() => onPrintReceipt(receipt)}>Print</button>{!receipt.reversedAt && <button type="button" className="table-action danger" onClick={() => onReverseReceipt(receipt)}>Reverse</button>}</div></td>
              </tr>)}</tbody>
            </table></div></div>
          )}
        </div>
      )}
      {tab === "ledger" && (
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
            <button className="primary-button">Generate statement</button>
          </form>
          {statement ? <StatementTable
            statement={statement}
            partyLabel={`Customer: ${customer.name} (${customer.code})`}
            partyDetails={`${customer.phone}${customer.address ? ` · ${customer.address}` : ""}`}
          /> : <p className="muted-message">Choose a date range to generate the customer ledger.</p>}
        </div>
      )}
    </div>
  );
}

function StatementTable({
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

function StatusBadge({ active, low = false }: { active: boolean; low?: boolean }) {
  return <span className={active ? low ? "status-badge low" : "status-badge active" : "status-badge inactive"}><span />{active ? low ? "Low stock" : "Active" : "Inactive"}</span>;
}

function InvoiceCard({ invoice, onPrint }: { invoice: Invoice; onPrint: (invoice: Invoice) => void }) {
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
      <button className="table-action no-print" onClick={() => onPrint(invoice)}>Preview / print invoice</button>
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
