# Installing Greige Fabric POS

This guide covers installing a packaged desktop release on Windows, macOS, or
Linux. Obtain the installer/package from the person or team distributing the
release. Packaged files are produced in the project's `release/` directory;
this repository does not currently publish downloads automatically.

## Before installing

- Download the package built for your operating system and CPU architecture.
- Back up any existing POS data before upgrading. Do not uninstall the app as a
  way to upgrade it.
- Close Greige Fabric POS before installing an update.
- Keep your backup files outside the application installation folder.

The database and owner PIN are stored in the operating system's per-user
application data directory, not alongside the installed program. Windows
uninstall is configured to preserve application data. On startup, the app
creates a snapshot before applying pending database migrations.

## Windows

The first release target is a 64-bit Windows NSIS installer.

1. Download `Greige Fabric POS-Setup-<version>-x64.exe`.
2. Open the installer and follow its prompts. You can choose the installation
   directory and create desktop and Start Menu shortcuts.
3. Launch **Greige Fabric POS** from the Start Menu or desktop shortcut.
4. If Windows SmartScreen warns that the publisher is unknown, only continue
   if you trust the release source. Builds are not currently code-signed.

To build the installer yourself on Windows x64, install Node.js 22.12 or newer
and npm 10 or newer, open a terminal in the project directory, and run:

```powershell
npm install
npm run dist:win
```

The installer is written to `release/`. Building the NSIS installer on Linux
requires Wine; building on Windows or a Windows CI runner is recommended.

## macOS

Use the DMG built for your Mac's CPU architecture.

1. Open the downloaded `.dmg` file.
2. Drag **Greige Fabric POS** into the **Applications** folder.
3. Eject the mounted installer image and launch the app from Applications.
4. If macOS blocks the app because it is not signed/notarized, only open it if
   you trust the release source and your organization's policy permits it.

To build a DMG, use a Mac build machine with Node.js 22.12 or newer and npm 10
or newer:

```sh
npm install
npm run dist:mac
```

The DMG is written to `release/`. Code signing and notarization are not
configured by default, so Gatekeeper may show a warning.

## Linux

The project produces AppImage and Debian (`.deb`) packages. Choose the format
supported by your distribution.

### AppImage

```sh
chmod +x "./Greige Fabric POS.AppImage"
"./Greige Fabric POS.AppImage"
```

Replace `Greige Fabric POS.AppImage` with the exact downloaded filename.

If the app cannot start because a shared system library is missing, install the
missing dependency for your Linux distribution and try again. On systems using
GNOME Keyring or KDE Wallet, ensure the keyring/wallet service is running;
owner-PIN storage requires Electron's secure storage integration.

### Debian or Ubuntu package

```sh
sudo apt install ./greige-fabric-pos_<version>_amd64.deb
```

Launch **Greige Fabric POS** from the applications menu. The exact generated
filename may vary by version and architecture; use the `.deb` provided with
the release.

To build Linux packages on a Linux build machine:

```sh
npm install
npm run dist:linux
```

The AppImage and `.deb` are written to `release/`. Native dependencies are
rebuilt for the target Electron runtime and build platform; use a native build
machine or matching CI runner for the desired Linux architecture.

## Installing from source for development

For development only, install Node.js 22.12 or newer and npm 10 or newer, then
run:

```sh
npm install
npm run dev
```

This starts the local Next.js development server and Electron together. A
packaged production build does not use the development server. To create a
production package, use the platform-specific build command above.

## Upgrading and recovery

1. Open the current version and use **Backup & recovery** to create and verify
   a backup. Copy it to another drive or protected location when possible.
2. Close the app and install the new version over the old version.
3. Start the new version and allow the database migrations to finish.
4. Confirm the app opens and check key stock, customer, supplier, and accounting
   records.

If an upgrade or migration fails, preserve the database and backup files and
contact the release maintainer before retrying. To restore a backup, open
**Backup & recovery**, enter the owner PIN, select **Restore backup**, confirm
the operation, and allow the application to restart. The current database is
preserved before the restore is applied.

For release validation, see the [Windows release checklist in the README](./README.md#windows-release-validation).
