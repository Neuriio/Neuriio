-- token_stats: read only OUR coins' trades (2026-11-08). The view read every trade of every Ascend coin (76k rows, sorted on disk)
-- and then kept our few coins: ~3 s per request. Every coin page looks a coin up here first and refreshes it every 15 s, so once
-- the site went live the database saturated and everything timed out ("canceling statement due to statement timeout": token_stats,
-- token_chart, ascend_token_stats). Same columns and calculations; the only change is the filter in `t`.
create or replace view public.token_stats with (security_invoker = true) as
 WITH t AS (
         SELECT trades.market,
            trades.ts,
            trades.block_number,
            trades.log_index,
            trades.venue,
            trades.quote_amount,
            trades.usd_value,
            trades.price_hype,
            trades.curve_sold
           FROM trades
          WHERE trades.venue = ANY (ARRAY['curve'::venue, 'pool'::venue])
            AND trades.market IN (SELECT tk.address FROM tokens tk WHERE NOT tk.registry IS DISTINCT FROM app_registry())
        ), agg AS (
         SELECT t.market,
            count(*) AS trades,
            count(*) FILTER (WHERE t.ts > (now() - '24:00:00'::interval)) AS trades_24h,
            COALESCE(sum(t.usd_value), 0::numeric) AS volume_usd,
            COALESCE(sum(t.usd_value) FILTER (WHERE t.ts > (now() - '24:00:00'::interval)), 0::numeric) AS volume_usd_24h,
            COALESCE(sum(t.quote_amount), 0::numeric) AS volume_hype,
            max(t.ts) AS last_trade_at
           FROM t
          GROUP BY t.market
        ), last_price AS (
         SELECT DISTINCT ON (t.market) t.market,
            t.price_hype
           FROM t
          WHERE t.price_hype IS NOT NULL
          ORDER BY t.market, t.ts DESC, t.block_number DESC, t.log_index DESC
        ), price_ago AS (
         SELECT DISTINCT ON (t.market) t.market,
            t.price_hype
           FROM t
          WHERE t.price_hype IS NOT NULL AND t.ts <= (now() - '24:00:00'::interval)
          ORDER BY t.market, t.ts DESC, t.block_number DESC, t.log_index DESC
        ), curve AS (
         SELECT DISTINCT ON (t.market) t.market,
            t.curve_sold
           FROM t
          WHERE t.venue = 'curve'::venue AND t.curve_sold IS NOT NULL
          ORDER BY t.market, t.ts DESC, t.block_number DESC, t.log_index DESC
        )
 SELECT k.address,
    k.handle,
    k.symbol,
    k.category,
    k.creator,
    k.x_user_id,
    u.x_name,
    COALESCE(u.x_pfp_url, k.pfp_url) AS x_pfp_url,
    k.launched_at,
    k.graduated,
    k.pair,
    k.graduated_at,
    COALESCE(lp.price_hype, k.virtual_hype / 1073000000::numeric) AS price_hype,
    COALESCE(lp.price_hype, k.virtual_hype / 1073000000::numeric) * 1000000000::numeric AS mcap_hype,
    COALESCE(pa.price_hype, k.virtual_hype / 1073000000::numeric) AS price_hype_24h_ago,
        CASE
            WHEN k.graduated THEN 1::numeric
            ELSE LEAST(COALESCE(c.curve_sold, 0::numeric) / 793100000::numeric, 1::numeric)
        END AS curve_progress,
    COALESCE(a.trades, 0::bigint) AS trades,
    COALESCE(a.trades_24h, 0::bigint) AS trades_24h,
    COALESCE(a.volume_usd, 0::numeric) AS volume_usd,
    COALESCE(a.volume_usd_24h, 0::numeric) AS volume_usd_24h,
    COALESCE(a.volume_hype, 0::numeric) AS volume_hype,
    a.last_trade_at,
    k.kind,
    k.name,
    k.member_x_user_ids,
    ( SELECT cp.content::jsonb ->> 'sector'::text
           FROM creator_profiles cp
          WHERE cp.hash = k.profile_hash) AS sector,
    k.launchpad
   FROM tokens k
     LEFT JOIN user_cards u USING (x_user_id)
     LEFT JOIN agg a ON a.market = k.address
     LEFT JOIN last_price lp ON lp.market = k.address
     LEFT JOIN price_ago pa ON pa.market = k.address
     LEFT JOIN curve c ON c.market = k.address
  WHERE NOT k.registry IS DISTINCT FROM app_registry();
