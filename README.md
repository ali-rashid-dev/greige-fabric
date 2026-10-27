# Greige Fabric POS

Greige Fabric POS is an offline-first Electron desktop application for fabric
catalog, inventory, supplier purchasing, and Accounts Payable workflows. It uses
Next.js App Router, React, TypeScript, SQLite, and a narrow, validated Electron
preload bridge.

## Fabric catalog

Each fabric quality has a unique SKU, name, construction, composition, width,
GSM, purchase cost, selling rate, reorder threshold, stock movements, and active
status. Prices are stored as integer minor currency units and displayed in PKR;
stock quantities are stored to three decimal places in metres.

The catalog supports search by SKU, name, construction, or composition; status
and low-stock filters; create/edit/details; activation/deactivation; stock
summaries; and invoice history. Product records are never deleted through the
app. Invoices preserve SKU, fabric name, sold quantity, and unit selling rate as
snapshots, so later product edits do not rewrite past sales.

## Inventory

Stock is stored as integer millimeters and displayed in meters. Opening stock,
supplier receipts, sales, and authorized adjustments all use the inventory
service, which updates the balance and movement history in one SQLite
transaction. Movements record product, signed quantity, type, reference,
timestamp, and actor. Inventory valuation uses the persisted stock value and
weighted-average cost; low-stock and movement reports are available in the
Inventory screen.

Manual inventory and supplier-balance adjustments, plus nonzero supplier
opening balances, require an owner PIN. The PIN is encrypted using Electron
`safeStorage` and the operating system keychain; these operations fail closed
when secure storage is unavailable or the PIN is not configured. On Linux,
GNOME Keyring or KDE Wallet must be available.

## Suppliers and Accounts Payable

Supplier records include a unique code, contact details, and an AP-derived
outstanding balance. Supplier opening balances, purchase bills, payments, and
authorized adjustments are posted to a double-entry ledger. Receiving a bill
records the supplier purchase, inventory movement, weighted-average cost, and
AP posting together. Payments are posted to the selected Cash or Bank account.
Supplier statements show opening and closing balances for a date range, and the
supplier subledger can be reconciled to the Accounts Payable control account.

Sales invoices are recorded against Accounts Receivable; sales revenue and cost
of goods sold are also posted to the ledger. Tax rules, receipt printing,
customer records, and customer payment collection are not yet included.

## Prerequisites

- Node.js 22.12 or newer (Node 24 LTS recommended).
- npm 10 or newer.
- Native build tools if `better-sqlite3` needs to compile on your platform.

## Install and run

```sh
npm install
npm run dev
```

`npm run dev` starts the Next.js development server on `127.0.0.1:3000` and
Electron. Use `npm run dev:web` for the renderer alone, or start the renderer
first and then run `npm run dev:electron`.

See [PROJECT-COMMANDS.md](./PROJECT-COMMANDS.md) for all available commands.

## Data storage

The POS database is created at
`app.getPath("userData")/greige-fabric-pos.sqlite`. It is separate from the
former Greige Notes database. Versioned SQL migrations are in
`database/migrations/`; the app verifies migration checksums and backs up an
existing POS database before applying a pending migration. The old Notes
database is not opened, migrated, or deleted.

## Build and package

```sh
npm run build
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The production renderer is a static export in `out/`; Electron main and preload
files are written to `dist-electron/`. Electron Builder writes packages to
`release/`. Cross-platform builds may need a native runner for the target
operating system. macOS signing and notarization are not configured by default.

## Project structure

- `src/app/`: catalog, inventory, supplier, and invoice-history screens.
- `src/shared/`: Zod request schemas, IPC channels, and public types.
- `src/main/`: Electron lifecycle, SQLite setup, inventory/fabric/supplier
  services, local authorization, accounting, and validated IPC handlers.
- `database/migrations/`: versioned SQL schema.
- `tests/`: catalog, inventory, accounting, supplier reconciliation, and
  historical-price snapshot tests.

The renderer has no direct Node.js, filesystem, or SQLite access. It calls a
small API exposed by the preload script; the main process validates every IPC
input with Zod and checks the sender frame. Context isolation and sandboxing
remain enabled, with Node integration disabled.
