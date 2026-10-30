// The site-wide under construction page (main.tsx): our logo and a line of text over a circle of the app's dot grid.
import React, { useEffect, useRef } from "react";

const SPACING = 20; // the app's dot grid (.app in app.css)
const CIRCLE = "radial-gradient(circle closest-side, #000 50%, transparent 100%)"; // the rim fades into the page

type Dot = { x: number; y: number; edge: number; start: number; life: number; cyan: boolean };

/** The app's background dots, each slowly glowing up and fading at random like /launch's FlickerDots. */
function FlickerGrid() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let raf = 0;
    let dots: Dot[] = [];
    const next = (d: Dot, now: number, first = false) => {
      d.life = 2600 + Math.random() * 3400;
      d.start = now + (first ? -Math.random() * 9000 : 600 + Math.random() * (2000 + d.edge * d.edge * 9000));
      d.cyan = Math.random() < 0.3;
    };
    const layout = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      canvas.width = canvas.height = Math.round(w * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const R = w / 2;
      const steps = Math.floor(R / SPACING);
      dots = [];
      for (let i = -steps; i <= steps; i++)
        for (let j = -steps; j <= steps; j++) {
          const r = Math.hypot(i, j) * SPACING;
          if (r < R) dots.push({ x: R + i * SPACING, y: R + j * SPACING, edge: r / R, start: 0, life: 0, cyan: false });
        }
      const now = performance.now();
      for (const d of dots) next(d, now, true);
    };
    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, w);
      for (const d of dots) {
        if (now - d.start > d.life) next(d, now);
        const t = (now - d.start) / d.life;
        const glow = reduce || t < 0 ? 0 : Math.sin(Math.PI * t) ** 2;
        ctx.fillStyle = "rgba(129, 114, 152, 0.35)";
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1, 0, Math.PI * 2);
        ctx.fill();
        if (glow > 0) {
          ctx.fillStyle = `rgba(${d.cyan ? "216, 255, 254" : "236, 221, 255"}, ${glow * 0.8})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1 + glow * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    layout();
    draw(performance.now());
    const ro = new ResizeObserver(() => {
      layout();
      if (reduce) draw(performance.now());
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: "min(96vmin, 860px)",
        aspectRatio: "1",
        transform: "translate(-50%, -50%)",
        WebkitMaskImage: CIRCLE,
        maskImage: CIRCLE,
      }}
    />
  );
}

export function Paused() {
  return (
    <main
      style={{
        position: "relative",
        overflow: "hidden",
        minHeight: "100dvh",
        boxSizing: "border-box",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "clamp(16px, 4vmin, 28px)",
        textAlign: "center",
        color: "#fff",
        fontFamily: "Manrope, system-ui, sans-serif",
      }}
    >
      <FlickerGrid />
      {/* same as the top bar's logo (.logo in app.css) */}
      <span
        style={{
          position: "relative",
          display: "block",
          width: "clamp(56px, 12vmin, 96px)",
          aspectRatio: "1",
          boxSizing: "border-box",
          borderRadius: "11.5%",
          overflow: "hidden",
          border: "1.5px solid #e8e0ff",
        }}
      >
        <img src="/brand/logo.png" alt="Neuriio" style={{ display: "block", width: "100%", height: "100%" }} />
      </span>
      <div style={{ position: "relative", textShadow: "0 0 6px #120c1d, 0 0 12px #120c1d, 0 0 18px #120c1d" }}>
        <p style={{ margin: 0, fontSize: "clamp(14px, 2.6vmin, 18px)", color: "#b9aecb" }}>
          We're building a new integration. Back soon.
        </p>
      </div>
    </main>
  );
}
