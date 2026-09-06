import fs from "fs-extra";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig } from "../../config/user";
import { atomicWrite } from "../../utils/atomicWrite";

// Hermes (v0.12+ through v0.20.x) keeps ALL of its config in
// ~/.hermes/config.yaml — NOT config.json. Named custom endpoints live in the
// `providers:` map (keyed by provider id) and the active model is the
// `model.default:` string with `model.provider: custom:<id>` selecting the
// site. The previous MODELSWAP adapter wrote a config.json with a
// models.providers/agents.defaults tree that no Hermes version ever read.
const HERMES_CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");

async function loadHermesConfig(): Promise<Record<string, any>> {
  if (!(await fs.pathExists(HERMES_CONFIG_PATH))) return {};
  const content = await fs.readFile(HERMES_CONFIG_PATH, "utf-8");
  if (!content.trim()) return {};
  return (yaml.load(content) as Record<string, any>) || {};
}

async function saveHermesConfig(data: Record<string, any>): Promise<void> {
  await fs.ensureDir(path.dirname(HERMES_CONFIG_PATH));
  await atomicWrite(HERMES_CONFIG_PATH, yaml.dump(data, { lineWidth: 120, noRefs: true }));
}

function buildProviderEntry(
  provider: Provider,
  modelIds: string[],
  apiKey?: string,
  resolvedModels?: Record<string, ResolvedModel | undefined>,
): Record<string, any> {
  const entry: Record<string, any> = {
    api: provider.baseUrl,
    default_model: modelIds[0],
    // Pin the site to exactly the models ModelSwap selected: a LIST-shaped
    // `models:` is Hermes's ID allowlist, and `discover_models: false` stops
    // its live /models probe from replacing it with the site's full catalog
    // (dict-shaped models is mere metadata — that's why the full site catalog
    // used to show through). See hermes_cli/model_switch_providers.py.
    discover_models: false,
    models: [...modelIds],
  };
  if (apiKey) entry.api_key = apiKey;
  entry.transport = provider.type === "anthropic" ? "anthropic_messages" : "chat_completions";
  // The opencode.ai gateway rate-limits anonymous traffic separately from the
  // official opencode client (verified 429 without the UA). Hermes sends its
  // own UA, so pin the opencode client's one via extra_headers (see gateway.ts).
  const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
  if (gatewayHeaders) entry.extra_headers = gatewayHeaders;
  // Per-model facts ride in a sibling key — `models` must stay a list to keep
  // its allowlist meaning.
  const facts: Record<string, Record<string, any>> = {};
  for (const modelId of modelIds) {
    const resolvedModel = resolvedModels?.[modelId];
    const modelFacts: Record<string, any> = {};
    if (Number.isFinite(resolvedModel?.context)) modelFacts.context_length = resolvedModel!.context;
    if (resolvedModel?.modalities.input?.includes("image")) modelFacts.supports_vision = true;
    if (Object.keys(modelFacts).length) facts[modelId] = modelFacts;
  }
  if (Object.keys(facts).length) entry.model_facts = facts;
  return entry;
}

export class HermesAdapter extends BaseAdapter {
  readonly id = "hermes";
  readonly name = "Hermes";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const state = config.agentProviders?.hermes;
    if (state?.activeProviderId && state?.activeModelId) {
      return { providerId: state.activeProviderId, modelId: state.activeModelId };
    }
    return null;
  }

  async applyConfig(provider: Provider, modelId: string, resolvedModel?: ResolvedModel): Promise<void> {
    // `modelId` is the routed provider-native model ID. The resolved ID is
    // canonical metadata and must never replace it in Hermes config.
    const apiKey = await this.resolveApiKey(provider);
    const data = await loadHermesConfig();

    if (typeof data.providers !== "object" || data.providers === null || Array.isArray(data.providers)) {
      data.providers = {};
    }
    data.providers[provider.id] = buildProviderEntry(provider, [modelId], apiKey, { [modelId]: resolvedModel });

    // Active model selects the named custom provider and its default model.
    if (typeof data.model !== "object" || data.model === null) data.model = {};
    data.model.default = modelId;
    data.model.provider = `custom:${provider.id}`;
    // ModelSwap never writes model.base_url; drop stale values left by older
    // writes so the active provider block is the single source of truth.
    delete data.model.base_url;
    if (Number.isFinite(resolvedModel?.context)) data.model.context_length = resolvedModel!.context;
    else delete data.model.context_length;
    if (Number.isFinite(resolvedModel?.output)) data.model.max_tokens = resolvedModel!.output;
    else delete data.model.max_tokens;
    if (resolvedModel?.modalities.input?.includes("image")) data.model.supports_vision = true;
    else delete data.model.supports_vision;
    // `reasoning` has no provider-neutral Hermes setting. It is expressed via
    // provider-specific `extra_body`, so emitting one from a boolean fact
    // would be an unsupported guess.

    await saveHermesConfig(data);
  }

  // Additive (multi-site) support: Hermes natively keeps every configured
  // site in the `providers:` map and lets you switch between them in its own
  // UI. applyModels upserts one site's entry (all its selected models' facts
  // merged, first model as default_model) without touching other sites or
  // the active `model:` block.
  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };
    const data = await loadHermesConfig();
    if (typeof data.providers !== "object" || data.providers === null || Array.isArray(data.providers)) {
      data.providers = {};
    }

    const bySite = new Map<string, { provider: Provider; modelIds: string[] }>();
    for (const { provider, modelId } of entries) {
      const slot = bySite.get(provider.id) || { provider, modelIds: [] };
      slot.modelIds.push(modelId);
      bySite.set(provider.id, slot);
    }

    const written: string[] = [];
    for (const { provider, modelIds } of bySite.values()) {
      const apiKey = await this.resolveApiKey(provider);
      data.providers[provider.id] = buildProviderEntry(provider, modelIds, apiKey);
      written.push(...modelIds);
    }

    await saveHermesConfig(data);
    return { written, skipped: [] };
  }

  // Which MODELSWAP provider ids currently have a `providers:` entry — a
  // present entry = the site is enabled (Hermes has no per-site enabled flag).
  async listEnabledProviders(): Promise<string[]> {
    const data = await loadHermesConfig();
    if (typeof data.providers !== "object" || data.providers === null) return [];
    return Object.keys(data.providers);
  }

  // Chip click / site save (activate): move Hermes's active model to this
  // site+model. Unlike applyConfig this never narrows the site's allowlist —
  // it only repoints model: (and the entry's default_model) so Hermes starts
  // using the switched model on its next run.
  async activateModel(provider: Provider, modelId: string, resolvedModel?: ResolvedModel): Promise<void> {
    const data = await loadHermesConfig();
    if (typeof data.providers !== "object" || data.providers === null) data.providers = {};
    const entry = data.providers[provider.id];
    if (entry && typeof entry === "object") entry.default_model = modelId;

    if (typeof data.model !== "object" || data.model === null) data.model = {};
    data.model.default = modelId;
    data.model.provider = `custom:${provider.id}`;
    delete data.model.base_url;
    if (Number.isFinite(resolvedModel?.context)) data.model.context_length = resolvedModel!.context;
    else delete data.model.context_length;
    if (Number.isFinite(resolvedModel?.output)) data.model.max_tokens = resolvedModel!.output;
    else delete data.model.max_tokens;
    if (resolvedModel?.modalities.input?.includes("image")) data.model.supports_vision = true;
    else delete data.model.supports_vision;
    await saveHermesConfig(data);
  }

  // Remove one site's entry entirely. If the removed site was the active one,
  // clear `model.provider`/`model.default` so Hermes falls back to its
  // built-in default instead of dangling `custom:<removed-id>`.
  async removeProvider(providerId: string): Promise<void> {
    const data = await loadHermesConfig();
    if (typeof data.providers !== "object" || data.providers === null) return;
    if (!(providerId in data.providers)) return;
    delete data.providers[providerId];
    if (data.model?.provider === `custom:${providerId}`) {
      delete data.model.provider;
      delete data.model.default;
    }
    await saveHermesConfig(data);
  }
}
