# Greige Fabric POS

Greige Fabric POS is an offline-first Electron desktop application for managing
fabric qualities and stock. It uses Next.js App Router, React, TypeScript,
SQLite, and a narrow, validated Electron preload bridge.

## Fabric catalog

Each fabric quality has a unique SKU, name, construction, composition, width,
GSM, purchase cost, selling rate, reorder threshold, stock movements, and active
status. Prices are stored as integer minor currency units and displayed in PKR;
stock quantities are stored to three decimal places in metres.

The catalog supports search by SKU, name, construction, or composition; status
and low-stock filters; create/edit/details; activation/deactivation; stock
adjustments; stock summaries; and invoice history. Product records are never
deleted through the app. Invoices preserve SKU, fabric name, sold quantity, and
unit selling rate as snapshots, so later product edits do not rewrite past
sales.

This first workflow records a simple invoice and reduces on-hand stock. It does
not yet include payment collection, tax rules, receipt printing, customer
records, purchasing, or reporting.

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

- `src/app/`: catalog, stock, and invoice-history screens.
- `src/shared/`: Zod request schemas, IPC channels, and public types.
- `src/main/`: Electron lifecycle, SQLite setup, fabric service, and validated
  IPC handlers.
- `database/migrations/`: versioned SQL schema.
- `tests/`: contract, stock, and historical-price snapshot tests.

The renderer has no direct Node.js, filesystem, or SQLite access. It calls a
small API exposed by the preload script; the main process validates every IPC
input with Zod and checks the sender frame. Context isolation and sandboxing
remain enabled, with Node integration disabled.
