# Handoff — Neuriio (state as of 2026-10-18: the USDC world is LIVE on app.neuriio.xyz (testnet): contracts, backend, app and docs all switched; NEXT CHAT: see "USDC WORLD" -> "What's left")

Read this first in a new session. `README.md` has per-step detail; this file is the current truth.
**Consolidated 2026-10-12:** finished work, old session logs, the paused PropAMM stack, superseded deployments and the
dropped Higgsfield prompts were removed from this file. The full previous version is in git:
`git show a73300e:HANDOFF.md` (everything up to 2026-10-10, incl. PropAMM/one-click design, old testnet addresses,
security sweeps #1-4 in detail, the Uniswap V4 research and Appendix B/C video prompts).

**Project name: Neuriio.** Local folder `/Users/von/Neuriio`; code in the **private** GitHub repo
**https://github.com/finding-agi/Neuriio** (branch `main`). Railway redeploys the app + watcher on every push to `main`.

## USDC WORLD (live since 2026-10-18): contracts, backend (switch run), app (pushed 4701f76) and docs (88206f4)

Final design (user, 2026-10-17 evening; memory "loss-mint-staking-plan"): tokens pair with USDC; every trade pays 1%
(curve and pool, bots included: the fee is inside the new pools). Curve fees: 80% $NEURIIO stakers / 10% KNTQ buyback /
10% treasury. Pool fees: 40% $NEURIIO stakers / 40% that token's stakers / 10% creator / 10% treasury. Staking an X
token (opens at graduation) earns its USDC fees AND mints $NEURIIO: 100 per $1 earned, flat until $1M of total platform
fees, then PAPER's decay (S = $120M). Staking $NEURIIO earns USDC only. Claimed $NEURIIO is staked automatically;
$NEURIIO can't be transferred. No loss-mint, boosts or locks. Contracts: `src/stake/` (NeuriioStaking,
NeuriioMinter, NeuriioPlatformToken), `src/launch/NeuriioFees.sol` + `NeuriioPad.sol`, `src/swap/NeuriioRouter.sol`,
`src/swap/v2` (USDC quote + 1% fee), `src/testnet/TestUSDC.sol`. 71 Foundry tests.

### Review (2026-10-18, Opus): no critical/high fund-loss issues -> NO contract rebuild
- The source verified on Blockscout is identical to the local files for all 10 contracts, and the live wiring is
  right (pad + factory -> current vault, minter approves only it, $NEURIIO minter = NeuriioMinter, wallets set,
  vault USDC = `held`, pad holds no stray USDC). Extra throwaway attack tests passed (deleted after): staking stays
  solvent in USDC and $NEURIIO over 1,024 random runs, every curve buyer can always sell back, USDC sent to a pool's
  address before graduation is burned, a flash-swap callback can't pull anything from staking or the vault.
- **Fixed (scripts + payout bot only; contracts untouched):** `replace-feevault.sh` didn't pass MINTER (failed at
  once); `transfer-ownership.sh` listed the routers (no owner: the handover reverted) and missed NeuriioMinter (now
  $NEURIIO + minter; anvil dry run with a stand-in Safe moved all 7 + the factory, old key locked out);
  `pay-protocol.mjs` misread the replaced USDC vault `0xcb49...` (community layout: hourly error, its 5.08 USDC never
  paid). `deploy-core.sh` is now the one new-world script (`deploy-usdc-world.sh` folded in and removed): saves the
  minter + faucet, keeps any world already in the file as `<file>-<registry>.json`, live test on testnet worlds.
  `deploy-launchpad.sh`, `replace-feevault.sh`, `transfer-ownership.sh` take DEPLOYMENTS + RPC + OWNER_KEY for anvil
  dry runs (all four dry-ran on anvil: ALL CHECKS PASSED).
- **Until go-live:** don't run `deploy-launchpad.sh` on testnet: it points Supabase LAUNCHPAD_ADDRESS at the new pad,
  which breaks launches on the live HYPE app.
- **Mainnet notes:** `freezeMintCurve()` only locks the curve numbers; the owner can still mint $NEURIIO through
  `neuriio.setMinter` or `minter.setVault` (and so take $NEURIIO stakers' USDC share): the multisig (+ timelock) must
  own both, or add a one-way lock. Next rebuild only (not worth a redeploy): NeuriioPlatformToken's comment still
  describes the dropped loss-mint; `IFeeVault` in `src/swap/interfaces.sol` is unused. Accepted risk, unchanged:
  $NEURIIO mint farming (wash trades, or USDC sent straight to NeuriioFees, count as fees).

### Done
- **Contracts on testnet, all verified on Blockscout** (`./script/verify-world.sh`: ALL VERIFIED): test USDC
  `0xe83c...0c7b` (only the faucet wallet mints), registry `0x24dc...2219`, factory `0xf698...3b69`, NeuriioPad
  `0x892b...8d76` (VIRTUAL_QUOTE 1,000 USDC: graduates at ~2,834 USDC raised), staking `0x63e2...709a`, $NEURIIO
  `0x5964...1089`, minter `0x2406...f031`, fees `0x35cc...d6b9`, router `0x86cc...4776` (`./script/redeploy-staking.sh`,
  live test ALL CHECKS PASSED). Full addresses: `deployments/elysium-testnet.json`; the old HYPE world's are in
  `deployments/elysium-testnet-hype.json`.
- **Backend `prepare` DONE (2026-10-17):** `./script/supabase-deploy.sh prepare` ran: the indexer indexes BOTH worlds
  (secret WORLDS), the app still lists the HYPE world (APP_REGISTRY / app_config.registry = `0xd787...84fc`). Checked:
  USDC world indexed from its deploy block (2 launches, 12 trades, USDC amounts, real traders), no errors. Pool trades
  store no `fee` (same as the HYPE world). Tests: `./script/test-supabase.sh` (12), `npm --prefix keeper test` (8).
- **App, local only (`npm --prefix app run dev`, http://localhost:5173), uncommitted:**
  - Explore: edge to edge, cards touching (Hyperliquid-style): Top 25 | chart | trade | stake, Positions full width
    below; resizes with the window (<= 1280px the stake card moves under the trade card; phones keep their layout).
    Cards: 1px #ECDDFF border at 50%, 4px corners, no dots/gradients/shadows. Landing frame + /showcase unchanged.
  - Stake card (`app/src/components/StakeCard.tsx`), split in half: top = the picked X token, bottom = $NEURIIO; Stake /
    Unstake / Claim tabs, #8C7D9F accents. LAYOUT ONLY (buttons disabled, values "—"). Not on phones yet.
  - /launch opens on one Launch button (no glow) in a small circle of slowly flickering dots plus a 3-dot-tall band of
    them across the page, level with the button; Launch goes straight to the Sector step (log in first if needed;
    someone who already launched lands on Type). Old two-screen intro removed.
  - Font: Manrope everywhere (was Lilex). The videos in `video/` still use Lilex.
  - The app now points at the USDC world (`app/src/lib/config.ts`: `elysium-testnet.json`, `QUOTE` = USDC at $1).
    Launched tokens are priced in USDC on Explore, Feed, Trending and the account panel.
  - Trade box in USDC through the router (`app/src/lib/trade.ts`, `OrderCard.tsx`): curve and pool, 1% fee, quick
    amounts 5/25/100/250 USDC, silent one-time approval (unlimited, to the router) before the first buy / first sell of
    a token, "Need a little HYPE for gas" when the wallet has none. Checked in demo mode only.
  - Data: the app sends `x-neuriio-registry` with every Supabase read so it lists ITS world before the switch.
    Migration `supabase/migrations/20261018054548_world_header.sql` (token_stats + Top 25 per world; no header =
    app_config as before) **APPLIED 2026-10-18** (Supabase connector): no header still lists the 7 HYPE tokens (live
    site unchanged), the USDC header lists the 2 USDC test tokens.
  - **Wired to USDC 2026-10-18 (local, demo + live reads checked; no real wallet tx from the app yet):**
    - Launch + FTF launch (`lib/launch.ts`, `LaunchCard.tsx`): first buy in USDC (quick 10/50/100, USDC balance,
      "Graduates at $13,696 mcap", 1% fee); approves exactly the first buy's USDC to the pad, then
      `launch(pass, sig, quoteIn, minOut)`. Until the switch the backend still signs passes for the HYPE pad: the app
      stops with "launching opens at go-live" instead of sending a tx that would revert.
    - Creator fees in USDC (Explore header, profile modal, Feed, Account box): 10% of pool fees, every vault summed.
    - Stake boxes (`lib/stake.ts`, `StakeCard.tsx`): stake / unstake / claim on both halves, Max, earned USDC +
      $NEURIIO re-read every 5 s, one silent unlimited approval per X token, "Opens after graduation".
    - $NEURIIO box in Account (under Creator fees): staked amount, USDC earned + Claim, unstaked wallet amount.
    - Platform fees widget (user, 2026-10-18: Explore, above the Top 25): lifetime `totalFees` of every vault in
      `feeVaults`, refreshed every 15 s; hidden on the landing / showcase.

### What's left (in order)
Done 2026-10-18: step 2 docs (GitBook live: 1% USDC fees + split, new Staking page, new contracts) and the go-live
switch (`supabase-deploy.sh switch`: launch passes for the USDC pad, app_config + no-header API = USDC world; then
everything pushed, Railway redeployed app + watcher).
1. **Test USDC for testers:** the faucet only gives HYPE, so nobody new can trade yet. Make the faucet wallet (a
   TestUSDC minter) mint test USDC with the HYPE claim (`supabase/functions/ftf`, `claimHype`).
2. **A real launch / trade / stake / claim from the app** with a wallet holding test USDC (user, in their browser).
3. Tell testers the old HYPE tokens are gone; remove the Privy LAN origin `https://192.168.0.64:5174`.

Mainnet only (later): multisig ownership incl. the $NEURIIO minter + `freezeMintCurve()`, Fable audit, real bridged
USDC, legal review.

## Earlier plan (written 2026-10-12; videos + public testnet opening)

**The app is built and ready for the public testnet launch.** "Launch" = public launch on Elysium **TESTNET**; mainnet
is a few weeks out and only if users and demand show up (memory "launch-is-testnet"). Multisig + formal audit are
mainnet work, not launch blockers.

**Schedule (user):** Mon 10-12 launch video + thesis post (docs only); Wed 10-14 "How a launch works" video;
**Fri 10-16 the app opens to the public on testnet** (go-live switches below). FTF video any day. Posts come from
@Neuriio; the user quotes them from their personal X. Feedback channel = the user's X + @Neuriio (Telegram later; the
footer Telegram icon stays "coming soon"). The "try it, tell us what's broken" ask starts only in the post that opens the app.

**NEXT CHAT, IN THIS ORDER (user, 2026-10-12):**
1. **3D dot clips 2, 3 and 4** (5 s each, plans below, already agreed with the user). Clip 1 (helix) is DONE. Build one
   clip at a time, render, send, get feedback, then the next. Technical notes in "3D dot clips" below.
2. **Video B "Live on testnet"** for Fri 10-16 (the app opening): plan it second by second with the user before
   building (memory "plan-video-before-building").
3. Post copy only if the user asks (they mainly want video). Build copy from the thesis (memory "neuriio-thesis").
   Content doc: Claude Doc "Neuriio launch content: Oct 12–16"
   https://claude.ai/code/artifact/8243ce06-32c0-4c72-abd5-f330b843eb20 (its 45 s script is superseded by the Remotion videos).

**Go-live switches (Fri 10-16, when the user says go; the user flips these):**
- ~~Delete the Cloudflare redirect that sent `app.neuriio.xyz` to the docs~~ **DONE 2026-10-12** (the landing is live there).
- Remove `APP_PASSCODE` on Railway (service `Neuriio`) -> the App button goes straight in.
- Switch the `neuriio.xyz` redirect (Cloudflare rule "soft launch") from the docs to the app.
- **Remove `https://192.168.0.64:5174` from Privy's allowed origins** (added 2026-10-10 for phone testing).

**Reminders for the user (memory "pending-reminders"):** move contract ownership to a multisig + formal audit (Fable)
before mainnet; decide the points reset (see "Points").

## 3D dot clips (Remotion + three.js; LOCAL ONLY in `video/`, never commit)

Series of 5 s clips, 16:9, 2560x1440 @ 60 fps rendered at 1.5x = 3840x2160. All share:
- **Background:** the app's new look, `#120c1d` with the flat, still lavender dot grid
  (`radial-gradient(rgba(129,114,152,.35) 1.8px, transparent 1.9px) 0 0 / 36px 36px` = the app's 20 px grid at video
  scale). Copy `AppBackground` from `video/src/scenes/Helix3D.tsx`.
- **Dots:** white, like the app's side strands, sized and faded by depth; accent = brand lavender `#ecddff`.

**Clip 1 — dot helix: DONE 2026-10-12.** Composition **"Helix3D"** (`video/src/scenes/Helix3D.tsx`), file
`video/out/helix-3d-4k.mp4` (24 MB). The app's side strand (`app/src/components/DnaStrand.tsx`: radius swells and
pinches, 4.5 lobes, flattened cross-section twisting 1.6 turns) as 14,000 three.js points. 0-1 s grows up from the
bottom while turning; 1-2.5 s camera orbits a quarter turn; 2.5-4 s camera rises over the top and looks down the strand
(spiral tunnel) while a lavender wave runs up it; 4-5 s back to the side view. User has not given feedback yet beyond
moving on.

**Clip 2 — dot-grid terrain (TO BUILD):**
- 0-1 s: the flat background dot grid tilts back into a 3D floor running to the horizon.
- 1-4 s: the camera glides low over it; three "buy" ripples spread from random points, lifting the dots like water
  and lighting each dot they pass (lavender).
- 4-5 s: the camera rises and the floor settles flat.
**Clip 3 — dots form the logo (TO BUILD):**
- 0-1.5 s: thousands of dots drift in 3D space, the camera drifting slowly through them.
- 1.5-3 s: they swirl in and lock into a 3D Neuriio mark.
- 3-4 s: the mark holds and turns slightly, catching the light.
- 4-5 s: it bursts back into a drifting cloud.
- Logo source: `app/public/brand/mark.png` (480x295, the mark with a light outline; no SVG exists). Sample its opaque
  pixels into target points (+ a little depth/extrusion); the new logo tile is `app/public/brand/logo.png`.
**Clip 4 — dot tunnel (TO BUILD):**
- 0-3.5 s: the camera flies forward through a tunnel of dot rings; rings light up as it passes, speed builds.
- 3.5-5 s: it bursts out of the end onto the flat dark background with the logo tile in the centre.

**How to build them (learned on clip 1):**
- Deps installed in `video/` (exact versions): `@remotion/three@4.0.534` (= remotion's version), `three@0.178.0`,
  `@react-three/fiber@8.18.0`, `@types/three@0.178.0`.
- Pattern: `<ThreeCanvas width height camera gl={{ alpha: true }}>` over an `AbsoluteFill` background; a `<points>` with a
  `BufferGeometry` (static per-dot attributes) + `ShaderMaterial` (positions, size, alpha computed in the vertex shader
  from uniforms). Set the camera from `useThree()` inside the canvas each frame (`position`, `lookAt`).
- **GOTCHA (cost a full broken render):** three.js reads a ShaderMaterial's `uniforms` object ONCE. Create it with
  `useMemo` and mutate `.value` every frame; passing a new object each render works in `remotion still` (one frame) but
  freezes every frame of a video at its first value.
- **Render with `--gl=angle`** (without it nothing draws headless). Point sizes are in device pixels: multiply by
  `window.devicePixelRatio` (uniform `uPx`) so 4K renders keep the look; cap the size so close-up dots don't blob.
- Quick checks: `npx remotion still Helix3D out/x.png --frame=120 --scale=0.5 --gl=angle`, or render the whole clip at
  `--scale=0.25` and tile frames: `ffmpeg -i out/x.mp4 -vf "select='not(mod(n\,30))',scale=400:-1,tile=5x2" -frames:v 1 t.png`.
  4K: `npx remotion render <Id> out/<name>-4k.mp4 --scale=1.5 --crf=16 --gl=angle`.

## Videos (Remotion; `video/` is LOCAL ONLY: listed in `.git/info/exclude`, never commit or push it)

Remotion = React/TS video from code, free licence (Neuriio <= 3 people). Higgsfield, Jitter and Figma were dropped.
`cd video && npm run studio` to preview. Base 2560x1440 @ 60 fps; 4K = `--scale=1.5 --crf=16`; 1080p = `--scale=0.75`;
low-res check `--scale=0.25` (0.35 gives a fractional height). Memory "launch-video-remotion" + "plan-video-before-building"
(agree each beat second by second with the user before building; they want lots of motion). Finished, all in `video/out/`:
- **Launch video** (Mon 10-12): `neuriio-launch-4k.mp4` (14.3 s; backup `neuriio-launch-1080p.mp4`), composition
  **"Cards"**: dot-grid ripples -> five X profile cards in an arc -> "tokenize accounts" types -> cards merge into the real
  /launch card + app header -> Login, Launch clicks -> "create social markets" -> logo tile with two dot rings.
  Uses real app captures: `node video/scripts/capture-launch.mjs` / `capture-header.mjs` (need the app dev server on
  :5173; re-run if the header or launch card changes; the header capture predates the 2026-10-12 background/logo change).
- **"How a launch works"** (Wed 10-14): `how-a-launch-works-4k.mp4` (9.6 s), composition **"HowItWorks"**: banner card ->
  token -> rides the bonding curve (calm buys, wild burst at the top, camera zoom) -> lock -> logo tile.
- **FTF video**: `ftf-4k.mp4` (11.5 s), composition **"Ftf"**: four X cards bud out of the logo like dividing cells
  (SVG goo filter), close into a 2x2 grid, melt into a token -> caret -> "create an FTF, / put everyone onchain".
  Its background (vertical mirrored purple -> lavender gradient, twinkling dots in the dark bands) is exported as
  `Background({ frame, plain?, quiet? })` from `Ftf.tsx`; plain loop `ftf-background-4k.mp4` (4 s).
- **"final post of this thread"** (2026-10-12): `final-post-4k.mp4` (5 s), composition **"FinalPost"**: the FTF background
  with the line static in the centre (Lilex 600, 96 px, `#6b5a8e`), no typing.
- **3D dot helix**: see above. Older drafts: "Launch" (2D helix opening), "Storyline".
- Brand for videos: font Lilex; lavender `#ecddff`, `#a99bbd` soft words, card `#1b1428`; X banners in `video/public/x/`.

## The site today (2026-10-12)

**Domains (Cloudflare):** `app.neuriio.xyz` -> Railway service `Neuriio` (proxied, SSL Full Strict) — **public since
2026-10-12** (redirect rule deleted). `docs.neuriio.xyz` -> GitBook "Neuriio Docs" (Git Sync with `docs/` on `main`;
pull before editing docs, GitBook edits arrive as "GITBOOK-n" commits). `neuriio.xyz` -> 302 to the docs (rule "soft
launch"; switch to the app at go-live). Testers' Railway URL: `neuriio-production.up.railway.app`.

**Server + passcode gate (`app/serve.mjs`):** static server for `app/dist` with SPA fallback + security headers
(`X-Frame-Options: DENY`, `frame-ancestors 'none'`, HSTS, nosniff). With Railway variable `APP_PASSCODE` set (ON since
2026-10-08) the **app routes** (`/explore`, `/launch`, `/feed`, `/trending`, any extensionless path, and `index.html`
by any spelling) show the "Private Beta" passcode page (centred, no scroll); `/`, `/showcase` and every file stay open.
Correct code = 30-day HttpOnly cookie (HMAC of the passcode; changing it signs everyone out); 10 wrong tries per visitor /
200 overall per 15 min. `/showcase` alone is frameable by our own pages (`SAMEORIGIN`).
Local check of the real server: `.claude/launch.json` "gate" (port 8098, passcode `preview-only`, serves `app/dist`:
run `npm --prefix app run build` first).

### Landing page `/` (built 2026-10-11/12; `app/src/components/Landing.tsx`)
- One screen, no scroll. Background = the FTF video's gradient on a canvas (`LandingBg`): dark purple top and bottom,
  lavender light band (centred on desktop; at 30% height on phones so it sits behind the hero), dots twinkling slowly in
  the dark bands, faint in the light band. Header = logo (no menu), coin marquee, Account + Points (real; signing in keeps
  you on the landing). No footer.
- Hero: "Neuriio" (white), "Tokenize Accounts, / Create Social Markets", "The first un-vampable launchpad / to gain
  exposure to X accounts" (light text on desktop; dark tagline/subline on phones), buttons **App** (`/explore`, passcode
  while it's on) and **Docs** (docs.neuriio.xyz, new tab).
- **Showcase card:** a frame with a `#ECDDFF` stroke and a light running round just inside it (conic gradient, 16 s
  loop). Inside, a still picture of the app: **nothing inside can be clicked** (`inert`, `pointer-events: none`).
  - Desktop: the real `ExploreCard` (Positions hidden), frame bleeds ~80 px off the bottom of the screen.
  - Phones: an iframe of **`/showcase`** = the whole desktop Explore page at 1440x900 (logo + menu, marquee held still,
    Account + Points drawn signed-out, the showcase card, footer links; Positions left out), scaled to the frame's width
    (wide, not tall). `index.html` marks `/showcase` transparent before first paint (no dark flash).
- **Showcase data (fake, fixed; `LANDING` in `app/src/lib/explore.ts`, true on `/` and `/showcase`):** `DEMO = DEV_DEMO
  || LANDING` drives the token lists, chart, trade box and positions; Send stays real (`SendModal` uses `DEV_DEMO`). #1
  token @kntqkid: $7.8M mcap, $1.4M 24h volume, $41.3M all-time, 353 trades/24h, launched 28 days ago (graduated); the rest
  $1M-$28M mcap. Fixed HYPE price `SHOW_HYPE_USD = 40` so numbers read as set. Chart = 32 fixed candles + volume climbing
  with pullbacks (`showcaseCandles`), `fitContent` fills the width; no live feed. Avatars = the logo mark on 7 gradients
  by rank (#1 green).

### App look (2026-10-12)
- **Every app page background = the passcode page's**: `#120c1d` with an even 20 px lavender dot grid (`.app` in
  `app.css`; body `#120c1d`). The dot strands on /launch, /feed, /trending are unchanged (exact colours).
- **New logo** (`app/public/brand/logo.png`, 256 px, from the user's image): header, favicon, Privy pop-up, passcode
  page. The glow behind the header logo tile was removed.
- Chart card glow + dots made faint (`.ex-bg-center`). **TradingView logo off everywhere; "Charts by TradingView" link
  under the chart's right corner** (`ExploreCard.tsx`) = the Lightweight Charts licence credit: keep it.

### Pages (all built)
- **Explore** (`/explore`; unknown paths land here): search, Top 25 by total volume (re-ranked every minute), chart
  (Lightweight Charts v5: market cap in USD, candles + volume, 5m-4H, stored gap-free candles from `token_chart` + live
  trades), order card (curve or pool, exact quotes, 1% min slippage), positions, profile modal, creator fees earned.
  Phones: chart card + one card with tabs About / Trade / Positions.
- **Launch** (`/launch`): intro -> FTF line -> flow (Type: Personal or FTF -> Sector -> Profile -> Launch). FTF = 4 members
  invited by X handle, notifications bell in the Account panel. Phones: steps stack.
- **Trending** (`/trending`): Bonding / Recently graduated / Trending (3-day volume, `trending_tokens()`), three columns
  (phones: tabs).
- **Feed** (`/feed`): posts are still SAMPLES (not stored); real posting is later. Phones: Feed / Notifications tabs.
- Menu: Feed (New), Launch, Trending, Explore, Perps/Spot/Outcome (Coming soon). Footer: X, Docs, Telegram (soon).
- Account panel: balances, deposit address, Send (any token), creator-fee Claim, export key, notifications.
  Points card: real total from the `leaderboard` view (`app/src/lib/points.ts`).
- **Phone testing:** the user checks mobile on the live link after a push (the phone dev server `dev:phone` exists but
  stays OFF unless asked). X login on phones goes through x.com and returns.

## Product (decided by the user)

- **Launchpad (pump.fun model) on Elysium with our own pool.** Pairs with HYPE (pool uses WHYPE). Launching is free (gas).
  1B supply; 793.1M sold on a constant-product curve over virtual reserves (`virtualHype` : 1.073B tokens); the last curve
  buy moves the raised HYPE + 206.9M tokens into our pool (Uniswap V2 fork) and **burns all LP** (0x…dEaD). **Mainnet
  target (user, 2026-10-15): graduate at ~$70k market cap**, priced in HYPE on launch day: graduation FDV = 13.7 x
  `virtualHype` and HYPE raised = 2.83 x `virtualHype` (fixed by the 1.073B / 793.1M split), so
  `virtualHype` = 70,000 / (13.7 x HYPE price), e.g. ~64 HYPE at $80 (raises ~181 HYPE); set it with `setVirtualHype`
  before mainnet launches. Testnet stays 0.1 HYPE (graduates at ~0.29 HYPE raised; testnet HYPE is scarce, user is fine
  with the small market caps there). All USD in the app/indexer already uses HYPE's mainnet price.
  Only the launchpad can create pairs; pre-sent tokens are skimmed; slippage + deadline on every trade; owner pause
  stops launches + buys, **sells stay open**.
- **Fees:** curve 0.75% (20% creator / 80% protocol), pool 0.25% (80% creator / 20% protocol), all into **NeuriioFees**
  in HYPE; protocol share -> 60% community / 40% KNTQ buyback (both `0x10E942585ceBf3dcf8377ff8eC38F2458662EEC3`, the
  user's wallet), paid by `payProtocol()` (`./script/run-pay-protocol.sh`, hourly). KNTQ buyback is manual (buy on
  HyperCore, burn, post txs).
- **"Tokenize Accounts":** X is the only login (Privy, embedded "Neuriio wallet" for everyone). One personal token per X
  account, named `@handle` / ticker `HANDLE`, via an EIP-712 launch pass signed by our backend key after Privy verifies
  the X login. Reserved tickers (HYPE, USDC, KNTQ, NEURIIO, …) can't launch.
- **FTF ("Friends Turned Fam"):** exactly 4 members fixed before launch, creator fees split equally, name + 2-10 char
  ticker, own picture; members need no personal token; 50 launch points per member.
- **Sectors:** Robotics, Quantum, Finance, AI, Energy, Memory, Space -> "How are you active?" (Trader, Meme trader,
  Researcher, Influencer, Builder, Creator); stored in the hashed creator profile.
- **Legal framing:** tokens are MEMES, not investments. Say back / support / trade, never invest / returns; disclaimer
  "no promise of value, creators owe holders nothing"; builders get a "fair launch" / "locked liquidity", never "raise
  money", never equity. Legal review before mainnet.
- **Thesis** (`docs/README.md`, memory "neuriio-thesis"): launchpads evolve by what they give exposure to (memes ->
  stocks/crypto onchain -> **social exposure**); the problem is authenticity; Neuriio = X login, only you can launch you.

## Testnet contracts: the OLD HYPE world (Elysium testnet, chain 99801; now `deployments/elysium-testnet-hype.json`)

The live site still runs on these until go-live; `deployments/elysium-testnet.json` is now the USDC world (see top).
Current core (deployed + verified on Blockscout 2026-10-08, core block 5372584): NeuriioRegistry
`0xd7879e97c6558486ca0a92283d70a46e89ea84fc`, NeuriioFees `0x7e9e5e96c3e99fd201a15e6a33c59aec51a39b2b`, NeuriioSwap
(router) `0x4a85eca6f3ef4a07d049bd1907debb3e8961acac`, NeuriioPad `0xd9943d81b72aa55e52580bbb595af797b04d5e59`,
UniswapV2Factory (ours) `0xd30f539cf731d843534a9e3fe9fec51bb456339c`, WHYPE `0x517f12d5d17c4755fbdf988fe9cc24334c3314c7`,
launch signer `0x25626586434fb2003d12957a1fC4B0fA5EA52886` (key only in Supabase secrets).
Owner of everything: Foundry keystore **`burner`** = `0xef584b1098e12c34d1d85de76285c408ab6917a8` (hot key -> multisig
before mainnet). Older cores/launchpads are retired testnet worlds (see git history).
- **Upgrade-safe architecture:** the core (registry, factory, fees vault, router) is deployed ONCE per network
  (`./script/deploy-core.sh`); upgrades are new NeuriioPad versions (`./script/deploy-launchpad.sh`, retires the previous
  one for NEW launches only; old versions keep trading/graduating). Fee vault swappable (`./script/replace-feevault.sh`,
  old balances stay claimable). Indexer, watcher and app follow the registry, never one address; the app always reads
  `registry.launchpadOf(token)` on-chain before sending HYPE.
- **V2 fork:** `src/swap/v2/` = Uniswap v2-core v1.0.1 (solc 0.5.16, GPL-3.0) with marked "Neuriio" changes (0.25% fee
  taken out to the vault as WHYPE; createPair only by the token's launchpad); `./script/v2-diff.sh` prints the diff.
- **Verify:** `forge verify-contract ADDR PATH:NAME --chain 99801 --verifier blockscout --verifier-url
  https://elysium.kinetiq.xyz/api/ --compilation-profile default|size --constructor-args ... --watch` (`size` for
  NeuriioPad + NeuriioToken; args in local `broadcast/*/run-latest.json`). Later tokens/pools auto-match.
- **Multisig handover READY:** `./script/transfer-ownership.sh <safe> [account]` (Ownable2Step on registry, every pad,
  every fees vault; factory `feeToSetter` last, only to a deployed Safe with threshold >= 2; writes
  `deployments/accept-ownership.json` for Safe Transaction Builder); `check <safe>` = read-only report; fork-tested.
  **Blocker: Safe isn't deployed on Elysium.** Decision (user, 2026-10-13): **we deploy Safe ourselves** (not waiting on
  Kinetiq): the official Safe contracts (singleton, proxy factory, fallback handler, MultiSend) on Elysium, then create
  the Safe (2+ signers) and use safe-cli to sign the accept-ownership batch. No contract redeploy needed for the handover
  (Ownable2Step, same addresses, verification stays). Not moved: the launch signer and the fee wallets.

## Backend (Supabase project "Neuriio", ref `yviymgfgaepmtijgyyyo`; Railway project `lively-renewal`)

- **Supabase:** tables users (private), tokens, trades, candles, creator_profiles, ftf_drafts/members, points_ledger;
  views `token_stats`, `leaderboard`, `top_tokens_live`; RPCs `token_chart`, `trending_tokens`. Edge Functions
  `launch-pass`, `register` (called after every X login), `ftf`, `indexer` (pg_cron every minute: launches, trades,
  graduations, router `Swapped`, HL builder fills). Claude has the Supabase connector: `apply_migration` for DDL (then
  rename the local file to the recorded version), `execute_sql` for reads/fixes.
- **Watcher** (`keeper/watcher.mjs`, Railway service `watcher`): broadcasts each trade on private Realtime channels
  `trades:all` / `trades:<token>` as its block lands (charts + positions update ~1-2 s after a trade). ONE instance only
  (the hypedexer websocket allows one per IP); never also run it on the Mac. Pool trades can arrive split (Sync / Swap /
  Swapped in separate batches): `completePoolTrades` rebuilds them from the tx receipt.
  **If live updates lag again:** `railway logs -s watcher` (every trade logs `ev="trades"`), a Node listener on
  `trades:all` with the anon JWT, then check what the chart does with each live trade.
- **Railway:** service `Neuriio` (root `Dockerfile`, builds `app/` with `VITE_PRIVY_APP_ID`, serves with `serve.mjs`,
  `PORT=8080`, `APP_PASSCODE`) + service `watcher` (`RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile.watcher`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` legacy service_role). Use the **Railway CLI** (connector never loads); Claude
  reads logs/variables, the user runs deploys and variable writes (memory "railway-access").
- **Realtime keys:** viewers use the legacy anon JWT, the watcher the legacy service_role key (new keys failed). Re-test
  when Supabase retires legacy keys.

### Points
Rules in `points_rules`: launched tokens (curve + pool) **100 pts per $100k** (raised 2026-10-10, new trades only), HL
via Neuriio 75 per $1M, 50 per launch (+50 per FTF member). Catch: launch points are per TOKEN, so testnet redeploys
credited @von_hl 4x and @__HLOS 2x. **User to decide:** launch points once per X account ever, and/or reset
`points_ledger` at the beta start and at mainnet. Later: Points panel boxes + leaderboard page.

## Running things

```bash
npm --prefix app run dev            # app on http://localhost:5173 (use localhost, not 127.0.0.1: Privy). ?demo = sample data (dev only)
npm --prefix app run build          # app/dist (what Railway serves); typecheck: npm --prefix app run typecheck
forge test                          # contracts; forge build --sizes must stay green (NeuriioPad uses the 200-run "size" profile)
cd keeper && npm test               # keeper tests
./script/test-supabase.sh           # Edge Function shared logic
./script/run-pay-protocol.sh burner # hourly protocol-fee payout (hosting later)
./script/deploy-launchpad.sh burner && ./script/supabase-deploy.sh   # contract upgrade flow (then restart the watcher)
./script/launchpad-test.sh burner   # live: launch -> buy -> sell -> graduate -> router swaps (burner needs ~0.35 HYPE)
./script/hype-to-elysium.sh burner [amount]   # HyperCore HYPE -> HyperEVM -> Elysium (~70 s)
cd video && npm run studio          # videos (local only)
```
Keys: **never paste a private key into chat**; the user types keystore passwords into a terminal tab.

## Hard-won facts (don't rediscover these)

- **Elysium:** HyperCore read precompile + `ElysiumCoreWriter` are NOT live (~4 weeks after mainnet). Solidity
  `block.number` = HyperEVM's height (use ArbSys); `block.timestamp` 1 s resolution, trails by 1-2 s; blocks only with
  txs (~0.16 s apart under load). Official RPC has no websocket; hypedexer (`wss://elysium-testnet-rpc.hypedexer.com/`)
  allows one websocket per IP. The RPC returns 403 to Python's default user agent. A plain HYPE transfer costs ~21.9k gas.
  viem's receipt polling defaults to 4 s: set `pollingInterval` (app uses 300 ms).
- **Bridging:** HyperEVM -> Elysium ~1 min; **Elysium -> HyperEVM waits for a rollup checkpoint (~25 min measured)**.
  No direct Elysium <-> HyperCore path; tokens hop through HyperEVM.
- **"Graduating to HyperCore" (Kinetiq docs, re-checked 2026-10-11):** optional, not a pool: Elysium token -> mirror
  bridge (lock on Elysium, 1:1 on HyperEVM, permissionless) -> HyperCore via a deposit wallet after the issuer's spot
  deployment ceremony: win the ticker (Dutch auction ~31 h, **max 6 chars**), deposit wallet, one-shot genesis, permanent
  link, optional listing. Bridged tokens disable Hyperliquidity, so the book starts EMPTY (no liquidity needed, but
  nobody can trade until someone makes markets). The deployer can set a share of that pair's HyperCore fees. Deposit-wallet
  contracts are pre-launch. Our curve -> our pool graduation is unaffected; HyperCore would be an optional later tier for
  big tokens (per-token ticker cost, multi-day setup).
- **Kinetiq:** runs no pool/DEX; 25% of sequencer fees go to apps using Elysium blockspace — **ask Kinetiq how to apply**
  (also: mainnet date, Safe on mainnet, builder incentives).
- **Hyperliquid:** API limit 1,200 weight/min/IP (allMids 2, clearinghouse 2, metaAndAssetCtxs 20). Coin icons from
  `app.hyperliquid.xyz/coins/<COIN>.svg` are copied into `app/public/` (never hotlinked).
- **App/dev:** installing an npm package while Vite runs can load two Reacts (blank page): `vite.config.js` dedupes;
  if it recurs `npm --prefix app run dev -- --force`. The Browser pane can't do X OAuth (user tests logged-in states
  in their own browser); hidden panes pause animations. Privy needs HTTPS off-localhost.
- **Supabase:** pg-safeupdate rejects DELETE without WHERE; Postgres grants EXECUTE to PUBLIC by default (revoke on
  internal functions); `_` is a LIKE wildcard (escape handles).

## Security status
- Quick reviews done (2026-09-29/30, Opus): contracts — no critical/high findings; fixes shipped for candle-write
  access, wallet<->X privacy, LIKE-wildcard matching, rate limits, fee-vault replaceability, on-chain launchpad check.
  Biggest trust point: `LAUNCH_SIGNER_KEY` in Supabase secrets (a leak = passes for any handle; rotate via
  `setLaunchSigner`). Owner powers (approve versions, redirect future fees, pause buys, reserved tickers, signer) touch
  no existing balances.
- **Before mainnet:** formal audit with the highest model (Fable; memory "audit-preference") -> public
  `docs/ARCHITECTURE.md` + `docs/SECURITY_AUDIT.md` -> professional audit + bug bounty; multisig + timelock;
  Supabase Pro; legal review; hosting for the payout bot.
- Open: when posts become real, the Send recipient must come from `users` server-side; FTF launch points can be farmed
  with extra FTFs (user informed); balances read every token per viewer every 10 s (index holdings server-side at scale).

## Paused / later
- **PropAMM + one-click HyperCore trading stack: PAUSED until capital**, removed from the tree 2026-10-08; restore with
  `git checkout 9fcfe57 -- archive/propamm` (stored as `.txt`). Its testnet contracts sit idle. Design notes (EIP-7702
  one-click buys, FastBridge, wallet findings) are in the old handoff (`git show a73300e:HANDOFF.md`, §§1-9).
- Later: real Feed posting, Points boxes + leaderboard page, X app under the Neuriio account for login (consent screen
  says "Privy" today), pitch deck, fast-exit bridge idea, KNTQ buyback automation.

## Working preferences (memory)
Build UI one element at a time in the user's order; mobile changes apply only to mobile unless the user says otherwise;
**commit/push only when the user says so, never ask**; plan videos second by second first; say up front when a design
won't work with users' wallets. Commits authored `von <von@hlos.org>`; GitHub CLI account `finding-agi`.
