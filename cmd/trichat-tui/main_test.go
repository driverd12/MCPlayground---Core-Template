package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseJSONLineFallbackDirect(t *testing.T) {
	type payload struct {
		Kind string `json:"kind"`
	}
	parsed, usedFallback, err := parseJSONLineFallback[payload](`{"kind":"ok"}`)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if usedFallback {
		t.Fatalf("expected direct parse without fallback")
	}
	if parsed.Kind != "ok" {
		t.Fatalf("expected kind=ok, got %q", parsed.Kind)
	}
}

func TestParseJSONLineFallbackWithNoise(t *testing.T) {
	type payload struct {
		Kind string `json:"kind"`
	}
	raw := "bridge note: warming up\n{\"kind\":\"ok\"}\n"
	parsed, usedFallback, err := parseJSONLineFallback[payload](raw)
	if err != nil {
		t.Fatalf("expected fallback parse to succeed, got %v", err)
	}
	if !usedFallback {
		t.Fatalf("expected fallback parse to be used")
	}
	if parsed.Kind != "ok" {
		t.Fatalf("expected kind=ok, got %q", parsed.Kind)
	}
}

func TestParseJSONLineFallbackInvalid(t *testing.T) {
	type payload struct {
		Kind string `json:"kind"`
	}
	if _, _, err := parseJSONLineFallback[payload]("not-json"); err == nil {
		t.Fatalf("expected invalid JSON parse to fail")
	}
}

func TestClassifyCommandAdapterError(t *testing.T) {
	class := classifyCommandAdapterError("bridge command failed: command not found: codex")
	if !class.Persistent {
		t.Fatalf("expected command-not-found to be persistent")
	}
	if class.Code != "command_not_found" {
		t.Fatalf("unexpected class code: %q", class.Code)
	}
	if class.SuppressFor < time.Minute {
		t.Fatalf("expected non-trivial suppression window, got %s", class.SuppressFor)
	}
}

func TestClassifyModelAdapterError(t *testing.T) {
	class := classifyModelAdapterError("ollama request failed on /api/chat: context deadline exceeded")
	if !class.Retryable {
		t.Fatalf("expected deadline errors to be retryable")
	}
	if class.Persistent {
		t.Fatalf("did not expect deadline errors to be persistent")
	}
	if class.Code != "timeout" {
		t.Fatalf("unexpected class code: %q", class.Code)
	}
}

func TestParseSuppressionMetadata(t *testing.T) {
	until := time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339)
	parsedUntil, reason := parseSuppressionMetadata(map[string]any{
		"suppressed_until":   until,
		"suppression_reason": "command_not_found: codex",
	})
	if reason != "command_not_found: codex" {
		t.Fatalf("unexpected suppression reason: %q", reason)
	}
	if parsedUntil.IsZero() {
		t.Fatalf("expected non-zero suppressed_until")
	}
}

func TestDeriveAdaptiveTimeoutsApplies(t *testing.T) {
	settings := runtimeSettings{
		modelTimeoutSeconds:          30,
		bridgeTimeoutSeconds:         60,
		adapterFailoverTimeoutSecond: 75,
		adaptiveTimeoutsEnabled:      true,
		adaptiveTimeoutMinSamples:    10,
		adaptiveTimeoutMaxStepSecond: 8,
	}
	slo := triChatSloStatusResp{}
	slo.Metrics.Adapter.LatencySamples = 40
	p95 := 18000.0
	slo.Metrics.Adapter.P95LatencyMS = &p95
	slo.Metrics.Adapter.ErrorRate = 0.14
	slo.Metrics.Turns.FailureRate = 0.11

	tuned, info := deriveAdaptiveTimeouts(settings, slo)
	if !info.Applied {
		t.Fatalf("expected adaptive tuning to apply")
	}
	if tuned.modelTimeoutSeconds <= settings.modelTimeoutSeconds {
		t.Fatalf("expected model timeout increase, got %d", tuned.modelTimeoutSeconds)
	}
	if tuned.bridgeTimeoutSeconds < settings.bridgeTimeoutSeconds {
		t.Fatalf("expected bridge timeout not to shrink on elevated error profile, got %d", tuned.bridgeTimeoutSeconds)
	}
}

func TestDeriveAdaptiveTimeoutsSkipsWithInsufficientSamples(t *testing.T) {
	settings := runtimeSettings{
		modelTimeoutSeconds:          20,
		bridgeTimeoutSeconds:         30,
		adapterFailoverTimeoutSecond: 45,
		adaptiveTimeoutsEnabled:      true,
		adaptiveTimeoutMinSamples:    20,
		adaptiveTimeoutMaxStepSecond: 8,
	}
	slo := triChatSloStatusResp{}
	slo.Metrics.Adapter.LatencySamples = 5
	p95 := 8000.0
	slo.Metrics.Adapter.P95LatencyMS = &p95

	tuned, info := deriveAdaptiveTimeouts(settings, slo)
	if info.Applied {
		t.Fatalf("expected adaptive tuning to skip")
	}
	if info.Reason != "insufficient-samples" {
		t.Fatalf("unexpected skip reason: %q", info.Reason)
	}
	if tuned.modelTimeoutSeconds != settings.modelTimeoutSeconds {
		t.Fatalf("expected model timeout unchanged, got %d", tuned.modelTimeoutSeconds)
	}
	if tuned.bridgeTimeoutSeconds != settings.bridgeTimeoutSeconds {
		t.Fatalf("expected bridge timeout unchanged, got %d", tuned.bridgeTimeoutSeconds)
	}
}

func TestSuppressionStatePersistsAcrossCollectRestore(t *testing.T) {
	cfg := appConfig{
		codexCommand:                 "python3 ./bridges/codex_bridge.py",
		cursorCommand:                "python3 ./bridges/cursor_bridge.py",
		imprintCommand:               "python3 ./bridges/local-imprint_bridge.py",
		adapterCircuitThreshold:      2,
		adapterCircuitRecoverySecond: 45,
	}
	settings := runtimeSettings{
		adapterCircuitThreshold:      2,
		adapterCircuitRecoverySecond: 45,
	}

	orch := newOrchestrator(cfg)
	orch.agents["codex"].mu.Lock()
	orch.agents["codex"].commandSuppressedUntil = time.Now().Add(90 * time.Second).UTC()
	orch.agents["codex"].commandSuppressionCause = "command_not_found: codex"
	orch.agents["codex"].mu.Unlock()

	rawStates := orch.collectStates(cfg, settings)
	if len(rawStates) == 0 {
		t.Fatalf("expected collected states")
	}

	states := make([]adapterState, 0, len(rawStates))
	for _, raw := range rawStates {
		buf, err := json.Marshal(raw)
		if err != nil {
			t.Fatalf("marshal collected state: %v", err)
		}
		var state adapterState
		if err := json.Unmarshal(buf, &state); err != nil {
			t.Fatalf("unmarshal collected state: %v", err)
		}
		states = append(states, state)
	}

	restored := newOrchestrator(cfg)
	restored.restoreStates(states, settings)

	restoredAgent := restored.agents["codex"]
	restoredAgent.mu.Lock()
	defer restoredAgent.mu.Unlock()
	if restoredAgent.commandSuppressedUntil.IsZero() {
		t.Fatalf("expected command suppression timestamp to be restored")
	}
	if restoredAgent.commandSuppressionCause == "" {
		t.Fatalf("expected command suppression reason to be restored")
	}
}

func TestParseCouncilQuestionFallbackTarget(t *testing.T) {
	question := parseCouncilQuestion(
		`{"target_agent":"unknown","question":"Can you provide rollback steps?","rationale":"need recovery coverage","urgency":0.7}`,
		"codex",
		[]string{"codex", "cursor", "local-imprint"},
	)
	if question.TargetAgent != "cursor" {
		t.Fatalf("expected fallback target cursor, got %q", question.TargetAgent)
	}
	if question.Question == "" {
		t.Fatalf("expected non-empty question")
	}
	if question.Urgency <= 0 {
		t.Fatalf("expected urgency > 0")
	}
}

func TestBuildInteropPromptIncludesCouncilQuestions(t *testing.T) {
	incoming := []councilQuestion{
		{
			AskerAgent:  "cursor",
			TargetAgent: "codex",
			Question:    "How will you validate rollback safety?",
			Rationale:   "execution safety",
			Urgency:     0.8,
		},
	}
	prompt := buildInteropPromptForAgent(
		"Ship feature safely",
		"codex",
		[]string{"cursor", "local-imprint"},
		1,
		"cursor: plan\nlocal-imprint: risk",
		"cursor->codex: add tests",
		incoming,
	)
	if !strings.Contains(prompt, "Incoming council questions") {
		t.Fatalf("expected council question section in interop prompt")
	}
	if !strings.Contains(prompt, "How will you validate rollback safety?") {
		t.Fatalf("expected council question text in interop prompt")
	}
}

func TestShouldContinueCouncilConvergenceStopsOnLatencyBudget(t *testing.T) {
	novelty := triChatNoveltyResp{
		Found:         true,
		RetryRequired: true,
		Disagreement:  true,
		NoveltyScore:  0.34,
	}
	continueLoop, reason := shouldContinueCouncilConvergence(
		2,
		1,
		6,
		50*time.Second,
		45*time.Second,
		novelty,
		0.22,
		0.34,
		0.05,
	)
	if continueLoop {
		t.Fatalf("expected convergence loop to stop on latency budget")
	}
	if reason != "latency-budget" {
		t.Fatalf("expected reason latency-budget, got %q", reason)
	}
}

func TestShouldContinueCouncilConvergenceStopsOnNoveltyImproved(t *testing.T) {
	novelty := triChatNoveltyResp{
		Found:         true,
		RetryRequired: true,
		Disagreement:  true,
		NoveltyScore:  0.41,
	}
	continueLoop, reason := shouldContinueCouncilConvergence(
		3,
		1,
		6,
		12*time.Second,
		45*time.Second,
		novelty,
		0.25,
		0.42,
		0.05,
	)
	if continueLoop {
		t.Fatalf("expected convergence loop to stop after novelty improvement")
	}
	if reason != "novelty-improved" {
		t.Fatalf("expected reason novelty-improved, got %q", reason)
	}
}

func TestIsCouncilTranscriptMessageClassification(t *testing.T) {
	council := triChatMessage{
		AgentID: "codex",
		Role:    "assistant",
		Content: "@cursor can you prove rollback safety?",
		Metadata: map[string]any{
			"kind":             "fanout-council-question",
			"council_exchange": true,
		},
	}
	if !isCouncilTranscriptMessage(council) {
		t.Fatalf("expected council message classification")
	}

	userFacing := triChatMessage{
		AgentID: "codex",
		Role:    "assistant",
		Content: "Here is my final recommendation.",
		Metadata: map[string]any{
			"kind": "fanout-response",
		},
	}
	if isCouncilTranscriptMessage(userFacing) {
		t.Fatalf("did not expect user-facing assistant reply to be classified as council")
	}
}

func TestNormalizeCouncilStripMode(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "always", want: "always"},
		{input: "AUTO", want: "auto"},
		{input: "off", want: "off"},
		{input: "invalid", want: "auto"},
	}
	for _, tc := range cases {
		got := normalizeCouncilStripMode(tc.input)
		if got != tc.want {
			t.Fatalf("normalizeCouncilStripMode(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestRenderTimelineCouncilStripModes(t *testing.T) {
	baseMessages := []triChatMessage{
		{
			AgentID: "codex",
			Role:    "assistant",
			Content: "@cursor challenge this merge plan",
			Metadata: map[string]any{
				"kind":             "fanout-council-question",
				"council_exchange": true,
			},
		},
		{
			AgentID: "cursor",
			Role:    "assistant",
			Content: "User-facing answer",
			Metadata: map[string]any{
				"kind": "fanout-response",
			},
		},
	}

	modeOff := model{
		theme:    newTheme(),
		settings: runtimeSettings{councilStripMode: "off"},
		messages: baseMessages,
	}
	offRendered := modeOff.renderTimeline()
	if strings.Contains(offRendered, "Council Transcript Strip") {
		t.Fatalf("expected council strip hidden when mode=off")
	}

	modeAuto := model{
		theme:    newTheme(),
		settings: runtimeSettings{councilStripMode: "auto"},
		messages: baseMessages,
	}
	autoRendered := modeAuto.renderTimeline()
	if !strings.Contains(autoRendered, "Council Transcript Strip") {
		t.Fatalf("expected council strip visible when mode=auto and council messages exist")
	}

	modeAlways := model{
		theme:    newTheme(),
		settings: runtimeSettings{councilStripMode: "always"},
		messages: []triChatMessage{
			{
				AgentID: "cursor",
				Role:    "assistant",
				Content: "No council message in this turn",
				Metadata: map[string]any{
					"kind": "fanout-response",
				},
			},
		},
	}
	alwaysRendered := modeAlways.renderTimeline()
	if !strings.Contains(alwaysRendered, "Council Transcript Strip") {
		t.Fatalf("expected council strip visible when mode=always")
	}
}

func TestFanoutUsesParallelAsksWithQuorumFirstFinalize(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "mock_bridge.py")
	script := `#!/usr/bin/env python3
import json
import sys
import time

delay = 0.0
if len(sys.argv) > 1:
    delay = float(sys.argv[1])

payload = json.loads(sys.stdin.read() or "{}")
request_id = str(payload.get("request_id", ""))
agent_id = str(payload.get("agent_id", ""))
op = str(payload.get("op", "ask"))

if op == "ask":
    time.sleep(delay)
    envelope = {
        "kind": "trichat.adapter.response",
        "protocol_version": "trichat-bridge-v1",
        "request_id": request_id,
        "agent_id": agent_id,
        "bridge": "mock-bridge",
        "content": f"{agent_id} quick response",
        "meta": {"mock": True}
    }
else:
    envelope = {
        "kind": "trichat.adapter.pong",
        "protocol_version": "trichat-bridge-v1",
        "request_id": request_id,
        "agent_id": agent_id,
        "bridge": "mock-bridge",
        "timestamp": "2026-01-01T00:00:00Z",
        "meta": {"mock": True}
    }

sys.stdout.write(json.dumps(envelope))
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock bridge script: %v", err)
	}

	cfg := appConfig{
		repoRoot:                     tmpDir,
		codexCommand:                 fmt.Sprintf("python3 %s 0.04", shellQuote(scriptPath)),
		cursorCommand:                fmt.Sprintf("python3 %s 0.05", shellQuote(scriptPath)),
		imprintCommand:               fmt.Sprintf("python3 %s 3.80", shellQuote(scriptPath)),
		model:                        defaultModel,
		modelTimeoutSeconds:          10,
		bridgeTimeoutSeconds:         10,
		adapterFailoverTimeoutSecond: 10,
		adapterCircuitThreshold:      2,
		adapterCircuitRecoverySecond: 45,
	}
	settings := runtimeSettings{
		model:                        defaultModel,
		consensusMinAgents:           2,
		modelTimeoutSeconds:          10,
		bridgeTimeoutSeconds:         10,
		adapterFailoverTimeoutSecond: 10,
		adapterCircuitThreshold:      2,
		adapterCircuitRecoverySecond: 45,
	}
	orch := newOrchestrator(cfg)

	startedAt := time.Now()
	responses, _ := orch.fanout(
		"TRICHAT_TURN_PHASE=propose\nTest quorum-first fanout",
		nil,
		nil,
		cfg,
		settings,
		"all",
		"trichat-test-thread",
		"",
	)
	duration := time.Since(startedAt)

	if duration >= 2*time.Second {
		t.Fatalf("expected quorum-first fanout under 2s, got %s", duration)
	}
	if len(responses) != 2 {
		t.Fatalf("expected exactly 2 quorum responses, got %d", len(responses))
	}

	responders := map[string]bool{}
	for _, response := range responses {
		responders[response.agentID] = true
		if !fanoutResponseCountsTowardQuorum(response) {
			t.Fatalf("response from %s should count toward quorum", response.agentID)
		}
	}
	if responders["local-imprint"] {
		t.Fatalf("expected slow straggler local-imprint to be skipped by quorum finalize")
	}
}

func TestFanoutResponseCountsTowardQuorumSkipsDegraded(t *testing.T) {
	ok := fanoutResponseCountsTowardQuorum(agentResponse{
		agentID: "codex",
		content: "ready",
		adapterMeta: map[string]any{
			"adapter":  "command",
			"degraded": false,
		},
	})
	if !ok {
		t.Fatalf("expected non-degraded response to count toward quorum")
	}

	degraded := fanoutResponseCountsTowardQuorum(agentResponse{
		agentID: "cursor",
		content: "degraded",
		adapterMeta: map[string]any{
			"adapter":  "degraded",
			"degraded": true,
		},
	})
	if degraded {
		t.Fatalf("expected degraded response to be excluded from quorum")
	}
}
