(function () {
  var state = {
    activeTab: "office",
    bootstrap: null,
    snapshot: null,
    snapshotFingerprint: "",
    selectedAgentId: "",
    refreshHandle: null,
    snapshotRequest: false,
    patientZeroNoteDraft: "",
    patientZeroNoteDirty: false,
    patientZeroLastSavedNote: "",
    intakeModeDirty: false,
  };

  var els = {
    subtitle: document.querySelector("#subtitle"),
    statusStrip: document.querySelector("#status-strip"),
    officeView: document.querySelector("#office-view"),
    workbenchView: document.querySelector("#workbench-view"),
    briefingView: document.querySelector("#briefing-view"),
    workersView: document.querySelector("#workers-view"),
    patientZeroView: document.querySelector("#patient-zero-view"),
    eventsView: document.querySelector("#events-view"),
    tabs: Array.prototype.slice.call(document.querySelectorAll(".tabs__button")),
    intakeForm: document.querySelector("#intake-form"),
    intakeMode: document.querySelector("#intake-mode"),
    intakeResult: document.querySelector("#intake-result"),
    agentDetail: document.querySelector("#agent-detail"),
    refreshButton: document.querySelector("#refresh-button"),
    actionButtons: Array.prototype.slice.call(document.querySelectorAll("[data-action]")),
  };

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

  function patientZeroSkullSvg(enabled) {
    var fill = enabled ? "#f1dfd4" : "#cfb9ad";
    var accent = enabled ? "#b43c3c" : "#6c3030";
    return (
      '<svg viewBox="0 0 96 96" aria-hidden="true">' +
      '<rect x="24" y="20" width="48" height="10" fill="' + accent + '" />' +
      '<rect x="18" y="30" width="60" height="28" rx="6" fill="' + fill + '" />' +
      '<rect x="26" y="58" width="44" height="14" rx="4" fill="' + fill + '" />' +
      '<rect x="30" y="38" width="12" height="12" fill="#0f1116" />' +
      '<rect x="54" y="38" width="12" height="12" fill="#0f1116" />' +
      '<polygon points="48,44 40,58 56,58" fill="' + accent + '" />' +
      '<rect x="34" y="62" width="6" height="12" fill="#0f1116" />' +
      '<rect x="44" y="62" width="6" height="12" fill="#0f1116" />' +
      '<rect x="54" y="62" width="6" height="12" fill="#0f1116" />' +
      '<rect x="28" y="74" width="8" height="10" fill="' + accent + '" />' +
      '<rect x="60" y="74" width="8" height="10" fill="' + accent + '" />' +
      "</svg>"
    );
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

  function renderStatusStrip() {
    if (!state.snapshot) {
      els.statusStrip.innerHTML = '<div class="chip"><strong>Loading</strong><span>Waiting for office telemetry.</span></div>';
      return;
    }
    var summary = state.snapshot.summary || {};
    var kernel = summary.kernel || {};
    var tasks = summary.tasks || {};
    var host = summary.local_host || {};
    var router = summary.router || {};
    var liveBackend = router.live_backend || {};
    var runtimeWorkers = summary.runtime_workers || {};
    var maintain = summary.maintain || {};
    var autopilot = summary.autopilot || {};
    var providers = summary.provider_bridge || {};
    var desktop = summary.desktop_control || {};
    var patientZero = summary.patient_zero || {};
    var privilegedAccess = summary.privileged_access || {};
    var chips = [];
    if (state.snapshot.errors && state.snapshot.errors.length) {
      chips.push(["Snapshot", String(state.snapshot.errors.length) + " partial errors"]);
    }
    chips.push(
      ["Kernel", String(kernel.state || "n/a") + " | healthy " + String(kernel.healthy || 0) + " | degraded " + String(kernel.degraded || 0)],
      ["Tasks", "run " + String(tasks.running || 0) + " | queue " + String(tasks.pending || 0) + " | fail " + String(tasks.failed || 0)],
      ["Host", "cpu " + Math.round((host.cpu_utilization || 0) * 100) + "% | ram " + fmt(host.ram_available_gb) + " / " + fmt(host.ram_total_gb) + " GB | swap " + fmt(host.swap_used_gb) + " GB"],
      ["Router", String(router.default_backend_id || "n/a") + " | " + (liveBackend.probe_model_loaded ? "warm" : "cold") + " | " + fmt(liveBackend.latency_ms_p50, 0) + " ms"],
      ["Autopilot", (autopilot.running ? "running" : "idle") + " | exec " + (autopilot.execute_enabled ? "armed" : "advisory") + " | " + String(autopilot.last_execution_mode || "none")],
      ["Workers", "active " + String(runtimeWorkers.active_count || 0) + " | sessions " + String(runtimeWorkers.session_count || 0)],
      ["Maintain", (maintain.running ? "running" : "idle") + " | eval_due " + (maintain.eval_due ? "yes" : "no")],
      ["Providers", "connected " + String(providers.connected_count || 0) + " | disconnected " + String(providers.disconnected_count || 0)],
      ["Desktop", (desktop.enabled ? "enabled" : "disabled") + " | eyes " + (desktop.observe_ready ? "yes" : "no") + " | hands " + (desktop.act_ready ? "yes" : "no") + " | ears " + (desktop.listen_ready ? "yes" : "no")],
      [
        "Patient Zero",
        (patientZero.enabled ? "armed" : "standby") +
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
        return '<div class="chip"><strong>' + escapeHtml(entry[0]) + "</strong><span>" + escapeHtml(entry[1]) + "</span></div>";
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
      '<div class="metric"><span>Patient Zero control</span><strong>' + escapeHtml((summary.patient_zero && summary.patient_zero.full_control_authority) ? "full authority" : ((summary.patient_zero && summary.patient_zero.autonomous_control_enabled) ? "autonomy armed" : "bounded")) + '</strong></div>' +
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
        thread_id: state.snapshot.thread_id || "",
        tags: ["workbench"],
      }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      return fetchSnapshot({ forceLive: true, explicitForceLive: true });
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
    els.workbenchView.innerHTML =
      '<div class="workbench-grid">' +
      '<section class="workbench-hero">' +
      '<div><div class="section-title">Daily Workbench</div><h2>' + escapeHtml(workbench.headline || "No workbench headline available.") + '</h2><p>This view turns live MCP core state into the next concrete move, instead of making you infer it from raw telemetry.</p></div>' +
      '<div class="workbench-hero__meta">' +
      '<div class="workbench-status ' + statusClassName + '">' + escapeHtml(String(workbench.status || "ready").toUpperCase()) + '</div>' +
      '<div class="metric"><span>Focus</span><strong>' + escapeHtml(workbench.focus_area || "intake") + '</strong></div>' +
      '<div class="metric"><span>Blockers</span><strong>' + String(blockers.length) + '</strong></div>' +
      '<div class="metric"><span>Suggestions</span><strong>' + String(suggestions.length) + "</strong></div>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card workbench-card--wide">' +
      '<div class="section-title">Quick Actions</div>' +
      '<div class="workbench-actions">' +
      '<button class="button" data-workbench-action="recover_expired_tasks"' + (quickActions.recover_expired_tasks ? "" : " disabled") + '>Recover Expired Tasks</button>' +
      '<button class="button" data-workbench-action="retry_failed_tasks"' + (quickActions.retry_failed_tasks ? "" : " disabled") + '>Retry Failed Tasks</button>' +
      '<button class="button" data-workbench-action="seed_first_suggestion"' + (suggestions.length ? "" : " disabled") + '>Seed First Suggestion</button>' +
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
      '<div class="section-title">Queue Shape</div>' +
      '<div class="workbench-stats">' +
      '<article><span>Running</span><strong>' + String(queue.running || 0) + '</strong></article>' +
      '<article><span>Pending</span><strong>' + String(queue.pending || 0) + '</strong></article>' +
      '<article><span>Failed</span><strong>' + String(queue.failed || 0) + '</strong></article>' +
      '<article><span>Completed</span><strong>' + String(queue.completed || 0) + "</strong></article>" +
      "</div>" +
      "</section>" +
      '<section class="workbench-card">' +
      '<div class="section-title">Next Moves</div>' +
      '<div class="workbench-list">' +
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
    var providerBridge = state.snapshot.provider_bridge || {};
    var providerDiagnostics = Array.isArray(providerBridge.diagnostics) ? providerBridge.diagnostics.slice(0, 8) : [];
    var routingHtml = routingOutlook.map(function (entry) {
      return '<div class="metric"><span>' + escapeHtml(entry.task_kind || "n/a") + '</span><strong>' + escapeHtml((entry.selected_backend_id || "n/a") + " -> " + (entry.top_planned_backend_id || "n/a") + "@" + (entry.top_planned_node_id || "n/a")) + "</strong></div>";
    }).join("");
    var sessionsHtml = runtimeSessions.map(function (entry) {
      return '<div class="metric"><span>' + escapeHtml((entry.runtime_id || "n/a") + " · " + (entry.status || "n/a")) + '</span><strong>' + escapeHtml(entry.task_id || entry.runtime_session_id || "n/a") + "</strong></div>";
    }).join("");
    var providersHtml = providerDiagnostics.map(function (entry) {
      var label = (entry.display_name || entry.client_id || "provider") + " · " + (entry.status || "n/a");
      var detail = entry.detail || entry.command || "no detail";
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(detail) + "</strong></div>";
    }).join("");
    els.workersView.innerHTML =
      '<div class="workers-grid">' +
      '<section class="brief-card"><div class="section-title">Hybrid Routing Outlook</div><div class="metric-list">' + (routingHtml || '<div class="metric"><span>Routing</span><strong>no outlook entries</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Runtime Sessions</div><div class="metric-list">' + (sessionsHtml || '<div class="metric"><span>Runtime workers</span><strong>no active sessions</strong></div>') + "</div></section>" +
      '<section class="brief-card"><div class="section-title">Provider Bridges</div><div class="metric-list">' + (providersHtml || '<div class="metric"><span>Provider bridge</span><strong>no diagnostics</strong></div>') + "</div></section>" +
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
    var posture = enabled ? "ARMED" : "STANDBY";
    var capabilityRows = [
      ["Eyes", desktop.observe_ready ? "Live observe path available." : "Observe lane not ready."],
      ["Hands", desktop.act_ready ? "Keyboard and pointer actuation available." : "Actuation lane not ready."],
      ["Ears", desktop.listen_ready ? "Microphone/listen lane available." : "Listen lane not ready."],
      ["Browser", patientZero.browser_ready ? String(patientZero.browser_app || "Safari") + " ready for operator-directed work." : String(patientZero.browser_app || "Safari") + " not currently ready."],
      [
        "Autonomy",
        patientZero.autonomous_control_enabled
          ? "Maintain self-drive and autopilot execution are armed for independent local work."
          : "Autonomous execution is not fully armed yet."
      ],
      [
        "CLI Toolkit",
        (toolkit.terminal_toolkit_ready
          ? "codex / cursor / gemini / gh available for autonomous terminal execution."
          : "CLI toolkit is not fully armed yet.")
      ],
      [
        "Office Agents",
        (toolkit.local_agent_spawn_ready
          ? "Local directors and leaf agents are available for delegation and follow-through."
          : "Local agent pool is not fully armed yet.")
      ],
      [
        "Imprint",
        toolkit.imprint_ready
          ? "Local Imprint is in the active specialist pool."
          : "Local Imprint is not currently armed in the specialist pool."
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
      '<div class="patient-zero-banner__icon">' + patientZeroSkullSvg(enabled) + '</div>' +
      '<div class="patient-zero-banner__copy">' +
      '<div class="section-title">Explicit High-Risk Local Control</div>' +
      '<h2>' + escapeHtml(posture + " · Patient Zero") + '</h2>' +
      '<p>' + escapeHtml(report.scope_notice || "Operator-visible elevated control surface for local execution.") + '</p>' +
      '<div class="patient-zero-banner__meta">' +
      '<span class="tag ' + (enabled ? "tag--block" : "tag--talk") + '">' + escapeHtml(String(patientZero.permission_profile || "high_risk")) + '</span>' +
      '<span class="tag">' + escapeHtml("authority " + (patientZero.full_control_authority ? "full" : (patientZero.autonomous_control_enabled ? "autonomous" : "partial"))) + '</span>' +
      '<span class="tag">' + escapeHtml("armed_by " + (patientZero.armed_by || "n/a")) + '</span>' +
      '<span class="tag">' + escapeHtml("armed_at " + (patientZero.armed_at || "n/a")) + '</span>' +
      "</div>" +
      "</div>" +
      '<div class="patient-zero-banner__actions">' +
      '<button class="patient-zero-button patient-zero-button--arm" data-patient-zero-action="patient_zero_enable">ENABLE PATIENT ZERO</button>' +
      '<button class="patient-zero-button patient-zero-button--disarm" data-patient-zero-action="patient_zero_disable">DISABLE PATIENT ZERO</button>' +
      "</div>" +
      "</section>" +
      '<section class="patient-zero-card">' +
      '<div class="section-title">Operator Note</div>' +
      '<textarea class="patient-zero-note" data-patient-zero-note rows="4" placeholder="Record intent for the audit trail.">' + escapeHtml(noteValue) + '</textarea>' +
      '<div class="patient-zero-note__hint">This note is stored with the arm or disarm event.</div>' +
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
            return '<article class="event-row"><div>' + escapeHtml(entry) + "</div></article>";
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
    renderPatientZeroView();
    renderEventsView();
    renderAgentDetail();
    setTab(state.activeTab);
  }

  function renderSubtitle() {
    if (els.subtitle) {
      els.subtitle.textContent = state.snapshot
        ? "Thread " + state.snapshot.thread_id + " · data age " + relativeTime(state.snapshot.fetched_at_iso)
        : "Connecting to live MCP operator surface";
    }
  }

  function syncIntakeMode(patientZeroEnabled) {
    if (!els.intakeMode) {
      return;
    }
    var autoOption = els.intakeMode.querySelector('option[value=""]');
    if (autoOption) {
      autoOption.textContent = patientZeroEnabled
        ? "auto (Patient Zero full control)"
        : "auto (bounded unless Patient Zero is armed)";
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
        var nextFingerprint = snapshotFingerprint(payload);
        var shouldRenderAll = nextFingerprint !== state.snapshotFingerprint;
        state.snapshot = payload;
        state.snapshotFingerprint = nextFingerprint;
        var patientZeroNote =
          payload &&
          payload.summary &&
          payload.summary.patient_zero &&
          typeof payload.summary.patient_zero.last_operator_note === "string"
            ? payload.summary.patient_zero.last_operator_note
            : "";
        state.patientZeroLastSavedNote = patientZeroNote;
        if (!state.patientZeroNoteDirty) {
          state.patientZeroNoteDraft = patientZeroNote;
        }
        if (!state.selectedAgentId && payload.agents && payload.agents.length && payload.agents[0].agent) {
          state.selectedAgentId = payload.agents[0].agent.agent_id || "";
        }
        if (meta.refreshState === "pending") {
          setResultText(forceLive ? "Live refresh started." : "Snapshot refresh started.");
        } else if (meta.snapshotSource === "cache-refreshing-stale") {
          setResultText("Showing cached office data while a fresh snapshot loads.");
        } else if (forceLive) {
          setResultText("Live refresh complete.");
        } else {
          setResultText("Ready.");
        }
        if (shouldRenderAll) {
          renderAll();
        } else {
          renderSubtitle();
        }
        return payload;
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
      fetchSnapshot().catch(function (error) {
        setResultText("Snapshot refresh degraded: " + String(error));
        if (!state.snapshot) {
          renderLoadingShell("Snapshot retrying after a partial failure.");
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
      return fetchSnapshot({ forceLive: true, explicitForceLive: true });
    });
  }

  function submitIntake(event) {
    event.preventDefault();
    var objectiveNode = document.querySelector("#intake-objective");
    var titleNode = document.querySelector("#intake-title");
    var riskNode = document.querySelector("#intake-risk");
    var modeNode = document.querySelector("#intake-mode");
    var dryRunNode = document.querySelector("#intake-dry-run");
    var objective = objectiveNode ? String(objectiveNode.value || "").trim() : "";
    if (!objective) {
      setResultText("Objective required.");
      return;
    }
    return getJson("/office/api/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: titleNode ? String(titleNode.value || "").trim() : "",
        objective: objective,
        risk: riskNode ? riskNode.value : "medium",
        mode: modeNode ? modeNode.value : "",
        dry_run: dryRunNode ? !!dryRunNode.checked : false,
      }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      return fetchSnapshot({ forceLive: true, explicitForceLive: true });
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
    }
    if (els.intakeMode) {
      els.intakeMode.addEventListener("change", function () {
        state.intakeModeDirty = String(els.intakeMode.value || "").trim().length > 0;
      });
    }
    if (els.refreshButton) {
      els.refreshButton.addEventListener("click", function () {
        fetchSnapshot({ forceLive: true, explicitForceLive: true }).catch(function (error) {
          setResultText(String(error));
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
