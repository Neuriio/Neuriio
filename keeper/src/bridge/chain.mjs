// FastBridge adapter for the relayer (viem). All reads in a snapshot use one block so credit and
// pending deposits are mutually consistent.
import { parseAbi } from "viem";

export const bridgeAbi = parseAbi([
  "function credit() view returns (uint256)",
  "function depositCount() view returns (uint256)",
  "function deposits(uint256) view returns (address user, uint64 createdAt, uint8 status, address hlRecipient, uint96 amount, uint96 fee)",
  "function config() view returns (uint16 feeBps, uint64 minFee, uint64 maxDeposit, uint32 refundDelay, uint64 maxPayout, uint64 dailyPayoutCap)",
  "function markFulfilled(uint256[] ids)",
  "function payout(bytes32 hlRef, address to, uint256 gross)",
  "function setCredit(uint256 expected, uint256 newCredit)",
  "function increaseCredit(uint256 amount)",
  "function decreaseCredit(uint256 amount)",
  "function paidOut(bytes32) view returns (bool)",
  "event DepositRequested(uint256 indexed id, address indexed user, address indexed hlRecipient, address tokenIn, uint256 amountIn, uint256 amount, uint256 fee)",
  "error AlreadyPaid(bytes32 hlRef)",
  "error NotPending(uint256 id)",
  "error PayoutTooLarge(uint256 amount, uint256 max)",
  "error DailyCapExceeded(uint256 wouldBe, uint256 cap)",
  "error InsufficientLiquidity(uint256 amount, uint256 available)",
  "error AmountTooSmall(uint256 gross, uint256 fee)",
  "error NotRelayer(address caller)",
  "error EnforcedPause()",
  "error StaleCredit(uint256 expected, uint256 actual)",
]);

const PENDING = 1;

export class BridgeChain {
  constructor({ pub, wallet, chain, address }) {
    Object.assign(this, { pub, wallet, chain, address });
    this.scanFrom = 1n; // lowest id that may still be pending
  }

  _read(functionName, args, blockNumber) {
    return this.pub.readContract({ address: this.address, abi: bridgeAbi, functionName, args, blockNumber });
  }

  async _write(functionName, args) {
    const { request } = await this.pub.simulateContract({
      address: this.address,
      abi: bridgeAbi,
      functionName,
      args,
      account: this.wallet.account,
      chain: this.chain,
    });
    const hash = await this.wallet.writeContract(request);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  async refundDelayMs() {
    const c = await this._read("config");
    return Number(c[3]) * 1000;
  }

  async snapshot() {
    // cacheTime 0: viem otherwise reuses a block number for seconds, and a stale snapshot is
    // exactly what must never drive credit or payouts.
    const blockNumber = await this.pub.getBlockNumber({ cacheTime: 0 });
    const [credit, count] = await Promise.all([this._read("credit", [], blockNumber), this._read("depositCount", [], blockNumber)]);
    const pending = [];
    let advance = true;
    for (let id = this.scanFrom; id <= count; id++) {
      const [, createdAt, status, hlRecipient, amount] = await this._read("deposits", [id], blockNumber);
      if (status === PENDING) {
        advance = false;
        pending.push({ id: Number(id), hlRecipient, amount, createdAtMs: Number(createdAt) * 1000 });
      } else if (advance) {
        this.scanFrom = id + 1n;
      }
    }
    return { credit, pending };
  }

  markFulfilled(ids) {
    return this._write("markFulfilled", [ids.map(BigInt)]);
  }

  payout(hlRef, to, units) {
    return this._write("payout", [hlRef, to, units]);
  }

  /** Compare-and-set on-chain: reverts StaleCredit if credit moved since the snapshot. */
  setCredit(from, to) {
    return this._write("setCredit", [from, to]);
  }
}
