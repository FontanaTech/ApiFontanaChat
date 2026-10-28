import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoOpen } from '../src';

const IDLE = 120_000;
const DELAY = 600;

function setup(extra: Partial<Parameters<typeof createAutoOpen>[0]> = {}) {
  const target = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const open = vi.fn();
  const auto = createAutoOpen({ open, target, doc, ...extra });
  const activity = (type = 'pointermove') => target.dispatchEvent(new Event(type));
  const setHidden = (h: boolean) => {
    doc.hidden = h;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { auto, open, activity, setHidden, target, doc };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createAutoOpen', () => {
  it('(a) abre el chat al cargar la página tras openDelayMs', () => {
    const { auto, open } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(1);
    auto.destroy();
  });

  it('(b) tras cerrarlo y 2 minutos de inactividad, reaparece', () => {
    const { auto, open } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyClosed();
    vi.advanceTimersByTime(IDLE - 1);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(2);
    auto.destroy();
  });

  it('(b) la actividad reinicia la espera (sin reiniciar el timer en cada evento)', () => {
    const { auto, open, activity } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyClosed();
    vi.advanceTimersByTime(IDLE - 10_000);
    activity('keydown'); // quedan 10 s, pero hubo actividad: faltan 2 min completos desde ahora
    vi.advanceTimersByTime(10_000);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IDLE - 10_001);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(2);
    auto.destroy();
  });

  it.each(['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'])('(b) %s cuenta como actividad', (type) => {
    const { auto, open, activity } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyClosed();
    vi.advanceTimersByTime(IDLE - 1000);
    activity(type);
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(1);
    auto.destroy();
  });

  it('(c) con la pestaña oculta no reabre; al volver visible espera de nuevo idleMs', () => {
    const { auto, open, setHidden } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyClosed();
    vi.advanceTimersByTime(60_000);
    setHidden(true);
    vi.advanceTimersByTime(IDLE * 3);
    expect(open).toHaveBeenCalledTimes(1);
    setHidden(false);
    vi.advanceTimersByTime(IDLE - 1);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(2);
    auto.destroy();
  });

  it('(c) si la página carga oculta, la apertura inicial espera a que sea visible', () => {
    const { auto, open, doc, setHidden } = setup();
    doc.hidden = true;
    auto.start();
    vi.advanceTimersByTime(10_000);
    expect(open).not.toHaveBeenCalled();
    setHidden(false);
    vi.advanceTimersByTime(DELAY);
    expect(open).toHaveBeenCalledTimes(1);
    auto.destroy();
  });

  it('(d) mientras está abierto no hay temporizador ni reaperturas', () => {
    const { auto, open, activity } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyOpened();
    activity();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(IDLE * 5);
    expect(open).toHaveBeenCalledTimes(1);
    auto.destroy();
  });

  it('(d) abrirlo manualmente antes de la apertura inicial cancela la automática', () => {
    const { auto, open } = setup();
    auto.start();
    auto.notifyOpened();
    vi.advanceTimersByTime(IDLE);
    expect(open).not.toHaveBeenCalled();
    auto.destroy();
  });

  it('(e) el ciclo cerrar → inactividad → reaparecer se repite', () => {
    const { auto, open } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    for (let i = 2; i <= 4; i++) {
      auto.notifyClosed();
      vi.advanceTimersByTime(IDLE);
      expect(open).toHaveBeenCalledTimes(i);
    }
    auto.destroy();
  });

  it('(f) destroy limpia timers y listeners', () => {
    const { auto, open, activity, setHidden } = setup();
    auto.start();
    vi.advanceTimersByTime(DELAY);
    auto.notifyClosed();
    expect(vi.getTimerCount()).toBe(1);
    auto.destroy();
    expect(vi.getTimerCount()).toBe(0);
    activity();
    setHidden(true);
    setHidden(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(IDLE * 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('(f) destroy antes de la apertura inicial impide que abra', () => {
    const { auto, open } = setup();
    auto.start();
    auto.destroy();
    vi.advanceTimersByTime(IDLE);
    expect(open).not.toHaveBeenCalled();
  });

  it('(g) registra los listeners como passive', () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const auto = createAutoOpen({ open: vi.fn(), target, doc: new EventTarget() });
    auto.start();
    const calls = target.addEventListener.mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual(['keydown', 'pointerdown', 'pointermove', 'scroll', 'touchstart', 'wheel']);
    for (const c of calls) expect(c[2]).toMatchObject({ passive: true });
    auto.destroy();
    expect(target.removeEventListener).toHaveBeenCalledTimes(6);
  });

  it('respeta idleMs y openDelayMs personalizados e isOpen', () => {
    let isOpen = false;
    const { auto, open } = setup({ idleMs: 5000, openDelayMs: 100, isOpen: () => isOpen });
    auto.start();
    vi.advanceTimersByTime(100);
    expect(open).toHaveBeenCalledTimes(1);
    auto.notifyClosed();
    isOpen = true; // el usuario lo reabrió sin avisar
    vi.advanceTimersByTime(5000);
    expect(open).toHaveBeenCalledTimes(1);
    auto.destroy();
  });
});
