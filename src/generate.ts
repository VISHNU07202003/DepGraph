/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it as the last
 *     argument, so reading the final argv entry works whatever else your command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory.
 *   - For LLM access, point the OpenAI SDK at `$LITMUS_API_URL/proxy/openai/v1` with the
 *     key in LITMUS_ASSESSMENT_TOKEN (set from your assessment page's AI credentials; the
 *     same are provided when we run your generator). Use an OpenRouter model id such as
 *     `openai/gpt-4o`.
 *
 * This is a SKELETON. Replace the inference in generate() with your own approach. Do not
 * hardcode a toolkit's relations: your node ids must be slugs from the catalog you are
 * handed, and your output must change when the input changes.
 */

import { readFileSync, writeFileSync } from "fs";

type Schema = Record<string, any>;
type Tool = Record<string, any>;

interface Node {
  id: string;
  service?: string;
}

interface Edge {
  from: string;
  to: string;
  label: string;
}

interface Graph {
  nodes: Node[];
  edges: Edge[];
}

const CATALOG_PATH = process.argv.length > 2
  ? process.argv[process.argv.length - 1]
  : undefined;

const OUT_PATH = "dependency_graph.json";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("Usage: npm run generate -- <catalog.json>");
  }

  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const tools = Array.isArray(raw)
    ? raw
    : raw.tools ?? raw.items ?? [];

  if (!Array.isArray(tools)) {
    throw new Error("Catalog must contain an array of tools");
  }

  return tools;
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.function?.name ?? tool.name;
}

function normalize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function tokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  if (!ref.startsWith("#/")) return undefined;

  let current: any = root;

  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current?.[key];
  }

  return current;
}

interface Field {
  name: string;
  context: string[];
}

function extractFields(root: Schema): Field[] {
  const fields: Field[] = [];
  const seen = new Set<string>();

  function walk(
    schema: Schema | undefined,
    context: string[],
    depth: number,
    refs: Set<string>,
  ) {
    if (!schema || depth > 12) return;

    if (schema.$ref) {
      if (refs.has(schema.$ref)) return;

      const resolved = resolveRef(schema.$ref, root);
      if (resolved) {
        walk(
          resolved,
          context,
          depth + 1,
          new Set([...refs, schema.$ref]),
        );
      }
    }

    for (const key of ["allOf", "anyOf", "oneOf"]) {
      for (const option of schema[key] ?? []) {
        walk(option, context, depth + 1, refs);
      }
    }

    if (schema.items) {
      walk(schema.items, context, depth + 1, refs);
    }

    for (const [name, child] of Object.entries(
      schema.properties ?? {},
    )) {
      const path = [...context, name];
      const identity = path.join(".");

      if (!seen.has(identity)) {
        seen.add(identity);
        if (
  !["data", "error", "successful", "errors"].includes(
    name.toLowerCase()
  )
) {
  fields.push({ name, context: path });
}
      }

      walk(child as Schema, path, depth + 1, refs);
    }
  }

  walk(root, [], 0, new Set());

  return fields;
}


const GENERIC = new Set([
  "id", "name", "type", "url", "body", "data",
  "status", "message", "success", "successful",
  "error", "errors", "count", "total", "page",
  "owner", "repo", "repository", "per_page",
  "created_at", "updated_at", "html_url",
  "node_id", "login", "sha", "state",
  "description", "visibility", "package_type",
  "content_type", "value_type", "config__url",
  "labels", "ref", "org", "username"
]);


function isGeneric(name: string): boolean {
  return GENERIC.has(name.toLowerCase());
}

function relatedEntity(
  producer: Tool,
  field: Field,
  consumerInput: string,
): boolean {
  const inputTokens = tokens(consumerInput);
  const producerTokens = tokens(
    `${slugOf(producer) ?? ""} ${producer.name ?? ""}`,
  );

  const pathTokens = field.context.flatMap(tokens);

  const entityTokens = inputTokens.filter(
    t => !["id", "number", "name", "key", "uuid"].includes(t),
  );

  if (entityTokens.length === 0) return false;

  const availableTokens = new Set([...producerTokens, ...pathTokens]);

  return entityTokens.every(
    token =>
      availableTokens.has(token) ||
      availableTokens.has(`${token}s`) ||
      availableTokens.has(token.replace(/s$/, "")),
  );
}


function fieldMatches(
  producer: Tool,
  field: Field,
  input: string,
): boolean {
  if (isGeneric(input)) return false;

  const output = normalize(field.name);
  const target = normalize(input);

  const identifierSuffixes = [
    "id", "number", "slug", "sha", "uuid"
  ];

  const inputParts = tokens(input);
  const outputParts = tokens(field.name);

  // Exact identifier match.
  if (output === target) {
    return relatedEntity(producer, field, input);
  }

  // Match Issue.number -> issue_number,
  // PullRequest.number -> pull_number, etc.
  if (
    inputParts.length >= 2 &&
    outputParts.length === 1 &&
    identifierSuffixes.includes(outputParts[0]) &&
    inputParts[inputParts.length - 1] === outputParts[0]
  ) {
    return relatedEntity(producer, field, input);
  }

  return false;
}


function inferService(tool: Tool): string | undefined {
  const slug = slugOf(tool) ?? "";
  const words = slug.split("_");

  if (words.length < 3) return undefined;

  // A lightweight grouping label, not used for matching.
  return words.slice(1, 3).join("_").toLowerCase();
}

function generate(tools: Tool[]): Graph {
  const validTools = tools.filter(
    tool => typeof slugOf(tool) === "string",
  );

  const nodes: Node[] = validTools.map(tool => ({
    id: slugOf(tool)!,
    service: inferService(tool),
  }));

  const producers = validTools.map(tool => ({
    tool,
    slug: slugOf(tool)!,
    fields: extractFields(tool.outputParameters ?? {}),
  }));

  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();

  for (const consumer of validTools) {
    const to = slugOf(consumer)!;
    const input = consumer.inputParameters ?? {};
    const required: string[] = input.required ?? [];

    for (const parameter of required) {
      if (isGeneric(parameter)) continue;

      for (const producer of producers) {
        if (producer.slug === to) continue;

        const matches = producer.fields.some(field =>
          fieldMatches(producer.tool, field, parameter),
        );

        if (!matches) continue;

        const key = `${producer.slug}|${to}|${parameter}`;

        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({
            from: producer.slug,
            to,
            label: parameter,
          });
        }
      }
    }
  }

  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.label.localeCompare(b.label),
  );

  return { nodes, edges };
}

function main() {
  const tools = loadCatalog();
  const graph = generate(tools);

  writeFileSync(
    OUT_PATH,
    JSON.stringify(graph, null, 2),
    "utf8",
  );

  console.log(`Catalog tools: ${tools.length}`);
  console.log(`Graph nodes: ${graph.nodes.length}`);
  console.log(`Graph edges: ${graph.edges.length}`);
  console.log(`Output: ${OUT_PATH}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
