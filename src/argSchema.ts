// Per-tool argument contracts. The gateway checks a tool call's arguments before any card is
// sent, so an approver never approves something the executor can't run as shown, and limits
// (such as a maximum refund) are enforced as data the compliance team can read.
//
// Deliberately small: types, required, min/max, enum, maxLength, no unknown fields. Anything
// richer belongs in the executor's own validation, which should exist as well.

export type ArgType = "string" | "number" | "integer" | "boolean";

export interface ArgSpec {
  type: ArgType;
  required: boolean;
  min?: number;
  max?: number;
  enum?: string[];
  maxLength?: number;
}

export type ArgSchema = Record<string, ArgSpec>;

const TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);
const ARG_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accepts the short form ("number") or the long form ({ "type": "number", "max": 500 }). */
export function parseArgSchema(raw: unknown, where: string): ArgSchema {
  if (!isObject(raw) || Object.keys(raw).length === 0) throw new Error(`${where}: args must list at least one argument`);
  const schema: ArgSchema = {};
  for (const [name, value] of Object.entries(raw)) {
    const at = `${where}.${name}`;
    if (!ARG_NAME.test(name)) throw new Error(`${at}: argument names are lower_snake_case`);
    const spec = typeof value === "string" ? { type: value } : value;
    if (!isObject(spec) || typeof spec.type !== "string" || !TYPES.has(spec.type)) {
      throw new Error(`${at}: type must be one of ${[...TYPES].join(", ")}`);
    }
    const type = spec.type as ArgType;
    const numeric = type === "number" || type === "integer";
    for (const bound of ["min", "max"] as const) {
      if (spec[bound] !== undefined && (!numeric || typeof spec[bound] !== "number")) throw new Error(`${at}: ${bound} needs a numeric type and a number`);
    }
    if (spec.enum !== undefined && (type !== "string" || !Array.isArray(spec.enum) || spec.enum.length === 0 || !spec.enum.every((e) => typeof e === "string"))) {
      throw new Error(`${at}: enum needs a string type and a non-empty list of strings`);
    }
    if (spec.maxLength !== undefined && (type !== "string" || !Number.isInteger(spec.maxLength) || (spec.maxLength as number) < 1)) {
      throw new Error(`${at}: maxLength needs a string type and a positive integer`);
    }
    if (spec.required !== undefined && typeof spec.required !== "boolean") throw new Error(`${at}: required must be true or false`);
    schema[name] = {
      type,
      required: (spec.required as boolean | undefined) ?? true,
      min: spec.min as number | undefined,
      max: spec.max as number | undefined,
      enum: spec.enum as string[] | undefined,
      maxLength: spec.maxLength as number | undefined,
    };
  }
  return schema;
}

/** Returns every problem, not just the first, so the agent (or developer) can fix them in one go. */
export function validateArgs(schema: ArgSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(args)) {
    if (!schema[name]) problems.push(`unexpected argument "${name}" (allowed: ${Object.keys(schema).join(", ")})`);
  }
  for (const [name, spec] of Object.entries(schema)) {
    const v = args[name];
    if (v === undefined || v === null) {
      if (spec.required) problems.push(`missing required argument "${name}"`);
      continue;
    }
    const ok =
      spec.type === "string" ? typeof v === "string"
        : spec.type === "boolean" ? typeof v === "boolean"
          : spec.type === "integer" ? Number.isInteger(v)
            : typeof v === "number" && Number.isFinite(v);
    if (!ok) {
      problems.push(`"${name}" must be a ${spec.type}`);
      continue;
    }
    if (typeof v === "number" && spec.min !== undefined && v < spec.min) problems.push(`"${name}" must be at least ${spec.min}`);
    if (typeof v === "number" && spec.max !== undefined && v > spec.max) problems.push(`"${name}" must be at most ${spec.max}`);
    if (typeof v === "string" && spec.enum && !spec.enum.includes(v)) problems.push(`"${name}" must be one of ${spec.enum.join(", ")}`);
    if (typeof v === "string" && spec.maxLength !== undefined && v.length > spec.maxLength) {
      problems.push(`"${name}" must be at most ${spec.maxLength} characters`);
    }
  }
  return problems;
}
