import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import { FabricServiceError } from "./errors";

function pinDigest(pin: string): Buffer {
  return createHash("sha256").update(pin).digest();
}

export class OwnerAuthService {
  constructor(private readonly filePath: string) {}

  async pinStatus(): Promise<{ configured: boolean }> {
    this.assertSecureStorage();
    try {
      await readFile(this.filePath);
      return { configured: true };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { configured: false };
      }
      throw error;
    }
  }

  async setPin(pin: string): Promise<{ configured: boolean }> {
    this.assertSecureStorage();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let encryptedPin: string;
    try {
      encryptedPin = safeStorage.encryptString(pin).toString("base64");
    } catch (error) {
      console.error("Could not encrypt the owner PIN with operating-system secure storage.", error);
      throw new FabricServiceError(
        "AUTHORIZATION",
        "The owner PIN could not be encrypted by secure device storage.",
      );
    }
    try {
      await writeFile(this.filePath, encryptedPin, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new FabricServiceError("CONFLICT", "The owner PIN has already been configured.");
      }
      throw error;
    }
    return { configured: true };
  }

  async verifyPin(pin: string): Promise<boolean> {
    this.assertSecureStorage();
    let encryptedPin: string;
    try {
      encryptedPin = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new FabricServiceError(
          "AUTHORIZATION",
          "Set up the owner PIN before making inventory adjustments.",
        );
      }
      throw error;
    }

    let storedPin: string;
    try {
      storedPin = safeStorage.decryptString(Buffer.from(encryptedPin, "base64"));
    } catch {
      throw new FabricServiceError(
        "AUTHORIZATION",
        "The owner PIN cannot be decrypted with this device's secure storage.",
      );
    }
    return timingSafeEqual(pinDigest(pin), pinDigest(storedPin));
  }

  private assertSecureStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new FabricServiceError(
        "AUTHORIZATION",
        "Secure operating-system storage is unavailable; owner PIN operations are disabled.",
      );
    }
    if (
      process.platform === "linux" &&
      ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())
    ) {
      throw new FabricServiceError(
        "AUTHORIZATION",
        "Configure GNOME Keyring or KDE Wallet to store the owner PIN securely.",
      );
    }
  }
}
