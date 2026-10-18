# Neuriio

Fair-launch token launchpad on [Elysium](https://elysium.kinetiq.xyz/docs/what-is-elysium). Creators tokenize their X
account; builders launch a token with no presale, no insider allocation and liquidity locked forever.

## How a launch works

1. **Launch.** Log in with X; each X account can launch one token. Launching is free (gas only).
2. **Bonding curve.** 1B supply; 793.1M tokens sell on a constant-product curve over virtual reserves, priced in HYPE.
   Everyone buys from the same curve. Every curve trade pays a 0.75% fee.
3. **Graduation.** When the last curve token sells, the same transaction moves all raised HYPE and the remaining
   206.9M tokens into the token's own pool (a Uniswap V2 fork, paired with WHYPE). Only the launchpad can create pools,
   so nobody can open one first at a bad price.
4. **Locked liquidity.** All LP tokens are sent to `0x…dEaD`. Graduated pools charge 0.25% per swap.

Creators earn a share of their token's trading fees in HYPE (20% of curve fees, 80% of pool fees), claimable from
`NeuriioFees`.

## Repository

| Path | What |
| --- | --- |
| `src/launch/` | `NeuriioPad` (curve + graduation), `NeuriioRegistry` (permanent identity and versions), `NeuriioFees` (fee vault), `NeuriioToken` |
| `src/swap/` | `NeuriioRouter` (every app trade, curve or pool, in USDC) and `v2/`: the Uniswap v2-core fork that holds graduated pools |
| `src/stake/` | `NeuriioStaking` (stake graduated tokens or $NEURIIO for a share of fees), `NeuriioMinter` and `NeuriioPlatformToken` ($NEURIIO) |
| `src/testnet/` | `TestUSDC` (testnet only; mintable by the faucet) |
| `test/` | Foundry tests, including a solvency fuzz |
| `script/` | Deploy scripts (Foundry + shell) and testnet tooling |
| `app/` | Web app (React + Vite, Privy login), served by `app/serve.mjs` |
| `keeper/` | `watcher.mjs` (live trades to the app) and `pay-protocol.mjs` (protocol fee payouts) |
| `supabase/` | Database migrations and Edge Functions (launch passes, indexer, registration) |
| `deployments/` | Addresses of the live testnet contracts, read by the app and the keeper |

## Development

Requires [Foundry](https://book.getfoundry.sh) and Node 22.

```bash
git clone --recurse-submodules https://github.com/finding-agi/Neuriio.git
forge test                          # contracts
npm --prefix keeper install && npm --prefix keeper test
npm --prefix app install && npm --prefix app run dev   # needs VITE_PRIVY_APP_ID in app/.env.local
```

## Deployment

Testnet (Elysium, chain 99801): `script/deploy-core.sh` deploys the permanent core and the first `NeuriioPad`;
`script/deploy-launchpad.sh` ships a new `NeuriioPad` version on the existing core; `script/replace-feevault.sh`
swaps in a new `NeuriioFees`; `script/verify-world.sh` verifies everything on the explorer;
`script/supabase-deploy.sh` points the backend at the current addresses. The web app and the watcher run on Railway from `Dockerfile` and
`keeper/Dockerfile.watcher`.

## Disclaimer

Tokens launched on Neuriio are memes with no promise of value. They are not equity, shares or a claim on any person
or company, and nothing here is investment advice.

## License

`src/swap/v2/` is a fork of Uniswap v2-core under its original license (`src/swap/v2/LICENSE`).
