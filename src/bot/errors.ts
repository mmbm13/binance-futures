/** Extract a readable message from Binance SDK / API errors. */
export function formatError(e: unknown): string {
  if (e instanceof Error && e.message && e.message !== '[object Object]') {
    return e.message;
  }
  if (typeof e === 'object' && e !== null) {
    const o = e as { message?: string; body?: { msg?: string }; msg?: string };
    if (o.body?.msg) return o.body.msg;
    if (o.msg) return o.msg;
    if (o.message && o.message !== '[object Object]') return o.message;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}
