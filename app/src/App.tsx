// Neuriio app shell: blank layout from the wireframe (content comes step by step).
import "./app.css";
import { AccountBox } from "./components/AccountBox";
import { PointsBox } from "./components/PointsBox";
import { CardStack } from "./components/CardStack";
import { MenuBox } from "./components/MenuBox";
import { SocialLinks } from "./components/SocialLinks";
import { LogoMarquee } from "./components/LogoMarquee";
import { useTickerLogos } from "./lib/tickers";

export function App() {
  const tickers = useTickerLogos();
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

      <main className="stage">
        <div className="panel tabs-slot" />
        <div className="panel card-slot" />
      </main>

      <SocialLinks />
    </div>
  );
}
