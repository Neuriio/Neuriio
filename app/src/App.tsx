// Neuriio app shell: blank layout from the wireframe (content comes step by step).
import "./app.css";
import { AccountBox } from "./components/AccountBox";
import { PointsBox } from "./components/PointsBox";
import { CardStack } from "./components/CardStack";
import { MenuBox } from "./components/MenuBox";
import { SocialLinks } from "./components/SocialLinks";
import { LogoMarquee } from "./components/LogoMarquee";
import { useTickerLogos } from "./lib/tickers";
import { LaunchCard } from "./components/LaunchCard";
import { ExploreCard } from "./components/ExploreCard";
import { FeedCard } from "./components/FeedCard";
import { TrendingCard } from "./components/TrendingCard";
import { DnaStrand } from "./components/DnaStrand";
import { useRegisterOnLogin } from "./lib/register";
import { useNotificationsPoller } from "./lib/ftf";

// One layout for every page; the center card changes by path (app.neuriio.xyz/launch, ...).
// Explore is home: "/" (and any unknown path) shows it, and the address bar is set to /explore.
const ROUTES = ["/launch", "/feed", "/explore", "/trending"];
const RAW = location.pathname.replace(/\/+$/, "") || "/";
const PAGE = ROUTES.includes(RAW) ? RAW : "/explore";
if (RAW !== PAGE) history.replaceState(null, "", "/explore" + location.search + location.hash);

export function App() {
  const tickers = useTickerLogos();
  useRegisterOnLogin();
  useNotificationsPoller();
  return (
    <div className="app">
      <header className="top">
        <div className="top-left">
          <a className="logo" href="/" aria-label="Neuriio home">
            <img src="/brand/logo.png" alt="Neuriio" width={52} height={52} />
          </a>
          <MenuBox />
        </div>
        <LogoMarquee logos={tickers} className="top-marquee" />
        <CardStack>
          <PointsBox />
          <AccountBox />
        </CardStack>
      </header>

      {PAGE === "/launch" ? (
        // launch: one bigger card, no tabs bar
        <>
          <DnaStrand side="left" />
          <DnaStrand side="right" phase={1.3} />
          <main className="stage stage-launch">
            <LaunchCard />
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
        // explore: search + top list beside the picked token's chart
        <main className="stage stage-explore">
          <ExploreCard />
        </main>
      )}

      <SocialLinks />
    </div>
  );
}
