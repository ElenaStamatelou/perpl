# Bot Optimization Plan

A working document. Update the checkboxes as we go. Nothing here is final —
we test one change at a time, look at the numbers, and decide the next step
together.

---

## 1. The goal, in plain language

Every time the bot opens a trade, it pays a small fee (like a service charge).
When it closes the trade, the price may have moved a little in your favor or
against you — that's called **PnL** (profit and loss), and it's a *separate*
thing from the fee.

**Cost = Fee you paid − PnL you made.** If PnL is negative (price moved
against you), it *adds* to your cost. If PnL is positive, it *offsets* the
fee.

Right now, roughly:
- You pay about **$45 in fees for every $1,000,000 you trade** (fixed by
  Perpl, we can't change this directly).
- On top of that, price movement against you adds **another ~$40 per
  $1,000,000**, on average.
- So your real, all-in cost is about **$85 per $1,000,000 traded**.

**The goal of everything below is to shrink that second number** (the price
movement cost), since the fee itself is fixed. If we shrink it enough, cost
could even go negative — meaning the bot makes money instead of costing money.
That's what "positive PnL" means.

**But cost isn't the only number that matters.** You're running this bot to
rack up volume (points), not just to minimize spending. A change that halves
your cost per $1M but also halves your volume per hour hasn't actually helped
— you'd spend the same total money to earn half the points. So for every
test below, **we track two numbers side by side**: cost per $1M, and volume
per hour. A good result is one where cost drops *without* volume dropping by
a similar or bigger amount. See Section 5.

### Why your win rate looks low, and why that's not the real problem

Out of your trades: about 11% were winners, 46% were losers, and the rest
were a wash (roughly break-even). That sounds bad, but the *size* of each
matters more than how often you win:
- Average win: about **+$0.02**
- Average loss: about **−$0.08**

So losses are about 4x bigger than wins, on average. That's the actual thing
to fix — not "win more often," but "make the losing trades smaller" (or the
winning ones bigger). Every test below is really an attempt at that.

---

## 2. Where the cost is coming from (what we found in your logs)

We looked at your actual trade history (not a guess) and found two moments
where price moves against you the most:

1. **Opening a trade**: usually fine (bot waits for a good price), but the
   worst 10% of opens lose about 2bps (0.02%) because the bot kept trying at
   worse and worse prices during a fast-moving market.
2. **Closing a trade**: this is the bigger one. Right now, closing is done
   with an "instant" order that just takes whatever price is available
   immediately — like grabbing the first offer instead of waiting for a
   better one. At your current $600 size, this costs about **1 basis point
   (0.01%)** on average, and it gets worse the bigger the trade is.

That close-side cost is the single biggest lever we have.

### The proof — not a guess, checked directly against your history

We don't have to speculate about either of these; both show up clearly when
we look at all your trades together (over 1,500 of them):

**Bigger trades cost more to close, consistently:**

| How big the trade actually was | Cost to close it |
|---|---|
| ~$260 | 0.28 bps |
| ~$560 | 0.55 bps |
| ~$770 | 0.57 bps |
| ~$800 | 0.47 bps |
| ~$990 | **0.79 bps** |

Roughly triples from smallest to largest. Makes sense: an instant order has
to eat through however much of the order book it takes to fill immediately —
a bigger order eats deeper, at worse prices.

**Trades that take many tries to open cost far more than quick ones:**

| Tries needed to open | Cost |
|---|---|
| 1-2 tries | 0.03 bps |
| 3-5 tries | 0.50 bps |
| 6-10 tries | **0.57 bps** — about 20x the 1-2-try cost |

Needing many tries means price kept moving away each time the bot re-posted
— so by the time it finally filled, it filled at a much worse price than an
early, easy fill would have.

**Why this matters**: these two patterns are strong and consistent enough
that we don't need to "test and hope" for the first two changes below — we
already know they'll help. What we DO still need to test is how much
*volume* we give up in exchange, since that's the one thing history can't
tell us (see Section 4).

---

## 3. Small glossary (things that come up below)

| Term | What it means |
|---|---|
| **bps (basis points)** | 1 bps = 0.01%. 100 bps = 1%. Small unit for talking about tiny fees/costs. |
| **Maker order** | An order that *waits* on the order book for someone else to trade against it. Cheaper (sometimes even pays *you*), but might not fill, or takes time. |
| **Taker order** | An order that trades *immediately* against whatever's already on the book. Always fills right away, but usually costs more. |
| **Notional** | The dollar size of one trade (e.g. $600 means you're opening a $600 position). |
| **Slippage** | How much worse a price you're willing to accept vs. the current market price, to guarantee an instant fill. |
| **Chase** | The bot repeatedly re-posting an order at the current best price, trying to get a maker (cheap) fill before giving up. |
| **Trend guard** | A safety check: if price has been moving fast recently, wait instead of opening a trade into it. |
| **All-in cost** | Fees + the cost/benefit of price movement, combined — the real number that matches what your deposit balance actually does. |

---

## 4. The plan

Not everything here needs to be a cautious one-at-a-time experiment. T1 and
T3 below are already *proven* to reduce cost per trade (Section 2's tables) —
the only open question for them is how much volume we give up, so we're
turning both on together as **Round 1**. T2 and T4 are genuinely uncertain
(we don't have the historical data to prove them ahead of time), so those
stay as separate, one-at-a-time tests in **Round 2**, only if Round 1 needs
more help. T5 (bigger size) comes last, once closing is fixed - since we now
know bigger size makes closing worse, it makes more sense to try after,
not before.

---

### Round 1 — turn on together (both already proven to cut cost per trade)

### T1 — Close trades the "patient" way instead of "instant"

**What it does today**: when closing a position, the bot grabs the first
available price immediately (a "taker" order). This is simple and always
works, but costs you the spread — like paying the asking price instead of
haggling.

**What we'd change**: `CLOSE_MAKER_FIRST=true` — this tells the bot to first
*try* to close the patient way (resting an order and waiting, like it already
does when opening), and only fall back to the instant method if that doesn't
work in time.

**Why it should help**: closing is always free on Perpl regardless of method,
so a patient close either costs nothing extra, or can even work out in your
favor (like buying at a slightly better price than instant).

**The trade-off (real, not minor)**: the position stays open longer while
waiting for a good price, which means fewer completed trades per hour — i.e.
less volume. This is the central tension of this whole test: is "cheaper per
trade" worth "fewer trades"? We won't know until we see both numbers
together (Section 5). If volume drops a lot more than cost improves, this
one gets reverted, full stop — cheaper-but-slower isn't automatically a win
for a volume-farming bot.

### T3 — Give up sooner on a trade that isn't filling well

**What it does today**: `MAKER_CHASE_ATTEMPTS=10` — when opening, the bot
tries up to 10 times to get a good ("maker") price before giving up. We found
that fills happening on try #7, #8, #9, #10 tend to be the worst-priced ones —
like still trying to buy at an old price while the market has already moved
on without you.

**What we'd change**: lower it to `MAKER_CHASE_ATTEMPTS=5`. This means the
bot gives up sooner on a trade that's clearly not going well, and skips that
cycle instead of forcing a bad fill (skipping costs nothing).

**Round 1 checklist** (T1 + T3 together):
- [ ] Set `CLOSE_MAKER_FIRST=true` in `.env`
- [ ] Set `MAKER_CHASE_ATTEMPTS=5` in `.env`
- [ ] Restart the bot, let it run at least a full day (mix of market moods —
      see Section 6)
- [ ] Compare against baseline (Section 5) — watch Costs per $1M AND Volume
      per Hour together
- [ ] Also run `npx tsx scripts/close-fill-rate.ts` — new tool that shows what
      % of closes actually filled the cheap (maker) way vs fell back to
      instant, and how many tries it typically took. This is the one number
      we genuinely couldn't know ahead of time (see Section 4 discussion).
- [ ] Keep, adjust, or (only if volume drops too much) revert

---

### Round 2 — only if Round 1 needs more help (genuinely untested, one at a time)

### T2 — Make instant closes accept a smaller bad price (fallback only, once T1 is on)

**What it does today**: `MAX_TAKER_SLIPPAGE_BPS=15` — when the bot falls back
to an instant close (maker chase didn't fill in time), it's allowed to accept
a price up to 0.15% worse than the current market price to guarantee the
trade goes through. On a bigger trade, this can mean digging deep into the
order book, which costs more. Unlike T1/T3, we don't have proof this helps
overall — it only fine-tunes the fallback path, which should fire less often
once T1 is on.

**What we'd change**: lower it to `MAX_TAKER_SLIPPAGE_BPS=5`. Forces the bot
to accept a much smaller bad price on that fallback — if it can't get a
decent price, it partially closes and retries (already handled
automatically) instead of accepting a bad price all at once.

- [ ] Set `MAX_TAKER_SLIPPAGE_BPS=5` in `.env`
- [ ] Restart the bot, let it run at least a full day
- [ ] Compare against baseline
- [ ] Keep or revert

### T4 — Be more cautious about trading during fast price moves

**What it does today**: `TREND_GUARD_MAX_DRIFT_BPS=3.5` — before opening, the
bot checks how much price has moved in the last 10 seconds. If it's moved
more than 3.5bps, the bot waits instead of opening (since trading into a
sudden move usually goes badly).

**What we'd change**: lower it to `TREND_GUARD_MAX_DRIFT_BPS=2.0` — a
stricter, more cautious threshold, so the bot waits out more of these moments
instead of trading through them. Unlike T1/T3, this one genuinely needs a
live test — the guard already filters out the worst moments before they
happen, so history can't tell us what a *stricter* guard would have avoided.

**The trade-off**: the bot will wait more often, meaning less volume per
hour.

- [ ] Set `TREND_GUARD_MAX_DRIFT_BPS=2.0` in `.env`
- [ ] Restart the bot, let it run at least a full day
- [ ] Compare against baseline
- [ ] Keep or revert

---

### Round 3 — bigger trade size, once closing is fixed

### T5 — Try a bigger trade size again

**What it does today**: `NOTIONAL_USD=600` (or whatever we land on above).

**What we'd change**: try `NOTIONAL_USD=800`, using whatever combination of
T1-T4 worked best.

**Why**: bigger trades = more $ volume per hour (good for points farming), as
long as the cost-per-$1M doesn't get worse. $600 already beat $400 on every
quality measure we checked, so it's worth testing whether that holds at $800
too, once we've fixed the closing-cost issue.

- [ ] Set `NOTIONAL_USD=800` in `.env` (after T1-T4 are settled)
- [ ] Restart the bot, let it run 3-4 hours
- [ ] Compare against baseline
- [ ] Keep or revert

---

## 5. How to check the result after each test

**Open `logs/runs-summary.xlsx`.** Every time you stop and restart the bot,
it creates one new row summarizing that whole run. Look at the newest row and
compare it to the row(s) before your change. Two columns matter, together:

- **Costs per $1M** — your real all-in cost, in a bank-statement sign
  convention: **negative means you net lost money, positive means you net
  made money.** So for this one, *more positive (or less negative) is
  better* — the opposite direction from how "cost" normally reads, worth
  double-checking each time so it doesn't get read backwards.
- **Volume per Hour** — now a built-in column, no manual math needed. This is
  your points-farming speed.

A test is a genuine win only if Costs per $1M improves **without** Volume per
Hour dropping by a similar or larger percentage. If both move in your favor,
great. If cost improves but volume tanks, that's a real trade-off to discuss,
not an automatic win.

**For the notional-size test (T5) specifically**, use the built-in comparison
tool instead, since it's designed to split results by trade size:
```
npx tsx scripts/compare-notional.ts
```

---

## 6. How do we know a result is real, and not just a lucky/unlucky hour?

This is a fair challenge to the whole plan, worth answering directly: **BTC's
price behavior changes hour to hour on its own**, completely independent of
any setting we change. A calmer hour will look better than a choppy one no
matter what the bot is doing. So if we test setting A for 3 hours, then
setting B for the next 3 hours, and B looks better — is that B, or just B
getting the calmer hour?

**We actually measured this.** Looking at hours where the bot ran with the
exact same settings the whole time (no change at all), the average
price-adverse cost still swung between **0.11 and 0.49 bps** from one 2-hour
window to the next — nearly a 5x difference, from market conditions alone.
That's the "noise floor": any test result that falls inside roughly that
range could just be a normal fluctuation, not a real effect from the setting
we changed.

**What we'll do about it, in order of preference:**

1. **Run each test long enough to average out a few different market moods**
   — not just one calm patch. A half-day (or across a full day, hitting both
   quiet and volatile stretches) is much more trustworthy than 3 hours.
2. **If a result looks promising, run it again** before fully committing —
   if setting A beats B twice in separate tries, that's real evidence; if it
   wins once and loses once, it was probably noise.
3. **The gold-standard option, if you're up for it later**: run two bot
   instances at the same time, on two separate accounts, one with the old
   setting and one with the new one. Since they'd trade through the *exact
   same* price moves simultaneously, this removes the "different hour"
   problem entirely — whichever does better, actually is better, not just
   luckier. The bot already has the pieces for this (`PERPL_ACCOUNT_ID`,
   `BOT_LABEL`, and a second slot already sketched out in
   `ecosystem.config.cjs`) — it just needs a second funded account, and
   we'd want to vary timing/notional slightly between the two so they don't
   look like mirrored wallets (flagged as a wash-trading risk in the
   README). We can set this up whenever you want a more rigorous read than
   sequential testing gives us.

---

## 7. Ground rules while we do this

- Change **one setting at a time**. If we change two things at once and the
  result improves, we won't know which one actually helped.
- Run each test long enough to cover a mix of market conditions (see Section
  6) — a single good/bad few-hour stretch isn't enough to trust.
- Track **both** cost per $1M and volume per hour for every test (Section
  5) — a cheaper bot that trades much less isn't automatically better.
- After each test, we'll decide together: keep it, revert it, or adjust it
  further before moving to the next one.
