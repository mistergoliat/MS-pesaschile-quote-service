export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeHref(value: string, allowedProtocols: readonly string[]): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (allowedProtocols.includes("mailto:") && trimmed.includes("@") && !trimmed.includes(":")) {
    return `mailto:${trimmed}`;
  }

  if (allowedProtocols.includes("tel:") && /^[+()\d\s-]+$/.test(trimmed) && !trimmed.includes(":")) {
    return `tel:${trimmed.replace(/\s+/g, "")}`;
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);

    if (!allowedProtocols.includes(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
