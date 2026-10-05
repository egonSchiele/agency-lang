import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMlxModelRecord } from "../stdlib/mlxModelRecord.js";
import { _resolveModel } from "../stdlib/localModels.js";
import { listModels } from "./models.js";

describe("listModels", () => {
  let dir: string;
  let models: string;
  let startCwd: string;
  const savedModelsDir = process.env.AGENCY_MODELS_DIR;

  // Each test runs in an empty project of its own, with its own models
  // folder, so it never reads the developer's agency.json or real models.
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "list-models-")));
    models = path.join(dir, "models");
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "agency.json"), "{}");
    startCwd = process.cwd();
    process.chdir(project);
    process.env.AGENCY_MODELS_DIR = models;
  });

  afterEach(() => {
    process.chdir(startCwd);
    if (savedModelsDir === undefined) {
      delete process.env.AGENCY_MODELS_DIR;
    } else {
      process.env.AGENCY_MODELS_DIR = savedModelsDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** An MLX chat model downloaded by Agency. */
  function mlxModel(repo: string, complete: boolean = true): string {
    const at = path.join(models, "mlx", repo.replace("/", "--"));
    fs.mkdirSync(at, { recursive: true });
    const config = JSON.stringify({ architectures: ["Qwen3ForCausalLM"], model_type: "qwen3" });
    fs.writeFileSync(path.join(at, "config.json"), config);
    fs.writeFileSync(path.join(at, "model.safetensors"), "weights");
    writeMlxModelRecord(at, {
      repo,
      revision: "abc123",
      files: { "model.safetensors": { size: 7, complete } },
      kind: "chat",
    });
    return at;
  }

  /** A diffusers image model downloaded by Agency. */
  function diffusersModel(repo: string): string {
    const at = path.join(models, "diffusers", repo.replace("/", "--"));
    fs.mkdirSync(path.join(at, "transformer"), { recursive: true });
    fs.writeFileSync(path.join(at, "model_index.json"), '{"_class_name": "ZImagePipeline"}');
    fs.writeFileSync(path.join(at, "transformer", "config.json"), "{}");
    fs.writeFileSync(path.join(at, "transformer", "model.safetensors"), "weights");
    writeMlxModelRecord(at, {
      repo,
      revision: "def456",
      files: { "transformer/model.safetensors": { size: 7, complete: true } },
      kind: "image",
    });
    return at;
  }

  function setAliases(aliases: Record<string, unknown>): void {
    fs.writeFileSync("agency.json", JSON.stringify({ client: { modelAliases: aliases } }));
  }

  it("returns the directory, kind, family, and revision of an MLX and a diffusers model", () => {
    const chat = mlxModel("org/chat");
    const image = diffusersModel("org/image");
    const listed = listModels();
    expect(listed.find((model) => model.name === "org/chat")).toMatchObject({
      backend: "mlx",
      kind: "chat",
      family: "Qwen3ForCausalLM",
      directory: chat,
      complete: true,
      revision: "abc123",
      aliases: [],
    });
    expect(listed.find((model) => model.name === "org/image")).toMatchObject({
      backend: "diffusers",
      kind: "image",
      family: "ZImagePipeline",
      directory: image,
      complete: true,
      revision: "def456",
    });
  });

  it("lists the aliases that point at a model, by URI and by directory", () => {
    const chat = mlxModel("org/chat");
    diffusersModel("org/image");
    setAliases({
      "my-chat": "mlx:org/chat",
      "chat-folder": chat,
      painter: { backend: "diffusers", uri: "diffusers:org/image", description: "Fast." },
      elsewhere: "mlx:other/repo",
    });
    const listed = listModels();
    expect(listed.find((model) => model.name === "org/chat")?.aliases).toEqual([
      { name: "my-chat", description: "" },
      { name: "chat-folder", description: "" },
    ]);
    expect(listed.find((model) => model.name === "org/image")?.aliases).toEqual([
      { name: "painter", description: "Fast." },
    ]);
  });

  it("matches an alias pinned to a revision only against the download at that revision", () => {
    mlxModel("org/chat");
    setAliases({
      current: "mlx:org/chat@abc",
      older: "mlx:org/chat@fff999",
    });
    expect(listModels().find((model) => model.name === "org/chat")?.aliases).toEqual([
      { name: "current", description: "" },
    ]);
  });

  it("gives every complete MLX or diffusers model a name that resolves", () => {
    mlxModel("org/chat");
    diffusersModel("org/image");
    mlxModel("org/partial", false);
    const servable = listModels().filter(
      (model) => model.complete && model.backend !== "llama-cpp" && model.kind !== "controlnet",
    );
    expect(servable.map((model) => model.name).sort()).toEqual(["org/chat", "org/image"]);
    for (const model of servable) {
      expect(_resolveModel(model.name)).toEqual({
        backend: model.backend,
        target: `${model.backend}:${model.name}`,
      });
    }
  });

  it("lists a download that is not complete, and says so", () => {
    mlxModel("org/partial", false);
    expect(listModels().find((model) => model.name === "org/partial")?.complete).toBe(false);
  });
});
