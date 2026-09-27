/**
 * Thin, dependency-injected wrappers around the two browser APIs the share
 * UI needs (Clipboard, Web Share). Accepting the API as a parameter rather
 * than reading `navigator` directly means these are testable in plain
 * Node with a fake implementation — the same pattern already used for
 * ads eligibility (src/lib/ads.ts's injectable check function) — with no
 * need for a jsdom/browser test environment.
 */

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface CopyResult {
  ok: boolean;
}

/** Copies `url` to the clipboard. Never throws — a denied/unsupported clipboard is reported as `{ ok: false }`, not an exception. */
export async function copyStoryLink(
  url: string,
  clipboard: ClipboardLike | undefined | null,
): Promise<CopyResult> {
  if (!clipboard) return { ok: false };
  try {
    await clipboard.writeText(url);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export interface NativeShareLike {
  share(data: { title: string; url: string }): Promise<void>;
}

export interface NativeShareResult {
  shared: boolean;
  /** The user dismissed the native share sheet — not an error. */
  cancelled: boolean;
  /** navigator.share isn't available in this browser at all. */
  unsupported: boolean;
}

/** Invokes the Web Share API with `{ title, url }`. Distinguishes "user cancelled" (AbortError) from a genuine failure so the caller never shows an error for a normal dismissal. */
export async function shareViaNativeShare(
  data: { title: string; url: string },
  nativeShare: NativeShareLike | undefined | null,
): Promise<NativeShareResult> {
  if (!nativeShare) return { shared: false, cancelled: false, unsupported: true };
  try {
    await nativeShare.share(data);
    return { shared: true, cancelled: false, unsupported: false };
  } catch (err) {
    const cancelled = err instanceof Error && err.name === "AbortError";
    return { shared: false, cancelled, unsupported: false };
  }
}
