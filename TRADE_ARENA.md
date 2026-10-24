# Trade Arena: roadmap (drafted 2026-10-24)

1v1 paper-perps duels for a real wager. Two players put up the same wager, each gets $10k of play money, and both trade
synthetic BTC/ETH perps at live Hyperliquid prices for 24 hours. The higher PnL wins the pot (less the rake).
Inspired by PaperTrade (reads HyperCore BBO through HyperEVM precompiles). Elysium's read precompile is not live yet,
so prices come from Hyperliquid's API for now.

Status: **Phase 1 (escrow contract) written and tested; nothing deployed.** The nav's "Trade · Soon" button stays greyed out and becomes the arena's
entry when it ships.

## Decided (user, 2026-10-24)

| Rule | Value |
|---|---|
| Match | 1v1, FIFO queue per wager tier (you can't be matched with yourself) |
| Wager tiers | 0.1, 1, 5, 10 HYPE (4 lobbies) |
| Starting balance | $10,000 synthetic USD per player |
| Markets | BTC and ETH perps, long or short |
| Leverage | up to 50x per position, with liquidations |
| Duration | 24 h from the moment the match is made |
| Qualification | at least 3 trades AND an average hold time of at least 5 minutes |
| Winner | the qualified player with the higher PnL |
| Rake | 15% of the total pot to the treasury (winner gets 85% of both wagers) |
| Fees | none on trades (it's play money) |
| Liquidation | isolated per position, liquidated when its loss reaches 94% of its margin (HL-style) |
| Clock | never stops, not even during an HL outage |
| Concurrency | one player in one match (or one queue) at a time |
| Points | players earn points for arena play (amounts to decide) |
| Placement | the Trade button in the top nav (greyed out until launch) |

## Proposed defaults (not yet confirmed)

- **Fills:** longs fill at HL's best ask, shorts at the best bid, read by the server at the moment the order arrives.
  Clients never send a price.
- **Order types:** market orders only in v1. TP/SL and limit orders come later.
- **Liquidation details:** checked on every mid-price tick. The whole margin is lost (not just 94%), and the trade
  still counts toward the 3-trade minimum.
- **"Trade" and hold time:** one trade = one position opened and later closed. Hold time runs from the open to the
  close. Positions still open at 24 h are closed at the mid price and count with their hold time so far.
- **PnL:** final balance minus $10,000.
- **Edge cases:** if only one player qualifies, that player wins. If neither qualifies, or the PnL is tied, both are
  refunded with no rake. You can leave the queue for a full refund before you're matched.
- **Dead-server safety:** if a match isn't settled within 48 h of ending, each player can withdraw their own wager
  from the contract.

## Blockers and risks (flagged before building)

1. **Settlement trusts our server.** PnL is computed off-chain, so a settler key tells the escrow who won. That's
   fine on testnet. On mainnet it's a trusted key holding players' HYPE: it should be a dedicated key with no other
   powers, results should be publicly checkable (the full trade log with HL prices), and the dead-server refund above
   is required.
2. **New contract outside the audit freeze.** ArenaEscrow is not part of the 8-contract audit scope. It needs its own
   review before mainnet.
3. **Legal.** Head-to-head wagering for real HYPE needs a jurisdiction review before mainnet, even as a skill game.
   Testnet HYPE has no value, so nothing blocks a testnet launch.
4. **Wallets.** Every user has the Privy Neuriio wallet, and a wager is one ordinary payable transaction, so nothing
   wallet-specific blocks this. Testnet users need HYPE beyond gas for the wager, which means a faucet or a top-up
   flow.
5. **Price source.** We use mainnet HL prices (testnet HL prices are thin and odd). If HL's API is down, trading pauses
   and the match clock keeps running (decided: the clock never stops).
6. **Liquidity of the queue.** At ~60 users, the 5 and 10 HYPE lobbies may sit empty. Show the queue count per lobby,
   and maybe notify waiting players when someone joins.

## Architecture

```
Player (Privy wallet)
  |  enter(tier) + wager  ->  ArenaEscrow (Elysium)  --emits MatchMade-->  watcher
  |                                                                          |
  |  open/close order  ->  Supabase edge fn "arena-trade"                    |
  |                          - checks the match is live and the player is in it
  |                          - reads HL l2Book (BTC/ETH) -> fill at bid/ask
  |                          - writes arena_trades / arena_positions
  |                                                                          |
  |  live prices + both PnLs  <-  Supabase realtime  <-  watcher: HL websocket (bbo/allMids)
  |                                                       - liquidations on every tick
  |                                                       - at 24 h: close all, score, settle()
                                                            -> ArenaEscrow pays winner 85%, treasury 15%
```

Later, when Elysium's HyperCore read precompile ships, fills can be priced on-chain (the PaperTrade model) and the
server's role shrinks to submitting orders. See phase 5.

## Phases

### Phase 1: escrow contract: DONE IN CODE 2026-10-24 (not deployed, not committed)
`src/arena/NeuriioArena.sol` (~185 lines incl. events/errors; on OpenZeppelin `Ownable2Step`, `Pausable`,
`ReentrancyGuardTransient`; 6.8 KB), tests `test/NeuriioArena.t.sol` (31 incl. a fuzz check that every payout adds
up; full suite 150 pass, fmt clean). No open-source wager escrow fits (OpenZeppelin dropped its Escrow contracts in
v5; GitHub wager contracts are unaudited), so it's written small instead.
- `enter()` payable: the amount picks the tier (must be exactly 0.1/1/5/10 HYPE). A tier's 1v1 queue is at most one
  player long, so the next entrant is matched at once, on-chain (`MatchMade`). Refused while you're queued or in a
  live match (one match per player; also rules out matching yourself).
- `leave()`: full refund while waiting.
- `settle(id, winner)`: settler only. The watcher calls it the moment the 24 h end, and the same transaction sends
  the HYPE straight to the winner's Neuriio wallet (no claim step, no wait). It must happen within 48 h of the end, a
  deadline for our server, not a wait for players. The winner gets 85% of the pot and the treasury
  15%; `winner = 0` (draw / nobody qualified) refunds both with no rake. The rake is snapshotted at match time.
- `reclaim(id)`: anyone, from 72 h after the start, if unsettled: refunds both (dead-server safety).
- Payouts are pushed; one that bounces is kept in `owed` for `withdraw()`, so a bad wallet can't block a settle.
- Owner (Ownable2Step): tiers, rake (cap 20%), treasury, settler and pause (stops new entries only). It can't move
  players' HYPE.
- Next: a deploy script + testnet deploy (constructor: owner, treasury, settler, 1500, tiers) and a settler key in
  SSM. Mainnet: add it to the audit scope (it's small: a day or two of review).

### Phase 2: Trade engine (Supabase + watcher)
- Tables: `arena_matches` (mirrors the contract), `arena_positions`, `arena_trades`, `arena_prices` (latest BBO).
  RLS lets anyone read every match, since logs are public by design.
- Edge function `arena-trade`: auth via Privy, then open (market, side, leverage 1-50, margin ≤ free balance) or close.
  It prices from HL `l2Book` at request time and refuses if the match isn't live or HL is unreachable.
- Watcher: subscribes to the HL websocket for BTC/ETH, writes prices, liquidates, closes everything at 24 h, scores
  (qualification + PnL) and calls `settle()` with the settler key. It also indexes `MatchMade` / `Entered` / `Left`.
- Tests: fill pricing, liquidation price (94% of margin) at 1x/10x/50x, qualification math, the hold-time average, settlement on
  every edge case.

### Phase 3: UI (/trade, desktop + mobile together)
- **Lobby:** 4 tier cards (0.1 / 1 / 5 / 10 HYPE) showing players waiting and an Enter button. While you wait, show
  the queue state and a Leave button.
- **Match screen:** a live chart (reuse `CandleChart`), long/short + leverage + size, open positions with liq price,
  your PnL vs your opponent's (live), the 24 h countdown, and qualification meters (trades 0/3, avg hold vs 5 min).
- **Result screen:** win/lose/void, payout, and a shareable card (fits the "social exposure" thesis: @handle vs
  @handle).
- Built one element at a time in the user's order. The Trade button un-greys only at launch.

### Phase 4: Testnet beta
- Deploy ArenaEscrow plus the settler key (SSM, like the payout bot), run the watcher on EC2, and add a HYPE top-up
  for wagers.
- Points for arena play (amounts for playing vs winning to decide). Arena match history on the profile.

### Phase 5: Mainnet gates (parked until the user says mainnet)
- Legal review, an ArenaEscrow audit, a dedicated settler key (or a Safe-owned setter), and mainnet HYPE tiers.
- Move pricing on-chain via Elysium's HyperCore read precompile once it's live (check the ABI in the Elysium docs
  first).

## Still to decide
1. Points: how many for playing a match, and how many for winning?
