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
records its supplier invoice number/reference and purchase date, inventory
movement, weighted-average cost, and accounting posting together. Credit bills
post to AP; cash and bank bills post to the selected payment account. Partial
payments at receipt or later are tracked against an invoice and reduce its
remaining due. Freight, loading, and other eligible acquisition costs can be
entered and are allocated by material line value (by quantity if material cost
is zero); integer minor-unit rounding remainders go to the largest remainder,
with line order as a deterministic tie-breaker. Inventory cost uses half-up
rounding in integer arithmetic. Payments are posted to the selected Cash or Bank account.
Supplier statements show opening and closing balances for a date range, and the
supplier subledger can be reconciled to the Accounts Payable control account.

## Partnership & Investors

The Partnership & Investors workspace manages partner and investor profiles,
effective-dated ownership/profit-sharing terms, capital contributions, partner
loans, repayments, withdrawals, profit distributions, reversals, and printable
or CSV-exportable statements. Contributions, loan balances, partner capital,
and distributable profits use separate ledger accounts and partner subledger
references; withdrawals are drawings, not business expenses. Posted records
cannot be edited or deleted, and each financial transaction is linked to its
balanced journal entry.

Profit and loss allocations are previewed from the accounting engine's finalized
ledger income and expenses, and can be posted only after the selected accounting
period is closed. Applicable sharing terms must total exactly 100%; the preview
uses the terms effective at the end of that period. Changing current agreement
terms does not recalculate old allocations. Profit allocations transfer value
from the partner allocation equity account to profit distributions payable;
losses reduce partner capital under the same effective sharing terms. The module
uses validated, operation-specific Electron IPC calls and does not add a login
or require an owner PIN.

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
For packaged application installation on Windows, macOS, or Linux, see
[INSTALLING.md](./INSTALLING.md).

## Data storage

The POS database is created at
`app.getPath("userData")/greige-fabric-pos.sqlite`. It is separate from the
former Greige Notes database. Versioned SQL migrations are in
`database/migrations/`; the app verifies migration checksums and backs up an
existing POS database before applying a pending migration. The old Notes
database is not opened, migrated, or deleted.

## Build and package

The first desktop release targets a 64-bit Windows NSIS installer:

```sh
npm run dist
```

`npm run dist` runs the production build and creates
`release/Greige Fabric POS-Setup-<version>-x64.exe`. The same Windows build is
available explicitly as `npm run dist:win`. Run it on Windows or a Windows CI
runner; creating the NSIS installer from Linux requires Wine. Electron Builder
rebuilds native dependencies for Electron 42 and the selected Windows x64
target, and unpacks native `.node` addons from the app archive. The package
includes the static Next.js export, Electron main/preload files, production
dependencies, and SQL migrations. This project uses `better-sqlite3` directly;
it has no Prisma runtime dependency.

The database remains in Electron's per-user `userData` directory, outside the
installation. The NSIS uninstall configuration preserves this data, and the
startup migration runner snapshots existing databases before applying
transactional migrations.

Other platform packages remain available when needed:

```sh
npm run dist:mac
npm run dist:linux
```

The production renderer is a static export in `out/`; production Electron loads
it from disk and does not require the Next.js development server. Electron main
and preload files are written to `dist-electron/`. Electron Builder writes
packages to `release/`. macOS signing and notarization are not configured by
default.

### Windows release validation

Before distributing an installer, complete the target-machine checks below.
Automated database and service tests are not a substitute for testing the
installer and printer on Windows.

- [ ] Install and launch the installer on a clean Windows x64 machine.
- [ ] Upgrade an installation containing real test data and confirm the data remains.
- [ ] Upgrade a database with pending migrations and confirm migration succeeds.
- [ ] Confirm sales, purchases, and accounting work with networking disabled.
- [ ] Print an invoice on the shop's target printer and compare its totals.
- [ ] Create a backup, restore it, and confirm the application recovers the records.
- [x] Verify write permissions in main-process IPC handlers; protected operations validate owner authorization.
- [x] Verify production startup loads the exported renderer from disk, not the development server.
- [x] Run automated tests for transactional inventory/accounting behavior and database migration recovery.

## Project structure

- `src/app/`: catalog, inventory, supplier, partnership, and invoice-history screens.
- `src/shared/`: Zod request schemas, IPC channels, and public types.
- `src/main/`: Electron lifecycle, SQLite setup, inventory/fabric/supplier/partner
  services, local authorization, accounting, and validated IPC handlers.
- `database/migrations/`: versioned SQL schema.
- `tests/`: catalog, inventory, accounting, supplier reconciliation, and
  historical-price snapshot tests.

The renderer has no direct Node.js, filesystem, or SQLite access. It calls a
small API exposed by the preload script; the main process validates every IPC
input with Zod and checks the sender frame. Context isolation and sandboxing
remain enabled, with Node integration disabled.
