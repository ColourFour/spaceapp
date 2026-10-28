import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
  stopReload: vi.fn(),
  reload: vi.fn(),
  create: vi.fn(),
  connect: vi.fn(),
  workflowModules: ["synthetic-workflow-interceptor"],
  sinks: { syntheticTraceSink: {} }
}));

vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect: state.connect },
  Worker: { create: state.create }
}));
vi.mock("@space/runtime", () => ({
  otlpSpanExporterFromEnv: () => ({ close: state.close })
}));
vi.mock("../src/memory-maintenance-activities.js", () => ({}));
vi.mock("../src/memory-mutation-activity.js", () => ({ executePersistedMemoryChangeSet: vi.fn() }));
vi.mock("../src/activity-observability.js", () => ({ createActivityObservabilityInterceptors: vi.fn() }));
vi.mock("../src/workflow-tracing.js", () => ({
  workflowTracing: () => ({ workflowModules: state.workflowModules, sinks: state.sinks })
}));
vi.mock("../src/deployed-code-reload.js", () => ({ reloadWhenServicesCommitChanges: state.reload }));

describe("memory worker entrypoints retain tracing and deployment reload cleanup", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    previousExitCode = process.exitCode;
    vi.stubEnv("SPACE_MEMORY_GRAPH_ENABLED", "true");
    vi.stubEnv("SPACE_MEMORY_MAINTENANCE_ENABLED", "true");
    vi.stubEnv("SPACE_MEMORY_MUTATIONS_ENABLED", "true");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.connect.mockResolvedValue({});
    state.create.mockResolvedValue({ run: state.run });
    state.run.mockResolvedValue(undefined);
    state.close.mockResolvedValue(undefined);
    state.reload.mockReturnValue(state.stopReload);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const kind of ["maintenance", "mutation"] as const) {
    for (const fails of [false, true]) {
      it(`${kind}: closes tracing and stops the reload watcher when run ${fails ? "rejects" : "resolves"}`, async () => {
        const error = new Error("synthetic worker failure");
        if (fails) state.run.mockRejectedValue(error);
        const started = kind === "maintenance"
          ? import("../src/memory-maintenance-worker.js")
          : import("../src/memory-mutation-worker.js");
        if (fails && kind === "mutation") {
          await expect(started).rejects.toBe(error);
        } else {
          await started;
          if (fails) expect(process.exitCode).toBe(1);
        }
        expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
          interceptors: expect.objectContaining({ workflowModules: state.workflowModules }),
          sinks: state.sinks
        }));
        expect(state.reload).toHaveBeenCalledWith(expect.objectContaining({ run: state.run }), expect.any(Object));
        expect(state.stopReload).toHaveBeenCalledTimes(1);
        expect(state.close).toHaveBeenCalledTimes(1);
      });
    }
  }
});
