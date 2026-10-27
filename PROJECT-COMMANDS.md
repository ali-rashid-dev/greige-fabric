# Project command guide

Run commands from the project root.

## Install dependencies

```sh
npm install
```

Install the project's Node.js dependencies.

## Run the application

| Command | Usage |
| --- | --- |
| `npm run dev` | Start the Next.js development server and Electron together. |
| `npm run dev:web` | Start only the Next.js renderer at `http://127.0.0.1:3000`. |
| `npm run dev:electron` | Start Electron after the local Next.js server responds. When run separately, start `npm run dev:web` first. |

Use `Ctrl+C` to stop development processes.

## Quality checks

| Command | Usage |
| --- | --- |
| `npm run typecheck` | Run TypeScript without emitting build output. |
| `npm run lint` | Run ESLint across the project. |
| `npm test` | Rebuild `better-sqlite3` for host Node, run Vitest catalog/database tests, then restore its Electron build. Let it finish so Electron's native module is ready for development. |

## Build and package

| Command | Usage |
| --- | --- |
| `npm run build` | Build the static Next.js renderer into `out/` and Electron main process into `dist-electron/`. |
| `npm run dist` | Build the Windows x64 NSIS installer (same as `npm run dist:win`). |
| `npm run dist:win` | Build Windows NSIS installer(s). |
| `npm run dist:mac` | Build a macOS DMG. Run on a macOS build machine. |
| `npm run dist:linux` | Build Linux AppImage and DEB packages. |

Packaged artifacts are written to `release/`. Build on a native runner for the
target operating system and architecture so native dependencies match the
platform. The Windows NSIS installer requires Windows or Wine. macOS signing
and notarization are not configured by default. See [INSTALLING.md](./INSTALLING.md)
for end-user installation instructions.

The runtime POS database is created in Electron's per-user application data
directory. SQL schema migrations live in `database/migrations/` and are bundled
with packaged apps.

## Show available scripts

```sh
npm run
```

This lists the scripts declared in `package.json`.
