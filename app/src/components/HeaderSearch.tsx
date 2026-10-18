// The header's token search on every page but Explore (Explore puts its own search there, which switches the token in
// place): type a handle or FTF name, pick a result, and it opens in Explore. Same look as Explore's search.
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { DEMO, displayName, searchTokens, type TokenStat } from "../lib/explore";
import { compactUsd } from "../lib/format";
import { QUOTE } from "../lib/config";
import { Avatar } from "./Avatar";

export function HeaderSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TokenStat[] | null>(null);

  useEffect(() => {
    if (!query.trim()) return setResults(null);
    let alive = true;
    const id = setTimeout(() => searchTokens(query).then((r) => alive && setResults(r), () => {}), 200);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [query]);

  return (
    <div className="ex-search-top">
      <label className="ex-search">
        <Search size={15} aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Search @handle or FTF"
          spellCheck={false}
        />
      </label>
      {results && (
        <ul className="ex-results">
          {results.map((t) => (
            <li key={t.address}>
              <a className="ex-row" href={`/explore?t=${t.address}${DEMO ? "&demo" : ""}`}>
                <span className="ex-rank" />
                <Avatar handle={t.handle} pfp={t.x_pfp_url} size={28} />
                <span className="ex-row-names">
                  <span className="ex-row-handle">{displayName(t)}</span>
                </span>
                <span className="ex-row-mcap">{compactUsd(t.price_hype * 1e9 * QUOTE.usd)}</span>
              </a>
            </li>
          ))}
          {results.length === 0 && <li className="ex-empty">No handle matches.</li>}
        </ul>
      )}
    </div>
  );
}
