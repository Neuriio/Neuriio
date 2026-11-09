// Random dots of the page's dot grid light up bright and fade, all over the background (launch page). Crisp, no glow: the
// grid dot itself turns bright lavender-white (the X banner's lit-dot colour, f0e6ff), holds, then fades back (user,
// 2026-11-08: "bright, not glowy", the banner's plain dark-purple dot grid without its gradients). Drawn on one canvas
// behind the content, on the grid's exact dot spots (.app background: a dot in the middle of every 20px square), and
// never under the header, the card or the footer. Decorative only: no pointer events, nothing on reduced motion.
import { useEffect, useRef } from "react";

const GRID = 20;
const PER_MEGAPIXEL = 16; // how many dots are lit at once per million px of page (about 33 on a 1920x1080 screen)
const DOT_R = 1.25; // px: the grid dot is 1px round; lit a hair bigger so it reads
const KEEP_CLEAR = ".stage > :not(.launch-go), .stage .panel, .launch-go-btn, .top > *, .site-foot"; // the Launch button itself, not its big empty square
const PAD = 14; // px kept clear around those

type Twinkle = { x: number; y: number; born: number; life: number; peak: number };

export function GridTwinkles() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let w = 0;
    let h = 0;
    let blocked: DOMRect[] = [];
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    // where the content is, in the host's coordinates (re-read now and then: the card grows and shrinks between steps)
    const measure = () => {
      const base = host.getBoundingClientRect();
      blocked = [...document.querySelectorAll(KEEP_CLEAR)].map((el) => {
        const r = el.getBoundingClientRect();
        return new DOMRect(r.left - base.left - PAD, r.top - base.top - PAD, r.width + 2 * PAD, r.height + 2 * PAD);
      });
    };
    const free = (x: number, y: number) => !blocked.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);

    let lit: Twinkle[] = [];
    const spawn = (now: number) => {
      for (let tries = 0; tries < 80; tries++) { // plenty of tries: around the open card only thin strips of page are free
        const x = Math.floor(Math.random() * Math.floor(w / GRID)) * GRID + GRID / 2;
        const y = Math.floor(Math.random() * Math.floor(h / GRID)) * GRID + GRID / 2;
        if (!free(x, y) || lit.some((t) => t.x === x && t.y === y)) continue;
        lit.push({ x, y, born: now, life: 2000 + Math.random() * 2000, peak: 0.75 + 0.25 * Math.random() });
        return;
      }
    };

    size();
    measure();
    const ro = new ResizeObserver(() => {
      size();
      measure();
    });
    ro.observe(host);
    // the cards are see-through, so no dot may ever show behind one: re-read often (the card opens, slides in and
    // changes height between steps) and the moment anything changes in the stage
    const remeasure = window.setInterval(measure, 200);
    const stage = document.querySelector(".stage");
    const mo = new MutationObserver(measure);
    if (stage) mo.observe(stage, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });

    let raf = 0;
    let last = performance.now();
    let owed = 0;
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      // keep about `target` lit: each lives ~3 s on average, so spawn target/3 per second (user, 2026-11-08: pulse slowed by over half)
      const target = Math.max(7, Math.round(((w * h) / 1e6) * PER_MEGAPIXEL));
      owed += (dt / 1000) * (target / 3);
      while (owed >= 1) {
        spawn(now);
        owed -= 1;
      }
      // a lit dot that a card has since moved over goes out at once
      lit = lit.filter((t) => now - t.born < t.life && free(t.x, t.y));

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#f0e6ff";
      for (const t of lit) {
        // comes on over 0.3 s, holds, fades off over the last 1 s
        const age = now - t.born;
        const lvl = Math.min(1, age / 300, (t.life - age) / 1000) * t.peak;
        ctx.globalAlpha = lvl;
        ctx.beginPath();
        ctx.arc(t.x, t.y, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(remeasure);
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="grid-twinkles" aria-hidden />;
}
