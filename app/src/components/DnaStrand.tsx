// Twisted dot strand on the launch and feed pages' sides (from the X banner's edges): a column of white dots on a
// surface whose radius swells and pinches along its height, slowly turning. Depth sets each dot's size and
// opacity, and the ends fade out. Decorative only: canvas, no pointer events, still frame on reduced motion.
import { useEffect, useRef } from "react";

const DOTS = 3400;
const LOBES = 4.5; // swells along the height
const TWIST = 1.6; // turns of the cross-section along the height
const SPIN = 0.12; // radians per second

type Dot = { v: number; a: number; s: number };

/** fixed: pinned to the viewport instead of the page, for pages that scroll (the feed). phone: still shown on
 *  narrow screens (trending), where the others hide. */
export function DnaStrand({
  side,
  phase = 0,
  fixed = false,
  phone = false,
}: {
  side: "left" | "right";
  phase?: number;
  fixed?: boolean;
  phone?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // fixed random dots on the surface: v = height 0..1, a = angle around, s = size jitter
    const dots: Dot[] = Array.from({ length: DOTS }, () => ({
      v: Math.random(),
      a: Math.random() * Math.PI * 2,
      s: 0.6 + Math.random() * 0.8,
    }));

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const R = w * 0.36;
      const spin = t * SPIN + phase;
      ctx.fillStyle = "#ffffff";
      for (const d of dots) {
        const y = d.v * h;
        // radius swells and pinches (never to zero, so the neck still has a few dots)
        const r = R * (0.18 + 0.82 * Math.abs(Math.sin(d.v * Math.PI * LOBES + phase)));
        // flattened cross-section that rotates along the height: the twist
        const ex = Math.cos(d.a) * r;
        const ez = Math.sin(d.a) * r * 0.55;
        const tw = d.v * Math.PI * 2 * TWIST + spin;
        const x = ex * Math.cos(tw) - ez * Math.sin(tw);
        const z = ex * Math.sin(tw) + ez * Math.cos(tw);
        const depth = (z / R + 1) / 2; // 0 back .. 1 front
        const ends = Math.min(1, d.v / 0.06, (1 - d.v) / 0.06); // soft fade at the screen's top and bottom
        const alpha = ends * (0.06 + 0.3 * depth);
        if (alpha <= 0.01) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(w / 2 + x, y, d.s * (0.7 + 0.8 * depth), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const loop = (ms: number) => {
      draw(ms / 1000);
      raf = requestAnimationFrame(loop);
    };
    if (still) draw(0);
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [phase]);

  return <canvas ref={ref} className={`dna-strand dna-${side}${fixed ? " dna-fixed" : ""}${phone ? " dna-phone" : ""}`} aria-hidden="true" />;
}
