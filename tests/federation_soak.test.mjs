import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePeerUrl,
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
