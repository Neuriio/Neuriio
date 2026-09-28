# PropAMM (paused)

The PropAMM (a pool priced off Hyperliquid's live book ± 5 bps, hedged on HyperCore perps) is paused until
we have the capital for pool reserves + hedge margin. The code is kept here as `.txt` so it doesn't compile
or deploy by accident. The launchpad (`src/launch/`) + our own swap (`src/swap/`) take its place.

Contents (original paths, plus `.txt`):
- `src/amm/PropAMM.sol`, `test/PropAMM.t.sol` — the pool and its tests
- `script/DeployPropAMM.s.sol`, `script/DeployKntqPool.s.sol` — deploys (oracle + mock tokens + pool, 2nd KNTQ pool)
- `script/deploy-testnet.sh`, `deploy-kntq-pool.sh`, `e2e-bridge.sh`, `e2e-oneclick.sh`, `smoke-trade.sh` — scripts that need it

To restore: `git mv` each file back without `.txt`, change `IUsdcPool` back to `PropAMM` in the tests if
wanted (FastBridge works with either: `IUsdcPool` matches PropAMM's ABI), and `forge test`.

Still live on Elysium testnet (idle while the feeder is stopped): PropAMM HYPE/USDC `0xcfda…9b`,
KNTQ/USDC `0x4150…639c`, still registered in FastBridge. The keeper's feeder/hedger code in `keeper/` is
unchanged and still targets them.
