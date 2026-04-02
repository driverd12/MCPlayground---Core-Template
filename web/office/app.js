(function () {
  var state = {
    activeTab: "office",
    bootstrap: null,
    snapshot: null,
    selectedAgentId: "",
    refreshHandle: null,
    snapshotRequest: false,
  };

  var SNAPSHOT_QUERY = "live=1";

  var els = {
    subtitle: document.querySelector("#subtitle"),
    statusStrip: document.querySelector("#status-strip"),
    officeView: document.querySelector("#office-view"),
    briefingView: document.querySelector("#briefing-view"),
    workersView: document.querySelector("#workers-view"),
    eventsView: document.querySelector("#events-view"),
    tabs: Array.prototype.slice.call(document.querySelectorAll(".tabs__button")),
    intakeForm: document.querySelector("#intake-form"),
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

  function getSnapshotAgents() {
    return state.snapshot && Array.isArray(state.snapshot.agents) ? state.snapshot.agents : [];
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
      ["Desktop", (desktop.enabled ? "enabled" : "disabled") + " | eyes " + (desktop.observe_ready ? "yes" : "no") + " | hands " + (desktop.act_ready ? "yes" : "no") + " | ears " + (desktop.listen_ready ? "yes" : "no")]
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
      '<div class="metric"><span>Self-drive</span><strong>' + (maintain.self_drive_enabled ? (maintain.self_drive_last_run_at ? ("last " + relativeTime(maintain.self_drive_last_run_at)) : "armed") : "off") + '</strong></div>' +
      '<div class="metric"><span>Providers</span><strong>' + String(providers.connected_count || 0) + " connected / " + String((providers.connected_count || 0) + (providers.configured_count || 0) + (providers.disconnected_count || 0) + (providers.unavailable_count || 0)) + ' total</strong></div>' +
      '<div class="metric"><span>Desktop</span><strong>' + escapeHtml((desktop.enabled ? "enabled" : "disabled") + " · " + (desktop.observe_ready ? "eyes" : "no-eyes") + " / " + (desktop.act_ready ? "hands" : "no-hands") + " / " + (desktop.listen_ready ? "ears" : "no-ears")) + '</strong></div>' +
      '<div class="metric"><span>Swarm profiles</span><strong>' + String(swarm.active_profile_count || 0) + '</strong></div>' +
      '<div class="metric"><span>Workflow exports</span><strong>' + String(workflowExports.bundle_count || 0) + "</strong></div>" +
      "</div></section>" +
      '<section class="brief-card"><div class="section-title">Decision Summary</div><pre>' + escapeHtml(current.decision_summary || "No decision summary recorded.") + '</pre><div class="section-title">Selected Strategy</div><pre>' + escapeHtml(current.selected_strategy || "No selected strategy recorded.") + "</pre></section>" +
      "</div>";
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
    if (els.subtitle) {
      els.subtitle.textContent = state.snapshot
        ? "Thread " + state.snapshot.thread_id + " · data age " + relativeTime(state.snapshot.fetched_at_iso)
        : "Connecting to live MCP operator surface";
    }
    renderStatusStrip();
    renderOfficeView();
    renderBriefingView();
    renderWorkersView();
    renderEventsView();
    renderAgentDetail();
    setTab(state.activeTab);
  }

  function getJson(url, options) {
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
        return payload;
      });
    });
  }

  function fetchBootstrap() {
    return getJson("/office/api/bootstrap").then(function (payload) {
      state.bootstrap = payload;
      return payload;
    });
  }

  function fetchSnapshot() {
    if (state.snapshotRequest) {
      return state.snapshotRequest;
    }
    var threadId = "";
    if (state.snapshot && state.snapshot.thread_id) {
      threadId = state.snapshot.thread_id;
    } else if (state.bootstrap && state.bootstrap.default_thread_id) {
      threadId = state.bootstrap.default_thread_id;
    }
    var params = new URLSearchParams(SNAPSHOT_QUERY);
    if (threadId) {
      params.set("thread_id", threadId);
    }
    state.snapshotRequest = getJson("/office/api/snapshot?" + params.toString())
      .then(function (payload) {
        state.snapshot = payload;
        if (!state.selectedAgentId && payload.agents && payload.agents.length && payload.agents[0].agent) {
          state.selectedAgentId = payload.agents[0].agent.agent_id || "";
        }
        setResultText("Ready.");
        renderAll();
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
        setResultText(String(error));
        renderLoadingShell("Snapshot retrying after a partial failure.");
      });
    }, intervalMs);
  }

  function postAction(action) {
    return getJson("/office/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: action }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      return fetchSnapshot();
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
        mode: modeNode ? modeNode.value : "execute_bounded",
        dry_run: dryRunNode ? !!dryRunNode.checked : false,
      }),
    }).then(function (result) {
      setResultText(JSON.stringify(result, null, 2));
      return fetchSnapshot();
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
    if (els.refreshButton) {
      els.refreshButton.addEventListener("click", function () {
        fetchSnapshot().catch(function (error) {
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
