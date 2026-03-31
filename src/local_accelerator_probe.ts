import { spawnSync } from "node:child_process";

export type LocalAcceleratorProfile = {
  accelerator_kind: "apple-metal" | "nvidia-cuda" | "none";
  vendor: string | null;
  model: string | null;
  api: "metal" | "cuda" | null;
  family: string | null;
  gpu_core_count: number | null;
  gpu_memory_total_gb: number | null;
  gpu_memory_available_gb: number | null;
  gpu_utilization: number | null;
  unified_memory: boolean;
  mlx_python: string | null;
  mlx_available: boolean;
  mlx_lm_available: boolean;
};

type MlxPythonResolutionInput = {
  workspace_root?: string | null;
};

function commandSucceeds(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function readJsonCommand<T>(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(String(result.stdout || "")) as T;
  } catch {
    return null;
  }
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function detectAppleMetalAccelerator(input: {
  memory_total_gb: number;
  memory_available_gb: number;
}) {
  const payload = readJsonCommand<{ SPDisplaysDataType?: Array<Record<string, unknown>> }>("system_profiler", [
    "SPDisplaysDataType",
    "-json",
  ]);
  const entries = Array.isArray(payload?.SPDisplaysDataType) ? payload!.SPDisplaysDataType! : [];
  const gpu = entries.find((entry) => readString(entry.sppci_device_type) === "spdisplays_gpu") ?? entries[0] ?? null;
  if (!gpu) {
    return null;
  }
  const vendor = readString(gpu.spdisplays_vendor);
  const model = readString(gpu.sppci_model) ?? readString(gpu._name);
  const family = readString(gpu.spdisplays_mtlgpufamilysupport);
  const gpuCoreCount = readNumber(gpu.sppci_cores);
  return {
    accelerator_kind: "apple-metal" as const,
    vendor,
    model,
    api: "metal" as const,
    family,
    gpu_core_count: gpuCoreCount === null ? null : Math.round(gpuCoreCount),
    gpu_memory_total_gb: input.memory_total_gb,
    gpu_memory_available_gb: input.memory_available_gb,
    gpu_utilization: null,
    unified_memory: true,
  };
}

function detectNvidiaAccelerator() {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }
  const line = String(result.stdout || "")
    .split(/\n+/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    return null;
  }
  const [nameRaw, memoryTotalMbRaw, memoryUsedMbRaw, utilizationRaw] = line.split(",").map((entry) => entry.trim());
  const memoryTotalMb = readNumber(memoryTotalMbRaw);
  const memoryUsedMb = readNumber(memoryUsedMbRaw);
  const utilizationPercent = readNumber(utilizationRaw);
  return {
    accelerator_kind: "nvidia-cuda" as const,
    vendor: "NVIDIA",
    model: readString(nameRaw),
    api: "cuda" as const,
    family: null,
    gpu_core_count: null,
    gpu_memory_total_gb:
      memoryTotalMb === null ? null : Number((memoryTotalMb / 1024).toFixed(4)),
    gpu_memory_available_gb:
      memoryTotalMb === null || memoryUsedMb === null ? null : Number(((memoryTotalMb - memoryUsedMb) / 1024).toFixed(4)),
    gpu_utilization:
      utilizationPercent === null ? null : Number(Math.max(0, Math.min(1, utilizationPercent / 100)).toFixed(4)),
    unified_memory: false,
  };
}

export function resolvePreferredMlxPython(input: MlxPythonResolutionInput = {}) {
  const workspaceRoot = readString(input.workspace_root);
  const workspaceVenvPython =
    workspaceRoot && workspaceRoot.length > 0
      ? `${workspaceRoot.replace(/\/+$/, "")}/.venv-mlx/bin/python`
      : null;
  const candidates = [
    readString(process.env.TRICHAT_MLX_PYTHON),
    workspaceVenvPython,
    "/opt/homebrew/bin/python3",
    "python3.12",
    "python3.11",
    "python3",
  ].filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    const versionResult = spawnSync(
      candidate,
      [
        "-c",
        "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)",
      ],
      { encoding: "utf8" }
    );
    if (versionResult.status === 0) {
      return candidate;
    }
  }
  return null;
}

function pythonModuleAvailable(pythonCommand: string | null, moduleName: string) {
  if (!pythonCommand) {
    return false;
  }
  return commandSucceeds(pythonCommand, [
    "-c",
    `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`,
  ]);
}

export function probeLocalAccelerator(input: {
  memory_total_gb: number;
  memory_available_gb: number;
  workspace_root?: string | null;
}): LocalAcceleratorProfile {
  const mlxPython = resolvePreferredMlxPython({
    workspace_root: input.workspace_root,
  });
  const mlxAvailable = pythonModuleAvailable(mlxPython, "mlx");
  const mlxLmAvailable = pythonModuleAvailable(mlxPython, "mlx_lm");
  const apple = process.platform === "darwin" ? detectAppleMetalAccelerator(input) : null;
  const nvidia = apple ? null : detectNvidiaAccelerator();
  const accelerator = apple ?? nvidia;
  if (!accelerator) {
    return {
      accelerator_kind: "none",
      vendor: null,
      model: null,
      api: null,
      family: null,
      gpu_core_count: null,
      gpu_memory_total_gb: null,
      gpu_memory_available_gb: null,
      gpu_utilization: null,
      unified_memory: false,
      mlx_python: mlxPython,
      mlx_available: mlxAvailable,
      mlx_lm_available: mlxLmAvailable,
    };
  }
  return {
    ...accelerator,
    mlx_python: mlxPython,
    mlx_available: mlxAvailable,
    mlx_lm_available: mlxLmAvailable,
  };
}
