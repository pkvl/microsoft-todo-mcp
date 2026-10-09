import { AppError } from "./errors";

/** Validate before acquiring a token: cursors and nextLink values are untrusted input. */
export function graphDestination(base: string, pathOrUrl: string): URL {
  try {
    const root = new URL(base);
    if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash || root.pathname !== "/v1.0") {
      throw new Error("Invalid Graph base");
    }
    if (/[\\\x00-\x20\x7f]/.test(pathOrUrl)) throw new Error("Invalid URL characters");
    const url = new URL(pathOrUrl.startsWith("/") ? `${base}${pathOrUrl}` : pathOrUrl);
    if (url.protocol !== "https:" || url.origin !== root.origin || url.username || url.password || url.hash) {
      throw new Error("Untrusted origin");
    }
    // Reject encoded separators, dot segments and nested escaping. IDs remain URI-encoded.
    if (/%(?:2f|5c|2e|25|00)/i.test(url.pathname)) throw new Error("Escaped path");
    if (!/^\/v1\.0\/me\/todo\/lists(?:\/[^/]+(?:\/tasks(?:\/[^/]+(?:\/(?:checklistItems|linkedResources|attachments|extensions)(?:\/[^/]+)?)?)?)?)?$/.test(url.pathname)) {
      throw new Error("Outside To Do API");
    }
    return url;
  } catch {
    throw new AppError("validation_error", "Request destination must be the configured HTTPS Microsoft Graph To Do API.");
  }
}
