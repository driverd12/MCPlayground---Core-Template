import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSidecarRunEnv,
  normalizePeerUrl,
  parseSoakPeers,
  sidecarStepAcceptedAllPeers,
} from "../scripts/federation_soak.mjs";

test("sidecarStepAcceptedAllPeers requires accepted 202 sends for every configured peer", () => {
  assert.equal(
    sidecarStepAcceptedAllPeers(
      {
        json: {
          sends: [
            {
              peer: "http://dans-mbp.local:8787",
              target_peer: "http://dans-mbp.local:8787",
              ok: true,
              status: 202,
              response: { accepted: true },
            },
          ],
        },
      },
      ["http://Dans-MBP.local:8787"]
    ),
    true
  );

  assert.equal(
    sidecarStepAcceptedAllPeers(
      {
        json: {
          sends: [
            {
              peer: "http://dans-mbp.local:8787",
              ok: true,
              status: 202,
              response: { accepted: true },
            },
          ],
        },
      },
      ["http://Dans-MBP.local:8787", "http://coworker-mac.local:8787"]
    ),
    false
  );
});

test("normalizePeerUrl keeps peer matching insensitive to host case and trailing slash", () => {
  assert.equal(normalizePeerUrl("http://Dans-MBP.local:8787"), "http://dans-mbp.local:8787/");
});

test("soak explicit peers isolate one-shot sidecar runs from stale env peers", () => {
  const env = { MASTER_MOLD_FEDERATION_PEERS: "http://stale-peer.local:8787" };
  assert.deepEqual(
    parseSoakPeers(["node", "scripts/federation_soak.mjs", "--peer", "http://fresh-peer.local:8787"], env),
    ["http://fresh-peer.local:8787"]
  );

  const sidecarEnv = buildSidecarRunEnv(env);
  assert.equal(sidecarEnv.MASTER_MOLD_FEDERATION_PEERS, "");
});
