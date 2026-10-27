# Greige Fabric POS

Greige Fabric POS is a desktop application starter built with Electron, Next.js
App Router, React, and TypeScript. It currently contains only the branded
workspace shell; sales, products, inventory, customers, and other POS workflows
have not been implemented.

The starter uses PKR as its initial business currency setting in
`src/config/business.ts`. No pricing or currency-conversion behavior is included.

## Prerequisites

- Node.js 22.12 or newer (Node 24 LTS recommended).
- npm 10 or newer.

## Install and run

```sh
npm install
npm run dev
```

`npm run dev` starts the Next.js development server on `127.0.0.1:3000` and
Electron. Use `npm run dev:web` for the renderer alone, or start the renderer
first and then run `npm run dev:electron`.

See [PROJECT-COMMANDS.md](./PROJECT-COMMANDS.md) for all available commands.

## Build and package

```sh
npm run build
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The production renderer is a static export in `out/`; Electron main-process
output is written to `dist-electron/`. Electron Builder writes packages to
`release/`. Cross-platform builds may need a native runner for the target
operating system. macOS signing and notarization are not configured by default.

## Project structure

- `src/app/`: POS workspace shell and global styling.
- `src/config/business.ts`: business display name and initial currency code.
- `src/main/`: Electron lifecycle, window setup, and navigation/security policy.
- `tests/`: project setup smoke tests.

The renderer has no Node.js integration, preload bridge, database, or POS data
operations yet. Add domain features and their narrowly scoped IPC APIs only as
they are designed and needed.

## Existing Notes data

Notes-specific application code, schema, and migrations were removed from the
project. This setup change does not search for or delete old Notes database
files in the project directory or in the operating system's application-data
directories. Those files remain untouched and are no longer used by this app.
