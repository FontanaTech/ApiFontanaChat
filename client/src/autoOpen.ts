/**
 * Apertura automática del widget de chat (sin dependencias de framework).
 *
 * Comportamiento:
 *  - Al cargar la página el chat se abre solo, tras `openDelayMs`.
 *  - Si el visitante lo cierra y la página permanece inactiva `idleMs` (2 min por defecto), reaparece.
 *    Cualquier actividad (pointerdown, pointermove, keydown, scroll, touchstart, wheel) reinicia la espera.
 *  - Con la pestaña oculta no se reabre: la espera se pausa y se reinicia al volver a ser visible.
 *  - Mientras el chat está abierto no hay ningún temporizador. El ciclo se repite en cada cierre.
 *
 * Uso con un widget propio (el widget debe avisar de cada apertura/cierre):
 *
 *   const auto = createAutoOpen({ open: () => widget.open(), isOpen: () => widget.isOpen });
 *   widget.onOpen = () => { auto.notifyOpened(); void client.track('chat_open'); };
 *   widget.onClose = () => auto.notifyClosed();
 *   auto.start();                       // al montar la página
 *   // auto.destroy();                  // al desmontar (SPA)
 *
 * `open()` debe abrir el chat; el registro del evento 'chat_open' se hace con client.track('chat_open')
 * en la apertura del widget (automática o manual), no aquí.
 */

export interface AutoOpenTarget {
  addEventListener(type: string, listener: (e: any) => void, options?: any): void;
  removeEventListener(type: string, listener: (e: any) => void, options?: any): void;
}

export interface AutoOpenOptions {
  /** Abre el chat. */
  open: () => void;
  /** Si se indica y devuelve true cuando vence un temporizador, no se vuelve a llamar a open(). */
  isOpen?: () => boolean;
  /** Inactividad (con el chat cerrado) antes de reaparecer. Por defecto 120 000 ms. */
  idleMs?: number;
  /** Espera inicial antes de la primera apertura. Por defecto 600 ms. */
  openDelayMs?: number;
  /** Origen de los eventos de actividad. Por defecto `window`. */
  target?: AutoOpenTarget;
  /** Fuente de `hidden` y `visibilitychange`. Por defecto `document`. */
  doc?: AutoOpenTarget & { hidden?: boolean };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

export interface AutoOpen {
  /** Programa la apertura inicial y empieza a escuchar actividad. */
  start(): void;
  /** El chat se abrió (manual o automático): cancela cualquier espera. */
  notifyOpened(): void;
  /** El chat se cerró: arma la espera de inactividad. */
  notifyClosed(): void;
  /** Quita listeners y temporizadores. */
  destroy(): void;
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;
const LISTEN = { passive: true, capture: true } as const;

export function createAutoOpen(opts: AutoOpenOptions): AutoOpen {
  const idleMs = opts.idleMs ?? 120_000;
  const openDelayMs = opts.openDelayMs ?? 600;
  const target = opts.target ?? (typeof window !== 'undefined' ? (window as unknown as AutoOpenTarget) : undefined);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? (document as unknown as AutoOpenTarget & { hidden?: boolean }) : undefined);
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const now = opts.now ?? (() => Date.now());

  // initial: aún no se abrió automáticamente · open: chat abierto · closed: cerrado, esperando inactividad
  let phase: 'initial' | 'open' | 'closed' = 'initial';
  let started = false;
  let destroyed = false;
  let handle: unknown = null;
  let lastActivity = now();

  const hidden = () => doc?.hidden === true;
  const clear = () => {
    if (handle !== null) clearT(handle);
    handle = null;
  };
  const arm = (ms: number) => {
    clear();
    handle = setT(onTimer, Math.max(0, ms));
  };
  const openNow = () => {
    phase = 'open';
    clear();
    if (!opts.isOpen?.()) opts.open();
  };

  function onTimer() {
    handle = null;
    if (destroyed || phase === 'open') return;
    if (hidden()) return; // en pausa: visibilitychange lo reanuda
    if (phase === 'initial') return openNow();
    const remaining = idleMs - (now() - lastActivity);
    if (remaining > 0) return arm(remaining); // hubo actividad desde que se armó
    openNow();
  }

  // Solo guarda la marca de tiempo (sin reiniciar el temporizador en cada evento).
  const onActivity = () => {
    if (phase === 'closed') lastActivity = now();
  };

  const onVisibility = () => {
    if (destroyed || phase === 'open') return;
    if (hidden()) return clear();
    if (phase === 'initial') return arm(openDelayMs);
    lastActivity = now();
    arm(idleMs);
  };

  return {
    start() {
      if (started || destroyed) return;
      started = true;
      for (const t of ACTIVITY_EVENTS) target?.addEventListener(t, onActivity, LISTEN);
      doc?.addEventListener('visibilitychange', onVisibility);
      if (!hidden()) arm(openDelayMs);
    },
    notifyOpened() {
      if (destroyed) return;
      phase = 'open';
      clear();
    },
    notifyClosed() {
      if (destroyed) return;
      phase = 'closed';
      lastActivity = now();
      if (started && !hidden()) arm(idleMs);
      else clear();
    },
    destroy() {
      destroyed = true;
      clear();
      for (const t of ACTIVITY_EVENTS) target?.removeEventListener(t, onActivity, LISTEN);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
