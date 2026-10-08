export class HttpError extends Error {
  constructor(message, { status, data, headers } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
    this.headers = headers;
  }
}

/** fetch + JSON con timeout y errores con estado HTTP. */
export async function fetchJson(url, { headers = {}, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    throw new HttpError(data?.message || data?.error || `HTTP ${res.status}`, {
      status: res.status, data, headers: res.headers
    });
  }
  return { data, headers: res.headers, status: res.status };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
