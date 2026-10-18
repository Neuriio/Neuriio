// Neuriio app shell: blank layout from the wireframe (content comes step by step).
import "./app.css";
import { AccountBox } from "./components/AccountBox";
import { PointsBox } from "./components/PointsBox";
import { CardStack } from "./components/CardStack";
import { TopNav } from "./components/TopNav";
import { HeaderSearch } from "./components/HeaderSearch";
import { HypeButton } from "./components/HypeButton";
import { SocialLinks } from "./components/SocialLinks";
import { LogoMarquee } from "./components/LogoMarquee";
import { useTickerLogos } from "./lib/tickers";
import { LaunchCard } from "./components/LaunchCard";
import { ExploreCard } from "./components/ExploreCard";
import { FeedCard } from "./components/FeedCard";
import { TrendingCard } from "./components/TrendingCard";
import { DnaStrand } from "./components/DnaStrand";
import { LandingBg, LandingFrame, LandingHero, Showcase } from "./components/Landing";
import { useRegisterOnLogin } from "./lib/register";
import { useNotificationsPoller } from "./lib/ftf";

// One layout for every page; the center card changes by path (app.neuriio.xyz/launch, ...).
// "/" is the landing page (no menu; Explore inside a frame); any unknown path shows Explore and the address bar is set to /explore.
const ROUTES = ["/", "/showcase", "/launch", "/feed", "/explore", "/trending"];
const RAW = location.pathname.replace(/\/+$/, "") || "/";
const PAGE = ROUTES.includes(RAW) ? RAW : "/explore";
if (RAW !== PAGE) history.replaceState(null, "", "/explore" + location.search + location.hash);

export function App() {
  // /showcase: the landing's Explore card alone (framed into the landing on phones); no header, no account hooks
  return PAGE === "/showcase" ? <Showcase /> : <Page />;
}

function Page() {
  const tickers = useTickerLogos();
  useRegisterOnLogin();
  useNotificationsPoller();
  return (
    <div className={PAGE === "/" ? "app app-landing" : `app app-nav${PAGE === "/explore" ? " app-explore" : ""}`}>
      {PAGE === "/" && <LandingBg />}
      <header className="top">
        <div className="top-left">
          <a className="logo" href="/" aria-label="Neuriio home">
            <img src="/brand/logo.png" alt="Neuriio" width={52} height={52} />
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
            <div className="launch-hype">
              <HypeButton />
            </div>
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
      ) : PAGE === "/trending" ? (
        // trending: the Top 25 between the launch page's dot strands (shown on phones too)
        <>
          <DnaStrand side="left" fixed phone />
          <DnaStrand side="right" phase={1.3} fixed phone />
          <main className="stage stage-trending">
            <TrendingCard />
          </main>
        </>
      ) : (
        // explore: edge to edge, cards touching (Hyperliquid-style); top list | chart | order | stake, positions below
        <main className="stage stage-explore ex-wide">
          <ExploreCard />
        </main>
      )}

      {PAGE !== "/" && <SocialLinks />}
    </div>
  );
}
