import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = process.cwd();

const FRAMEWORK_FILES = [
  "templates/gemini/litellm-config.yaml.template",
  "templates/gemini/com.litellm.proxy.plist.template",
  "scripts/gemini_litellm_install.sh",
  "scripts/gemini_litellm_doctor.sh",
  "docs/GEMINI_VERTEX_LITELLM.md",
];
const DISALLOWED_PROJECT_ID = ["gen", "lang", "client", "0490838717"].join("-");
const DISALLOWED_HOME_PATH = "/" + ["Users", "dan.driver"].join("/");
const DISALLOWED_OAUTH_PREFIX = ["ya", "29"].join("");
const DISALLOWED_API_KEY_PREFIX = ["AI", "za"].join("");
const DISALLOWED_PRIVATE_KEY_MARKER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const DISALLOWED_SECRET_PATTERN = new RegExp(
  [DISALLOWED_OAUTH_PREFIX, DISALLOWED_API_KEY_PREFIX, DISALLOWED_PRIVATE_KEY_MARKER].map(escapeRegExp).join("|")
);

test("Gemini LiteLLM framework is packaged as secret-safe repo scaffolding", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  for (const relativePath of FRAMEWORK_FILES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relativePath)), `${relativePath} should exist`);
  }

  assert.equal(pkg.scripts["gemini:litellm:install"], "node ./scripts/run_sh.mjs ./scripts/gemini_litellm_install.sh");
  assert.equal(pkg.scripts["gemini:litellm:doctor"], "node ./scripts/run_sh.mjs ./scripts/gemini_litellm_doctor.sh");

  const joined = FRAMEWORK_FILES.map((relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")).join("\n");
  assert.match(joined, /__GCP_PROJECT_ID__/);
  assert.match(joined, /__ADC_PATH__/);
  assert.match(joined, /__VERTEX_REGIONS__/);
  assert.doesNotMatch(joined, new RegExp(escapeRegExp(DISALLOWED_PROJECT_ID)));
  assert.doesNotMatch(joined, new RegExp(escapeRegExp(DISALLOWED_HOME_PATH)));
  assert.doesNotMatch(joined, DISALLOWED_SECRET_PATTERN);
});

test("Gemini LiteLLM install dry-run renders local config without loading launchd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-gemini-litellm-"));
  const outputDir = path.join(tempDir, "proxy");
  const launchAgentsDir = path.join(tempDir, "LaunchAgents");
  const adcPath = path.join(tempDir, "application_default_credentials.json");
  const litellmBin = path.join(tempDir, "litellm");
  fs.writeFileSync(adcPath, "{}\n");
  fs.writeFileSync(litellmBin, "#!/usr/bin/env bash\n");
  fs.chmodSync(litellmBin, 0o755);

  try {
    const stdout = execFileSync(
      "bash",
      [
        "./scripts/gemini_litellm_install.sh",
        "--dry-run",
        "--project-id",
        "coworker-project",
        "--regions",
        "us-central1,europe-west4,asia-southeast1",
        "--litellm-bin",
        litellmBin,
        "--adc-path",
        adcPath,
        "--output-dir",
        outputDir,
        "--launchagents-dir",
        launchAgentsDir,
        "--port",
        "4999",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    assert.match(stdout, /dry_run=true/);
    assert.match(stdout, /launchd_load=skipped/);

    const config = fs.readFileSync(path.join(outputDir, "config.yaml"), "utf8");
    assert.match(config, /vertex_project: "coworker-project"/);
    assert.match(config, /vertex_location: "asia-southeast1"/);
    assert.match(config, /enable_health_check_routing: true/);
    assert.doesNotMatch(
      config,
      new RegExp(
        [DISALLOWED_PROJECT_ID, DISALLOWED_HOME_PATH, DISALLOWED_OAUTH_PREFIX, DISALLOWED_API_KEY_PREFIX]
          .map(escapeRegExp)
          .join("|")
      )
    );

    const plist = fs.readFileSync(path.join(launchAgentsDir, "com.litellm.proxy.plist"), "utf8");
    assert.match(plist, new RegExp(escapeRegExp(litellmBin)));
    assert.match(plist, new RegExp(escapeRegExp(adcPath)));
    assert.match(plist, /<string>4999<\/string>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Gemini LiteLLM shell scripts are syntactically valid", () => {
  for (const script of ["scripts/gemini_litellm_install.sh", "scripts/gemini_litellm_doctor.sh"]) {
    execFileSync("bash", ["-n", script], { cwd: REPO_ROOT });
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
