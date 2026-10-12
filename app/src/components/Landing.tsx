// app.neuriio.xyz/ — the landing page. One screen, no scroll (phones scroll); the framed Explore card runs off the bottom: the FTF video's mirrored gradient with
// randomly twinkling dots behind the header (logo, marquee, Points + Account), the hero (name, tagline, App + Docs)
// and a showcase Explore card (fake tokens, candles and trades) in a lavender frame with a glow running around inside its stroke.
// Signing in here stays here; "App" goes to /explore (behind the passcode page while APP_PASSCODE is set).
import { useEffect, useRef, useState } from "react";
import { ExploreCard } from "./ExploreCard";
import { LogoMarquee } from "./LogoMarquee";
import { MenuBox } from "./MenuBox";
import { SocialLinks } from "./SocialLinks";
import { useTickerLogos } from "../lib/tickers";
import { useIsMobile } from "../lib/media";

export function LandingHero() {
  return (
    <section className="ld-hero">
      <h1 className="ld-name">Neuriio</h1>
      <p className="ld-tag">
        Tokenize Accounts,
        <br />
        Create Social Markets
      </p>
      <p className="ld-sub">
        The first un-vampable launchpad
        <br />
        to gain exposure to X accounts
      </p>
      <div className="ld-ctas">
        <a className="ld-cta ld-cta-app" href="/explore">
          App
        </a>
        <a className="ld-cta ld-cta-docs" href="https://docs.neuriio.xyz" target="_blank" rel="noopener noreferrer">
          Docs
        </a>
      </div>
    </section>
  );
}

export function LandingFrame() {
  const mobile = useIsMobile();
  return (
    <div className="ld-frame">
      <span className="ld-glow" aria-hidden />
      {/* inert: a picture of the app, nothing inside takes clicks, taps or keyboard focus */}
      <div className="ld-frame-in" ref={(el) => el?.setAttribute("inert", "")}>
        {mobile ? <ShowcaseFrame /> : <ExploreCard />}
      </div>
    </div>
  );
}

const DESIGN_W = 1440; // a desktop screen: the whole Explore page (header, cards, footer links)
const DESIGN_H = 900;

/** Phones: a picture of the whole desktop Explore page, shrunk. /showcase in a DESIGN_W x DESIGN_H frame (so its
 *  media queries pick the desktop layout), scaled down to the box's width; the box takes the scaled height. */
function ShowcaseFrame() {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      const scale = el.clientWidth / DESIGN_W;
      if (scale > 0) setFit({ scale, h: DESIGN_H });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="ld-iframe-box" style={fit ? { height: DESIGN_H * fit.scale } : undefined}>
      {fit && (
        <iframe
          src="/showcase"
          title="Neuriio Explore"
          tabIndex={-1}
          aria-hidden
          style={{ width: DESIGN_W, height: fit.h, transform: `scale(${fit.scale})` }}
        />
      )}
    </div>
  );
}

/** /showcase: the desktop Explore page as a still picture (shown inside ShowcaseFrame on phones): logo + menu,
 *  marquee (held still), Account + Points as signed out, the showcase Explore card, the footer links. */
export function Showcase() {
  const tickers = useTickerLogos();
  return (
    <div className="app ld-shot">
      <header className="top">
        <div className="top-left">
          <span className="logo">
            <img src="/brand/logo.png" alt="" width={52} height={52} />
          </span>
          <MenuBox />
        </div>
        <LogoMarquee logos={tickers} className="top-marquee" />
        {/* Account + Points as a signed-out visitor sees them (never the viewer's own account) */}
        <div className="top-right card-stack">
          <div className="top-box-slot" data-card="Account">
            <span className="panel top-box morph-trigger account-trigger-locked">
              <span className="morph-trigger-content">
                <span className="login-text">Account</span>
              </span>
            </span>
          </div>
          <div className="top-box-slot" data-card="Points">
            <span className="panel top-box morph-trigger points">
              <span className="morph-trigger-content">
                <span className="top-value">Points</span>
              </span>
            </span>
          </div>
        </div>
      </header>
      <main className="stage stage-explore">
        <ExploreCard />
      </main>
      <SocialLinks />
    </div>
  );
}

// ------------------------------------------------------------------ background

// the FTF video's colours: dark purple in the outer bands, smoothing into light lavender through the light line
const DARK: [number, number, number] = [61, 47, 92];
const LIGHT: [number, number, number] = [214, 199, 240];
const GAP = 30; // dot grid (the video's 40 px at 2560 wide, scaled for screens)
// the light line runs across the middle of the page, as in the video; on phones it sits behind the hero (dark text)
const centerFor = (w: number) => (w <= 860 ? 0.3 : 0.5);
let CENTER = 0.5;

function bgAt(t: number): [number, number, number] {
  const k = Math.min(1, Math.max(0, (t - 0.12) / 0.88));
  const s = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep: no visible edge at either end
  return [DARK[0] + (LIGHT[0] - DARK[0]) * s, DARK[1] + (LIGHT[1] - DARK[1]) * s, DARK[2] + (LIGHT[2] - DARK[2]) * s];
}

/** 0 at the top and bottom edges, 1 on the light line (mirrored, each side stretched to its own edge). */
function lightness(y: number, h: number) {
  const cy = h * CENTER;
  return y < cy ? y / cy : 1 - (y - cy) / (h - cy);
}

export function LandingBg() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.body.style.background = "rgb(61,47,92)"; // the gradient's top colour, so Safari's bar matches it
    let w = 0;
    let h = 0;
    let grad: CanvasGradient | null = null;
    let dots: { x: number; y: number; light: number; dark: number; rnd: number }[] = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      CENTER = centerFor(w);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grad = ctx.createLinearGradient(0, 0, 0, h);
      for (let i = 0; i <= 80; i++) {
        const [r, g, b] = bgAt(lightness((i / 80) * h, h));
        grad.addColorStop(i / 80, `rgb(${r | 0},${g | 0},${b | 0})`);
      }
      dots = [];
      for (let y = GAP / 2; y < h; y += GAP) {
        const t = lightness(y, h);
        for (let x = GAP / 2; x < w; x += GAP) {
          const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          dots.push({
            x,
            y,
            light: Math.max(0, Math.min(1, (t - 0.45) / 0.4)), // dots turn deep purple on the light band
            dark: Math.max(0, 1 - t / 0.4) ** 1.5, // the dark bands, where dots light up
            rnd: n - Math.floor(n),
          });
        }
      }
    };

    const draw = (f: number) => {
      ctx.fillStyle = grad!;
      ctx.fillRect(0, 0, w, h);
      for (const d of dots) {
        let a = 0.2 + 0.05 * Math.sin(f * 0.025 + d.y * 0.013 + d.x * 0.009);
        let size = 1.6;
        let lit = 0;
        if (d.dark > 0 && d.rnd > 0.55) {
          lit = Math.max(0, Math.sin(f * 0.015 + d.rnd * 80)) ** 18 * d.dark; // a third of the video's speed
          a += 0.85 * lit;
          size += 1.2 * lit;
        }
        const l = d.light;
        ctx.globalAlpha = Math.min(1, a * (1 - 0.55 * l)); // softer on the light middle
        ctx.fillStyle = lit > 0.3 ? "rgb(236,221,255)" : `rgb(${(255 - 185 * l) | 0},${(255 - 200 * l) | 0},${(255 - 155 * l) | 0})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    resize();
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      draw(((now - start) / 1000) * 60); // the video's frame clock (60 fps)
      raf = requestAnimationFrame(loop);
    };
    if (still) draw(0);
    else raf = requestAnimationFrame(loop);
    const onResize = () => {
      resize();
      if (still) draw(0);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return <canvas ref={ref} className="ld-bg" aria-hidden />;
}
