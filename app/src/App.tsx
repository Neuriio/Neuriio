// Neuriio app shell: blank layout from the wireframe (content comes step by step).
import "./app.css";
import { AccountBox } from "./components/AccountBox";
import { PointsBox } from "./components/PointsBox";
import { CardStack } from "./components/CardStack";
import { TopNav } from "./components/TopNav";
import { HeaderSearch } from "./components/HeaderSearch";
import { SiteFooter } from "./components/SiteFooter";
import { LogoMarquee } from "./components/LogoMarquee";
import { useTickerLogos } from "./lib/tickers";
import { LaunchCard } from "./components/LaunchCard";
import { ExploreCard } from "./components/ExploreCard";
import { FeedCard } from "./components/FeedCard";
import { SwapCard } from "./components/SwapCard";
import { DnaStrand } from "./components/DnaStrand";
import { LandingBg, LandingFrame, LandingHero, Showcase } from "./components/Landing";
import { useRegisterOnLogin } from "./lib/register";
import { useNotificationsPoller } from "./lib/ftf";
import { ArtPage } from "./components/ArtPage";
import { SafePage } from "./components/SafePage";
import { TradeMock } from "./components/TradeMock";

// One layout for every page; the center card changes by path (app.neuriio.xyz/launch, ...).
// "/" opens the Feed (public launch, user 2026-10-20: no landing page, no passcode); any other unknown path shows Explore.
// The address bar is set to the page shown. (The landing page's code stays, unused, for a later marketing site.)
// (/trending was removed 2026-11-05: its Trending list now lives in Explore, so old /trending links land on Explore)
const ROUTES = ["/showcase", "/safe", "/art", "/trade", "/launch", "/feed", "/explore", "/swap"];
const RAW = location.pathname.replace(/\/+$/, "") || "/";
const PAGE = RAW === "/" ? "/feed" : ROUTES.includes(RAW) ? RAW : "/explore";
if (RAW !== PAGE) history.replaceState(null, "", PAGE + location.search + location.hash);

export function App() {
  // /showcase: the landing's Explore card alone (framed into the landing on phones); no header, no account hooks
  // /safe (unlisted): the Neuriio Safe's approval page for its owners' own wallets (SafePage)
  if (PAGE === "/safe") return <SafePage />;
  // /art (unlisted): a creator sets their coin's art on Ascend (ArtPage); open while the site is paused
  if (PAGE === "/art") return <ArtPage />;
  return PAGE === "/showcase" ? <Showcase /> : <Page />;
}

function Page() {
  const tickers = useTickerLogos();
  useRegisterOnLogin();
  useNotificationsPoller();
  return (
    <div className={PAGE === "/" ? "app app-landing" : `app app-nav${PAGE === "/explore" || PAGE === "/trade" ? " app-explore" : ""}`}>
      {PAGE === "/" && <LandingBg />}
      <header className="top">
        <div className="top-left">
          <a className="logo" href="/" aria-label="Neuriio home">
            <img src="/brand/logo-dots.png" alt="Neuriio" width={52} height={52} />
          </a>
        </div>
        {PAGE !== "/" && <TopNav current={PAGE} />}
        <LogoMarquee logos={tickers} className="top-marquee" />
        {/* the token search: Explore puts its own here (desktop; picking switches the token in place); other pages
            search and open the token in Explore */}
        {PAGE !== "/" && (
          <div id="top-search" className="top-search">
            {PAGE !== "/explore" && <HeaderSearch />}
          </div>
        )}
        <CardStack>
          <PointsBox />
          <AccountBox />
        </CardStack>
      </header>

      {PAGE === "/" ? (
        // landing: hero + the live Explore card in a glowing frame, one screen
        <main className="ld-stage">
          <LandingHero />
          <LandingFrame />
        </main>
      ) : PAGE === "/launch" ? (
        // launch: one bigger card, no tabs bar
        <>
          <DnaStrand side="left" />
          <DnaStrand side="right" phase={1.3} />
          <main className="stage stage-launch">
            <LaunchCard />
            {/* the testnet funds button (HypeButton) was removed for mainnet (user, 2026-11-09); the component file is kept */}
          </main>
        </>
      ) : PAGE === "/feed" ? (
        // feed: one column as wide as Explore's three cards; grows with the page and scrolls
        <>
          <DnaStrand side="left" fixed />
          <DnaStrand side="right" phase={1.3} fixed />
          <main className="stage stage-feed">
            <FeedCard />
          </main>
        </>
      ) : PAGE === "/trade" ? (
        // LOCAL MOCKUP of the Trade Arena flow (TradeMock.tsx): not for pushing
        <main className="stage stage-explore ex-wide">
          <TradeMock />
        </main>
      ) : PAGE === "/swap" ? (
        // swap: one centered swap card between the launch page's dot strands
        <>
          <DnaStrand side="left" fixed />
          <DnaStrand side="right" phase={1.3} fixed />
          <main className="stage stage-swap">
            <SwapCard />
          </main>
        </>
      ) : (
        // explore: edge to edge, cards touching (Hyperliquid-style); top list | chart | order | stake, positions below
        <main className="stage stage-explore ex-wide">
          <ExploreCard />
        </main>
      )}

      {PAGE !== "/" && <SiteFooter />}
    </div>
  );
}
