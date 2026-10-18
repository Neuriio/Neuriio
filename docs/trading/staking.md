# Staking

Staking lets you share in Neuriio's trading fees, in USDC. There are two kinds:

| Stake | You earn | Opens |
| --- | --- | --- |
| A graduated token | 40% of that token's pool fees, in USDC, **plus newly minted Neuriio** | When the token graduates |
| Neuriio | 80% of every curve fee and 40% of every pool fee, across all tokens, in USDC | Any time |

Staking is a choice. There's no lockup: stake or unstake any amount at any time.

## Staking a token

Once a token [graduates](../launching/graduation.md), anyone holding it can stake it from the **stake card** on its
Explore page.

* Every pool trade of that token pays 1%, and **40% of it goes to the people staking it**, shared by how much each has
  staked.
* Every **$1** you earn this way also **mints Neuriio** for you (100 Neuriio per $1 to start; see below).
* A token still on its bonding curve can't be staked yet.

## Neuriio

Neuriio is the platform token. The only way it's created is by staking graduated tokens: there's no presale, no team
allocation and no pre-mint.

* **Stake Neuriio** to share 80% of every curve fee and 40% of every pool fee on Neuriio, in USDC. Staking Neuriio
  doesn't mint more Neuriio.
* **Claimed Neuriio is staked for you.** When you claim from a token you stake, the USDC goes to your wallet and the
  Neuriio goes straight into your Neuriio stake, where it starts earning right away.
* **Neuriio can't be sent** to other wallets for now: it can only be staked and unstaked.

### How much Neuriio is minted

| Total fees Neuriio has taken | Neuriio per $1 earned |
| --- | --- |
| Up to $1M | 100 |
| After $1M | 100 × (S ÷ (S + h))², with S = $120M and h = fees past the first $1M |

The rate stays at 100 until Neuriio has taken $1M in fees, then slowly falls as the platform grows. For example, with
$31M taken it's about 64 per $1, and with $101M taken it's about 30.

## Rewards drip in

Fees don't land all at once. Each payment to a pool drips out over **one hour** to whoever is staked during that hour.
Jumping in for a moment before a big trade and leaving right after earns almost nothing; staying staked earns your
full share. If everyone leaves a pool partway through, the rest waits for the next stakers.

## Claiming

* **Stake card on Explore:** the **Claim** tab shows the USDC (and Neuriio) you've earned on that token.
* **Account → Neuriio:** your staked Neuriio and the USDC it has earned, with a **Claim** button.

Claim any time; you only pay gas. Unclaimed rewards never expire.

## Good to know

* The staking contract has **no owner**: nobody, including Neuriio, can move staked tokens or rewards. Only you can
  unstake yours.
* Fees are paid from real trading activity. They go up and down with volume and can be zero.

{% hint style="warning" %}
Staking shares trading fees; it is not a promise of value or of any amount. Tokens are memes and can go to zero. Read
the [Disclaimer](../trust/disclaimer.md).
{% endhint %}
