// The Agora feed route (api/agora.ts). Run: node --test app/api/agora.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { agoraTarget } from "./agora.ts";

const t = (q: string) => agoraTarget(new URL(`https://app.neuriio.xyz/agora${q}`));

test("only the top list and single-token reads are forwarded", () => {
  assert.equal(t("?list=top")?.target, "https://api.agoradex.app/api/tokens?sort=volume&window=24h&launchpad=all&q=&limit=15&offset=0");
  assert.equal(t("?token=0x8DF4F39D592DE2AAEE15838B265C2392D19A4128&range=7d")?.target, "https://api.agoradex.app/api/tokens/0x8df4f39d592de2aaee15838b265c2392d19a4128?range=7d");
  assert.equal(t("?token=0x8df4f39d592de2aaee15838b265c2392d19a4128")?.target.endsWith("?range=24h"), true);
  for (const bad of ["", "?list=all", "?token=0x123", "?token=0x8df4f39d592de2aaee15838b265c2392d19a4128&range=1y", "?token=../../traders"]) {
    assert.equal(t(bad), null, bad);
  }
});
