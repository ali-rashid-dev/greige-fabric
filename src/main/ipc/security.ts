export function isTrustedSender(
  url: string,
  isMainFrame: boolean,
  developmentUrl: string | undefined,
  productionFileUrl: string,
): boolean {
  if (!isMainFrame) return false;
  if (developmentUrl) {
    try {
      return new URL(url).origin === new URL(developmentUrl).origin;
    } catch {
      return false;
    }
  }
  return url === productionFileUrl;
}
