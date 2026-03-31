const roomOrder = ["command_deck", "lounge", "build_bay", "ops_rack"];
const roomNames = {
  command_deck: "Command Deck",
  lounge: "Lounge + Water",
  build_bay: "Build Bay",
  ops_rack: "Ops Rack",
};

const stateLabels = {
  working: "WORK",
  supervising: "LEAD",
  talking: "CHAT",
  break: "BREAK",
  sleeping: "SLEEP",
  blocked: "BLOCK",
  offline: "DOWN",
  idle: "IDLE",
};

let latestSnapshot = null;
let selectedAgentId = null;
let refreshTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compact(value, fallback = "n/a") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function byId(id) {
  return document.getElementById(id);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function renderStatusStrip(snapshot) {
  const summary = snapshot.summary || {};
  const tasks = summary.tasks || {};
  const kernel = summary.kernel || {};
  const host = summary.local_host || {};
  const router = summary.router || {};
  const reaction = summary.reaction_engine || {};
  const chips = [
    ["Kernel", `${compact(kernel.state)} / healthy ${kernel.healthy ?? 0}`],
    ["Tasks", `run ${tasks.running ?? 0} pending ${tasks.pending ?? 0} failed ${tasks.failed ?? 0}`],
    ["Host", `cpu ${Math.round((host.cpu_utilization || 0) * 100)}% ram ${host.ram_available_gb ?? 0}/${host.ram_total_gb ?? 0}GB`],
    ["Router", `${compact(router.default_backend_id)} / ${router.enabled_backend_count ?? 0} backends`],
    ["Runtime", `${summary.runtime_workers?.active_count ?? 0} active / ${summary.runtime_workers?.session_count ?? 0} sessions`],
    ["Reactions", `${reaction.runtime_running ? "live" : "down"} / sent ${reaction.last_sent_count ?? 0}`],
  ];
  byId("status-strip").innerHTML = chips
    .map(([label, value]) => `<div class="chip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`)
    .join("");
}

function findAgent(agentId) {
  return (latestSnapshot?.agents || []).find((entry) => entry.agent?.agent_id === agentId) || null;
}

function spriteTileMarkup(entry) {
  const agent = entry.agent || {};
  const state = compact(entry.state, "idle").toLowerCase();
  const tier = compact(agent.tier, "leaf").toLowerCase();
  const name = compact(agent.display_name, agent.agent_id);
  const evidence = compact(entry.evidence_detail);
  const activity = compact(entry.activity);
  return `
    <button class="agent-tile state-${escapeHtml(state)} tier-${escapeHtml(tier)} ${selectedAgentId === agent.agent_id ? "selected" : ""}" data-agent-id="${escapeHtml(agent.agent_id)}">
      <div class="agent-head">
        <div class="agent-name">${escapeHtml(name)}</div>
        <div class="tier-badge">${escapeHtml(tier)}</div>
      </div>
      <div class="agent-scene">
        <div class="sprite-wrap">
          <div class="monitor"></div>
          <div class="pixel-sprite"></div>
          <div class="desk"></div>
        </div>
        <div>
          <div class="state-badge">${escapeHtml(stateLabels[state] || state.toUpperCase())}</div>
          <div class="agent-activity">${escapeHtml(activity)}</div>
        </div>
      </div>
      <div class="agent-evidence">${escapeHtml(evidence)}</div>
    </button>
  `;
}

function renderRooms(snapshot) {
  const agentsById = new Map((snapshot.agents || []).map((entry) => [entry.agent?.agent_id, entry]));
  for (const roomId of roomOrder) {
    const container = byId(`room-${roomId}`);
    const ids = snapshot.rooms?.[roomId] || [];
    if (!ids.length) {
      container.innerHTML = `<div class="agent-tile"><div class="agent-name">${escapeHtml(roomNames[roomId])}</div><div class="agent-activity">No agents currently present.</div></div>`;
      continue;
    }
    container.innerHTML = ids
      .map((agentId) => agentsById.get(agentId))
      .filter(Boolean)
      .map((entry) => spriteTileMarkup(entry))
      .join("");
  }
}

function renderInspector(snapshot) {
  const current = snapshot.current || {};
  const selected = selectedAgentId ? findAgent(selectedAgentId) : null;
  if (selected) {
    const agent = selected.agent || {};
    byId("inspector").innerHTML = `
      <div class="details-grid">
        <div>
          <h3>${escapeHtml(compact(agent.display_name, agent.agent_id))}</h3>
          <div>${escapeHtml(compact(agent.description))}</div>
        </div>
        <div>
          <strong>State</strong>
          <div>${escapeHtml(compact(selected.state))} :: ${escapeHtml(compact(selected.activity))}</div>
        </div>
        <div>
          <strong>Evidence</strong>
          <div>${escapeHtml(compact(selected.evidence_source))} :: ${escapeHtml(compact(selected.evidence_detail))}</div>
        </div>
        <div>
          <strong>Actions</strong>
          <div>${escapeHtml((selected.actions || []).join(", ") || "none")}</div>
        </div>
      </div>
    `;
    return;
  }
  byId("inspector").innerHTML = `
    <div class="details-grid">
      <div>
        <h3>Ring Leader</h3>
        <div>${escapeHtml(compact(current.current_objective))}</div>
      </div>
      <div>
        <strong>Spawn Path</strong>
        <div>${escapeHtml((current.spawn_path || []).join(" -> ") || "n/a")}</div>
      </div>
      <div>
        <strong>Execution Tasks</strong>
        <div>${escapeHtml((current.execution_task_ids || []).join(", ") || "none")}</div>
      </div>
    </div>
  `;
}

function renderMission(snapshot) {
  const current = snapshot.current || {};
  byId("current-objective").textContent = compact(current.current_objective);
  byId("current-strategy").textContent = `${compact(current.selected_strategy)} | selected agent: ${compact(current.selected_agent)}`;
  byId("delegation-brief").textContent = JSON.stringify(current.delegation_brief || {}, null, 2);
  byId("confidence-method").textContent = JSON.stringify(current.confidence_method || {}, null, 2);
}

function renderRuntimeSummary(snapshot) {
  const summary = snapshot.summary || {};
  const router = summary.router || {};
  const host = summary.local_host || {};
  const runtime = summary.runtime_workers || {};
  const maintain = summary.maintain || {};
  const swarm = summary.swarm || {};
  const items = [
    ["Host", `${host.host_id || "local"} / workers ${host.worker_count ?? 0} / recommended ${host.recommended_worker_count ?? 0}`],
    ["Memory", `${host.ram_available_gb ?? 0}GB free / swap ${host.swap_used_gb ?? 0}GB / thermal ${host.thermal_pressure || "n/a"}`],
    ["Router", `${router.live_backend?.backend_id || "n/a"} / loaded ${router.live_backend?.probe_model_loaded ? "yes" : "no"} / resident ${router.live_backend?.probe_resident_model_count ?? 0}`],
    ["Runtime", `active ${runtime.active_count ?? 0} / failed ${runtime.failed_count ?? 0} / sessions ${runtime.session_count ?? 0}`],
    ["Maintain", `${maintain.running ? "running" : "stopped"} / eval_due ${maintain.eval_due ? "yes" : "no"} / score ${maintain.last_eval_score ?? "n/a"}`],
    ["Swarm", `profiles ${swarm.active_profile_count ?? 0} / checkpoints ${swarm.checkpoint_artifact_count ?? 0}`],
  ];
  byId("runtime-summary").innerHTML = items
    .map(([label, value]) => `<div class="metric-row"><strong>${escapeHtml(label)}</strong><div>${escapeHtml(value)}</div></div>`)
    .join("");
}

function renderEvents(snapshot) {
  const events = snapshot.events || [];
  if (!events.length) {
    byId("event-feed").innerHTML = `<div class="event-item"><strong>Events</strong><div>No recent bus events.</div></div>`;
    return;
  }
  byId("event-feed").innerHTML = events
    .slice(0, 10)
    .map((event) => `
      <div class="event-item">
        <strong>${escapeHtml(compact(event.event_type, "event"))}</strong>
        <div>${escapeHtml(compact(event.content || event.summary || event.role || ""))}</div>
        <div>${escapeHtml(compact(event.created_at))}</div>
      </div>
    `)
    .join("");
}

function attachRoomHandlers() {
  document.querySelectorAll("[data-agent-id]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedAgentId = element.getAttribute("data-agent-id");
      renderAll(latestSnapshot);
    });
  });
}

async function postJson(url, payload) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function runAction(action) {
  const result = await postJson("/api/action", { action });
  byId("intake-result").textContent = `Action ${action} completed.`;
  await refreshSnapshot();
  return result;
}

async function submitIntake(event) {
  event.preventDefault();
  const objective = byId("objective-input").value.trim();
  if (!objective) {
    byId("intake-result").textContent = "Objective is required.";
    return;
  }
  byId("intake-result").textContent = "Dispatching objective...";
  const result = await postJson("/api/intake", {
    objective,
    dry_run: byId("dry-run-toggle").checked,
  });
  byId("intake-result").textContent = `Objective accepted. Goal: ${compact(result.result?.autonomy?.goal?.goal_id, "created")}`;
  byId("objective-input").value = "";
  await refreshSnapshot();
}

function renderAll(snapshot) {
  if (!snapshot) {
    return;
  }
  latestSnapshot = snapshot;
  renderStatusStrip(snapshot);
  renderMission(snapshot);
  renderRooms(snapshot);
  renderInspector(snapshot);
  renderRuntimeSummary(snapshot);
  renderEvents(snapshot);
  attachRoomHandlers();
}

async function refreshSnapshot() {
  const snapshot = await fetchJson("/api/snapshot");
  renderAll(snapshot);
}

async function bootstrap() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      byId("intake-result").textContent = `Running ${button.dataset.action}...`;
      try {
        await runAction(button.dataset.action);
      } catch (error) {
        byId("intake-result").textContent = String(error);
      }
    });
  });
  byId("refresh-now").addEventListener("click", () => refreshSnapshot().catch((error) => {
    byId("intake-result").textContent = String(error);
  }));
  byId("intake-form").addEventListener("submit", (event) => {
    submitIntake(event).catch((error) => {
      byId("intake-result").textContent = String(error);
    });
  });
  await refreshSnapshot();
  refreshTimer = window.setInterval(() => {
    refreshSnapshot().catch((error) => {
      byId("intake-result").textContent = String(error);
    });
  }, 2500);
}

window.addEventListener("beforeunload", () => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
});

bootstrap().catch((error) => {
  byId("intake-result").textContent = String(error);
});
