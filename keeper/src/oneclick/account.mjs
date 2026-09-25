// Client side of the one-click flow (browser-safe, viem). The user's wallet delegates to
// NeuriioAccount via EIP-7702; a session key kept on the device then signs buys silently and our
// sponsor submits them (users never need HYPE for gas).
//
// Setup (once): generate a device key, then the MAIN wallet signs two things in one flow:
//   1. the 7702 authorization (wallet -> NeuriioAccount code)
//   2. an AddSession message (device key, caps, expiry)
// The sponsor submits both in one type-4 transaction.
import { encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const accountAbi = parseAbi([
  "struct Buy { address token; uint256 amountIn; uint256 minUsdcOut; uint256 deadline; uint256 nonce; }",
  "struct Session { uint48 validUntil; uint32 epoch; uint64 maxPerBuy; uint64 maxPerDay; uint32 day; uint64 spentToday; }",
  "function buy(Buy b, bytes signature) returns (uint256 depositId)",
  "function addSession(address key, uint48 validUntil, uint64 maxPerBuy, uint64 maxPerDay)",
  "function addSessionWithSig(address key, uint48 validUntil, uint64 maxPerBuy, uint64 maxPerDay, uint32 epoch, uint256 nonce, bytes signature)",
  "function revokeSession(address key)",
  "function revokeAllSessions()",
  "function session(address key) view returns (Session)",
  "function epoch() view returns (uint32)",
  "function nonceUsed(uint256 nonce) view returns (bool)",
  "function bridge() view returns (address)",
  "event Bought(address indexed key, uint256 indexed depositId, address token, uint256 amountIn, uint256 usdcGross)",
  "error OnlySelf()",
  "error BadSignature()",
  "error InvalidSession(address key)",
  "error InvalidParams()",
  "error Expired()",
  "error NonceUsed(uint256 nonce)",
  "error StaleEpoch(uint32 signed, uint32 current)",
  "error OverPerBuyCap(uint256 gross, uint256 cap)",
  "error OverDailyCap(uint256 wouldBe, uint256 cap)",
]);

const domain = (account, chainId) => ({ name: "Neuriio Account", version: "1", chainId, verifyingContract: account });

const BUY_TYPES = {
  Buy: [
    { name: "token", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minUsdcOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};
const ADD_SESSION_TYPES = {
  AddSession: [
    { name: "key", type: "address" },
    { name: "validUntil", type: "uint48" },
    { name: "maxPerBuy", type: "uint64" },
    { name: "maxPerDay", type: "uint64" },
    { name: "epoch", type: "uint32" },
    { name: "nonce", type: "uint256" },
  ],
};

/** 7702 designator: code of a wallet delegated to `delegate` is 0xef0100 ++ delegate. */
export async function isDelegatedTo(pub, wallet, delegate) {
  const code = await pub.getCode({ address: wallet });
  return (code ?? "").toLowerCase() === `0xef0100${delegate.slice(2).toLowerCase()}`;
}

export const randomNonce = () => BigInt(generatePrivateKey()); // unordered 256-bit nonce

/**
 * One-time setup, signed by the user's MAIN wallet (a viem local account or anything with
 * signAuthorization + signTypedData). Returns the payload for the sponsor's /setup endpoint.
 * @param {object} o
 * @param {object} o.main        user's main wallet account
 * @param {object} o.pub         public client (Elysium)
 * @param {string} o.delegate    NeuriioAccount implementation address
 * @param {object} o.caps        { maxPerBuy, maxPerDay } USDC base units (bigint), validDays
 */
export async function prepareSetup({ main, pub, delegate, caps }) {
  const chainId = await pub.getChainId();
  const deviceKey = generatePrivateKey(); // store on the device only
  const device = privateKeyToAccount(deviceKey);
  const delegated = await isDelegatedTo(pub, main.address, delegate);
  // the sponsor sends the tx, so the authorization uses the wallet's current nonce (not +1)
  const authorization = delegated
    ? null
    : await main.signAuthorization({
        address: delegate,
        chainId,
        nonce: await pub.getTransactionCount({ address: main.address }),
      });
  const epoch = delegated ? await pub.readContract({ address: main.address, abi: accountAbi, functionName: "epoch" }) : 0;
  const session = {
    key: device.address,
    validUntil: BigInt(Math.floor(Date.now() / 1000) + (caps.validDays ?? 30) * 86_400),
    maxPerBuy: BigInt(caps.maxPerBuy),
    maxPerDay: BigInt(caps.maxPerDay),
    epoch,
    nonce: randomNonce(),
  };
  const signature = await main.signTypedData({
    domain: domain(main.address, chainId),
    types: ADD_SESSION_TYPES,
    primaryType: "AddSession",
    message: session,
  });
  return { deviceKey, request: { wallet: main.address, authorization, session, signature } };
}

/** A buy signed by the device's session key. `order.deadline` in unix seconds. */
export async function signBuy({ device, wallet, chainId, order }) {
  const b = { minUsdcOut: 0n, nonce: randomNonce(), deadline: BigInt(Math.floor(Date.now() / 1000) + 120), ...order };
  const signature = await device.signTypedData({ domain: domain(wallet, chainId), types: BUY_TYPES, primaryType: "Buy", message: b });
  return { wallet, order: b, signature };
}

export const encodeBuy = ({ order, signature }) =>
  encodeFunctionData({ abi: accountAbi, functionName: "buy", args: [order, signature] });

export const encodeAddSession = ({ session: s, signature }) =>
  encodeFunctionData({
    abi: accountAbi,
    functionName: "addSessionWithSig",
    args: [s.key, s.validUntil, s.maxPerBuy, s.maxPerDay, s.epoch, s.nonce, signature],
  });
