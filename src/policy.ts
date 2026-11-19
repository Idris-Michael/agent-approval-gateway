// Which agent tools may run, which need a person to approve, and who that person is.
// Default-deny: a tool that isn't listed is refused, so a new or hallucinated tool name
// can never slip through. The policy is data, so compliance can review it without reading code.
import fs from "node:fs";
import { parseArgSchema, validateArgs, type ArgSchema } from "./argSchema.js";

export type ToolDecision =
  | { action: "allow" }
  | { action: "require_approval"; approverIds: string[]; expiryMs: number }
  | { action: "deny"; reason: string };

export interface Policy {
  version: 1;
  decide: (tool: string) => ToolDecision;
  /** Problems with a call's arguments against the tool's schema. Empty if fine or no schema. */
  checkArgs: (tool: string, args: Record<string, unknown>) => string[];
  tools: string[];
}

interface ToolRule {
  requiresApproval: boolean;
  approvers?: string[];
  expiryHours?: number;
  args?: unknown;
}

interface PolicyFile {
  version: number;
  defaults?: { expiryHours?: number };
  approverGroups?: Record<string, string[]>;
  tools: Record<string, ToolRule>;
}

const MAX_EXPIRY_HOURS = 24 * 7;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

function checkExpiry(hours: unknown, where: string): number | undefined {
  if (hours === undefined) return undefined;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > MAX_EXPIRY_HOURS) {
    throw new Error(`${where}: expiryHours must be a number between 0 and ${MAX_EXPIRY_HOURS}`);
  }
  return hours;
}

// "env:FINANCE_APPROVER_ID" reads the id from the environment, so real user ids stay out of git
function resolveId(id: string, env: NodeJS.ProcessEnv, where: string): string {
  if (!id.startsWith("env:")) return id;
  const value = env[id.slice(4)];
  if (!value) throw new Error(`${where}: environment variable ${id.slice(4)} is not set`);
  return value;
}

/** Validates the whole file up front and names every problem's location. Throws on the first one. */
export function parsePolicy(raw: unknown, env: NodeJS.ProcessEnv = process.env): Policy {
  if (!isObject(raw)) throw new Error("policy: must be a JSON object");
  if (raw.version !== 1) throw new Error("policy: version must be 1");
  const file = raw as unknown as PolicyFile;

  const defaultExpiry = checkExpiry(file.defaults?.expiryHours, "policy.defaults") ?? 72;

  const groups = new Map<string, string[]>();
  if (file.approverGroups !== undefined) {
    if (!isObject(file.approverGroups)) throw new Error("policy.approverGroups: must be an object");
    for (const [name, ids] of Object.entries(file.approverGroups)) {
      if (!isStringArray(ids) || ids.length === 0) throw new Error(`policy.approverGroups.${name}: must be a non-empty list of user ids`);
      groups.set(name, ids.map((id) => resolveId(id, env, `policy.approverGroups.${name}`)));
    }
  }

  if (!isObject(file.tools) || Object.keys(file.tools).length === 0) throw new Error("policy.tools: must list at least one tool");
  const rules = new Map<string, ToolDecision>();
  const schemas = new Map<string, ArgSchema>();
  for (const [tool, rule] of Object.entries(file.tools)) {
    const where = `policy.tools.${tool}`;
    if (!TOOL_NAME.test(tool)) throw new Error(`${where}: tool names are lower_snake_case`);
    if (!isObject(rule) || typeof rule.requiresApproval !== "boolean") throw new Error(`${where}: requiresApproval must be true or false`);
    if (rule.args !== undefined) schemas.set(tool, parseArgSchema(rule.args, `${where}.args`));
    if (!rule.requiresApproval) {
      if (rule.approvers !== undefined) throw new Error(`${where}: approvers set on a tool that needs no approval`);
      rules.set(tool, { action: "allow" });
      continue;
    }
    if (!isStringArray(rule.approvers) || rule.approvers.length === 0) throw new Error(`${where}: approvers must name at least one group`);
    const ids = rule.approvers.flatMap((g) => {
      const members = groups.get(g);
      if (!members) throw new Error(`${where}: unknown approver group "${g}"`);
      return members;
    });
    const expiryHours = checkExpiry(rule.expiryHours, where) ?? defaultExpiry;
    rules.set(tool, { action: "require_approval", approverIds: [...new Set(ids)], expiryMs: expiryHours * 3_600_000 });
  }

  return {
    version: 1,
    tools: [...rules.keys()],
    decide: (tool) => rules.get(tool) ?? { action: "deny", reason: `tool "${tool}" is not in the policy` },
    checkArgs: (tool, args) => {
      const schema = schemas.get(tool);
      return schema ? validateArgs(schema, args) : [];
    },
  };
}

export function loadPolicy(path: string, env: NodeJS.ProcessEnv = process.env): Policy {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`policy file ${path} could not be read: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`policy file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parsePolicy(json, env);
}
