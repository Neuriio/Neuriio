// Lights up a few random dots of the page's dot grid around whatever matches `selector`; each one fades in and out. Drawn into .app (the
// element that paints the grid), on its exact dot spots, re-picked every few seconds. ButtonDots is the same look inside a button, on hover.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GRID = 20; // the page's dot grid (app.css .app background): one dot at the middle of every 20px square
const REACH = 3; // how many grid rows/columns around an element can light up
const PER_ELEMENT = 9;

type Dot = { x: number; y: number; d: number; t: number };

/** Random grid dots around `el` that it doesn't cover and that are on the page. */
function dotsAround(el: Element, host: HTMLElement, count: number, duration: () => number, delay: () => number): Dot[] {
  const base = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = r.left - base.left;
  const top = r.top - base.top;
  const spots: { x: number; y: number }[] = [];
  const i0 = Math.floor((left - REACH * GRID) / GRID);
  const i1 = Math.ceil((left + r.width + REACH * GRID) / GRID);
  const j0 = Math.floor((top - REACH * GRID) / GRID);
  const j1 = Math.ceil((top + r.height + REACH * GRID) / GRID);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = i * GRID + GRID / 2;
      const y = j * GRID + GRID / 2;
      const inside = x > left - 4 && x < left + r.width + 4 && y > top - 4 && y < top + r.height + 4;
      if (inside || x <= 0 || y <= 0 || x >= base.width) continue;
      // only where the grid shows, never on top of a card or control
      if (document.elementFromPoint(x + base.left, y + base.top)?.closest(".panel, .ex-card, button, a, input")) continue;
      spots.push({ x, y });
    }
  }
  const out: Dot[] = [];
  for (let k = 0; k < count && spots.length; k++) {
    const [spot] = spots.splice(Math.floor(Math.random() * spots.length), 1);
    out.push({ ...spot, d: duration(), t: delay() });
  }
  return out;
}

export function LitDots({ selector }: { selector: string }) {
  const [dots, setDots] = useState<Dot[]>([]);
  const host = document.querySelector<HTMLElement>(".app");
  useEffect(() => {
    if (!host) return;
    const pick = () => {
      const out: Dot[] = [];
      document.querySelectorAll(selector).forEach((el) => out.push(...dotsAround(el, host, PER_ELEMENT, () => 1.6 + Math.random() * 2.4, () => Math.random() * 2)));
      setDots(out);
    };
    pick();
    const id = setInterval(pick, 4500);
    window.addEventListener("resize", pick);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", pick);
    };
  }, [host, selector]);
  if (!host) return null;
  return createPortal(
    <div className="lit-dots" aria-hidden>
      {dots.map((p, i) => (
        <span key={`${p.x}-${p.y}-${i}`} style={{ left: p.x, top: p.y, animationDuration: `${p.d}s`, animationDelay: `${p.t}s` }} />
      ))}
    </div>,
    host,
  );
}

const BUTTON_GRID = 8; // .btn-dots' background: one dot at the middle of every 8px square
const BUTTON_DOTS = 3;

/**
 * Inside a button (position: relative), behind its content: on mouse hover a faint grid of dots appears and some of them glow and fade.
 * Touch screens have no hover, so nothing shows there.
 */
export function ButtonDots() {
  const box = useRef<HTMLSpanElement>(null);
  const [dots, setDots] = useState<Dot[] | null>(null);
  useEffect(() => {
    const el = box.current;
    const button = el?.parentElement;
    if (!el || !button) return;
    let timer = 0;
    const light = () => {
      const cols = Math.floor(el.clientWidth / BUTTON_GRID);
      const rows = Math.floor(el.clientHeight / BUTTON_GRID);
      setDots(
        Array.from({ length: BUTTON_DOTS }, () => ({
          x: Math.floor(Math.random() * cols) * BUTTON_GRID + BUTTON_GRID / 2,
          y: Math.floor(Math.random() * rows) * BUTTON_GRID + BUTTON_GRID / 2,
          d: 1 + Math.random() * 0.9,
          t: Math.random() * 0.4,
        })),
      );
    };
    const enter = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      light();
      clearInterval(timer);
      timer = window.setInterval(light, 1500);
    };
    const leave = () => {
      clearInterval(timer);
      setDots(null);
    };
    button.addEventListener("pointerenter", enter);
    button.addEventListener("pointerleave", leave);
    return () => {
      clearInterval(timer);
      button.removeEventListener("pointerenter", enter);
      button.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <span ref={box} className={`btn-dots${dots ? " is-on" : ""}`} aria-hidden>
      {dots?.map((p, i) => (
        <span key={`${p.x}-${p.y}-${i}`} style={{ left: p.x, top: p.y, animationDuration: `${p.d}s`, animationDelay: `${p.t}s` }} />
      ))}
    </span>
  );
}
