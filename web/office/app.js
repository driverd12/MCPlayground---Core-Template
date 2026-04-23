(function () {
  function defaultHostPairDraft() {
    return {
      host_id: "",
      display_name: "",
      hostname: "",
      ip_address: "",
      mac_address: "",
      ssh_user: "",
      worker_count: "1",
      workspace_root: "",
      agent_runtime: "",
      model_label: "",
      permission_profile: "task_worker",
      desktop_context: true,
      approve: false,
    };
  }

  var state = {
    activeTab: "office",
    bootstrap: null,
    snapshot: null,
    snapshotFingerprint: "",
    snapshotMeta: null,
    selectedAgentId: "",
    refreshHandle: null,
    realtimeHandle: null,
    snapshotRequest: false,
    realtime: null,
    realtimeRequest: false,
    patientZeroNoteDraft: "",
    patientZeroNoteDirty: false,
    patientZeroLastSavedNote: "",
    intakeModeDirty: false,
    intakeTargetAgentIds: [],
    officeActions: {},
    hostPairDraft: defaultHostPairDraft(),
  };

  var els = {
    subtitle: document.querySelector("#subtitle"),
    statusStrip: document.querySelector("#status-strip"),
    officeView: document.querySelector("#office-view"),
    workbenchView: document.querySelector("#workbench-view"),
    briefingView: document.querySelector("#briefing-view"),
    workersView: document.querySelector("#workers-view"),
    hostsView: document.querySelector("#hosts-view"),
    patientZeroView: document.querySelector("#patient-zero-view"),
    eventsView: document.querySelector("#events-view"),
    tabs: Array.prototype.slice.call(document.querySelectorAll(".tabs__button")),
    intakeForm: document.querySelector("#intake-form"),
    intakeTitle: document.querySelector("#intake-title"),
    intakeObjective: document.querySelector("#intake-objective"),
    intakeRisk: document.querySelector("#intake-risk"),
    intakeMode: document.querySelector("#intake-mode"),
    intakeDryRun: document.querySelector("#intake-dry-run"),
    intakeSubmit: document.querySelector('#intake-form button[type="submit"]'),
    intakeResult: document.querySelector("#intake-result"),
    intakeConsole: null,
    agentDetail: document.querySelector("#agent-detail"),
    refreshButton: document.querySelector("#refresh-button"),
    actionButtons: Array.prototype.slice.call(document.querySelectorAll("[data-action]")),
  };

  var MASTER_MOLD_MODE_LABEL = "MASTER-MOLD MODE";
  var MASTER_MOLD_MODE_HERO_ASSET = "/office/master-mold-mode-banner.svg?v=20260420d";

  function setBootState(value) {
    if (document.body) {
      document.body.setAttribute("data-office-boot", value);
    }
  }

  function setPatientZeroTone(value) {
    if (document.body) {
      document.body.setAttribute("data-patient-zero", value);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function operatorFacingText(value) {
    return String(value == null ? "" : value)
      .replace(/patient zero/gi, MASTER_MOLD_MODE_LABEL)
      .replace(/patient-zero/gi, MASTER_MOLD_MODE_LABEL);
  }

  function masterMoldModeState(enabled) {
    return enabled ? "enabled" : "disabled";
  }

  function masterMoldModePosture(enabled) {
    return enabled ? "ENABLED" : "DISABLED";
  }

  function fmt(value, digits) {
    var number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits == null ? 1 : digits) : "n/a";
  }

  function relativeTime(isoValue) {
    var stamp = new Date(isoValue || 0).getTime();
    if (!Number.isFinite(stamp) || stamp <= 0) return "n/a";
    var seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    var minutes = String(Math.floor((seconds % 3600) / 60));
    if (minutes.length < 2) minutes = "0" + minutes;
    return Math.floor(seconds / 3600) + "h" + minutes + "m";
  }

  function ageSeconds(isoValue) {
    var stamp = new Date(isoValue || 0).getTime();
    if (!Number.isFinite(stamp) || stamp <= 0) return null;
    return Math.max(0, (Date.now() - stamp) / 1000);
  }

  function chipToneClass(tone) {
    return tone ? " chip--" + tone : "";
  }

  function humanizeSource(value) {
    return String(value || "live").replace(/-/g, " ");
  }

  function latestProviderBridgeGeneratedAt(snapshot) {
    var summary = snapshot && snapshot.summary ? snapshot.summary : {};
    var providerBridgeSummary = summary.provider_bridge || {};
    if (providerBridgeSummary.generated_at) {
      return providerBridgeSummary.generated_at;
    }
    var providerBridge = snapshot && snapshot.provider_bridge ? snapshot.provider_bridge : {};
    return providerBridge.generated_at || "";
  }

  function overlayRealtimeSnapshot(snapshot) {
    if (!state.realtime) {
      return snapshot;
    }
    var base = snapshot && typeof snapshot === "object" ? snapshot : {};
    var merged = Object.assign({}, base);
    var realtime = state.realtime || {};
    var baseSnapshot = realtime.base_snapshot || {};
    if (realtime.thread_id) merged.thread_id = realtime.thread_id;
    if (realtime.theme) merged.theme = realtime.theme;
    if (baseSnapshot.fetched_at != null) merged.fetched_at = baseSnapshot.fetched_at;
    if (baseSnapshot.fetched_at_iso) merged.fetched_at_iso = baseSnapshot.fetched_at_iso;
    if (baseSnapshot.cache) merged.cache = baseSnapshot.cache;
    if (Array.isArray(realtime.errors)) merged.errors = realtime.errors;
    if (Array.isArray(realtime.agents)) merged.agents = realtime.agents;
    if (realtime.rooms && typeof realtime.rooms === "object") merged.rooms = realtime.rooms;
    if (realtime.summary && typeof realtime.summary === "object") merged.summary = realtime.summary;
    if (realtime.provider_bridge && typeof realtime.provider_bridge === "object") merged.provider_bridge = realtime.provider_bridge;
    if (Array.isArray(realtime.router_suppression_decisions)) {
      merged.router_suppression_decisions = realtime.router_suppression_decisions;
    }
    return merged;
  }

  function statusClass(value) {
    if (value === true || value === "healthy" || value === "WORK" || value === "work") return "metric--good";
    if (value === false || value === "degraded" || value === "BLOCK" || value === "block") return "metric--bad";
    return "metric--warn";
  }

  function toneForState(agentState) {
    switch (agentState) {
      case "working":
      case "supervising":
        return "#d78e58";
      case "talking":
        return "#6db5ae";
      case "break":
        return "#d9b35f";
      case "sleeping":
        return "#8da0d6";
      case "blocked":
      case "offline":
        return "#d96c6c";
      default:
        return "#f2f1e8";
    }
  }

  function spriteSvg(agent) {
    var stateName = agent && agent.state ? agent.state : "idle";
    var fill = toneForState(stateName);
    var eye = stateName === "sleeping" ? "#1e2430" : "#111317";
    var accent = stateName === "blocked" ? "#d96c6c" : "#1e2430";
    var motion = stateName === "working" ? 1 : stateName === "talking" ? 2 : 0;
    var blink = stateName === "idle" ? 7 : 10;
    return (
      '<svg viewBox="0 0 96 96" aria-hidden="true">' +
      '<rect x="28" y="22" width="40" height="8" fill="' + accent + '" />' +
      '<rect x="18" y="30" width="60" height="22" fill="' + fill + '" />' +
      '<rect x="12" y="52" width="72" height="14" fill="' + fill + '" />' +
      '<rect x="18" y="66" width="10" height="16" fill="' + fill + '" />' +
      '<rect x="40" y="66" width="10" height="16" fill="' + fill + '" />' +
      '<rect x="62" y="66" width="10" height="16" fill="' + fill + '" />' +
      '<rect x="28" y="42" width="' + blink + '" height="8" fill="' + eye + '" />' +
      '<rect x="60" y="42" width="' + blink + '" height="8" fill="' + eye + '" />' +
      '<rect x="0" y="82" width="96" height="4" fill="rgba(0,0,0,0.25)" />' +
      '<rect x="' + (30 + motion) + '" y="86" width="36" height="2" fill="rgba(255,255,255,0.08)" />' +
      "</svg>"
    );
  }

  function masterMoldModeHeroMarkup() {
    return '<img src="' + MASTER_MOLD_MODE_HERO_ASSET + '" alt="' + MASTER_MOLD_MODE_LABEL + ' citadel artwork" />';
  }

  function getSnapshotAgents() {
    return state.snapshot && Array.isArray(state.snapshot.agents) ? state.snapshot.agents : [];
  }

  function snapshotFingerprint(payload) {
    return JSON.stringify(payload, function (key, value) {
      if (key === "fetched_at" || key === "fetched_at_iso") return undefined;
      if (key === "cache" && value && typeof value === "object") {
        var copy = {};
        Object.keys(value).forEach(function (entryKey) {
          if (entryKey !== "written_at") {
            copy[entryKey] = value[entryKey];
          }
        });
        return copy;
      }
      return value;
    });
  }

  function findAgent(agentId) {
    var agents = getSnapshotAgents();
    for (var index = 0; index < agents.length; index += 1) {
      if (agents[index] && agents[index].agent && agents[index].agent.agent_id === agentId) {
        return agents[index];
      }
    }
    return null;
  }

  function setTab(tab) {
    state.activeTab = tab;
    for (var i = 0; i < els.tabs.length; i += 1) {
      var button = els.tabs[i];
      button.classList.toggle("is-active", button.getAttribute("data-tab") === tab);
    }
    var panels = Array.prototype.slice.call(document.querySelectorAll(".tab-panel"));
    for (var j = 0; j < panels.length; j += 1) {
      var panel = panels[j];
      panel.classList.toggle("is-active", panel.id === tab + "-view");
    }
  }

  function setResultText(value) {
    if (els.intakeResult) {
      els.intakeResult.textContent = String(value == null ? "" : value);
    }
  }

  function compactIntakeText(value, limit) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!limit || text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)).replace(/\s+$/, "") + "…";
  }

  function shellQuote(value) {
    return "'" + String(value == null ? "" : value).replace(/'/g, "'\"'\"'") + "'";
  }

  function getWorkbench() {
    if (!state.snapshot || !state.snapshot.workbench || typeof state.snapshot.workbench !== "object") {
      return null;
    }
    return state.snapshot.workbench;
  }

  function ensureIntakeConsole() {
    if (els.intakeConsole) return els.intakeConsole;
    if (!els.intakeForm || !els.intakeForm.parentNode) return null;
    els.intakeConsole = document.createElement("section");
    els.intakeConsole.className = "intake-console";
    els.intakeForm.parentNode.insertBefore(els.intakeConsole, els.intakeForm);
    return els.intakeConsole;
  }

  function getBridgeIntakeAgents() {
    var explicitTargets =
      state.snapshot && Array.isArray(state.snapshot.bridge_targets) ? state.snapshot.bridge_targets : [];
    if (explicitTargets.length) {
      return explicitTargets
        .map(function (entry) {
          if (!entry || typeof entry !== "object") return null;
          var agentId = String(entry.agent_id || "").trim();
          if (!agentId) return null;
          return {
            agent_id: agentId,
            display_name: String(entry.display_name || agentId).trim() || agentId,
            role_lane: String(entry.role_lane || entry.provider || agentId).trim(),
          };
        })
        .filter(Boolean);
    }
    var roster = state.snapshot && state.snapshot.roster && Array.isArray(state.snapshot.roster.agents) ? state.snapshot.roster.agents : [];
    var preferredIds = ["codex", "claude", "cursor", "gemini"];
    var byId = {};
    roster.forEach(function (entry) {
      if (!entry || typeof entry !== "object") return;
      var agentId = String(entry.agent_id || "").trim();
      if (!agentId || preferredIds.indexOf(agentId) === -1 || entry.enabled === false) return;
      byId[agentId] = {
        agent_id: agentId,
        display_name: String(entry.display_name || agentId).trim() || agentId,
        role_lane: String(entry.role_lane || entry.provider || agentId).trim(),
      };
    });
    return preferredIds
      .filter(function (agentId) { return !!byId[agentId]; })
      .map(function (agentId) { return byId[agentId]; });
  }

  function readIntakeDraft() {
    return {
      title: els.intakeTitle ? String(els.intakeTitle.value || "").trim() : "",
      objective: els.intakeObjective ? String(els.intakeObjective.value || "").trim() : "",
      risk: els.intakeRisk ? String(els.intakeRisk.value || "medium").trim() || "medium" : "medium",
      mode: els.intakeMode ? String(els.intakeMode.value || "").trim() : "",
      dryRun: els.intakeDryRun ? !!els.intakeDryRun.checked : false,
      trichatAgentIds: state.intakeTargetAgentIds.slice().filter(Boolean),
    };
  }

  function compilerCommandPreview(draft) {
    var parts = ["./scripts/autonomy_ide_ingress.sh"];
    if (draft.title) parts.push("--title " + shellQuote(draft.title));
    if (draft.risk) parts.push("--risk " + shellQuote(draft.risk));
    if (draft.mode) parts.push("--mode " + shellQuote(draft.mode));
    (draft.trichatAgentIds || []).forEach(function (agentId) {
      parts.push("--agent " + shellQuote(agentId));
    });
    if (draft.dryRun) parts.push("--dry-run");
    parts.push("-- " + shellQuote(draft.objective || "<bounded objective>"));
    return parts.join(" ");
  }

  function gateTone(ok, warn) {
    if (ok) return "good";
    if (warn) return "warn";
    return "bad";
  }

  function renderIntakeDesk() {
    var host = ensureIntakeConsole();
    if (!host) return;

    var draft = readIntakeDraft();
    if (els.intakeSubmit) {
      els.intakeSubmit.textContent = draft.dryRun ? "Preview dispatch" : "Dispatch objective";
    }

    if (!state.snapshot) {
      host.innerHTML =
        '<div class="intake-console__header">' +
        '<div class="intake-console__eyebrow">Objective Compiler</div>' +
        "<h3>Waiting for live workbench telemetry.</h3>" +
        "<p>Once the office snapshot lands, the intake desk will show blockers, suggested objectives, and a dispatch preview.</p>" +
        "</div>";
      return;
    }

    var workbench = getWorkbench() || {};
    var summary = state.snapshot.summary || {};
    var maintain = summary.maintain || {};
    var providers = summary.provider_bridge || {};
    var patientZero = summary.patient_zero || {};
    var blockers = Array.isArray(workbench.blockers) ? workbench.blockers.slice(0, 3) : [];
    var nextActions = Array.isArray(workbench.next_actions) ? workbench.next_actions.slice(0, 3) : [];
    var suggestions = Array.isArray(workbench.suggested_objectives) ? workbench.suggested_objectives.slice(0, 3) : [];
    var activeExecution = workbench.active_execution || {};
    var dispatchReady = !!draft.objective;
    var modeLabel = draft.mode || "auto";
    var riskLabel = draft.risk || "medium";
    var bridgeAgents = getBridgeIntakeAgents();
    state.intakeTargetAgentIds = state.intakeTargetAgentIds.filter(function (agentId) {
      return bridgeAgents.some(function (entry) { return entry.agent_id === agentId; });
    });
    draft.trichatAgentIds = state.intakeTargetAgentIds.slice();
    var focusArea = compactIntakeText(workbench.focus_area || "intake", 24);
    var statusLabel = compactIntakeText(workbench.status || (dispatchReady ? "ready" : "draft"), 24);
    var headline = compactIntakeText(
      workbench.headline || "Compile one bounded objective, review runtime gates, and dispatch through the MCP core.",
      180
    );
    var activeLabel =
      compactIntakeText(
        (activeExecution.step && activeExecution.step.title) ||
          (activeExecution.task && activeExecution.task.objective) ||
          (activeExecution.goal && activeExecution.goal.title) ||
          "",
        110
      ) || "No active execution summary from the workbench yet.";

    var gates = [
      {
        label: "Maintain",
        tone: gateTone(maintain.running === true, maintain.eval_due === false),
        detail: (maintain.running ? "loop active" : "loop idle") + " · eval_due " + (maintain.eval_due ? "yes" : "no"),
      },
      {
        label: "Providers",
        tone: gateTone((providers.disconnected_count || 0) === 0, (providers.connected_count || 0) > 0),
        detail:
          "connected " +
          String(providers.connected_count || 0) +
          " · disconnected " +
          String(providers.disconnected_count || 0),
      },
      {
        label: MASTER_MOLD_MODE_LABEL,
        tone: gateTone(patientZero.enabled !== true, patientZero.autonomous_control_enabled !== true),
        detail:
          masterMoldModeState(patientZero.enabled) +
          " · autonomy " +
          (patientZero.autonomous_control_enabled ? "enabled" : "bounded"),
      },
      {
        label: "Dispatch",
        tone: gateTone(dispatchReady, !!draft.title || !!draft.objective),
        detail:
          (draft.dryRun ? "dry run" : "live dispatch") +
          " · mode " +
          modeLabel +
          " · risk " +
          riskLabel +
          " · agents " +
          (draft.trichatAgentIds.length ? draft.trichatAgentIds.join(", ") : "auto"),
      },
    ];

    var blockersHtml = blockers.length
      ? '<div class="intake-console__section">' +
        '<div class="intake-console__label">Blockers</div>' +
        '<div class="intake-console__stack">' +
        blockers
          .map(function (entry) {
            var remediation = entry && entry.remediation ? entry.remediation : null;
            var payload = remediation && remediation.payload ? JSON.stringify(remediation.payload) : "";
            return (
              '<article class="intake-console__card">' +
              '<strong>' + escapeHtml(compactIntakeText(entry.title || "Runtime attention", 96)) + "</strong>" +
              '<p>' + escapeHtml(compactIntakeText(entry.detail || "", 180)) + "</p>" +
              (remediation && remediation.action
                ? '<button type="button" class="button intake-console__inline-action" data-workbench-action="' +
                  escapeHtml(remediation.action) +
                  '" data-workbench-payload="' +
                  escapeHtml(payload) +
                  '">' +
                  escapeHtml(remediation.label || "Run") +
                  "</button>"
                : "") +
              "</article>"
            );
          })
          .join("") +
        "</div>" +
        "</div>"
      : "";

    var nextActionsHtml = nextActions.length
      ? '<div class="intake-console__section">' +
        '<div class="intake-console__label">Next actions</div>' +
        '<ul class="intake-console__list">' +
        nextActions
          .map(function (entry) {
            return (
              "<li><strong>" +
              escapeHtml(compactIntakeText(entry.label || "Next", 72)) +
              "</strong><span>" +
              escapeHtml(compactIntakeText(entry.detail || "", 120)) +
              "</span></li>"
            );
          })
          .join("") +
        "</ul>" +
        "</div>"
      : "";

    var suggestionsHtml =
      '<div class="intake-console__section">' +
      '<div class="intake-console__label">Suggested objectives</div>' +
      '<div class="intake-console__stack">' +
      (suggestions.length
        ? suggestions
            .map(function (entry, index) {
              return (
                '<article class="intake-console__card intake-console__card--suggestion">' +
                '<strong>' + escapeHtml(compactIntakeText(entry.title || "Suggested objective", 90)) + "</strong>" +
                '<p>' + escapeHtml(compactIntakeText(entry.why || entry.objective || "", 180)) + "</p>" +
                '<div class="intake-console__meta">' +
                "<span>" + escapeHtml("risk " + (entry.risk || "medium")) + "</span>" +
                "<span>" + escapeHtml("mode " + (entry.mode || "auto")) + "</span>" +
                "</div>" +
                '<button type="button" class="button intake-console__inline-action" data-seed-objective-index="' +
                String(index) +
                '">Seed intake</button>' +
                "</article>"
              );
            })
            .join("")
        : '<article class="intake-console__card"><strong>No suggestions yet</strong><p>The workbench will surface compiler suggestions once the current queue and blockers are summarized.</p></article>') +
      "</div>" +
      "</div>";

    var targetsHtml =
      '<div class="intake-console__section">' +
      '<div class="intake-console__label">Bridge targets</div>' +
      '<div class="intake-console__agent-grid">' +
      (bridgeAgents.length
        ? bridgeAgents
            .map(function (entry) {
              var selected = draft.trichatAgentIds.indexOf(entry.agent_id) >= 0;
              return (
                '<button type="button" class="button intake-console__agent' +
                (selected ? " intake-console__agent--selected" : "") +
                '" data-intake-agent-id="' +
                escapeHtml(entry.agent_id) +
                '">' +
                '<strong>' + escapeHtml(entry.display_name) + "</strong>" +
                '<span>' + escapeHtml(entry.role_lane || entry.agent_id) + "</span>" +
                "</button>"
              );
            })
            .join("")
        : '<article class="intake-console__card"><strong>No bridge agents surfaced</strong><p>The roster has not exposed Claude/Codex bridge targets in this snapshot yet.</p></article>') +
      "</div>" +
      '<div class="intake-console__meta">' +
      "<span>" +
      escapeHtml(draft.trichatAgentIds.length ? ("explicit routing: " + draft.trichatAgentIds.join(", ")) : "routing: auto") +
      "</span>" +
      (draft.trichatAgentIds.length
        ? '<button type="button" class="button intake-console__inline-action" data-intake-agent-clear="true">Clear explicit targets</button>'
        : "") +
      "</div>" +
      "</div>";

    host.innerHTML =
      '<div class="intake-console__header">' +
      '<div class="intake-console__eyebrow">Objective Compiler</div>' +
      "<h3>" + escapeHtml(headline) + "</h3>" +
      "<p>Focus " + escapeHtml(focusArea) + " · status " + escapeHtml(statusLabel) + " · active lane " + escapeHtml(activeLabel) + "</p>" +
      "</div>" +
      '<div class="intake-console__gates">' +
      gates
        .map(function (entry) {
          return (
            '<div class="intake-console__gate intake-console__gate--' +
            entry.tone +
            '">' +
            "<strong>" +
            escapeHtml(entry.label) +
            "</strong>" +
            "<span>" +
            escapeHtml(entry.detail) +
            "</span>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      blockersHtml +
      nextActionsHtml +
      targetsHtml +
      suggestionsHtml +
      '<div class="intake-console__section">' +
      '<div class="intake-console__label">Dispatch preview</div>' +
      '<article class="intake-console__card intake-console__card--preview">' +
      '<strong>' +
      escapeHtml(dispatchReady ? (draft.dryRun ? "Dry-run preview ready" : "Dispatch summary ready") : "Seed or write a bounded objective") +
      "</strong>" +
      "<p>" +
      escapeHtml(
        dispatchReady
          ? compactIntakeText(draft.objective, 220)
          : "Use a suggested objective or write one bounded slice of work with a clear definition of done."
      ) +
      "</p>" +
      '<pre class="intake-console__preview">' +
      escapeHtml(compilerCommandPreview(draft)) +
      "</pre>" +
      "</article>" +
      "</div>";
  }

  function renderStatusStrip() {
    renderIntakeDesk();
    if (!state.snapshot) {
      els.statusStrip.innerHTML = '<div class="chip"><strong>Loading</strong><span>Waiting for office telemetry.</span></div>';
      return;
    }
    var summary = state.snapshot.summary || {};
    var kernel = summary.kernel || {};
    var tasks = summary.tasks || {};
    var taskReasoning = tasks.reasoning_policy || {};
    var host = summary.local_host || {};
    var router = summary.router || {};
    var liveBackend = router.live_backend || {};
    var runtimeWorkers = summary.runtime_workers || {};
    var maintain = summary.maintain || {};
    var autopilot = summary.autopilot || {};
    var providers = summary.provider_bridge || {};
    var recentRouterSuppressionDecisions = Array.isArray(state.snapshot.router_suppression_decisions)
      ? state.snapshot.router_suppression_decisions.slice(0, 1)
      : [];
    var latestRouterSuppression = providers.latest_router_suppression || recentRouterSuppressionDecisions[0] || null;
    var providerResourceGate = providers.resource_gate || {};
    var providerResourceGateActive = !!providerResourceGate.active;
    var providerResourceGateLevel = providerResourceGateActive
      ? String(providerResourceGate.severity || "moderate").toLowerCase() === "high"
        ? "critical"
        : "elevated"
      : "normal";
    var providerResourceGateDetail = providerResourceGateActive
      ? compactIntakeText(providerResourceGate.detail || providerResourceGate.reason || "bridges shed", 84)
      : "bridges available";
    var desktop = summary.desktop_control || {};
    var patientZero = summary.patient_zero || {};
    var privilegedAccess = summary.privileged_access || {};
    var officeAction = activeOfficeActionState();
    var detailAgeLabel = relativeTime(state.snapshot.fetched_at_iso);
    var liveAgeLabel = state.realtime && state.realtime.sampled_at ? relativeTime(state.realtime.sampled_at) : "n/a";
    var bridgeGeneratedAt = latestProviderBridgeGeneratedAt(state.snapshot);
    var bridgeAgeLabel = bridgeGeneratedAt ? relativeTime(bridgeGeneratedAt) : "n/a";
    var liveSource = state.realtime ? String(state.realtime.source || "live").trim() || "live" : "pending";
    var detailSource = state.snapshotMeta && state.snapshotMeta.snapshotSource
      ? String(state.snapshotMeta.snapshotSource)
      : "direct-node";
    var liveAge = state.realtime && state.realtime.sampled_at ? ageSeconds(state.realtime.sampled_at) : null;
    var bridgeAge = bridgeGeneratedAt ? ageSeconds(bridgeGeneratedAt) : null;
    var freshnessTone = liveSource.indexOf("cache") === 0
      ? "warn"
      : liveAge == null
        ? "bad"
        : liveAge <= 3 && (bridgeAge == null || bridgeAge <= 5)
          ? "good"
          : liveAge <= 10
            ? "warn"
            : "bad";
    var chips = [];
    if (state.snapshot.errors && state.snapshot.errors.length) {
      chips.push(["Snapshot", String(state.snapshot.errors.length) + " partial errors"]);
    }
    chips.push(
      [
        "Freshness",
        "detail " + detailAgeLabel + " | live " + liveAgeLabel + " | bridge " + bridgeAgeLabel,
        freshnessTone
      ],
      [
        "Live Lane",
        humanizeSource(liveSource) + " | detail " + humanizeSource(detailSource),
        liveSource === "live" || liveSource === "live-cache" ? "good" : "warn"
      ],
      ["Kernel", String(kernel.state || "n/a") + " | healthy " + String(kernel.healthy || 0) + " | degraded " + String(kernel.degraded || 0)],
      ["Tasks", "run " + String(tasks.running || 0) + " | queue " + String(tasks.pending || 0) + " | fail " + String(tasks.failed || 0)],
      [
        "Reasoning",
        "active " + String(taskReasoning.active_count || 0) +
          " | review " + String(taskReasoning.completion_review_needs_count || 0) +
          " | branch " + String(taskReasoning.branch_search_count || 0) +
          " | budget " + String(taskReasoning.budget_forcing_count || 0) +
          " | maxN " + String(taskReasoning.max_candidate_count || 0),
        (taskReasoning.completion_review_needs_count || 0) > 0
          ? "bad"
          : (taskReasoning.active_count || 0) > 0
            ? "warn"
            : "good"
      ],
      ["Host", "cpu " + Math.round((host.cpu_utilization || 0) * 100) + "% | ram " + fmt(host.ram_available_gb) + " / " + fmt(host.ram_total_gb) + " GB | swap " + fmt(host.swap_used_gb) + " GB"],
      ["Router", String(router.default_backend_id || "n/a") + " | " + (liveBackend.probe_model_loaded ? "warm" : "cold") + " | " + fmt(liveBackend.latency_ms_p50, 0) + " ms"],
      ["Autopilot", (autopilot.running ? "running" : "idle") + " | exec " + (autopilot.execute_enabled ? "armed" : "advisory") + " | " + String(autopilot.last_execution_mode || "none")],
      ["Workers", "active " + String(runtimeWorkers.active_count || 0) + " | sessions " + String(runtimeWorkers.session_count || 0)],
      [
        "Office Action",
        officeAction
          ? String(officeAction.action || "action") +
            " | running | " +
            (officeAction.startedAt ? relativeTime(officeAction.startedAt) + " ago" : "n/a")
          : "idle"
      ],
      ["Maintain", (maintain.running ? "running" : "idle") + " | eval_due " + (maintain.eval_due ? "yes" : "no")],
      ["Providers", "connected " + String(providers.connected_count || 0) + " | disconnected " + String(providers.disconnected_count || 0)],
      [
        "Router Hold",
        latestRouterSuppression
          ? String(latestRouterSuppression.reason || "suppressed").replace(/_/g, " ") +
            " | " +
            String(latestRouterSuppression.selected_backend_id || "n/a") +
            " | " +
            (latestRouterSuppression.observed_at ? relativeTime(latestRouterSuppression.observed_at) + " ago" : "n/a")
          : "none recent"
      ],
      ["Bridge Gate", providerResourceGateLevel + " | " + providerResourceGateDetail],
      ["Desktop", (desktop.enabled ? "enabled" : "disabled") + " | eyes " + (desktop.observe_ready ? "yes" : "no") + " | hands " + (desktop.act_ready ? "yes" : "no") + " | ears " + (desktop.listen_ready ? "yes" : "no")],
      [
        MASTER_MOLD_MODE_LABEL,
        masterMoldModeState(patientZero.enabled) +
          " | autonomy " + (patientZero.autonomous_control_enabled ? "yes" : "no") +
          " | browser " + (patientZero.browser_ready ? "yes" : "no") +
          " | root " + (patientZero.root_shell_enabled ? "yes" : "manual")
      ],
      [
        "Root Lane",
        (privilegedAccess.root_execution_ready ? "ready" : "not-ready") +
          " | account " + String(privilegedAccess.account || "mcagent") +
          " | secret " + (privilegedAccess.secret_present ? "yes" : "no") +
          " | verified " + (privilegedAccess.credential_verified ? "yes" : "no")
      ]
    );
    els.statusStrip.innerHTML = chips
      .map(function (entry) {
        return '<div class="chip' + chipToneClass(entry[2]) + '"><strong>' + escapeHtml(entry[0]) + "</strong><span>" + escapeHtml(entry[1]) + "</span></div>";
      })
      .join("");
  }

  function renderOfficeView() {
    if (!state.snapshot) {
      els.officeView.innerHTML =
        '<section class="office-empty"><div class="section-title">Connecting</div><p>Fetching live office telemetry from the MCP control plane.</p></section>';
      return;
    }
    var rooms = state.snapshot.rooms || {};
    var titleMap = {
      command: "Command Deck",
      lounge: "Lounge + Water",
      build: "Build Bay",
      ops: "Ops Rack",
    };
    var roomKeys = ["command", "lounge", "build", "ops"];
    var errors = (state.snapshot.errors || []).slice(0, 3);
    var alertHtml = "";
    if (errors.length) {
      alertHtml =
        '<section class="office-alert"><div class="section-title">Partial Snapshot</div><ul>' +
        errors.map(function (entry) { return "<li>" + escapeHtml(entry) + "</li>"; }).join("") +
        "</ul></section>";
    }
    var grid = roomKeys
      .map(function (roomKey) {
        var agentIds = Array.isArray(rooms[roomKey]) ? rooms[roomKey] : [];
        var roomAgents = agentIds.map(findAgent).filter(Boolean);
        return (
          '<section class="room room--' + escapeHtml(roomKey) + '">' +
          '<div class="room__header"><div class="room__title">' + escapeHtml(titleMap[roomKey]) + '</div><div class="room__meta">' + roomAgents.length + ' agents</div></div>' +
          '<div class="room__agents">' +
          roomAgents.map(function (entry) {
            var agent = entry.agent || {};
            var tags = (entry.actions || []).map(function (tag) {
              var cls = "";
              if (tag === "blocked" || tag === "offline") cls = " tag--block";
              else if (tag === "coffee" || tag === "chat") cls = " tag--talk";
              else if (tag === "desk" || tag === "code" || tag === "brief") cls = " tag--work";
              return '<span class="tag' + cls + '">' + escapeHtml(tag) + "</span>";
            }).join("");
            return (
              '<article class="agent-tile ' + (agent.agent_id === state.selectedAgentId ? "is-selected" : "") + '" data-agent-id="' + escapeHtml(agent.agent_id || "") + '">' +
              '<div class="agent-tile__top"><div><div class="agent-tile__name">' + escapeHtml(agent.display_name || agent.agent_id || "Agent") + '</div><div class="agent-tile__state">' + escapeHtml(String(entry.state || "idle").toUpperCase()) + " · " + escapeHtml(agent.tier || "agent") + '</div></div><div class="agent-tile__state">' + escapeHtml(agent.token || "") + "</div></div>" +
              '<div class="sprite">' + spriteSvg(entry) + "</div>" +
              '<div class="agent-tile__tags">' + tags + "</div>" +
              "</article>"
            );
          }).join("") +
          "</div></section>"
        );
      })
      .join("");
    els.officeView.innerHTML = alertHtml + '<div class="office-grid">' + grid + "</div>";
    Array.prototype.slice.call(els.officeView.querySelectorAll("[data-agent-id]")).forEach(function (node) {
      node.addEventListener("click", function () {
        state.selectedAgentId = node.getAttribute("data-agent-id") || "";
        renderAll();
      });
    });
  }

  function renderBriefingView() {
    if (!state.snapshot) {
      els.briefingView.innerHTML = "";
      return;
    }
    var current = state.snapshot.current || {};
    var summary = state.snapshot.summary || {};
    var tmux = summary.tmux || {};
    var runtimeWorkers = summary.runtime_workers || {};
    var reactionEngine = summary.reaction_engine || {};
    var maintain = summary.maintain || {};
    var autopilot = summary.autopilot || {};
    var swarm = summary.swarm || {};
    var workflowExports = summary.workflow_exports || {};
    var providers = summary.provider_bridge || {};
    var desktop = summary.desktop_control || {};
    var confidence = current.confidence_method || {};
    var checks = confidence.checks || {};
    els.briefingView.innerHTML =
      '<div class="briefing-grid">' +
      '<section class="brief-card"><div class="section-title">Current Objective</div><pre>' + escapeHtml(current.current_objective || "No active objective.") + '</pre><div class="metric-list">' +
      '<div class="metric"><span>Spawn path</span><strong>' + escapeHtml(current.spawn_path || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Selected agent</span><strong>' + escapeHtml(current.selected_agent || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Execution mode</span><strong>' + escapeHtml(current.execution_mode || "none") + '</strong></div>' +
      '<div class="metric"><span>Council</span><strong>' + escapeHtml(((current.council_agent_ids || []).join(", ")) || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Execution tasks</span><strong>' + escapeHtml(((current.execution_task_ids || []).join(", ")) || "n/a") + "</strong></div>" +
      "</div></section>" +
      '<section class="brief-card"><div class="section-title">Confidence</div><div class="metric-list">' +
      '<div class="metric"><span>Mode</span><strong>' + escapeHtml(confidence.mode || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Score</span><strong>' + fmt(confidence.score, 2) + '</strong></div>' +
      '<div class="metric"><span>Owner clarity</span><strong>' + fmt(checks.owner_clarity, 2) + '</strong></div>' +
      '<div class="metric"><span>Actionability</span><strong>' + fmt(checks.actionability, 2) + '</strong></div>' +
      '<div class="metric"><span>Evidence bar</span><strong>' + fmt(checks.evidence_bar, 2) + '</strong></div>' +
      '<div class="metric"><span>Rollback ready</span><strong>' + fmt(checks.rollback_ready, 2) + '</strong></div>' +
      '<div class="metric"><span>Anti-echo</span><strong>' + fmt(checks.anti_echo, 2) + "</strong></div>" +
      "</div></section>" +
      '<section class="brief-card"><div class="section-title">Infrastructure</div><div class="metric-list">' +
      '<div class="metric"><span>Autopilot</span><strong class="' + statusClass(autopilot.running) + '">' + (autopilot.running ? "running" : "idle") + '</strong></div>' +
      '<div class="metric"><span>Execution posture</span><strong>' + (autopilot.execute_enabled ? "armed" : "advisory only") + '</strong></div>' +
      '<div class="metric"><span>Council</span><strong>' + String(autopilot.council_agent_count || 0) + " agents</strong></div>" +
      '<div class="metric"><span>Last execution</span><strong>' + escapeHtml(autopilot.last_execution_mode || "none") + '</strong></div>' +
      '<div class="metric"><span>tmux queue</span><strong>' + String(tmux.queue_depth || 0) + '</strong></div>' +
      '<div class="metric"><span>Runtime workers</span><strong>' + String(runtimeWorkers.active_count || 0) + " active / " + String(runtimeWorkers.session_count || 0) + ' total</strong></div>' +
      '<div class="metric"><span>Reaction engine</span><strong class="' + statusClass(reactionEngine.runtime_running) + '">' + (reactionEngine.runtime_running ? "running" : "down") + '</strong></div>' +
      '<div class="metric"><span>Maintain loop</span><strong class="' + statusClass(maintain.running) + '">' + (maintain.running ? "running" : "idle") + '</strong></div>' +
      '<div class="metric"><span>Maintain self-drive</span><strong>' + (maintain.self_drive_enabled ? (maintain.self_drive_last_run_at ? ("last " + relativeTime(maintain.self_drive_last_run_at)) : "armed") : "off") + '</strong></div>' +
      '<div class="metric"><span>Providers</span><strong>' + String(providers.connected_count || 0) + " connected / " + String((providers.connected_count || 0) + (providers.configured_count || 0) + (providers.disconnected_count || 0) + (providers.unavailable_count || 0)) + ' total</strong></div>' +
      '<div class="metric"><span>Desktop</span><strong>' + escapeHtml((desktop.enabled ? "enabled" : "disabled") + " · " + (desktop.observe_ready ? "eyes" : "no-eyes") + " / " + (desktop.act_ready ? "hands" : "no-hands") + " / " + (desktop.listen_ready ? "ears" : "no-ears")) + '</strong></div>' +
      '<div class="metric"><span>' + escapeHtml(MASTER_MOLD_MODE_LABEL + " control") + '</span><strong>' + escapeHtml((summary.patient_zero && summary.patient_zero.full_control_authority) ? "full authority" : ((summary.patient_zero && summary.patient_zero.autonomous_control_enabled) ? "autonomy enabled" : "bounded")) + '</strong></div>' +
      '<div class="metric"><span>Swarm profiles</span><strong>' + String(swarm.active_profile_count || 0) + '</strong></div>' +
      '<div class="metric"><span>Workflow exports</span><strong>' + String(workflowExports.bundle_count || 0) + "</strong></div>" +
      "</div></section>" +
      '<section class="brief-card"><div class="section-title">Decision Summary</div><pre>' + escapeHtml(current.decision_summary || "No decision summary recorded.") + '</pre><div class="section-title">Selected Strategy</div><pre>' + escapeHtml(current.selected_strategy || "No selected strategy recorded.") + "</pre></section>" +
      "</div>";
  }

  function seedIntakeFromWorkbench(index) {
    if (!state.snapshot || !state.snapshot.workbench || !Array.isArray(state.snapshot.workbench.suggested_objectives)) {
      return;
    }
    var suggestion = state.snapshot.workbench.suggested_objectives[index];
    if (!suggestion) {
      return;
    }
    var titleNode = document.querySelector("#intake-title");
    var objectiveNode = document.querySelector("#intake-objective");
    var riskNode = document.querySelector("#intake-risk");
    var modeNode = document.querySelector("#intake-mode");
    if (titleNode) titleNode.value = String(suggestion.title || "");
    if (objectiveNode) objectiveNode.value = String(suggestion.objective || "");
    if (riskNode && suggestion.risk) riskNode.value = suggestion.risk;
    if (modeNode) {
      modeNode.value = suggestion.mode || "";
      state.intakeModeDirty = String(modeNode.value || "").trim().length > 0;
    }
    setResultText("Seeded intake from workbench suggestion.");
  }

  function triggerWorkbenchAction(action, payload) {
    return postAction(action, payload || {});
  }

  function dispatchWorkbenchSuggestion(index) {
    if (!state.snapshot || !state.snapshot.workbench || !Array.isArray(state.snapshot.workbench.suggested_objectives)) {
      return Promise.resolve();
    }
    var suggestion = state.snapshot.workbench.suggested_objectives[index];
    if (!suggestion) {
      return Promise.resolve();
    }
    return getJson("/office/api/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: suggestion.title || "",
        objective: suggestion.objective || "",
        risk: suggestion.risk || "medium",
        mode: suggestion.mode || "",
        trichat_agent_ids: state.intakeTargetAgentIds.slice(),
        thread_id: state.snapshot.thread_id || "",
        tags: ["workbench"],
      }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      rememberOfficeActionResult("intake", result);
      waitForActionToSettle("intake", 1500);
      return result;
    });
  }

  function triggerBlockerRemediation(index) {
    if (!state.snapshot || !state.snapshot.workbench || !Array.isArray(state.snapshot.workbench.blockers)) {
      return Promise.resolve();
    }
    var blocker = state.snapshot.workbench.blockers[index];
    var remediation = blocker && blocker.remediation ? blocker.remediation : null;
    if (!remediation || !remediation.action) {
      return Promise.resolve();
    }
    return triggerWorkbenchAction(remediation.action, remediation.payload || {});
  }

  function renderWorkbenchView() {
    if (!state.snapshot) {
      els.workbenchView.innerHTML = "";
      return;
    }
    var workbench = state.snapshot.workbench || {};
    var activeExecution = workbench.active_execution || {};
    var goal = activeExecution.goal || {};
    var plan = activeExecution.plan || {};
    var step = activeExecution.step || {};
    var task = activeExecution.task || {};
    var queue = workbench.queue || {};
    var queueReasoning = queue.reasoning_policy || {};
    var reasoningReview = queueReasoning.completion_review || {};
    var reasoningReviewCount = Number(reasoningReview.needs_review_count || 0);
    var reasoningReviewFields = reasoningReview.missing_field_counts || {};
    var reasoningReviewFieldLabels = Object.keys(reasoningReviewFields)
      .map(function (key) {
        return key + ":" + String(reasoningReviewFields[key] || 0);
      })
      .slice(0, 4);
    var blockers = Array.isArray(workbench.blockers) ? workbench.blockers : [];
    var nextActions = Array.isArray(workbench.next_actions) ? workbench.next_actions : [];
    var suggestions = Array.isArray(workbench.suggested_objectives) ? workbench.suggested_objectives : [];
    var summary = (state.snapshot.summary && state.snapshot.summary.workbench) || {};
    var statusClassName =
      summary.status === "attention"
        ? "workbench-status--attention"
        : summary.status === "active"
          ? "workbench-status--active"
          : "workbench-status--ready";
    var runningTasks = Array.isArray(queue.running_tasks) ? queue.running_tasks : [];
    var pendingTasks = Array.isArray(queue.pending_tasks) ? queue.pending_tasks : [];
    var failedTasks = Array.isArray(queue.failed_tasks) ? queue.failed_tasks : [];
    var quickActions = workbench.quick_actions || {};
    var controlPlane = state.snapshot.summary || {};
    var maintain = controlPlane.maintain || {};
    var runtimeWorkers = controlPlane.runtime_workers || {};
    var reactionEngine = controlPlane.reaction_engine || {};
    var autopilot = controlPlane.autopilot || {};
    var providers = controlPlane.provider_bridge || {};
    var providerResourceGate = providers.resource_gate || {};
    var providerResourceGateActive = !!providerResourceGate.active;
    var providerResourceGateSeverity = String(providerResourceGate.severity || "none").toLowerCase();
    var providerResourceGateTone = !providerResourceGateActive ? "good" : providerResourceGateSeverity === "high" ? "bad" : "warn";
    var providerResourceGateValue = !providerResourceGateActive
      ? "normal"
      : providerResourceGateSeverity === "high"
        ? "critical"
        : "elevated";
    var providerResourceGateActions = [];
    if (providerResourceGate.recommendations && providerResourceGate.recommendations.suppress_outbound_bridges) {
      providerResourceGateActions.push("bridges shed");
    }
    if (providerResourceGate.recommendations && providerResourceGate.recommendations.pause_visible_sidecars) {
      providerResourceGateActions.push("sidecars paused");
    }
    var providerResourceGateDetail = providerResourceGateActive
      ? compactIntakeText(
          (providerResourceGate.detail || providerResourceGate.reason || "local pressure detected") +
            (providerResourceGateActions.length ? " · " + providerResourceGateActions.join(" · ") : ""),
          110
        )
      : "bridges open · sidecars live";
    var desktop = controlPlane.desktop_control || {};
    var patientZero = controlPlane.patient_zero || {};
    var privilegedAccess = controlPlane.privileged_access || {};
    var firstBlocker = blockers[0] || null;
    var firstSuggestion = suggestions[0] || null;
    var secondSuggestion = suggestions[1] || null;
    var firstPending = pendingTasks[0] || null;
    var firstRunning = runningTasks[0] || null;
    var schedulerReasons = [];
    var queuePressure = [];
    var schedulerNow = {
      title: "Open a bounded objective",
      detail: "The queue is clear enough to compile one concrete, reviewable slice of work.",
      actionHtml: suggestions.length
        ? '<button class="button button--primary" data-intake-seed="0">Seed intake</button>'
        : "",
    };
    var schedulerNext = {
      title: "Use the intake desk",
      detail: "Turn a bounded idea into a dispatchable objective with explicit risk and execution mode.",
      actionHtml: suggestions.length
        ? '<button class="button" data-intake-seed="0">Seed intake</button>'
        : "",
    };
    var whyNotNow = blockers.length
      ? blockers.map(function (entry) {
          return {
            title: entry.title || entry.kind || "Blocker",
            detail: entry.detail || "",
          };
        })
      : [
          {
            title: "No hard blockers",
            detail: "The runtime is clear enough to move the next owned slice without a recovery pass first.",
          },
        ];
    var controlPlaneItems = [
      {
        label: "Maintain",
        value: maintain.running ? "running" : "idle",
        tone: maintain.running ? "good" : "warn",
        detail: maintain.eval_due ? "eval due" : "eval current",
      },
      {
        label: "Reaction",
        value: reactionEngine.runtime_running ? "running" : "down",
        tone: reactionEngine.runtime_running ? "good" : "bad",
        detail: "runtime engine",
      },
      {
        label: "Workers",
        value: String(runtimeWorkers.active_count || 0) + " active",
        tone: (runtimeWorkers.active_count || 0) > 0 ? "good" : "warn",
        detail: String(runtimeWorkers.session_count || 0) + " sessions",
      },
      {
        label: "Reasoning",
        value: reasoningReviewCount ? String(reasoningReviewCount) + " review" : String(queueReasoning.active_count || 0) + " active",
        tone: reasoningReviewCount ? "bad" : (queueReasoning.active_count || 0) > 0 ? "warn" : "good",
        detail: reasoningReviewCount
          ? compactIntakeText(reasoningReviewFieldLabels.join(" · ") || "completion evidence missing", 84)
          : "branch " + String(queueReasoning.branch_search_count || 0) +
            " · budget " + String(queueReasoning.budget_forcing_count || 0),
      },
      {
        label: "Providers",
        value: String(providers.connected_count || 0) + " connected",
        tone: (providers.disconnected_count || 0) > 0 ? "warn" : "good",
        detail: String(providers.disconnected_count || 0) + " disconnected",
      },
      {
        label: "Bridge Gate",
        value: providerResourceGateValue,
        tone: providerResourceGateTone,
        detail: providerResourceGateDetail,
      },
      {
        label: "Desktop",
        value: desktop.enabled ? "enabled" : "disabled",
        tone: desktop.enabled && desktop.observe_ready && desktop.act_ready ? "good" : desktop.enabled ? "warn" : "bad",
        detail: (desktop.observe_ready ? "eyes" : "no-eyes") + " / " + (desktop.act_ready ? "hands" : "no-hands"),
      },
      {
        label: MASTER_MOLD_MODE_LABEL,
        value: masterMoldModeState(patientZero.enabled),
        tone: patientZero.enabled && privilegedAccess.root_execution_ready ? "good" : patientZero.enabled ? "warn" : "neutral",
        detail: privilegedAccess.root_execution_ready ? "root lane ready" : "root lane manual",
      },
      {
        label: "Autopilot",
        value: autopilot.running ? "running" : "idle",
        tone: autopilot.execute_enabled ? "good" : "warn",
        detail: autopilot.execute_enabled ? "execution armed" : "advisory only",
      },
    ];
    if (blockers.length) {
      schedulerNow = {
        title: firstBlocker.title || firstBlocker.kind || "Clear blockers",
        detail: firstBlocker.detail || "The runtime needs recovery before it should take on more work.",
        actionHtml:
          firstBlocker.remediation && firstBlocker.remediation.action
            ? '<button class="button button--primary" data-blocker-index="0">' + escapeHtml(firstBlocker.remediation.label || "Remediate") + "</button>"
            : "",
      };
      schedulerReasons.push("Blockers outrank new work because the runtime is already carrying unresolved risk.");
      if (failedTasks.length) {
        schedulerReasons.push("Failed tasks are consuming execution budget; recover them before opening new surface area.");
      }
      schedulerReasons.push("The office should restore control-plane confidence before dispatching fresh work.");
      if (activeExecution.current_objective) {
        schedulerNext = {
          title: "Resume the active lane",
          detail: activeExecution.current_objective,
          actionHtml: firstSuggestion
            ? '<button class="button" data-dispatch-suggestion="0">Dispatch recovery follow-up</button>'
            : "",
        };
      } else if (firstPending) {
        schedulerNext = {
          title: "Turn pending queue into owned execution",
          detail: firstPending.objective || firstPending.task_id || "Use the front of the pending queue as the next bounded slice.",
          actionHtml: firstSuggestion
            ? '<button class="button" data-dispatch-suggestion="0">Dispatch queued slice</button>'
            : "",
        };
      }
    } else if (activeExecution.current_objective && (runningTasks.length > 0 || String(step.status || "").toLowerCase() === "running")) {
      schedulerNow = {
        title: activeExecution.current_objective,
        detail: "Advance the owned execution lane before opening a parallel thread.",
        actionHtml: firstSuggestion
          ? '<button class="button button--primary" data-dispatch-suggestion="0">Dispatch next slice</button>'
          : "",
      };
      schedulerReasons.push("An active lane already exists, so forward progress beats opening parallel scope.");
      if (firstRunning) {
        schedulerReasons.push("The runtime is already executing " + (firstRunning.objective || firstRunning.task_id || "a running task") + ".");
      }
      if (firstPending) {
        schedulerNext = {
          title: "Drain the front of the queue",
          detail: firstPending.objective || firstPending.task_id || "Convert the next queued item into owned execution once the active lane moves.",
          actionHtml: secondSuggestion
            ? '<button class="button" data-dispatch-suggestion="1">Queue the follow-on slice</button>'
            : firstSuggestion
              ? '<button class="button" data-intake-seed="0">Seed intake from suggestion</button>'
              : "",
        };
      } else if (firstSuggestion) {
        schedulerNext = {
          title: firstSuggestion.title || "Open the next bounded slice",
          detail: firstSuggestion.why || firstSuggestion.objective || "",
          actionHtml: '<button class="button" data-intake-seed="0">Seed intake</button>',
        };
      }
    } else if (firstPending) {
      schedulerNow = {
        title: "Own the front of the pending queue",
        detail: firstPending.objective || firstPending.task_id || "Clarify and dispatch the next queued item instead of inventing new work.",
        actionHtml: firstSuggestion
          ? '<button class="button button--primary" data-dispatch-suggestion="0">Dispatch queued slice</button>'
          : "",
      };
      schedulerReasons.push("Pending work already exists, so the scheduler should convert it into owned execution before expanding scope.");
      schedulerReasons.push("Queue discipline is the highest-leverage move when the runtime is stable but backlog exists.");
      schedulerNext = {
        title: firstSuggestion ? (firstSuggestion.title || "Seed intake from the queue") : "Open a bounded objective",
        detail: firstSuggestion ? (firstSuggestion.why || firstSuggestion.objective || "") : "Once the pending queue is owned, open the next bounded objective.",
        actionHtml: firstSuggestion
          ? '<button class="button" data-intake-seed="0">Seed intake</button>'
          : "",
      };
    } else if (firstSuggestion) {
      schedulerNow = {
        title: firstSuggestion.title || "Open the next bounded objective",
        detail: firstSuggestion.why || firstSuggestion.objective || "The runtime is clear enough to dispatch a fresh bounded slice.",
        actionHtml: '<button class="button button--primary" data-dispatch-suggestion="0">Dispatch suggested slice</button>',
      };
      schedulerReasons.push("No blockers or queue pressure are visible, so the scheduler can safely open fresh bounded work.");
      schedulerNext = {
        title: "Stage the follow-on objective",
        detail: secondSuggestion ? (secondSuggestion.title || secondSuggestion.objective || "") : "Keep the intake desk warm with the next suggestion once the first slice is dispatched.",
        actionHtml: secondSuggestion
          ? '<button class="button" data-intake-seed="1">Seed second suggestion</button>'
          : '<button class="button" data-intake-seed="0">Seed intake</button>',
      };
    }
    if (!schedulerReasons.length) {
      schedulerReasons.push("The scheduler defaults to the smallest reviewable slice that improves control-plane confidence or execution flow.");
    }
    if (failedTasks.length) {
      queuePressure.push({
        title: failedTasks.length + " failed",
        detail: "Recovery work is already queued.",
      });
    }
    if (reasoningReviewCount) {
      queuePressure.push({
        title: reasoningReviewCount + " reasoning review",
        detail: reasoningReviewFieldLabels.length
          ? "Completed work is missing " + reasoningReviewFieldLabels.join(", ") + "."
          : "Completed work needs reasoning-policy evidence review.",
      });
    }
    if (pendingTasks.length) {
      queuePressure.push({
        title: pendingTasks.length + " pending",
        detail: "Tasks are waiting for ownership or execution.",
      });
    }
    if (runningTasks.length) {
      queuePressure.push({
        title: runningTasks.length + " running",
        detail: "The active lane is already consuming execution capacity.",
      });
    }
    if (!queuePressure.length) {
      queuePressure.push({
        title: "Queue is clear",
        detail: "There is room to open one bounded objective without adding backlog debt.",
      });
    }
    els.workbenchView.innerHTML =
      '<div class="workbench-grid">' +
      '<section class="workbench-hero">' +
      '<div><div class="section-title">Scheduler / Control Plane</div><h2>' + escapeHtml(workbench.headline || "No workbench headline available.") + '</h2><p>This view explains what should run next, what is being held back, and why the control plane picked that order.</p></div>' +
      '<div class="workbench-hero__meta">' +
      '<div class="workbench-status ' + statusClassName + '">' + escapeHtml(String(workbench.status || "ready").toUpperCase()) + '</div>' +
      '<div class="metric"><span>Focus</span><strong>' + escapeHtml(workbench.focus_area || "intake") + '</strong></div>' +
      '<div class="metric"><span>Bridge Gate</span><strong>' + escapeHtml(providerResourceGateValue) + '</strong></div>' +
      '<div class="metric"><span>Blockers</span><strong>' + String(blockers.length) + '</strong></div>' +
      '<div class="metric"><span>Suggestions</span><strong>' + String(suggestions.length) + "</strong></div>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card workbench-card--wide">' +
      '<div class="section-title">What Runs Next and Why</div>' +
      '<div class="workbench-scheduler">' +
      '<article class="workbench-scheduler__lane">' +
      '<span class="workbench-scheduler__eyebrow">Next up</span>' +
      '<strong>' + escapeHtml(schedulerNow.title) + '</strong>' +
      '<p>' + escapeHtml(schedulerNow.detail) + '</p>' +
      '<div class="workbench-scheduler__actions">' + schedulerNow.actionHtml + "</div>" +
      "</article>" +
      '<article class="workbench-scheduler__lane">' +
      '<span class="workbench-scheduler__eyebrow">Runs after</span>' +
      '<strong>' + escapeHtml(schedulerNext.title) + '</strong>' +
      '<p>' + escapeHtml(schedulerNext.detail) + '</p>' +
      '<div class="workbench-scheduler__actions">' + schedulerNext.actionHtml + "</div>" +
      "</article>" +
      '<article class="workbench-scheduler__lane">' +
      '<span class="workbench-scheduler__eyebrow">Control-plane health</span>' +
      '<div class="workbench-health-grid">' +
      controlPlaneItems.map(function (entry) {
        return '<article class="workbench-health workbench-health--' + escapeHtml(entry.tone || "neutral") + '"><span>' + escapeHtml(entry.label || "Signal") + '</span><strong>' + escapeHtml(entry.value || "n/a") + '</strong><small>' + escapeHtml(entry.detail || "") + "</small></article>";
      }).join("") +
      "</div>" +
      "</article>" +
      "</div>" +
      '<div class="workbench-scheduler__footer">' +
      '<div class="workbench-scheduler__stack">' +
      '<span class="workbench-scheduler__eyebrow">Why not now</span>' +
      whyNotNow.map(function (entry) {
        return '<article class="workbench-scheduler__item"><strong>' + escapeHtml(entry.title || "Gate") + '</strong><span>' + escapeHtml(entry.detail || "") + "</span></article>";
      }).join("") +
      "</div>" +
      '<div class="workbench-scheduler__stack">' +
      '<span class="workbench-scheduler__eyebrow">Queue pressure</span>' +
      queuePressure.map(function (entry) {
        return '<article class="workbench-scheduler__item"><strong>' + escapeHtml(entry.title || "Queue") + '</strong><span>' + escapeHtml(entry.detail || "") + "</span></article>";
      }).join("") +
      "</div>" +
      '<div class="workbench-actions">' +
      '<button class="button" data-workbench-action="recover_expired_tasks"' + (quickActions.recover_expired_tasks ? "" : " disabled") + '>Recover Expired Tasks</button>' +
      '<button class="button" data-workbench-action="retry_failed_tasks"' + (quickActions.retry_failed_tasks ? "" : " disabled") + '>Retry Failed Tasks</button>' +
      '<button class="button" data-workbench-action="seed_first_suggestion"' + (suggestions.length ? "" : " disabled") + '>Seed First Suggestion</button>' +
      '<button class="button" data-workbench-action="maintain">Run Maintain</button>' +
      "</div>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Active Lane</div>' +
      '<div class="metric-list">' +
      '<div class="metric"><span>Objective</span><strong>' + escapeHtml(activeExecution.current_objective || "No active objective.") + '</strong></div>' +
      '<div class="metric"><span>Goal</span><strong>' + escapeHtml(goal.title || "none") + '</strong></div>' +
      '<div class="metric"><span>Plan</span><strong>' + escapeHtml(plan.title || "none") + '</strong></div>' +
      '<div class="metric"><span>Step</span><strong>' + escapeHtml(step.title || "none") + '</strong></div>' +
      '<div class="metric"><span>Task</span><strong>' + escapeHtml(task.objective || "none") + "</strong></div>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Queue Pressure</div>' +
      '<div class="workbench-stats">' +
      '<article><span>Running</span><strong>' + String(queue.running || 0) + '</strong></article>' +
      '<article><span>Pending</span><strong>' + String(queue.pending || 0) + '</strong></article>' +
      '<article><span>Failed</span><strong>' + String(queue.failed || 0) + '</strong></article>' +
      '<article><span>Completed</span><strong>' + String(queue.completed || 0) + "</strong></article>" +
      '<article><span>Review</span><strong>' + String(reasoningReviewCount || 0) + "</strong></article>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Why This Order</div>' +
      '<div class="workbench-list">' +
      schedulerReasons.map(function (entry) {
        return '<article class="workbench-list__item"><strong>Scheduler rationale</strong><span>' + escapeHtml(entry || "") + "</span></article>";
      }).join("") +
      nextActions.map(function (entry) {
        return '<article class="workbench-list__item"><strong>' + escapeHtml(entry.label || "Action") + '</strong><span>' + escapeHtml(entry.detail || "") + "</span></article>";
      }).join("") +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Blockers</div>' +
      '<div class="workbench-list">' +
      (blockers.length
        ? blockers.map(function (entry) {
            return '<article class="workbench-list__item workbench-list__item--warn"><strong>' + escapeHtml(entry.title || entry.kind || "Blocker") + '</strong><span>' + escapeHtml(entry.detail || "") + '</span>' + (entry.remediation && entry.remediation.action ? ('<button class="button" data-blocker-index="' + escapeHtml(String(blockers.indexOf(entry))) + '">' + escapeHtml(entry.remediation.label || "Remediate") + "</button>") : "") + "</article>";
          }).join("")
        : '<article class="workbench-list__item"><strong>Clear</strong><span>No immediate blockers detected in the core snapshot.</span></article>') +
      "</div>" +
      "</section>" +
      '<section class="workbench-card workbench-card--wide">' +
      '<div class="section-title">Suggested Objectives</div>' +
      '<div class="workbench-suggestions">' +
      suggestions.map(function (entry, index) {
        return (
          '<article class="workbench-suggestion">' +
          '<div class="workbench-suggestion__meta"><span>' + escapeHtml(entry.risk || "medium") + '</span><span>' + escapeHtml(entry.mode || "auto") + '</span></div>' +
          '<h3>' + escapeHtml(entry.title || ("Suggestion " + (index + 1))) + '</h3>' +
          '<p>' + escapeHtml(entry.objective || "") + '</p>' +
          '<div class="workbench-suggestion__why">' + escapeHtml(entry.why || "") + '</div>' +
          '<div class="workbench-suggestion__actions"><button class="button button--primary" data-dispatch-suggestion="' + String(index) + '">Dispatch Now</button><button class="button" data-intake-seed="' + String(index) + '">Seed Intake</button></div>' +
          "</article>"
        );
      }).join("") +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Running Tasks</div>' +
      '<div class="workbench-list">' +
      (runningTasks.length
        ? runningTasks.map(function (entry) {
            return '<article class="workbench-list__item"><strong>' + escapeHtml(entry.objective || entry.task_id || "running task") + '</strong><span>' + escapeHtml((entry.task_id || "task") + " · p" + String(entry.priority || 0)) + "</span></article>";
          }).join("")
        : '<article class="workbench-list__item"><strong>No running tasks</strong><span>The core is not actively executing a task right now.</span></article>') +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Failed Tasks</div>' +
      '<div class="workbench-list">' +
      (failedTasks.length
        ? failedTasks.map(function (entry) {
            return '<article class="workbench-list__item workbench-list__item--warn"><strong>' + escapeHtml(entry.objective || entry.task_id || "failed task") + '</strong><span>' + escapeHtml((entry.task_id || "task") + " · " + (entry.last_error || "error unavailable")) + '</span><button class="button" data-retry-task-id="' + escapeHtml(entry.task_id || "") + '">Retry</button></article>';
          }).join("")
        : '<article class="workbench-list__item"><strong>No failed tasks</strong><span>Nothing is currently blocked in the failed queue.</span></article>') +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Pending Tasks</div>' +
      '<div class="workbench-list">' +
      (pendingTasks.length
        ? pendingTasks.map(function (entry) {
            return '<article class="workbench-list__item"><strong>' + escapeHtml(entry.objective || entry.task_id || "pending task") + '</strong><span>' + escapeHtml((entry.task_id || "task") + " · p" + String(entry.priority || 0)) + "</span></article>";
          }).join("")
        : '<article class="workbench-list__item"><strong>No pending tasks</strong><span>The queue is clear enough to open the next bounded objective.</span></article>') +
      "</div>" +
      "</section>" +
      "</div>";
    Array.prototype.slice.call(els.workbenchView.querySelectorAll("[data-intake-seed]")).forEach(function (button) {
      button.addEventListener("click", function () {
        seedIntakeFromWorkbench(Number(button.getAttribute("data-intake-seed") || "0"));
      });
    });
    Array.prototype.slice.call(els.workbenchView.querySelectorAll("[data-dispatch-suggestion]")).forEach(function (button) {
      button.addEventListener("click", function () {
        dispatchWorkbenchSuggestion(Number(button.getAttribute("data-dispatch-suggestion") || "0")).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
    Array.prototype.slice.call(els.workbenchView.querySelectorAll("[data-blocker-index]")).forEach(function (button) {
      button.addEventListener("click", function () {
        triggerBlockerRemediation(Number(button.getAttribute("data-blocker-index") || "0")).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
    Array.prototype.slice.call(els.workbenchView.querySelectorAll("[data-workbench-action]")).forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.getAttribute("data-workbench-action") || "";
        if (action === "seed_first_suggestion") {
          seedIntakeFromWorkbench(0);
          return;
        }
        if (action === "retry_failed_tasks") {
          triggerWorkbenchAction("retry_failed_tasks", {
            task_ids: failedTasks.map(function (entry) { return entry.task_id; }).filter(Boolean),
          }).catch(function (error) {
            setResultText(String(error));
          });
          return;
        }
        triggerWorkbenchAction(action, {}).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
    Array.prototype.slice.call(els.workbenchView.querySelectorAll("[data-retry-task-id]")).forEach(function (button) {
      button.addEventListener("click", function () {
        var taskId = button.getAttribute("data-retry-task-id") || "";
        triggerWorkbenchAction("retry_failed_tasks", {
          task_ids: [taskId],
        }).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
  }

  function renderWorkersView() {
    if (!state.snapshot) {
      els.workersView.innerHTML = "";
      return;
    }
    var summary = state.snapshot.summary || {};
    var router = summary.router || {};
    var localHost = summary.local_host || {};
    var routingOutlook = Array.isArray(router.routing_outlook) ? router.routing_outlook.slice(0, 6) : [];
    var runtimeSessions = Array.isArray(state.snapshot.runtime_sessions) ? state.snapshot.runtime_sessions.slice(0, 10) : [];
    var routerSuppressionDecisions = Array.isArray(state.snapshot.router_suppression_decisions)
      ? state.snapshot.router_suppression_decisions.slice(0, 5)
      : [];
    var providerBridge = state.snapshot.provider_bridge || {};
    var providerDiagnostics = Array.isArray(providerBridge.diagnostics) ? providerBridge.diagnostics.slice(0, 8) : [];
    var providerResourceGate = providerBridge.resource_gate || {};
    var providerResourceGateActive = !!providerResourceGate.active;
    var providerResourceGateSeverity = String(providerResourceGate.severity || "none").toLowerCase();
    var providerResourceGateValue = !providerResourceGateActive
      ? "normal"
      : providerResourceGateSeverity === "high"
        ? "critical"
        : "elevated";
    var providerResourceGateEffects = [];
    if (providerResourceGate.recommendations && providerResourceGate.recommendations.suppress_outbound_bridges) {
      providerResourceGateEffects.push("bridges shed");
    }
    if (providerResourceGate.recommendations && providerResourceGate.recommendations.pause_visible_sidecars) {
      providerResourceGateEffects.push("sidecars paused");
    }
    var routingHtml = routingOutlook.map(function (entry) {
      return '<div class="metric"><span>' + escapeHtml(entry.task_kind || "n/a") + '</span><strong>' + escapeHtml((entry.selected_backend_id || "n/a") + " -> " + (entry.top_planned_backend_id || "n/a") + "@" + (entry.top_planned_node_id || "n/a")) + "</strong></div>";
    }).join("");
    var sessionsHtml = runtimeSessions.map(function (entry) {
      return '<div class="metric"><span>' + escapeHtml((entry.runtime_id || "n/a") + " · " + (entry.status || "n/a")) + '</span><strong>' + escapeHtml(entry.task_id || entry.runtime_session_id || "n/a") + "</strong></div>";
    }).join("");
    var providerGateHtml =
      '<div class="metric"><span>Bridge gate</span><strong>' + escapeHtml(providerResourceGateValue) + "</strong></div>" +
      '<div class="metric"><span>Gate detail</span><strong>' +
      escapeHtml(
        providerResourceGateActive
          ? compactIntakeText(
              (providerResourceGate.detail || providerResourceGate.reason || "local pressure detected") +
                (providerResourceGateEffects.length ? " · " + providerResourceGateEffects.join(" · ") : ""),
              140
            )
          : "bridges available"
      ) +
      "</strong></div>" +
      '<div class="metric"><span>Gate snapshot</span><strong>' +
      escapeHtml(providerBridge.generated_at ? ("sampled " + relativeTime(providerBridge.generated_at) + " ago") : "n/a") +
      "</strong></div>";
    var providersHtml = providerDiagnostics.map(function (entry) {
      var label = (entry.display_name || entry.client_id || "provider") + " · " + (entry.status || "n/a");
      var detail = entry.detail || entry.command || "no detail";
      if (entry.resource_gate_blocked) {
        detail = [detail, entry.resource_gate_reason || "blocked by local resource gate"].filter(Boolean).join(" · ");
      }
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(detail) + "</strong></div>";
    }).join("");
    var suppressionHtml = routerSuppressionDecisions.map(function (entry) {
      var reason = String(entry.reason || "unknown").replace(/_/g, " ");
      var backendId = String(entry.selected_backend_id || "n/a");
      var pressureLevel = String(entry.pressure_level || "n/a");
      var suppressedAgents = Array.isArray(entry.suppressed_agent_ids) && entry.suppressed_agent_ids.length
        ? entry.suppressed_agent_ids.join(", ")
        : "none";
      var observedAt = entry.observed_at ? relativeTime(entry.observed_at) + " ago" : "n/a";
      return '<div class="metric"><span>' +
        escapeHtml(observedAt + " · " + reason) +
        '</span><strong>' +
        escapeHtml(backendId + " · pressure " + pressureLevel + " · agents " + suppressedAgents) +
        "</strong></div>";
    }).join("");
    els.workersView.innerHTML =
      '<div class="workers-grid">' +
      '<section class="brief-card"><div class="section-title">Hybrid Routing Outlook</div><div class="metric-list">' + (routingHtml || '<div class="metric"><span>Routing</span><strong>no outlook entries</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Runtime Sessions</div><div class="metric-list">' + (sessionsHtml || '<div class="metric"><span>Runtime workers</span><strong>no active sessions</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Provider Bridges</div><div class="metric-list">' + providerGateHtml + (providersHtml || '<div class="metric"><span>Provider bridge</span><strong>no diagnostics</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Recent Router Suppression Decisions</div><div class="metric-list">' + (suppressionHtml || '<div class="metric"><span>Router suppression</span><strong>none recent</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Local Host</div><div class="metric-list">' +
      '<div class="metric"><span>CPU</span><strong>' + Math.round((localHost.cpu_utilization || 0) * 100) + '%</strong></div>' +
      '<div class="metric"><span>RAM</span><strong>' + fmt(localHost.ram_available_gb) + " / " + fmt(localHost.ram_total_gb) + ' GB</strong></div>' +
      '<div class="metric"><span>Swap</span><strong>' + fmt(localHost.swap_used_gb) + ' GB</strong></div>' +
      '<div class="metric"><span>Thermal</span><strong>' + escapeHtml(localHost.thermal_pressure || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Workers</span><strong>' + String(localHost.worker_count || 0) + " / " + String(localHost.recommended_worker_count || 0) + '</strong></div>' +
      '<div class="metric"><span>Model lanes</span><strong>' + String(localHost.max_local_model_concurrency || 0) + "</strong></div>" +
      "</div></section>" +
      "</div>";
  }

  function hostTone(host) {
    var status = String(host.remote_access_status || "").toLowerCase();
    if (status === "approved" && host.enabled) return "good";
    if (status === "pending") return "warn";
    if (status === "rejected" || String(host.health_state || "").toLowerCase() === "offline") return "bad";
    return "neutral";
  }

  function hostContextSummary(host) {
    var context = host && host.desktop_context && typeof host.desktop_context === "object" ? host.desktop_context : {};
    var status = String(context.status || "").toLowerCase();
    var source = String(context.source || "none");
    var age = ageSeconds(context.generated_at || context.updated_at);
    var tone = "neutral";
    if (status === "available" && age != null && age <= 300) tone = "good";
    else if (status === "available" || status === "degraded") tone = "warn";
    else if (status === "unavailable") tone = "bad";
    var label = status ? status.toUpperCase() : "NONE";
    var detail = context.generated_at || context.updated_at ? relativeTime(context.generated_at || context.updated_at) + " ago" : "not captured";
    return {
      tone: tone,
      label: label,
      title: source + " · " + detail,
    };
  }

  function hostLocatorMatchLabel(host) {
    var normalized = String(host && host.remote_locator_matched_by || "").trim().toLowerCase();
    if (!normalized) return "";
    if (normalized === "approved_host_hostname") return "matched by hostname";
    if (normalized === "approved_host_mac") return "matched by MAC";
    if (normalized === "approved_host_address") return "matched by approved address";
    if (normalized === "loopback") return "matched by loopback";
    if (normalized === "env_allowlist") return "matched by allowlist";
    return "matched by " + normalized.replace(/_/g, " ");
  }

  function remoteHostsFromSnapshot() {
    var fabric = state.snapshot && state.snapshot.summary ? state.snapshot.summary.worker_fabric || {} : {};
    var hosts = Array.isArray(fabric.hosts) ? fabric.hosts : [];
    return hosts.filter(function (host) {
      return host && (host.transport === "ssh" || host.remote_access_status);
    });
  }

  function postHostAction(payload) {
    return getJson("/office/api/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      return fetchSnapshot({ forceLive: true, explicitForceLive: true }).then(function () {
        return result;
      });
      });
  }

  function incomingPeerDisplayName(peer) {
    var hostname = peer && peer.captured_hostname ? String(peer.captured_hostname) : "";
    if (hostname) return hostname.replace(/\.local$/i, "");
    return peer && peer.host_id ? String(peer.host_id) : "";
  }

  function hostPairDraftValue(name, fallback) {
    var value = state.hostPairDraft && state.hostPairDraft[name];
    if (value == null || value === "") return fallback == null ? "" : String(fallback);
    return String(value);
  }

  function syncHostPairDraftFromForm(form) {
    if (!form) return;
    var get = function (name) {
      var node = form.querySelector('[name="' + name + '"]');
      return node ? String(node.value || "") : "";
    };
    var desktopContextNode = form.querySelector('[name="desktop_context"]');
    var approveNode = form.querySelector('[name="approve"]');
    state.hostPairDraft = Object.assign({}, state.hostPairDraft || defaultHostPairDraft(), {
      host_id: get("host_id"),
      display_name: get("display_name"),
      hostname: get("hostname"),
      ip_address: get("ip_address"),
      mac_address: get("mac_address"),
      ssh_user: get("ssh_user"),
      worker_count: get("worker_count") || "1",
      workspace_root: get("workspace_root"),
      agent_runtime: get("agent_runtime"),
      model_label: get("model_label"),
      permission_profile: get("permission_profile") || "task_worker",
      desktop_context: desktopContextNode ? !!desktopContextNode.checked : true,
      approve: approveNode ? !!approveNode.checked : false,
    });
  }

  function prefillHostPairingFormFromPeer(button) {
    if (!button) return;
    var current = state.hostPairDraft || defaultHostPairDraft();
    state.hostPairDraft = Object.assign({}, current, {
      host_id: current.host_id || String(button.getAttribute("data-peer-host-id") || ""),
      display_name: current.display_name || String(button.getAttribute("data-peer-display-name") || ""),
      hostname: current.hostname || String(button.getAttribute("data-peer-hostname") || ""),
      ip_address: current.ip_address || String(button.getAttribute("data-peer-address") || ""),
      agent_runtime: current.agent_runtime || String(button.getAttribute("data-peer-runtime") || ""),
      model_label: current.model_label || String(button.getAttribute("data-peer-model-label") || ""),
    });
    renderHostsView();
    setResultText(
      "Prefilled host form from verified inbound peer " +
        String(button.getAttribute("data-peer-host-id") || button.getAttribute("data-peer-hostname") || "peer") +
        ". Confirm the workspace root and SSH user before staging."
    );
  }

  function submitHostPairing(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var get = function (name) {
      var node = form.querySelector('[name="' + name + '"]');
      return node ? String(node.value || "").trim() : "";
    };
    var approveNode = form.querySelector('[name="approve"]');
    var desktopContextNode = form.querySelector('[name="desktop_context"]');
    var requestDesktopContext = desktopContextNode ? !!desktopContextNode.checked : true;
    var remoteHost = {
      host_id: get("host_id"),
      display_name: get("display_name"),
      hostname: get("hostname"),
      ip_address: get("ip_address"),
      ssh_user: get("ssh_user"),
      workspace_root: get("workspace_root"),
      agent_runtime: get("agent_runtime"),
      model_label: get("model_label"),
      mac_address: get("mac_address"),
      worker_count: Number(get("worker_count") || "1"),
      permission_profile: get("permission_profile") || "task_worker",
      allowed_addresses: [get("ip_address")].filter(Boolean),
      capabilities: requestDesktopContext ? { desktop_context: true, desktop_observe: true } : {},
      tags: ["mac", "remote", "agent-host"],
      approve: approveNode ? !!approveNode.checked : false,
    };
    if (!remoteHost.workspace_root) {
      setResultText("Remote workspace root is required.");
      return;
    }
    postHostAction({
      action: "stage_remote_host",
      remote_host: remoteHost,
    }).then(function (result) {
      state.hostPairDraft = defaultHostPairDraft();
      if (state.activeTab === "hosts") {
        renderHostsView();
      }
      return result;
    }).catch(function (error) {
      setResultText(String(error));
    });
  }

  function renderHostsView() {
    if (!state.snapshot) {
      if (els.hostsView) els.hostsView.innerHTML = "";
      return;
    }
    if (!els.hostsView) return;
    var summary = state.snapshot.summary || {};
    var fabric = summary.worker_fabric || {};
    var draft = state.hostPairDraft || defaultHostPairDraft();
    var hosts = Array.isArray(fabric.hosts) ? fabric.hosts : [];
    var incomingPeers = Array.isArray(fabric.incoming_peers) ? fabric.incoming_peers : [];
    var remoteHosts = remoteHostsFromSnapshot();
    var pendingCount = remoteHosts.filter(function (host) {
      return String(host.remote_access_status || "").toLowerCase() === "pending";
    }).length;
    var approvedCount = remoteHosts.filter(function (host) {
      return String(host.remote_access_status || "").toLowerCase() === "approved";
    }).length;
    var incomingPeerRows = incomingPeers.length
      ? incomingPeers
          .map(function (peer) {
            var title = peer.captured_hostname || peer.host_id || "incoming peer";
            var detail = [
              peer.host_id ? "host " + peer.host_id : "",
              peer.current_remote_address ? "current " + peer.current_remote_address : "",
              peer.captured_agent_runtime || "",
              peer.captured_model_label || "",
            ].filter(Boolean).join(" · ");
            return (
              '<article class="host-row host-row--warn">' +
              '<div class="host-row__main">' +
              '<div class="host-row__eyebrow">FEDERATION · VERIFIED · NOT STAGED</div>' +
              '<strong>' + escapeHtml(title) + '</strong>' +
              '<span>' + escapeHtml(detail || "Verified peer awaiting staging.") + '</span>' +
              '<small>' + escapeHtml(peer.detail || "This peer can sign federation ingest, but it is not staged in worker.fabric yet.") + '</small>' +
              '</div>' +
              '<div class="host-row__metrics">' +
              '<div><span>Last Seen</span><strong>' + escapeHtml(peer.seen_at ? relativeTime(peer.seen_at) + " ago" : "n/a") + '</strong></div>' +
              '<div><span>Address</span><strong>' + escapeHtml(peer.current_remote_address || "n/a") + '</strong></div>' +
              '<div><span>Runtime</span><strong>' + escapeHtml(peer.captured_agent_runtime || "n/a") + '</strong></div>' +
              '<div><span>Status</span><strong>stage required</strong></div>' +
              '</div>' +
              '<div class="host-row__actions">' +
              '<button class="button button--primary" data-use-incoming-peer="1"' +
              ' data-peer-host-id="' + escapeHtml(peer.host_id || "") + '"' +
              ' data-peer-display-name="' + escapeHtml(incomingPeerDisplayName(peer)) + '"' +
              ' data-peer-hostname="' + escapeHtml(peer.captured_hostname || "") + '"' +
              ' data-peer-address="' + escapeHtml(peer.current_remote_address || "") + '"' +
              ' data-peer-runtime="' + escapeHtml(peer.captured_agent_runtime || "") + '"' +
              ' data-peer-model-label="' + escapeHtml(peer.captured_model_label || "") + '">' +
              'Use Details</button>' +
              '<span class="chip chip--warn">verified inbound</span>' +
              '</div>' +
              '</article>'
            );
          })
          .join("")
      : "";
    var hostRows = hosts.length
      ? hosts
          .map(function (host) {
            var tone = hostTone(host);
            var status = host.remote_access_status || (host.enabled ? "enabled" : "disabled");
            var title = host.display_name || host.host_id || "host";
            var currentAddress = String(host.remote_current_address || "").trim();
            var approvedAddress = String(host.remote_approved_ip_address || host.remote_ip_address || "").trim();
            var detail = [
              host.remote_hostname || host.ssh_destination || host.transport,
              currentAddress ? "current " + currentAddress : "",
              host.remote_mac_address,
              host.remote_agent_runtime,
              host.remote_model_label,
              host.remote_permission_profile ? "scope " + host.remote_permission_profile : "",
              host.remote_identity_public_key_configured ? "signed identity" : "",
            ].filter(Boolean).join(" · ");
            var allowed = Array.isArray(host.remote_allowed_addresses) && host.remote_allowed_addresses.length
              ? host.remote_allowed_addresses.join(", ")
              : "loopback/local only";
            var audit = [
              hostLocatorMatchLabel(host),
              approvedAddress ? "approved at " + approvedAddress : "",
              "allowed at approval: " + allowed,
              host.remote_locator_observed_at ? "last seen " + relativeTime(host.remote_locator_observed_at) + " ago" : "",
              "workspace: " + (host.workspace_root || "n/a"),
            ].filter(Boolean).join(" · ");
            var context = hostContextSummary(host);
            return (
              '<article class="host-row host-row--' + escapeHtml(tone) + '">' +
              '<div class="host-row__main">' +
              '<div class="host-row__eyebrow">' + escapeHtml(String(host.transport || "local").toUpperCase() + " · " + String(status).toUpperCase()) + "</div>" +
              '<strong>' + escapeHtml(title) + '</strong>' +
              '<span>' + escapeHtml(detail || "No remote identity metadata recorded.") + '</span>' +
              '<small>' + escapeHtml(audit) + '</small>' +
              '</div>' +
              '<div class="host-row__metrics">' +
              '<div><span>Health</span><strong>' + escapeHtml(String(host.health_state || "n/a")) + '</strong></div>' +
              '<div><span>Workers</span><strong>' + String(host.worker_count || 0) + '</strong></div>' +
              '<div><span>Queue</span><strong>' + String(host.queue_depth || 0) + '</strong></div>' +
              '<div><span>Context</span><strong class="chip chip--' + escapeHtml(context.tone) + '" title="' + escapeHtml(context.title) + '">' + escapeHtml(context.label) + '</strong></div>' +
              '</div>' +
              '<div class="host-row__actions">' +
              (host.transport === "ssh"
                ? '<button class="button" data-host-action="verify_remote_host" data-host-id="' + escapeHtml(host.host_id || "") + '">Verify</button>'
                : "") +
              (String(host.remote_access_status || "").toLowerCase() === "pending"
                ? '<button class="button button--primary" data-host-action="approve_remote_host" data-host-id="' + escapeHtml(host.host_id || "") + '">Approve</button>'
                : "") +
              (String(host.remote_access_status || "").toLowerCase() !== "rejected" && host.transport === "ssh"
                ? '<button class="button" data-host-action="reject_remote_host" data-host-id="' + escapeHtml(host.host_id || "") + '">Revoke</button>'
                : "") +
              '</div>' +
              '</article>'
            );
          })
          .join("")
      : '<article class="host-row"><div class="host-row__main"><strong>No hosts configured</strong><span>The local implicit host is available, but no durable fabric state has been saved yet.</span></div></article>';

    els.hostsView.innerHTML =
      '<div class="hosts-grid">' +
      '<section class="hosts-hero">' +
      '<div><div class="section-title">Host Pairing</div><h2>Approve many remote Macs without opening the whole LAN.</h2><p>Pairing adds a durable device identity, allowed address, runtime label, and task-worker scope for each approved host before it can use the local MCP surface.</p></div>' +
      '<div class="hosts-hero__stats">' +
      '<article><span>Total hosts</span><strong>' + String(fabric.host_count || hosts.length || 0) + '</strong></article>' +
      '<article><span>Approved remote</span><strong>' + String(approvedCount) + '</strong></article>' +
      '<article><span>Pending</span><strong>' + String(pendingCount) + '</strong></article>' +
      '<article><span>Verified inbound</span><strong>' + String(fabric.incoming_peer_count || incomingPeers.length || 0) + '</strong></article>' +
      '<article><span>Strategy</span><strong>' + escapeHtml(fabric.strategy || "balanced") + '</strong></article>' +
      '</div>' +
      '</section>' +
      (incomingPeers.length
        ? '<section class="hosts-panel hosts-panel--wide">' +
          '<div class="section-title">Verified Incoming Peers</div>' +
          '<p class="host-pair-form__hint">These peers are signing federation ingest successfully, but they are not staged in <code>worker.fabric</code> yet. Review the identity details below and then stage or approve them from this host.</p>' +
          '<div class="host-list">' + incomingPeerRows + '</div>' +
          '</section>'
        : '') +
      '<section class="hosts-panel hosts-panel--pair">' +
      '<div class="section-title">Add Remote Host</div>' +
      '<p class="host-pair-form__hint">Repeat this form, or run <code>node scripts/request_remote_access.mjs --server http://MAIN-MAC:8787</code> on any host that should request access.</p>' +
      '<form class="host-pair-form" id="host-pair-form">' +
      '<div class="host-pair-form__row"><label>Host ID<input name="host_id" placeholder="e.g. dans-mbp, studio-m2, rack-mini-01" value="' + escapeHtml(hostPairDraftValue("host_id")) + '" /></label><label>Display name<input name="display_name" placeholder="Operator-facing device name" value="' + escapeHtml(hostPairDraftValue("display_name")) + '" /></label></div>' +
      '<div class="host-pair-form__row"><label>Hostname<input name="hostname" placeholder="e.g. Dans-MBP.local" value="' + escapeHtml(hostPairDraftValue("hostname")) + '" /></label><label>Current IP<input name="ip_address" placeholder="changes are OK; e.g. 10.1.3.224" value="' + escapeHtml(hostPairDraftValue("ip_address")) + '" /></label></div>' +
      '<label>MAC address<input name="mac_address" placeholder="optional stable LAN hardware address" value="' + escapeHtml(hostPairDraftValue("mac_address")) + '" /></label>' +
      '<div class="host-pair-form__row"><label>SSH user<input name="ssh_user" placeholder="e.g. dan.driver" value="' + escapeHtml(hostPairDraftValue("ssh_user")) + '" /></label><label>Workers<input name="worker_count" value="' + escapeHtml(hostPairDraftValue("worker_count", "1")) + '" inputmode="numeric" /></label></div>' +
      '<label>Workspace root<input name="workspace_root" placeholder="/Users/you/Documents/Playground/MASTER-MOLD" value="' + escapeHtml(hostPairDraftValue("workspace_root")) + '" /></label>' +
      '<div class="host-pair-form__row"><label>Agent runtime<input name="agent_runtime" placeholder="e.g. claude, codex, cursor" value="' + escapeHtml(hostPairDraftValue("agent_runtime")) + '" /></label><label>Model label<input name="model_label" placeholder="e.g. Claude Opus, GPT-5.4" value="' + escapeHtml(hostPairDraftValue("model_label")) + '" /></label></div>' +
      '<div class="host-pair-form__row"><label>Permission<select name="permission_profile"><option value="task_worker"' + (hostPairDraftValue("permission_profile", "task_worker") === "task_worker" ? " selected" : "") + '>task worker</option><option value="read_only"' + (hostPairDraftValue("permission_profile") === "read_only" ? " selected" : "") + '>read only</option><option value="artifact_writer"' + (hostPairDraftValue("permission_profile") === "artifact_writer" ? " selected" : "") + '>artifact writer</option><option value="operator"' + (hostPairDraftValue("permission_profile") === "operator" ? " selected" : "") + '>operator</option></select></label><label class="host-pair-form__check"><input name="desktop_context" type="checkbox"' + ((state.hostPairDraft && state.hostPairDraft.desktop_context !== false) ? " checked" : "") + ' /> Context capture</label></div>' +
      '<label class="host-pair-form__check"><input name="approve" type="checkbox"' + ((state.hostPairDraft && state.hostPairDraft.approve) ? " checked" : "") + ' /> Approve immediately</label>' +
      '<button type="submit" class="button button--primary">Stage Host</button>' +
      '</form>' +
      '</section>' +
      '<section class="hosts-panel hosts-panel--wide">' +
      '<div class="section-title">Approved / Pending Fabric</div>' +
      '<div class="host-list">' + hostRows + '</div>' +
      '</section>' +
      '<section class="hosts-panel">' +
      '<div class="section-title">LAN Guard</div>' +
      '<div class="metric-list">' +
      '<div class="metric"><span>LAN bind</span><strong>MCP_HTTP_ALLOW_LAN=1 required</strong></div>' +
      '<div class="metric"><span>Bearer</span><strong>still required for MCP calls</strong></div>' +
      '<div class="metric"><span>Remote check</span><strong>hostname/MAC + signed host gate</strong></div>' +
      '<div class="metric"><span>Default</span><strong>loopback only</strong></div>' +
      '</div>' +
      '</section>' +
      '</div>';

    var form = els.hostsView.querySelector("#host-pair-form");
    if (form) {
      form.addEventListener("submit", submitHostPairing);
      Array.prototype.slice.call(form.querySelectorAll("input, select")).forEach(function (node) {
        node.addEventListener("input", function () {
          syncHostPairDraftFromForm(form);
        });
        node.addEventListener("change", function () {
          syncHostPairDraftFromForm(form);
        });
      });
    }
    Array.prototype.slice.call(els.hostsView.querySelectorAll("[data-use-incoming-peer]")).forEach(function (button) {
      button.addEventListener("click", function () {
        prefillHostPairingFormFromPeer(button);
      });
    });
    Array.prototype.slice.call(els.hostsView.querySelectorAll("[data-host-action]")).forEach(function (button) {
      button.addEventListener("click", function () {
        postHostAction({
          action: button.getAttribute("data-host-action") || "",
          host_id: button.getAttribute("data-host-id") || "",
        }).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
  }

  function renderPatientZeroView() {
    if (!state.snapshot) {
      els.patientZeroView.innerHTML = "";
      return;
    }
    var summary = state.snapshot.summary || {};
    var patientZero = summary.patient_zero || {};
    var privilegedAccess = summary.privileged_access || {};
    var desktop = summary.desktop_control || {};
    var toolkit = patientZero.toolkit || {};
    var report = patientZero.report || {};
    var enabled = !!patientZero.enabled;
    var posture = masterMoldModePosture(enabled);
    var capabilityRows = [
      ["Eyes", desktop.observe_ready ? "Live observe path available." : "Observe lane not ready."],
      ["Hands", desktop.act_ready ? "Keyboard and pointer actuation available." : "Actuation lane not ready."],
      ["Ears", desktop.listen_ready ? "Microphone/listen lane available." : "Listen lane not ready."],
      ["Browser", patientZero.browser_ready ? String(patientZero.browser_app || "Safari") + " ready for operator-directed work." : String(patientZero.browser_app || "Safari") + " not currently ready."],
      [
        "Autonomy",
        patientZero.autonomous_control_enabled
          ? "Maintain self-drive and autopilot execution are enabled for independent local work."
          : "Autonomous execution is not fully enabled yet."
      ],
      [
        "CLI Toolkit",
        (toolkit.terminal_toolkit_ready
          ? "codex / cursor / gemini / gh available for autonomous terminal execution."
          : "CLI toolkit is not fully enabled yet.")
      ],
      [
        "Office Agents",
        (toolkit.local_agent_spawn_ready
          ? "Local directors and leaf agents are available for delegation and follow-through."
          : "Local agent pool is not fully enabled yet.")
      ],
      [
        "Imprint",
        toolkit.imprint_ready
          ? "Local Imprint is in the active specialist pool."
          : "Local Imprint is not currently enabled in the specialist pool."
      ],
      [
        "Root Shell",
        privilegedAccess.root_execution_ready
          ? "Root execution ready through " + String(privilegedAccess.account || "mcagent") + "."
          : "Not ready: " + String(patientZero.root_shell_reason || "Manual operator-mediated only.")
      ],
      ["Audit", patientZero.autonomy_enabled ? "Operator-visible report mode active." : "Bounded audit mode only."],
    ];
    var activitySummary = Array.isArray(report.activity_summary) ? report.activity_summary : [];
    var noteValue = state.patientZeroNoteDirty
      ? state.patientZeroNoteDraft
      : String(patientZero.last_operator_note || "");
    els.patientZeroView.innerHTML =
      '<div class="patient-zero-grid">' +
      '<section class="patient-zero-banner">' +
      '<div class="patient-zero-banner__hero ' + (enabled ? "is-enabled" : "is-disabled") + '">' + masterMoldModeHeroMarkup() + '</div>' +
      '<div class="patient-zero-banner__copy">' +
      '<div class="section-title">Operator-Escalated Local Control</div>' +
      '<h2>' + escapeHtml(posture + " · " + MASTER_MOLD_MODE_LABEL) + '</h2>' +
      '<p>' + escapeHtml(operatorFacingText(report.scope_notice || "Operator-visible elevated control surface for local execution.")) + '</p>' +
      '<div class="patient-zero-banner__meta">' +
      '<span class="tag ' + (enabled ? "tag--block" : "tag--talk") + '">' + escapeHtml(String(patientZero.permission_profile || "high_risk")) + '</span>' +
      '<span class="tag">' + escapeHtml("authority " + (patientZero.full_control_authority ? "full" : (patientZero.autonomous_control_enabled ? "autonomous" : "partial"))) + '</span>' +
      '<span class="tag">' + escapeHtml("enabled_by " + (patientZero.armed_by || "n/a")) + '</span>' +
      '<span class="tag">' + escapeHtml("enabled_at " + (patientZero.armed_at || "n/a")) + '</span>' +
      "</div>" +
      "</div>" +
      '<div class="patient-zero-banner__actions">' +
      '<button class="patient-zero-button patient-zero-button--arm" data-patient-zero-action="patient_zero_enable">ENABLE ' + escapeHtml(MASTER_MOLD_MODE_LABEL) + '</button>' +
      '<button class="patient-zero-button patient-zero-button--disarm" data-patient-zero-action="patient_zero_disable">DISABLE ' + escapeHtml(MASTER_MOLD_MODE_LABEL) + '</button>' +
      "</div>" +
      "</section>" +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Operator Note</div>' +
      '<textarea class="patient-zero-note" data-patient-zero-note rows="4" placeholder="Record intent for the audit trail.">' + escapeHtml(noteValue) + '</textarea>' +
      '<div class="patient-zero-note__hint">This note is stored with the mode-enable or mode-disable event.</div>' +
      "</section>" +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Capabilities</div>' +
      '<div class="patient-zero-capabilities">' +
      capabilityRows.map(function (entry) {
        return '<article class="patient-zero-capability"><strong>' + escapeHtml(entry[0]) + '</strong><span>' + escapeHtml(entry[1]) + "</span></article>";
      }).join("") +
      "</div>" +
      "</section>" +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Autonomous Toolkit</div>' +
      '<div class="metric-list">' +
      '<div class="metric"><span>Bridge toolkit</span><strong>' + escapeHtml(toolkit.bridge_toolkit_ready ? "ready" : "partial") + '</strong></div>' +
      '<div class="metric"><span>Local agent spawn</span><strong>' + escapeHtml(toolkit.local_agent_spawn_ready ? "ready" : "partial") + '</strong></div>' +
      '<div class="metric"><span>Terminal toolkit</span><strong>' + escapeHtml(toolkit.terminal_toolkit_ready ? "ready" : "partial") + '</strong></div>' +
      '<div class="metric"><span>GitHub CLI</span><strong>' + escapeHtml(toolkit.github_cli_ready ? "ready" : "off") + '</strong></div>' +
      '<div class="metric"><span>Imprint</span><strong>' + escapeHtml(toolkit.imprint_ready ? "ready" : "off") + '</strong></div>' +
      '<div class="metric"><span>Lead</span><strong>' + escapeHtml(((state.snapshot.summary.autopilot || {}).lead_agent_id || "ring-leader")) + '</strong></div>' +
      '<div class="metric"><span>Bridge agents</span><strong>' + escapeHtml((toolkit.bridge_agents || []).map(function (entry) { return String((entry && entry.agent_id) || ""); }).filter(Boolean).join(", ") || "none") + '</strong></div>' +
      '<div class="metric"><span>Local agents</span><strong>' + escapeHtml((toolkit.local_agents || []).map(function (entry) { return String((entry && entry.agent_id) || ""); }).filter(Boolean).join(", ") || "none") + '</strong></div>' +
      '<div class="metric"><span>CLI commands</span><strong>' + escapeHtml((toolkit.terminal_commands || []).map(function (entry) { return String((entry && entry.command) || ""); }).filter(Boolean).join(", ") || "none") + '</strong></div>' +
      '</div>' +
      '</section>' +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Privileged Lane</div>' +
      '<div class="metric-list">' +
      '<div class="metric"><span>Account</span><strong>' + escapeHtml(String(privilegedAccess.account || "mcagent")) + '</strong></div>' +
      '<div class="metric"><span>Target user</span><strong>' + escapeHtml(String(privilegedAccess.target_user || "root")) + '</strong></div>' +
      '<div class="metric"><span>Root ready</span><strong>' + escapeHtml(privilegedAccess.root_execution_ready ? "yes" : "no") + '</strong></div>' +
      '<div class="metric"><span>Credential verified</span><strong>' + escapeHtml(privilegedAccess.credential_verified ? "yes" : "no") + '</strong></div>' +
      '<div class="metric"><span>Secret present</span><strong>' + escapeHtml(privilegedAccess.secret_present ? "yes" : "no") + '</strong></div>' +
      '<div class="metric"><span>Helper ready</span><strong>' + escapeHtml(privilegedAccess.helper_ready ? "yes" : "no") + '</strong></div>' +
      '<div class="metric"><span>Last verify</span><strong>' + escapeHtml(String(privilegedAccess.last_verified_at || "none")) + '</strong></div>' +
      '<div class="metric"><span>Verify error</span><strong>' + escapeHtml(String(privilegedAccess.last_verification_error || "none")) + '</strong></div>' +
      '<div class="metric"><span>Secret path</span><strong>' + escapeHtml(String(privilegedAccess.secret_path || "n/a")) + '</strong></div>' +
      '<div class="metric"><span>Last privileged actor</span><strong>' + escapeHtml(String(privilegedAccess.last_actor || "none")) + '</strong></div>' +
      '<div class="metric"><span>Last privileged command</span><strong>' + escapeHtml(String(privilegedAccess.last_command || "none")) + '</strong></div>' +
      "</div>" +
      "</section>" +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Recon Summary</div>' +
      '<div class="patient-zero-report">' +
      '<div class="metric"><span>Stance</span><strong>' + escapeHtml(report.stance || "No stance recorded.") + '</strong></div>' +
      '<div class="metric"><span>Priority Pull</span><strong>' + escapeHtml(report.priority_pull || "No current priority.") + '</strong></div>' +
      '<div class="metric"><span>Concern</span><strong>' + escapeHtml(report.concern || "No concern recorded.") + '</strong></div>' +
      '<div class="metric"><span>Desire</span><strong>' + escapeHtml(report.desire || "No desire recorded.") + '</strong></div>' +
      "</div>" +
      '<div class="section-title">Activity</div>' +
      '<div class="events-list">' +
      (activitySummary.length
        ? activitySummary.map(function (entry) {
            return '<article class="event-row"><div>' + escapeHtml(operatorFacingText(entry)) + "</div></article>";
          }).join("")
        : '<article class="event-row"><div>No recent activity summary recorded.</div></article>') +
      "</div>" +
      "</section>" +
      "</div>";

    Array.prototype.slice.call(els.patientZeroView.querySelectorAll("[data-patient-zero-action]")).forEach(function (button) {
      button.addEventListener("click", function () {
        var noteNode = els.patientZeroView.querySelector("[data-patient-zero-note]");
        var operatorNote = noteNode ? String(noteNode.value || "").trim() : "";
        postAction(button.getAttribute("data-patient-zero-action") || "", {
          operator_note: operatorNote,
        }).catch(function (error) {
          setResultText(String(error));
        });
      });
    });
    var patientZeroNoteNode = els.patientZeroView.querySelector("[data-patient-zero-note]");
    if (patientZeroNoteNode) {
      patientZeroNoteNode.addEventListener("input", function () {
        state.patientZeroNoteDraft = String(patientZeroNoteNode.value || "");
        state.patientZeroNoteDirty = state.patientZeroNoteDraft !== state.patientZeroLastSavedNote;
      });
    }
  }

  function renderEventsView() {
    if (!state.snapshot) {
      els.eventsView.innerHTML = "";
      return;
    }
    var events = Array.isArray(state.snapshot.events) ? state.snapshot.events.slice(0, 20) : [];
    els.eventsView.innerHTML =
      '<div class="events-list">' +
      (events.length
        ? events.map(function (event) {
            var content = event && event.content ? event.content : JSON.stringify(event);
            return '<article class="event-row"><div class="event-row__meta">' + escapeHtml((event.event_type || "event") + " · " + (event.source_agent || event.role || "n/a") + " · " + relativeTime(event.created_at)) + '</div><div>' + escapeHtml(content) + "</div></article>";
          }).join("")
        : '<article class="event-row"><div>No recent bus events.</div></article>') +
      "</div>";
  }

  function renderAgentDetail() {
    if (!state.snapshot) {
      els.agentDetail.innerHTML = "<div>Waiting for agent telemetry.</div>";
      return;
    }
    var selected = findAgent(state.selectedAgentId);
    if (!selected) {
      var agents = getSnapshotAgents();
      selected = agents.length ? agents[0] : null;
    }
    if (!selected || !selected.agent) {
      els.agentDetail.innerHTML = "<div>No agent selected.</div>";
      return;
    }
    state.selectedAgentId = selected.agent.agent_id || "";
    var agent = selected.agent;
    els.agentDetail.innerHTML =
      '<div class="agent-detail__header"><div><div class="section-title">' + escapeHtml((agent.tier || "agent") + " · " + (agent.role || "n/a")) + '</div><div><strong>' + escapeHtml(agent.display_name || agent.agent_id || "Agent") + '</strong></div></div><div>' + escapeHtml(String(selected.state || "idle").toUpperCase()) + "</div></div>" +
      '<div class="sprite">' + spriteSvg(selected) + "</div>" +
      '<div class="metric-list">' +
      '<div class="metric"><span>Activity</span><strong>' + escapeHtml(selected.activity || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Location</span><strong>' + escapeHtml(selected.location || "n/a") + '</strong></div>' +
      '<div class="metric"><span>Evidence</span><strong>' + escapeHtml((selected.evidence_source || "n/a") + " · " + (selected.evidence_detail || "n/a")) + '</strong></div>' +
      '<div class="metric"><span>Children</span><strong>' + escapeHtml((agent.managed_agent_ids || []).join(", ") || "none") + "</strong></div>" +
      "</div>";
  }

  function renderAll() {
    var patientZeroEnabled = !!(state.snapshot && state.snapshot.summary && state.snapshot.summary.patient_zero && state.snapshot.summary.patient_zero.enabled);
    setPatientZeroTone(patientZeroEnabled ? "enabled" : "disabled");
    syncIntakeMode(patientZeroEnabled);
    renderSubtitle();
    renderStatusStrip();
    renderOfficeView();
    renderWorkbenchView();
    renderBriefingView();
    renderWorkersView();
    renderHostsView();
    renderPatientZeroView();
    renderEventsView();
    renderAgentDetail();
    setTab(state.activeTab);
  }

  function renderSubtitle() {
    if (els.subtitle) {
      var actionState = activeOfficeActionState();
      var subtitle = state.snapshot
        ? "Thread " +
          state.snapshot.thread_id +
          " · detail " +
          relativeTime(state.snapshot.fetched_at_iso) +
          " · live lane " +
          (state.realtime && state.realtime.sampled_at ? relativeTime(state.realtime.sampled_at) : "pending") +
          " · bridge " +
          relativeTime(latestProviderBridgeGeneratedAt(state.snapshot))
        : "Connecting to live MCP operator surface";
      if (state.snapshotMeta && state.snapshotMeta.snapshotSource && state.snapshotMeta.snapshotSource !== "direct-node") {
        subtitle += " · " + humanizeSource(state.snapshotMeta.snapshotSource);
      }
      if (actionState && actionState.running) {
        subtitle += " · " + actionState.action + " running " + relativeTime(actionState.startedAt) + " ago";
      }
      els.subtitle.textContent = subtitle;
    }
  }

  function syncIntakeMode(patientZeroEnabled) {
    if (!els.intakeMode) {
      return;
    }
    var autoOption = els.intakeMode.querySelector('option[value=""]');
    if (autoOption) {
      autoOption.textContent = patientZeroEnabled
        ? "auto (" + MASTER_MOLD_MODE_LABEL + " enabled)"
        : "auto (bounded unless " + MASTER_MOLD_MODE_LABEL + " is enabled)";
    }
    if (!state.intakeModeDirty) {
      els.intakeMode.value = "";
    }
  }

  function getJsonWithResponse(url, options) {
    var requestOptions = options || {};
    return fetch(url, requestOptions).then(function (response) {
      return response.text().then(function (text) {
        var payload = {};
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (error) {
            var snippet = String(text || "").trim().replace(/\s+/g, " ").slice(0, 160);
            var contentType = response.headers.get("content-type") || "unknown";
            throw new Error(
              "Unexpected " + contentType + " response from " + url + (snippet ? ": " + snippet : "")
            );
          }
        }
        if (!response.ok) {
          throw new Error(payload.detail || payload.error || (response.status + " " + response.statusText));
        }
        return {
          payload: payload,
          meta: {
            snapshotSource: response.headers.get("x-office-snapshot-source") || "",
            snapshotStale: response.headers.get("x-office-snapshot-stale") || "",
            refreshState: response.headers.get("x-office-refresh-state") || "",
            snapshotAgeSeconds: response.headers.get("x-office-snapshot-age-seconds") || "",
            realtimeSource: response.headers.get("x-office-realtime-source") || "",
            realtimeAgeSeconds: response.headers.get("x-office-realtime-age-seconds") || "",
          },
        };
      });
    });
  }

  function getJson(url, options) {
    return getJsonWithResponse(url, options).then(function (result) {
      return result.payload;
    });
  }

  function fetchBootstrap() {
    return getJson("/office/api/bootstrap").then(function (payload) {
      state.bootstrap = payload;
      return payload;
    });
  }

  function fetchActionStatus(action) {
    var params = new URLSearchParams();
    if (action) {
      params.set("action", action);
    }
    return getJson("/office/api/action-status?" + params.toString());
  }

  function storeOfficeActionState(action, nextState) {
    if (!action) {
      return;
    }
    if (!nextState) {
      delete state.officeActions[action];
    } else {
      state.officeActions[action] = nextState;
    }
    renderSubtitle();
    renderStatusStrip();
  }

  function rememberOfficeActionResult(action, result) {
    if (!action || !result || result.accepted !== true) {
      return;
    }
    storeOfficeActionState(action, {
      action: action,
      startedAt: result.started_at || new Date().toISOString(),
      completedAt: null,
      running: true,
      code: null,
      stdout: "",
      stderr: "",
    });
  }

  function activeOfficeActionState() {
    var actionIds = Object.keys(state.officeActions || {});
    for (var i = 0; i < actionIds.length; i += 1) {
      var entry = state.officeActions[actionIds[i]];
      if (entry && entry.running) {
        return entry;
      }
    }
    return null;
  }

  function settleActionRefresh() {
    Promise.all([
      fetchLiveStatus().catch(function (error) {
        return error;
      }),
      fetchSnapshot().catch(function (error) {
        return error;
      }),
    ]).then(function (results) {
      var error = results.find(function (entry) {
        return entry instanceof Error;
      });
      if (error) {
        setResultText(String(error));
      }
    });
  }

  function waitForActionToSettle(action, delayMs) {
    var startedAt = Date.now();
    var intervalMs = 1500;
    var maxWaitMs = 90000;

    function scheduleNextPoll() {
      if (Date.now() - startedAt >= maxWaitMs) {
        return;
      }
      window.setTimeout(poll, intervalMs);
    }

    function poll() {
      fetchActionStatus(action)
        .then(function (payload) {
          var actionState = payload && payload.state ? payload.state : null;
          if (!actionState) {
            scheduleNextPoll();
            return;
          }
          storeOfficeActionState(action, actionState);
          if (actionState.running) {
            setResultText(action + " is still running.");
            scheduleNextPoll();
            return;
          }
          if (typeof actionState.code === "number" && actionState.code !== 0) {
            setResultText(action + " failed: " + String(actionState.stderr || actionState.code));
            return;
          }
          setResultText(action + " complete.");
          settleActionRefresh();
        })
        .catch(function () {
          scheduleNextPoll();
        });
    }

    window.setTimeout(poll, Math.max(0, Number(delayMs) || 0));
  }

  function fetchSnapshot(options) {
    var fetchOptions = options || {};
    var forceLive = !!fetchOptions.forceLive;
    var explicitForceLive = !!fetchOptions.explicitForceLive;
    if (state.snapshotRequest) {
      return state.snapshotRequest;
    }
    var threadId = "";
    if (state.snapshot && state.snapshot.thread_id) {
      threadId = state.snapshot.thread_id;
    } else if (state.bootstrap && state.bootstrap.default_thread_id) {
      threadId = state.bootstrap.default_thread_id;
    }
    var params = new URLSearchParams();
    if (forceLive) {
      params.set("live", explicitForceLive ? "force" : "1");
    }
    if (threadId) {
      params.set("thread_id", threadId);
    }
    state.snapshotRequest = getJsonWithResponse("/office/api/snapshot?" + params.toString())
      .then(function (result) {
        var payload = result.payload;
        var meta = result.meta || {};
        var mergedPayload = overlayRealtimeSnapshot(payload);
        var nextFingerprint = snapshotFingerprint(mergedPayload);
        var shouldRenderAll = nextFingerprint !== state.snapshotFingerprint;
        state.snapshotMeta = meta;
        state.snapshot = mergedPayload;
        state.snapshotFingerprint = nextFingerprint;
        var patientZeroNote =
          mergedPayload &&
          mergedPayload.summary &&
          mergedPayload.summary.patient_zero &&
          typeof mergedPayload.summary.patient_zero.last_operator_note === "string"
            ? mergedPayload.summary.patient_zero.last_operator_note
            : "";
        state.patientZeroLastSavedNote = patientZeroNote;
        if (!state.patientZeroNoteDirty) {
          state.patientZeroNoteDraft = patientZeroNote;
        }
        if (!state.selectedAgentId && mergedPayload.agents && mergedPayload.agents.length && mergedPayload.agents[0].agent) {
          state.selectedAgentId = mergedPayload.agents[0].agent.agent_id || "";
        }
        if (meta.refreshState === "pending") {
          setResultText(forceLive ? "Live refresh started; the status lane stays current." : "Snapshot refresh started; the status lane stays current.");
        } else if (meta.snapshotSource === "cache-refreshing-stale" || meta.snapshotSource === "cache-expired-refreshing") {
          setResultText("Detail panels are cached while a fresh snapshot loads. Live status is still updating.");
        } else if (forceLive) {
          setResultText("Live refresh complete.");
        } else {
          setResultText("Ready.");
        }
        if (shouldRenderAll) {
          renderAll();
        } else {
          renderSubtitle();
          renderStatusStrip();
        }
        return mergedPayload;
      }, function (error) {
        state.snapshotRequest = false;
        throw error;
      })
      .then(function (payload) {
        state.snapshotRequest = false;
        return payload;
      });
    return state.snapshotRequest;
  }

  function fetchLiveStatus() {
    if (state.realtimeRequest) {
      return state.realtimeRequest;
    }
    var threadId = "";
    if (state.snapshot && state.snapshot.thread_id) {
      threadId = state.snapshot.thread_id;
    } else if (state.bootstrap && state.bootstrap.default_thread_id) {
      threadId = state.bootstrap.default_thread_id;
    }
    var params = new URLSearchParams();
    if (threadId) {
      params.set("thread_id", threadId);
    }
    state.realtimeRequest = getJsonWithResponse("/office/api/realtime?" + params.toString())
      .then(function (result) {
        var payload = result.payload || {};
        state.realtime = payload;
        state.snapshot = overlayRealtimeSnapshot(state.snapshot || {});
        if (!state.selectedAgentId && state.snapshot && state.snapshot.agents && state.snapshot.agents.length && state.snapshot.agents[0].agent) {
          state.selectedAgentId = state.snapshot.agents[0].agent.agent_id || "";
        }
        renderAll();
        return payload;
      }, function (error) {
        state.realtimeRequest = false;
        throw error;
      })
      .then(function (payload) {
        state.realtimeRequest = false;
        return payload;
      });
    return state.realtimeRequest;
  }

  function renderLoadingShell(message) {
    state.snapshot = null;
    setResultText(message || "Waiting for office telemetry.");
    renderAll();
  }

  function ensureRefreshLoop() {
    if (state.refreshHandle) return;
    var refreshSeconds = state.bootstrap && state.bootstrap.refresh_interval_seconds ? Number(state.bootstrap.refresh_interval_seconds) : 2;
    var intervalMs = Math.max(2000, refreshSeconds * 1000);
    state.refreshHandle = setInterval(function () {
      if (activeOfficeActionState()) {
        return;
      }
      fetchSnapshot().catch(function (error) {
        setResultText("Snapshot refresh degraded: " + String(error));
        if (!state.snapshot) {
          renderLoadingShell("Snapshot retrying after a partial failure.");
        }
      });
    }, intervalMs);
  }

  function ensureRealtimeLoop() {
    if (state.realtimeHandle) return;
    var intervalMs =
      state.bootstrap && state.bootstrap.live_status_interval_ms
        ? Number(state.bootstrap.live_status_interval_ms)
        : 1250;
    intervalMs = Math.max(750, intervalMs);
    state.realtimeHandle = setInterval(function () {
      fetchLiveStatus().catch(function (error) {
        if (!state.snapshot) {
          setResultText("Live status lane degraded: " + String(error));
        }
      });
    }, intervalMs);
  }

  function postAction(action, extra) {
    var payload = Object.assign({ action: action }, extra || {});
    return getJson("/office/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (result) {
      if (action === "patient_zero_enable" || action === "patient_zero_disable") {
        var patientZeroNote = typeof payload.operator_note === "string" ? payload.operator_note.trim() : "";
        state.patientZeroNoteDraft = patientZeroNote;
        state.patientZeroLastSavedNote = patientZeroNote;
        state.patientZeroNoteDirty = false;
      }
      setResultText(JSON.stringify(result, null, 2));
      rememberOfficeActionResult(action, result);
      waitForActionToSettle(action, 1000);
      return result;
    });
  }

  function submitIntake(event) {
    event.preventDefault();
    var objective = els.intakeObjective ? String(els.intakeObjective.value || "").trim() : "";
    if (!objective) {
      setResultText("Objective required.");
      return;
    }
    return getJson("/office/api/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: els.intakeTitle ? String(els.intakeTitle.value || "").trim() : "",
        objective: objective,
        risk: els.intakeRisk ? els.intakeRisk.value : "medium",
        mode: els.intakeMode ? els.intakeMode.value : "",
        dry_run: els.intakeDryRun ? !!els.intakeDryRun.checked : false,
        trichat_agent_ids: state.intakeTargetAgentIds.slice(),
      }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      renderIntakeDesk();
      rememberOfficeActionResult("intake", result);
      waitForActionToSettle("intake", 1500);
      return result;
    });
  }

  function wireEvents() {
    els.tabs.forEach(function (button) {
      button.addEventListener("click", function () {
        setTab(button.getAttribute("data-tab") || "office");
      });
    });
    if (els.intakeForm) {
      els.intakeForm.addEventListener("submit", function (event) {
        submitIntake(event).catch(function (error) {
          setResultText(String(error));
        });
      });
      [els.intakeTitle, els.intakeObjective, els.intakeRisk, els.intakeMode, els.intakeDryRun].forEach(function (node) {
        if (!node) return;
        node.addEventListener("input", renderIntakeDesk);
        node.addEventListener("change", renderIntakeDesk);
      });
    }
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var seedButton = target.closest("[data-seed-objective-index]");
      if (seedButton) {
        var workbench = getWorkbench() || {};
        var suggestions = Array.isArray(workbench.suggested_objectives) ? workbench.suggested_objectives : [];
        var suggestion = suggestions[Number(seedButton.getAttribute("data-seed-objective-index"))];
        if (!suggestion) return;
        if (els.intakeTitle && !String(els.intakeTitle.value || "").trim()) {
          els.intakeTitle.value = suggestion.title || "";
        }
        if (els.intakeObjective) {
          els.intakeObjective.value = suggestion.objective || "";
        }
        if (els.intakeRisk && suggestion.risk) {
          els.intakeRisk.value = suggestion.risk;
        }
        if (els.intakeMode && typeof suggestion.mode === "string") {
          els.intakeMode.value = suggestion.mode;
        }
        setResultText("Seeded objective from the workbench. Review the dispatch preview, then submit.");
        renderIntakeDesk();
        return;
      }
      var intakeAgentButton = target.closest("[data-intake-agent-id]");
      if (intakeAgentButton) {
        var agentId = String(intakeAgentButton.getAttribute("data-intake-agent-id") || "").trim();
        if (!agentId) return;
        if (state.intakeTargetAgentIds.indexOf(agentId) >= 0) {
          state.intakeTargetAgentIds = state.intakeTargetAgentIds.filter(function (entry) { return entry !== agentId; });
        } else {
          state.intakeTargetAgentIds = state.intakeTargetAgentIds.concat([agentId]);
        }
        renderIntakeDesk();
        return;
      }
      var clearAgentTargetsButton = target.closest("[data-intake-agent-clear]");
      if (clearAgentTargetsButton) {
        state.intakeTargetAgentIds = [];
        renderIntakeDesk();
        return;
      }
      var actionButton = target.closest("[data-workbench-action]");
      if (actionButton) {
        var action = actionButton.getAttribute("data-workbench-action") || "";
        var payloadText = actionButton.getAttribute("data-workbench-payload") || "";
        var payload = {};
        if (payloadText) {
          try {
            payload = JSON.parse(payloadText);
          } catch (_error) {
            payload = {};
          }
        }
        postAction(action, payload).catch(function (error) {
          setResultText(String(error));
        });
      }
    });
    if (els.intakeMode) {
      els.intakeMode.addEventListener("change", function () {
        state.intakeModeDirty = String(els.intakeMode.value || "").trim().length > 0;
      });
    }
    if (els.refreshButton) {
      els.refreshButton.addEventListener("click", function () {
        Promise.all([
          fetchLiveStatus().catch(function (error) {
            return error;
          }),
          fetchSnapshot({ forceLive: true, explicitForceLive: true }).catch(function (error) {
            return error;
          }),
        ]).then(function (results) {
          var error = results.find(function (entry) {
            return entry instanceof Error;
          });
          if (error) {
            setResultText(String(error));
          }
        });
      });
    }
    els.actionButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        postAction(button.getAttribute("data-action") || "").catch(function (error) {
          setResultText(String(error));
        });
      });
    });
  }

  function boot() {
    setBootState("booting");
    wireEvents();
    renderLoadingShell("Waiting for office telemetry.");
    fetchBootstrap()
      .catch(function (error) {
        state.bootstrap = {
          default_thread_id: "ring-leader-main",
          refresh_interval_seconds: 2,
        };
        setResultText("Bootstrap degraded: " + String(error));
      })
      .then(function () {
        ensureRefreshLoop();
        ensureRealtimeLoop();
        fetchLiveStatus().catch(function (error) {
          if (!state.snapshot) {
            setResultText("Live status lane degraded: " + String(error));
          }
        });
        return fetchSnapshot().catch(function (error) {
          setResultText(String(error));
          renderLoadingShell("Snapshot retrying after a partial failure.");
        });
      })
      .then(function () {
        setBootState("ready");
      })
      .catch(function (error) {
        setBootState("failed");
        setResultText("GUI boot error: " + String(error));
      });
  }

  window.onerror = function (message, source, lineno, colno, error) {
    setResultText("GUI error: " + String((error && error.stack) || message || "Unknown GUI error"));
  };

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    setResultText("GUI promise rejection: " + String((reason && reason.stack) || (reason && reason.message) || reason || "Unknown promise rejection"));
  });

  boot();
})();
