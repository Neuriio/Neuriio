# Neuriio: development

How the product works is in the docs (https://docs.neuriio.xyz, source in `docs/`). The contracts' architecture,
roles and the internal security audit are in `audit/`.

## Repository

| Path | What |
| --- | --- |
| `src/launch/` | `NeuriioPad` (curve + graduation), `NeuriioRegistry` (permanent identity and versions), `NeuriioFees` (fee vault), `NeuriioToken` |
| `src/swap/` | `NeuriioRouter` (every app trade, curve or pool, in USDC) and `v2/`: the Uniswap v2-core fork that holds graduated pools |
| `src/stake/` | `NeuriioStaking` (stake graduated tokens or $NEURIIO for a share of fees), `NeuriioMinter` and `NeuriioPlatformToken` ($NEURIIO) |
| `src/testnet/` | `TestUSDC` (testnet only; mintable by the faucet) |
| `test/` | Foundry tests; `test/audit/` holds the internal audit's tests, `test/fork/` the mainnet rehearsal on a testnet fork |
| `script/` | Deploy scripts (Foundry + shell), including `DeployMainnet.s.sol`, and testnet tooling |
| `audit/` | `SECURITY_AUDIT.md` and `ARCHITECTURE.md` |
| `docs/` | The public docs (GitBook, synced from `main`) |
| `app/` | Web app (React + Vite, Privy login) |
| `keeper/` | `watcher.mjs` (live trades to the app) and `pay-protocol.mjs` (protocol fee payouts) |
| `supabase/` | Database migrations and Edge Functions (launch passes, indexer, registration) |
| `deployments/` | Addresses of the testnet contracts, read by the app and the keeper |

## Development

Requires [Foundry](https://book.getfoundry.sh) and Node 22.

```bash
git clone --recurse-submodules https://github.com/Neuriio/Neuriio.git
forge test                          # contracts
npm --prefix keeper install && npm --prefix keeper test
npm --prefix app install && npm --prefix app run dev   # needs VITE_PRIVY_APP_ID in app/.env.local
```

## Deployment

Testnet (Elysium, chain 99801): `script/deploy-core.sh` deploys the permanent core and the first `NeuriioPad`;
`script/deploy-launchpad.sh` ships a new `NeuriioPad` version on the existing core; `script/replace-feevault.sh`
swaps in a new `NeuriioFees`; `script/verify-world.sh` verifies everything on the explorer;
`script/supabase-deploy.sh` points the backend at the current addresses. Mainnet: `script/DeployMainnet.s.sol` (one
run: deploy, wire, lock, hand everything to the timelock run by the Safe). The web app runs on Vercel
(`app/vercel.json`); the watcher and the payout bot run on AWS EC2 (see HANDOFF.md).

## License

`src/swap/v2/` is a fork of Uniswap v2-core under its original license (`src/swap/v2/LICENSE`).
