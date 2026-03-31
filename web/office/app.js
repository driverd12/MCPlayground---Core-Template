const state = {
  activeTab: "office",
  bootstrap: null,
  snapshot: null,
  selectedAgentId: "",
  lastResult: "Ready.",
  refreshHandle: null,
  snapshotRequest: null,
};
const SNAPSHOT_QUERY = "live=1";

const els = {
  subtitle: document.querySelector("#subtitle"),
  statusStrip: document.querySelector("#status-strip"),
  officeView: document.querySelector("#office-view"),
  briefingView: document.querySelector("#briefing-view"),
  workersView: document.querySelector("#workers-view"),
  eventsView: document.querySelector("#events-view"),
  tabs: [...document.querySelectorAll(".tabs__button")],
  intakeForm: document.querySelector("#intake-form"),
  intakeResult: document.querySelector("#intake-result"),
  agentDetail: document.querySelector("#agent-detail"),
  refreshButton: document.querySelector("#refresh-button"),
  actionButtons: [...document.querySelectorAll("[data-action]")],
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "n/a";
}

function relativeTime(isoValue) {
  const stamp = new Date(isoValue || 0).getTime();
  if (!Number.isFinite(stamp) || stamp <= 0) return "n/a";
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
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
  const stateName = agent.state || "idle";
  const fill = toneForState(stateName);
  const eye = stateName === "sleeping" ? "#1e2430" : "#111317";
  const accent = stateName === "blocked" ? "#d96c6c" : "#1e2430";
  const motion = stateName === "working" ? 1 : stateName === "talking" ? 2 : 0;
  const blink = stateName === "idle" ? 7 : 10;
  return `
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect x="28" y="22" width="40" height="8" fill="${accent}" />
      <rect x="18" y="30" width="60" height="22" fill="${fill}" />
      <rect x="12" y="52" width="72" height="14" fill="${fill}" />
      <rect x="18" y="66" width="10" height="16" fill="${fill}" />
      <rect x="40" y="66" width="10" height="16" fill="${fill}" />
      <rect x="62" y="66" width="10" height="16" fill="${fill}" />
      <rect x="28" y="42" width="${blink}" height="8" fill="${eye}" />
      <rect x="60" y="42" width="${blink}" height="8" fill="${eye}" />
      <rect x="0" y="82" width="96" height="4" fill="rgba(0,0,0,0.25)" />
      <rect x="${30 + motion}" y="86" width="36" height="2" fill="rgba(255,255,255,0.08)" />
    </svg>
  `;
}

function findAgent(agentId) {
  return (state.snapshot?.agents || []).find((entry) => entry.agent.agent_id === agentId) || null;
}

function setTab(tab) {
  state.activeTab = tab;
  els.tabs.forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `${tab}-view`));
}

function renderStatusStrip() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    els.statusStrip.innerHTML = `<div class="chip"><strong>Loading</strong><span>Waiting for office telemetry.</span></div>`;
    return;
  }
  const summary = snapshot.summary || {};
  const kernel = summary.kernel || {};
  const tasks = summary.tasks || {};
  const localHost = summary.local_host || {};
  const router = summary.router || {};
  const liveBackend = router.live_backend || {};
  const runtimeWorkers = summary.runtime_workers || {};
  const maintain = summary.maintain || {};
  const chips = [];
  if ((snapshot.errors || []).length) {
    chips.push(["Snapshot", `${snapshot.errors.length} partial errors`]);
  }
  chips.push(
    ["Kernel", `${kernel.state || "n/a"} | healthy ${kernel.healthy ?? 0} | degraded ${kernel.degraded ?? 0}`],
    ["Tasks", `run ${tasks.running ?? 0} | queue ${tasks.pending ?? 0} | fail ${tasks.failed ?? 0}`],
    ["Host", `cpu ${Math.round((localHost.cpu_utilization || 0) * 100)}% | ram ${fmt(localHost.ram_available_gb)} / ${fmt(localHost.ram_total_gb)} GB | swap ${fmt(localHost.swap_used_gb)} GB`],
    ["Router", `${router.default_backend_id || "n/a"} | ${liveBackend.probe_model_loaded ? "warm" : "cold"} | ${fmt(liveBackend.latency_ms_p50, 0)} ms`],
    ["Workers", `active ${runtimeWorkers.active_count ?? 0} | sessions ${runtimeWorkers.session_count ?? 0}`],
    ["Maintain", `${maintain.running ? "running" : "idle"} | eval_due ${maintain.eval_due ? "yes" : "no"}`],
  );
  els.statusStrip.innerHTML = chips
    .map(([label, value]) => `<div class="chip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`)
    .join("");
}

function renderOfficeView() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    els.officeView.innerHTML = `
      <section class="office-empty">
        <div class="section-title">Connecting</div>
        <p>Fetching live office telemetry from the MCP control plane.</p>
      </section>
    `;
    return;
  }
  const rooms = {
    command: [],
    lounge: [],
    build: [],
    ops: [],
    ...(snapshot.rooms || {}),
  };
  const titleMap = {
    command: "Command Deck",
    lounge: "Lounge + Water",
    build: "Build Bay",
    ops: "Ops Rack",
  };
  const errors = (snapshot.errors || []).slice(0, 3);
  const html = Object.entries(rooms)
    .map(([roomKey, agentIds]) => {
      const roomAgents = agentIds.map(findAgent).filter(Boolean);
      return `
        <section class="room room--${roomKey}">
          <div class="room__header">
            <div class="room__title">${escapeHtml(titleMap[roomKey] || roomKey)}</div>
            <div class="room__meta">${roomAgents.length} agents</div>
          </div>
          <div class="room__agents">
            ${roomAgents
              .map((entry) => {
                const agent = entry.agent;
                const active = agent.agent_id === state.selectedAgentId;
                const tags = (entry.actions || [])
                  .map((tag) => `<span class="tag ${tag === "blocked" || tag === "offline" ? "tag--block" : tag === "coffee" || tag === "chat" ? "tag--talk" : tag === "desk" || tag === "code" || tag === "brief" ? "tag--work" : ""}">${escapeHtml(tag)}</span>`)
                  .join("");
                return `
                  <article class="agent-tile ${active ? "is-selected" : ""}" data-agent-id="${escapeHtml(agent.agent_id)}">
                    <div class="agent-tile__top">
                      <div>
                        <div class="agent-tile__name">${escapeHtml(agent.display_name)}</div>
                        <div class="agent-tile__state">${escapeHtml(entry.state.toUpperCase())} · ${escapeHtml(agent.tier)}</div>
                      </div>
                      <div class="agent-tile__state">${escapeHtml(agent.token)}</div>
                    </div>
                    <div class="sprite">${spriteSvg(entry)}</div>
                    <div class="agent-tile__tags">${tags}</div>
                  </article>
                `;
              })
              .join("")}
          </div>
        </section>
      `;
    })
    .join("");
  const hasAgents = (snapshot.agents || []).length > 0;
  const alertHtml = errors.length
    ? `
      <section class="office-alert">
        <div class="section-title">Partial Snapshot</div>
        <ul>
          ${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}
        </ul>
      </section>
    `
    : "";
  const emptyHtml = !hasAgents
    ? `
      <section class="office-empty">
        <div class="section-title">Office Floor Unavailable</div>
        <p>Live office presence is not available yet. The snapshot path is returning partial data.</p>
      </section>
    `
    : `<div class="office-grid">${html}</div>`;
  els.officeView.innerHTML = `${alertHtml}${emptyHtml}`;
  els.officeView.querySelectorAll("[data-agent-id]").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedAgentId = node.dataset.agentId || "";
      renderAll();
    });
  });
}

function renderBriefingView() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const current = snapshot.current || {};
  const summary = snapshot.summary || {};
  const tmux = summary.tmux || {};
  const runtimeWorkers = summary.runtime_workers || {};
  const reactionEngine = summary.reaction_engine || {};
  const maintain = summary.maintain || {};
  const swarm = summary.swarm || {};
  const workflowExports = summary.workflow_exports || {};
  const confidence = current.confidence_method || {};
  const checks = confidence.checks || {};
  els.briefingView.innerHTML = `
    <div class="briefing-grid">
      <section class="brief-card">
        <div class="section-title">Current Objective</div>
        <pre>${escapeHtml(current.current_objective || "No active objective.")}</pre>
        <div class="metric-list">
          <div class="metric"><span>Spawn path</span><strong>${escapeHtml(current.spawn_path || "n/a")}</strong></div>
          <div class="metric"><span>Selected agent</span><strong>${escapeHtml(current.selected_agent || "n/a")}</strong></div>
          <div class="metric"><span>Execution tasks</span><strong>${escapeHtml((current.execution_task_ids || []).join(", ") || "n/a")}</strong></div>
        </div>
      </section>
      <section class="brief-card">
        <div class="section-title">Confidence</div>
        <div class="metric-list">
          <div class="metric"><span>Mode</span><strong>${escapeHtml(confidence.mode || "n/a")}</strong></div>
          <div class="metric"><span>Score</span><strong>${fmt(confidence.score, 2)}</strong></div>
          <div class="metric"><span>Owner clarity</span><strong>${fmt(checks.owner_clarity, 2)}</strong></div>
          <div class="metric"><span>Actionability</span><strong>${fmt(checks.actionability, 2)}</strong></div>
          <div class="metric"><span>Evidence bar</span><strong>${fmt(checks.evidence_bar, 2)}</strong></div>
          <div class="metric"><span>Rollback ready</span><strong>${fmt(checks.rollback_ready, 2)}</strong></div>
          <div class="metric"><span>Anti-echo</span><strong>${fmt(checks.anti_echo, 2)}</strong></div>
        </div>
      </section>
      <section class="brief-card">
        <div class="section-title">Infrastructure</div>
        <div class="metric-list">
          <div class="metric"><span>tmux queue</span><strong>${tmux.queue_depth ?? 0}</strong></div>
          <div class="metric"><span>Runtime workers</span><strong>${runtimeWorkers.active_count ?? 0} active / ${runtimeWorkers.session_count ?? 0} total</strong></div>
          <div class="metric"><span>Reaction engine</span><strong class="${statusClass(reactionEngine.runtime_running)}">${reactionEngine.runtime_running ? "running" : "down"}</strong></div>
          <div class="metric"><span>Maintain loop</span><strong class="${statusClass(maintain.running)}">${maintain.running ? "running" : "idle"}</strong></div>
          <div class="metric"><span>Swarm profiles</span><strong>${swarm.active_profile_count ?? 0}</strong></div>
          <div class="metric"><span>Workflow exports</span><strong>${workflowExports.bundle_count ?? 0}</strong></div>
        </div>
      </section>
      <section class="brief-card">
        <div class="section-title">Decision Summary</div>
        <pre>${escapeHtml(current.decision_summary || "No decision summary recorded.")}</pre>
        <div class="section-title">Selected Strategy</div>
        <pre>${escapeHtml(current.selected_strategy || "No selected strategy recorded.")}</pre>
      </section>
    </div>
  `;
}

function renderWorkersView() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const summary = snapshot.summary || {};
  const router = summary.router || {};
  const localHost = summary.local_host || {};
  const routing = (router.routing_outlook || [])
    .slice(0, 6)
    .map((entry) => `
      <div class="metric">
        <span>${escapeHtml(entry.task_kind || "n/a")}</span>
        <strong>${escapeHtml(`${entry.selected_backend_id || "n/a"} -> ${entry.top_planned_backend_id || "n/a"}@${entry.top_planned_node_id || "n/a"}`)}</strong>
      </div>
    `)
    .join("");
  const runtimeSessions = (snapshot.runtime_sessions || [])
    .slice(0, 10)
    .map((entry) => `
      <div class="metric">
        <span>${escapeHtml(entry.runtime_id || "n/a")} · ${escapeHtml(entry.status || "n/a")}</span>
        <strong>${escapeHtml(entry.task_id || entry.runtime_session_id || "n/a")}</strong>
      </div>
    `)
    .join("");
  els.workersView.innerHTML = `
    <div class="workers-grid">
      <section class="brief-card">
        <div class="section-title">Hybrid Routing Outlook</div>
        <div class="metric-list">${routing || `<div class="metric"><span>Routing</span><strong>no outlook entries</strong></div>`}</div>
      </section>
      <section class="brief-card">
        <div class="section-title">Runtime Sessions</div>
        <div class="metric-list">${runtimeSessions || `<div class="metric"><span>Runtime workers</span><strong>no active sessions</strong></div>`}</div>
      </section>
      <section class="brief-card">
        <div class="section-title">Local Host</div>
        <div class="metric-list">
          <div class="metric"><span>CPU</span><strong>${Math.round((localHost.cpu_utilization || 0) * 100)}%</strong></div>
          <div class="metric"><span>CPU</span><strong>${Math.round((localHost.cpu_utilization || 0) * 100)}%</strong></div>
          <div class="metric"><span>RAM</span><strong>${fmt(localHost.ram_available_gb)} / ${fmt(localHost.ram_total_gb)} GB</strong></div>
          <div class="metric"><span>Swap</span><strong>${fmt(localHost.swap_used_gb)} GB</strong></div>
          <div class="metric"><span>Thermal</span><strong>${escapeHtml(localHost.thermal_pressure || "n/a")}</strong></div>
          <div class="metric"><span>Workers</span><strong>${localHost.worker_count ?? 0} / ${localHost.recommended_worker_count ?? 0}</strong></div>
          <div class="metric"><span>Model lanes</span><strong>${localHost.max_local_model_concurrency ?? 0}</strong></div>
        </div>
      </section>
    </div>
  `;
}

function renderEventsView() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const events = (snapshot.events || []).slice(0, 20);
  els.eventsView.innerHTML = `
    <div class="events-list">
      ${events.length
        ? events
            .map(
              (event) => `
                <article class="event-row">
                  <div class="event-row__meta">${escapeHtml(event.event_type || "event")} · ${escapeHtml(event.source_agent || event.role || "n/a")} · ${escapeHtml(relativeTime(event.created_at))}</div>
                  <div>${escapeHtml(event.content || JSON.stringify(event))}</div>
                </article>
              `
            )
            .join("")
        : `<article class="event-row"><div>No recent bus events.</div></article>`}
    </div>
  `;
}

function renderAgentDetail() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    els.agentDetail.innerHTML = `<div>Waiting for agent telemetry.</div>`;
    return;
  }
  const selected = findAgent(state.selectedAgentId) || snapshot.agents?.[0] || null;
  if (!selected) {
    els.agentDetail.innerHTML = `<div>No agent selected.</div>`;
    return;
  }
  state.selectedAgentId = selected.agent.agent_id;
  const agent = selected.agent;
  els.agentDetail.innerHTML = `
    <div class="agent-detail__header">
      <div>
        <div class="section-title">${escapeHtml(agent.tier)} · ${escapeHtml(agent.role)}</div>
        <div><strong>${escapeHtml(agent.display_name)}</strong></div>
      </div>
      <div>${escapeHtml(selected.state.toUpperCase())}</div>
    </div>
    <div class="sprite">${spriteSvg(selected)}</div>
    <div class="metric-list">
      <div class="metric"><span>Activity</span><strong>${escapeHtml(selected.activity || "n/a")}</strong></div>
      <div class="metric"><span>Location</span><strong>${escapeHtml(selected.location || "n/a")}</strong></div>
      <div class="metric"><span>Evidence</span><strong>${escapeHtml(`${selected.evidence_source || "n/a"} · ${selected.evidence_detail || "n/a"}`)}</strong></div>
      <div class="metric"><span>Children</span><strong>${escapeHtml((agent.managed_agent_ids || []).join(", ") || "none")}</strong></div>
    </div>
  `;
}

function renderAll() {
  const snapshot = state.snapshot;
  if (snapshot) {
    els.subtitle.textContent = `Thread ${snapshot.thread_id} · data age ${relativeTime(snapshot.fetched_at_iso)}`;
  } else {
    els.subtitle.textContent = "Connecting to live MCP operator surface";
  }
  renderStatusStrip();
  renderOfficeView();
  renderBriefingView();
  renderWorkersView();
  renderEventsView();
  renderAgentDetail();
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchBootstrap() {
  state.bootstrap = await getJson("/office/api/bootstrap");
}

async function fetchSnapshot() {
  if (state.snapshotRequest) {
    return state.snapshotRequest;
  }
  const threadId = state.snapshot?.thread_id || state.bootstrap?.default_thread_id || "";
  const params = new URLSearchParams(SNAPSHOT_QUERY);
  if (threadId) {
    params.set("thread_id", threadId);
  }
  state.snapshotRequest = (async () => {
    try {
      state.snapshot = await getJson(`/office/api/snapshot?${params.toString()}`);
      if (!state.selectedAgentId && state.snapshot?.agents?.length) {
        state.selectedAgentId = state.snapshot.agents[0].agent.agent_id;
      }
      renderAll();
      return state.snapshot;
    } finally {
      state.snapshotRequest = null;
    }
  })();
  return state.snapshotRequest;
}

function renderLoadingShell(message = "Waiting for office telemetry.") {
  state.snapshot = null;
  els.intakeResult.textContent = message;
  renderAll();
}

function ensureRefreshLoop() {
  if (state.refreshHandle) return;
  const intervalMs = Math.max(2000, Number(state.bootstrap?.refresh_interval_seconds || 2) * 1000);
  state.refreshHandle = setInterval(() => {
    fetchSnapshot().catch((error) => {
      els.intakeResult.textContent = String(error);
      renderLoadingShell("Snapshot retrying after a partial failure.");
    });
  }, intervalMs);
}

async function postAction(action) {
  const result = await getJson("/office/api/action", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  state.lastResult = JSON.stringify(result, null, 2);
  els.intakeResult.textContent = state.lastResult;
  await fetchSnapshot();
}

async function submitIntake(event) {
  event.preventDefault();
  const objective = document.querySelector("#intake-objective").value.trim();
  if (!objective) {
    els.intakeResult.textContent = "Objective required.";
    return;
  }
  const payload = {
    title: document.querySelector("#intake-title").value.trim(),
    objective,
    risk: document.querySelector("#intake-risk").value,
    mode: document.querySelector("#intake-mode").value,
    dry_run: document.querySelector("#intake-dry-run").checked,
  };
  const result = await getJson("/office/api/intake", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.lastResult = JSON.stringify(result, null, 2);
  els.intakeResult.textContent = state.lastResult;
  await fetchSnapshot();
}

function wireEvents() {
  els.tabs.forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  els.intakeForm.addEventListener("submit", (event) => {
    submitIntake(event).catch((error) => {
      els.intakeResult.textContent = String(error);
    });
  });
  els.refreshButton.addEventListener("click", () => {
    fetchSnapshot().catch((error) => {
      els.intakeResult.textContent = String(error);
    });
  });
  els.actionButtons.forEach((button) =>
    button.addEventListener("click", () => {
      postAction(button.dataset.action).catch((error) => {
        els.intakeResult.textContent = String(error);
      });
    })
  );
}

async function main() {
  document.body.dataset.officeBoot = "booting";
  wireEvents();
  renderLoadingShell();
  try {
    await fetchBootstrap();
  } catch (error) {
    state.bootstrap = {
      default_thread_id: "ring-leader-main",
      refresh_interval_seconds: 2,
    };
    els.intakeResult.textContent = `Bootstrap degraded: ${String(error)}`;
  }
  ensureRefreshLoop();
  try {
    await fetchSnapshot();
  } catch (error) {
    els.intakeResult.textContent = String(error);
    renderLoadingShell("Snapshot retrying after a partial failure.");
  }
  document.body.dataset.officeBoot = "ready";
}

main().catch((error) => {
  document.body.dataset.officeBoot = "failed";
  els.intakeResult.textContent = String(error);
});

window.addEventListener("error", (event) => {
  const message = event?.error?.stack || event?.message || "Unknown GUI error";
  els.intakeResult.textContent = `GUI error: ${message}`;
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  const message =
    typeof reason === "string"
      ? reason
      : reason?.stack || reason?.message || JSON.stringify(reason ?? "Unknown promise rejection");
  els.intakeResult.textContent = `GUI promise rejection: ${message}`;
});
