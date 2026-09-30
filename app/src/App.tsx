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
import { useRegisterOnLogin } from "./lib/register";
import { useNotificationsPoller } from "./lib/ftf";

// One layout for every page; the center card changes by path (app.neuriio.xyz/launch, ...).
const PAGE = location.pathname.replace(/\/+$/, "") || "/";

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
        <main className="stage stage-launch">
          <LaunchCard />
        </main>
      ) : PAGE === "/feed" ? (
        // feed: one column as wide as Explore's three cards; grows with the page and scrolls
        <main className="stage stage-feed">
          <FeedCard />
        </main>
      ) : PAGE === "/explore" ? (
        // explore: search + top list beside the picked token's chart
        <main className="stage stage-explore">
          <ExploreCard />
        </main>
      ) : (
        <main className="stage">
          <div className="panel tabs-slot" />
          <div className="panel card-slot" />
        </main>
      )}

      <SocialLinks />
    </div>
  );
}
