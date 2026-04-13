import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "platform_manifest.json");
const DOCTOR_PATH = path.join(REPO_ROOT, "scripts", "bootstrap_doctor.mjs");
const BOOTSTRAP_ENV_PATH = path.join(REPO_ROOT, "scripts", "bootstrap_env.mjs");
const BOOTSTRAP_INSTALL_PATH = path.join(REPO_ROOT, "scripts", "bootstrap_install.mjs");
const RUN_ENV_PATH = path.join(REPO_ROOT, "scripts", "run_env.mjs");
const RUN_SH_PATH = path.join(REPO_ROOT, "scripts", "run_sh.mjs");
const RUN_PYTHON_TESTS_PATH = path.join(REPO_ROOT, "scripts", "run_python_tests.mjs");
const MVP_SMOKE_PATH = path.join(REPO_ROOT, "scripts", "mvp_smoke.mjs");
const OPEN_BROWSER_PATH = path.join(REPO_ROOT, "scripts", "open_browser.mjs");
const OFFICE_GUI_NODE_PATH = path.join(REPO_ROOT, "scripts", "agent_office_gui.mjs");
const AGENTIC_SUITE_NODE_PATH = path.join(REPO_ROOT, "scripts", "agentic_suite_launch.mjs");

test("platform_manifest.json is valid JSON with required structure", () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), "scripts/platform_manifest.json must exist");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  // Required top-level keys
  assert.ok(manifest.prerequisites, "manifest must have prerequisites");
  assert.ok(manifest.browsers, "manifest must have browsers");
  assert.ok(manifest.platforms, "manifest must have platforms");
  assert.ok(manifest.launchers, "manifest must have launchers");

  // Prerequisites structure
  assert.ok(Array.isArray(manifest.prerequisites.required), "prerequisites.required must be an array");
  assert.ok(manifest.prerequisites.required.length >= 3, "must have at least 3 required prerequisites");
  for (const req of manifest.prerequisites.required) {
    assert.ok(req.name, "each prerequisite must have a name");
    assert.ok(req.check, "each prerequisite must have a check command");
    assert.ok(req.install_hint, "each prerequisite must have install hints");
  }

  // Browsers structure — must cover all target platforms
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.ok(Array.isArray(manifest.browsers[platform]), `browsers.${platform} must be an array`);
    assert.ok(manifest.browsers[platform].length >= 1, `browsers.${platform} must have at least 1 entry`);
    for (const browser of manifest.browsers[platform]) {
      assert.ok(browser.name, `each browser entry for ${platform} must have a name`);
      assert.ok(Array.isArray(browser.open_cmd), `each browser entry for ${platform} must have open_cmd array`);
    }
  }

  // Platforms structure
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.ok(manifest.platforms[platform], `platforms.${platform} must exist`);
    assert.ok(manifest.platforms[platform].service_manager, `platforms.${platform} must have service_manager`);
    assert.ok(manifest.platforms[platform].shell, `platforms.${platform} must have shell`);
  }

  assert.ok(manifest.launchers.office_gui, "manifest must describe the office GUI launcher");
  assert.ok(manifest.launchers.agentic_suite, "manifest must describe the agentic suite launcher");
  assert.ok(manifest.bootstrap_install, "manifest must describe bootstrap install profiles");
});

test("platform_manifest.json required prerequisites include node, python3, git", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const requiredNames = manifest.prerequisites.required.map((r) => r.name);
  assert.ok(requiredNames.includes("node"), "node must be a required prerequisite");
  assert.ok(requiredNames.includes("python3"), "python3 must be a required prerequisite");
  assert.ok(requiredNames.includes("git"), "git must be a required prerequisite");
});

test("platform_manifest.json browser entries for current platform preserve a browser or status fallback", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const currentPlatform = process.platform;
  const browsers = manifest.browsers[currentPlatform];
  if (!browsers) {
    // Platform not in manifest — skip gracefully
    return;
  }

  // At least one browser should be detectable on any dev machine
  let foundAny = false;
  for (const entry of browsers) {
    if (entry.app_path && fs.existsSync(entry.app_path)) {
      foundAny = true;
      break;
    }
    if (entry.binary) {
      try {
        const whichCmd = process.platform === "win32" ? "where" : "which";
        execFileSync(whichCmd, [entry.binary], { stdio: "ignore", timeout: 3000 });
        foundAny = true;
        break;
      } catch {
        // continue
      }
    }
  }
  const hasFallback =
    currentPlatform === "darwin"
      ? browsers.some((entry) => Array.isArray(entry.open_cmd) && entry.open_cmd[0] === "open")
      : currentPlatform === "linux"
        ? browsers.some((entry) => entry.binary === "xdg-open")
        : currentPlatform === "win32"
          ? browsers.some((entry) => entry.binary === "explorer")
          : false;
  assert.ok(
    foundAny || hasFallback,
    `manifest should provide either a detectable browser or a system fallback on ${currentPlatform}`
  );
});

test("platform_manifest.json prefers the system default browser before named browsers", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.browsers.darwin?.[0]?.name, "System default");
  assert.equal(manifest.browsers.linux?.[0]?.name, "System default");
  assert.equal(manifest.browsers.win32?.[0]?.name, "System default");
  assert.deepEqual(manifest.browsers.darwin?.[0]?.open_cmd, ["open"]);
  assert.deepEqual(manifest.browsers.linux?.[0]?.open_cmd, ["xdg-open"]);
  assert.deepEqual(manifest.browsers.win32?.[0]?.open_cmd, ["cmd.exe", "/c", "start", ""]);
});

test("platform_manifest.json win32 browser entries include program files fallbacks", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const win32Browsers = Array.isArray(manifest.browsers.win32) ? manifest.browsers.win32 : [];
  const entriesByName = new Map(win32Browsers.map((entry) => [entry.name, entry]));

  assert.equal(
    entriesByName.get("Microsoft Edge")?.program_files_path,
    "Microsoft\\Edge\\Application\\msedge.exe",
    "Microsoft Edge should include a Program Files fallback path"
  );
  assert.equal(
    entriesByName.get("Google Chrome")?.program_files_path,
    "Google\\Chrome\\Application\\chrome.exe",
    "Google Chrome should include a Program Files fallback path"
  );
  assert.equal(
    entriesByName.get("Firefox")?.program_files_path,
    "Mozilla Firefox\\firefox.exe",
    "Firefox should include a Program Files fallback path"
  );
  assert.equal(
    entriesByName.get("Microsoft Edge")?.local_app_data_path,
    "Microsoft\\Edge\\Application\\msedge.exe",
    "Microsoft Edge should include a LocalAppData fallback path"
  );
  assert.equal(
    entriesByName.get("Google Chrome")?.local_app_data_path,
    "Google\\Chrome\\Application\\chrome.exe",
    "Google Chrome should include a LocalAppData fallback path"
  );
  assert.equal(
    entriesByName.get("Firefox")?.local_app_data_path,
    "Mozilla Firefox\\firefox.exe",
    "Firefox should include a LocalAppData fallback path"
  );
});

test("platform_manifest.json office GUI launcher dependencies stay truthful", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const officeGui = manifest.launchers.office_gui;
  const agenticSuite = manifest.launchers.agentic_suite;

  assert.equal(officeGui.darwin.supported, true);
  assert.equal(officeGui.linux.supported, true);
  assert.equal(officeGui.darwin.entrypoint, "node ./scripts/agent_office_gui.mjs");
  assert.equal(officeGui.linux.entrypoint, "node ./scripts/agent_office_gui.mjs");
  assert.equal(officeGui.win32.entrypoint, "node ./scripts/agent_office_gui.mjs");
  assert.equal(officeGui.win32.supported, true);
  assert.deepEqual(officeGui.win32.required_tools, []);
  assert.deepEqual(officeGui.win32.recommended_tools, []);
  assert.equal(agenticSuite.darwin.entrypoint, "node ./scripts/agentic_suite_launch.mjs");
  assert.equal(agenticSuite.linux.entrypoint, "node ./scripts/agentic_suite_launch.mjs");
  assert.equal(agenticSuite.win32.entrypoint, "node ./scripts/agentic_suite_launch.mjs");
  assert.deepEqual(agenticSuite.linux.supported_distributions, ["ubuntu", "rocky", "amazon-linux"]);
});

test("bootstrap_doctor.mjs exists and runs without crashing", { timeout: 30_000 }, () => {
  assert.ok(fs.existsSync(DOCTOR_PATH), "scripts/bootstrap_doctor.mjs must exist");
  // Run doctor — it may exit non-zero if recommendations are missing, but it must not crash
  try {
    const result = execFileSync(process.execPath, [DOCTOR_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 25_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.ok(result.includes("[doctor]"), "doctor output must include [doctor] markers");
    assert.ok(result.includes("Platform:"), "doctor output must include Platform line");
    assert.ok(result.includes("node"), "doctor output must check for node");
    assert.ok(result.includes("Office GUI Launcher:"), "doctor output must include launcher readiness");
    assert.ok(result.includes("Agentic Suite Launcher:"), "doctor output must include suite launcher readiness");
    assert.ok(result.includes("native launcher"), "doctor output must describe the native launcher");
  } catch (error) {
    // Exit code 1 is acceptable (missing recommendations), but other errors are not
    if (error.status !== 1) {
      throw error;
    }
    assert.ok(
      String(error.stdout || "").includes("[doctor]"),
      "doctor output on partial failure must include [doctor] markers"
    );
    assert.ok(
      String(error.stdout || "").includes("Office GUI Launcher:"),
      "doctor output on partial failure must include launcher readiness"
    );
  }
});

test("bootstrap_doctor.mjs recognizes Windows Python launcher fallback", () => {
  const doctorSource = fs.readFileSync(DOCTOR_PATH, "utf8");
  assert.match(doctorSource, /py -3 --version/, "doctor should check the Windows Python launcher");
  assert.match(doctorSource, /python --version/, "doctor should check python when python3 is absent");
});

test("bootstrap_doctor.mjs includes Apple Silicon Ollama MLX readiness guidance", () => {
  const doctorSource = fs.readFileSync(DOCTOR_PATH, "utf8");
  assert.match(doctorSource, /Apple Silicon MLX/, "doctor should expose an Apple Silicon MLX advisory section");
  assert.match(doctorSource, /qwen3\.5:35b-a3b-coding-nvfp4/, "doctor should mention the Ollama MLX preview coding model");
  assert.match(doctorSource, /0\.19\+/, "doctor should mention the Ollama 0.19 runtime floor for the MLX preview");
  assert.match(doctorSource, /npm run ollama:mlx:preview/, "doctor should point to the guarded Apple Silicon setup command");
});

test("ollama MLX preview setup script is registered and Apple Silicon guarded", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const scriptPath = path.join(REPO_ROOT, "scripts", "ollama_mlx_preview_setup.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.equal(packageJson.scripts["ollama:mlx:preview"], "node ./scripts/ollama_mlx_preview_setup.mjs");
  assert.equal(packageJson.scripts["ollama:mlx:postpull"], "node ./scripts/ollama_mlx_postpull.mjs --wait");
  assert.match(source, /process\.platform !== "darwin"/, "setup script should reject non-macOS hosts");
  assert.match(source, /process\.arch !== "arm64"/, "setup script should reject non-Apple-Silicon hosts");
  assert.match(source, /TRICHAT_OLLAMA_MODEL/, "setup script should wire the preferred local Ollama model");
  assert.match(source, /qwen3\.5:35b-a3b-coding-nvfp4/, "setup script should target the MLX preview model");
  assert.match(source, /ollama_mlx_postpull\.mjs/, "setup script should chain into the post-pull soak pipeline");
});

test("bootstrap env pins are present and aligned with package metadata", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const nvmrc = fs.readFileSync(path.join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  const pythonVersion = fs.readFileSync(path.join(REPO_ROOT, ".python-version"), "utf8").trim();
  const toolVersions = fs.readFileSync(path.join(REPO_ROOT, ".tool-versions"), "utf8");

  assert.equal(packageJson.packageManager, "npm@10.9.4");
  assert.equal(packageJson.engines?.npm, ">=10 <11");
  assert.equal(nvmrc, "22");
  assert.equal(pythonVersion, "3.12.0");
  assert.match(toolVersions, /^nodejs 22\.22\.1/m);
  assert.match(toolVersions, /^python 3\.12\.0/m);
});

test("bootstrap_env.mjs exists as the pinned runtime bootstrap entrypoint", () => {
  assert.ok(fs.existsSync(BOOTSTRAP_ENV_PATH), "scripts/bootstrap_env.mjs must exist");
});

test("open_browser.mjs exists and reports usage error without url argument", () => {
  assert.ok(fs.existsSync(OPEN_BROWSER_PATH), "scripts/open_browser.mjs must exist");
  try {
    execFileSync(process.execPath, [OPEN_BROWSER_PATH], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.fail("open_browser.mjs should exit non-zero without url argument");
  } catch (error) {
    assert.equal(error.status, 2, "should exit with code 2 for missing argument");
    assert.ok(
      String(error.stderr || "").includes("usage"),
      "should print usage message"
    );
  }
});

test("agent_office_gui.mjs exists as the cross-platform office launcher entrypoint", () => {
  assert.ok(fs.existsSync(OFFICE_GUI_NODE_PATH), "scripts/agent_office_gui.mjs must exist");
});

test("agentic_suite_launch.mjs exists as the cross-platform suite launcher entrypoint", () => {
  assert.ok(fs.existsSync(AGENTIC_SUITE_NODE_PATH), "scripts/agentic_suite_launch.mjs must exist");
});

test("agent_office_gui.mjs status emits machine-readable status without crashing", { timeout: 30_000 }, () => {
  const raw = execFileSync(process.execPath, [OFFICE_GUI_NODE_PATH, "status"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 25_000,
  });
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.ok, "boolean");
  assert.equal(typeof parsed.mode, "string");
  assert.equal(typeof parsed.url, "string");
  assert.equal(parsed.platform, process.platform);
  assert.equal(typeof parsed.launchable, "boolean");
});

test("agentic_suite_launch.mjs status emits machine-readable status without crashing", { timeout: 30_000 }, () => {
  const raw = execFileSync(process.execPath, [AGENTIC_SUITE_NODE_PATH, "status"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 25_000,
  });
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.ok, "boolean");
  assert.equal(typeof parsed.reassurance_surface, "string");
  assert.equal(typeof parsed.app_probe_mode, "string");
  assert.equal(Array.isArray(parsed.requested_apps), true);
  assert.equal(Array.isArray(parsed.available_apps), true);
  assert.equal(Array.isArray(parsed.unavailable_apps), true);
  assert.equal(typeof parsed.suite_launcher.entrypoint, "string");
});

test("dist/server.js exists (build completed)", () => {
  const serverPath = path.join(REPO_ROOT, "dist", "server.js");
  assert.ok(fs.existsSync(serverPath), "dist/server.js must exist — run npm run build");
});

test("local_host_profile detects current platform correctly", async () => {
  // Import the built module to verify it works on this platform
  const distPath = path.join(REPO_ROOT, "dist", "local_host_profile.js");
  if (!fs.existsSync(distPath)) {
    return; // skip if not built
  }
  const { captureLocalHostProfile } = await import(distPath);
  const profile = captureLocalHostProfile();
  assert.equal(profile.platform, process.platform);
  assert.equal(profile.arch, process.arch);
  assert.ok(profile.cpu_count > 0);
  assert.ok(profile.memory_total_gb > 0);
  assert.ok(["healthy", "degraded"].includes(profile.health_state));
});

test("platform_manifest.json install_hints cover all three target platforms", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const targetPlatforms = ["darwin", "linux", "win32"];
  for (const prereq of manifest.prerequisites.required) {
    for (const platform of targetPlatforms) {
      assert.ok(
        prereq.install_hint[platform],
        `${prereq.name} must have install_hint for ${platform}`
      );
    }
  }
});

test("platform_manifest.json bootstrap install profiles cover the target platforms", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(typeof manifest.bootstrap_install.darwin.manager_label, "string");
  assert.equal(typeof manifest.bootstrap_install.win32.manager_label, "string");
  assert.equal(typeof manifest.bootstrap_install.linux.ubuntu.manager_label, "string");
  assert.equal(typeof manifest.bootstrap_install.linux.rocky.manager_label, "string");
  assert.equal(typeof manifest.bootstrap_install.linux["amazon-linux"].manager_label, "string");
  assert.equal(typeof manifest.bootstrap_install.darwin.commands.node, "string");
  assert.equal(typeof manifest.bootstrap_install.win32.commands.git, "string");
  assert.equal(typeof manifest.bootstrap_install.linux.ubuntu.commands.python3, "string");
});

test("package.json office GUI npm scripts use the cross-platform node launcher", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["bootstrap:env"], "node ./scripts/bootstrap_env.mjs");
  assert.equal(pkg.scripts["bootstrap:env:install"], "node ./scripts/bootstrap_env.mjs --install-missing");
  assert.equal(pkg.scripts["bootstrap:install"], "node ./scripts/bootstrap_install.mjs --apply");
  assert.equal(pkg.scripts["bootstrap:install:plan"], "node ./scripts/bootstrap_install.mjs --plan");
  assert.equal(pkg.scripts["test:python"], "node ./scripts/run_python_tests.mjs");
  assert.equal(pkg.scripts["mvp:smoke"], "node ./scripts/mvp_smoke.mjs");
  assert.equal(pkg.scripts["start:http"], "node ./scripts/run_env.mjs MCP_HTTP=1 -- node dist/server.js --http --http-port 8787");
  assert.equal(pkg.scripts["start:core"], "node ./scripts/run_env.mjs MCP_DOMAIN_PACKS=none -- node dist/server.js");
  assert.equal(pkg.scripts["start:core:http"], "node ./scripts/run_env.mjs MCP_HTTP=1 MCP_DOMAIN_PACKS=none -- node dist/server.js --http --http-port 8787");
  assert.equal(pkg.scripts["trichat:http"], "node ./scripts/run_env.mjs TRICHAT_MCP_TRANSPORT=http -- python3 ./scripts/trichat.py --transport http --url http://127.0.0.1:8787/ --origin http://127.0.0.1 --resume-latest --panel-on-start");
  assert.equal(pkg.scripts["providers:status"], "node ./scripts/run_sh.mjs ./scripts/provider_bridge.sh status");
  assert.equal(pkg.scripts["autonomy:status"], "node ./scripts/run_sh.mjs ./scripts/autonomy_ctl.sh status");
  assert.equal(pkg.scripts["agents:status"], "node ./scripts/run_sh.mjs ./scripts/agents_switch.sh status");
  assert.equal(pkg.scripts["trichat:office:gui"], "node ./scripts/agent_office_gui.mjs open");
  assert.equal(pkg.scripts["trichat:office:web"], "node ./scripts/agent_office_gui.mjs open");
  assert.equal(pkg.scripts["trichat:office:web:start"], "node ./scripts/agent_office_gui.mjs start");
  assert.equal(pkg.scripts["trichat:office:web:status"], "node ./scripts/agent_office_gui.mjs status");
  assert.equal(pkg.scripts["agentic:suite"], "node ./scripts/agentic_suite_launch.mjs open");
  assert.equal(pkg.scripts["agentic:suite:start"], "node ./scripts/agentic_suite_launch.mjs start");
  assert.equal(pkg.scripts["agentic:suite:status"], "node ./scripts/agentic_suite_launch.mjs status");
});

test("run_env.mjs and run_python_tests.mjs are present for cross-platform npm scripts", () => {
  assert.ok(fs.existsSync(RUN_ENV_PATH), "scripts/run_env.mjs must exist");
  assert.ok(fs.existsSync(RUN_SH_PATH), "scripts/run_sh.mjs must exist");
  assert.ok(fs.existsSync(RUN_PYTHON_TESTS_PATH), "scripts/run_python_tests.mjs must exist");
  assert.ok(fs.existsSync(MVP_SMOKE_PATH), "scripts/mvp_smoke.mjs must exist");
});

test("package.json shell-backed scripts route through run_sh.mjs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const directShellScripts = Object.entries(pkg.scripts)
    .filter(([, value]) => value.startsWith("./scripts/") && value.includes(".sh"))
    .map(([name]) => name);
  assert.deepEqual(directShellScripts, []);
});

test("run_env.mjs applies environment assignments without shell-specific syntax", () => {
  const output = execFileSync(
    process.execPath,
    [
      RUN_ENV_PATH,
      "MCPLAYGROUND_SMOKE_ENV=windows-safe",
      "--",
      "node",
      "-e",
      "process.stdout.write(process.env.MCPLAYGROUND_SMOKE_ENV || '')",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.equal(output, "windows-safe");
});

test("bootstrap_install.mjs exists and plan mode runs without crashing", () => {
  assert.ok(fs.existsSync(BOOTSTRAP_INSTALL_PATH), "scripts/bootstrap_install.mjs must exist");
  try {
    const result = execFileSync(process.execPath, [BOOTSTRAP_INSTALL_PATH, "--plan", "--required-only"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 25_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.ok(result.includes("[bootstrap:install]"), "plan output must include bootstrap:install markers");
  } catch (error) {
    if (![0, 1].includes(error.status)) {
      throw error;
    }
    assert.ok(
      String(error.stdout || "").includes("[bootstrap:install]"),
      "plan output on partial failure must include bootstrap:install markers"
    );
  }
});
