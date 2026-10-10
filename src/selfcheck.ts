/**
 * Local self-check. Runs your generator on the provided GitHub catalog and reports
 * shape + provenance metrics so you can iterate. Usage: `npm run selfcheck`.
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

const CATALOG = "github_catalog.json"; // provided toolkit, ships with your package
const OUT = "dependency_graph.json"; // what your generator writes

if (!existsSync(CATALOG)) {
  console.error(
    `missing ${CATALOG}. It ships with your assessment package; contact your recruiter if it is absent.`,
  );
  process.exit(1);
}

// Run the generator exactly like the grader does: the catalog path is the last arg.
execFileSync("node", ["--import", "tsx", "src/generate.ts", CATALOG], {
  stdio: "inherit",
});

const raw = JSON.parse(readFileSync(CATALOG, "utf-8"));
const tools = Array.isArray(raw) ? raw : (raw.tools ?? []);
const slugs = new Set<string>(
  tools
    .map((t: any) =>
      String(t.slug ?? t.name ?? t.function?.name ?? "").toUpperCase(),
    )
    .filter(Boolean),
);

const g = JSON.parse(readFileSync(OUT, "utf-8"));
if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
  throw new Error("Graph must contain nodes and edges arrays");
}

const nodes = g.nodes;
const edges = g.edges;
if (nodes.some((node: any) => typeof node?.id !== "string")) {
  throw new Error("Every graph node must have a string id");
}

const nodeIds = new Set<string>(nodes.map((node: any) => node.id));
if (nodeIds.size !== nodes.length) {
  throw new Error("Graph contains duplicate node ids");
}

const inCatalog = nodes.filter((n: any) =>
  slugs.has(String(n.id).toUpperCase()),
).length;
const provenance = nodes.length ? inCatalog / nodes.length : 0;
if (provenance !== 1) {
  throw new Error(`Node provenance must be 1.0; got ${provenance}`);
}

const edgeKeys = new Set<string>();
for (const edge of edges) {
  if (
    typeof edge?.from !== "string" ||
    typeof edge?.to !== "string" ||
    typeof edge?.label !== "string" ||
    !edge.label.trim()
  ) {
    throw new Error("Every graph edge must have string from/to/label values");
  }
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
    throw new Error(
      `Edge references an unknown node: ${edge.from} -> ${edge.to}`,
    );
  }

  const key = `${edge.from}\0${edge.to}\0${edge.label}`;
  if (edgeKeys.has(key)) {
    throw new Error(
      `Graph contains duplicate edge: ${edge.from} -> ${edge.to} (${edge.label})`,
    );
  }
  edgeKeys.add(key);
}

if (edges.length === 0) {
  throw new Error("Graph must contain at least one dependency edge");
}

const hasEdge = (from: string, to: string, label: string) =>
  edges.some(
    (edge: any) => edge.from === from && edge.to === to && edge.label === label,
  );

const expectedEdges = [
  [
    "GITHUB_LIST_REPOSITORY_ISSUES",
    "GITHUB_CREATE_AN_ISSUE_COMMENT",
    "issue_number",
  ],
  ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_MERGE_A_PULL_REQUEST", "pull_number"],
] as const;

for (const [from, to, label] of expectedEdges) {
  if (!hasEdge(from, to, label)) {
    throw new Error(`Missing expected dependency: ${from} -> ${to} (${label})`);
  }
}

if (
  hasEdge(
    "GITHUB_GET_A_PACKAGE_FOR_A_USER",
    "GITHUB_DELETE_PACKAGE_VERSION",
    "package_version_id",
  )
) {
  throw new Error(
    "Package metadata must not be treated as a package-version identifier source",
  );
}

console.log(
  JSON.stringify(
    {
      nodes: nodes.length,
      edges: edges.length,
      provenance_ratio: Number(provenance.toFixed(3)),
      labeled_edges: edges.filter((e: any) => e.label).length,
    },
    null,
    2,
  ),
);
console.log("Selfcheck passed.");
