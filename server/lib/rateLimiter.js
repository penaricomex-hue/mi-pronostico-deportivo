import { sleep } from './http.js';

/**
 * Limitador de ventana deslizante: como máximo `limit` llamadas cada `windowMs`.
 * Las llamadas que excedan el límite esperan en cola (no se descartan).
 * También respeta pausas impuestas por el servidor (429 + Retry-After).
 */
export function createRateLimiter({ limit = 10, windowMs = 60000, now = () => Date.now(), wait = sleep } = {}) {
  const timestamps = [];
  let blockedUntil = 0;
  let chain = Promise.resolve();

  async function acquire() {
    for (;;) {
      const t = now();
      while (timestamps.length && t - timestamps[0] >= windowMs) timestamps.shift();
      if (t < blockedUntil) { await wait(blockedUntil - t); continue; }
      if (timestamps.length < limit) { timestamps.push(t); return; }
      await wait(windowMs - (t - timestamps[0]) + 5);
    }
  }

  return {
    /** Ejecuta fn respetando el límite; las llamadas se serializan para el conteo. */
    schedule(fn) {
      const slot = chain.then(acquire);
      chain = slot.catch(() => {});
      return slot.then(fn);
    },
    /** Bloquea nuevas llamadas durante ms (p. ej. tras un 429). */
    pause(ms) {
      blockedUntil = Math.max(blockedUntil, now() + ms);
    },
    /** Ajusta el conteo con la cabecera de llamadas disponibles del proveedor. */
    syncAvailable(available) {
      if (!Number.isFinite(available)) return;
      const used = Math.max(0, limit - available);
      const t = now();
      while (timestamps.length < used) timestamps.push(t);
    },
    stats() {
      const t = now();
      const recent = timestamps.filter(x => t - x < windowMs).length;
      return { limit, windowMs, usedInWindow: recent, blockedForMs: Math.max(0, blockedUntil - t) };
    }
  };
}
