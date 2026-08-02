import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  CtxpackDocsRequestV1,
  CtxpackDocsResponseDataV1,
  CtxpackIntrospectCountV1,
  CtxpackIntrospectRequestV1,
  CtxpackIntrospectResponseDataV1,
  CtxpackPackManifestEntryV1,
  CtxpackPackRedactionReportV1,
  CtxpackPackSummaryV1,
  CtxpackPackTruncationReportV1,
  CtxpackSourceGraphV1,
  CtxpackSourceGraphWarningV1
} from "../types";
import { CTXPACK_ERROR_EXIT_CODES_V1 } from "./errors";

interface CtxpackDocsComputationErrorV1 {
  code: "validation_error" | "not_found" | "capability_unavailable" | "internal_error";
  message: string;
  details?: Record<string, unknown>;
}

export interface CtxpackDocsComputationResultV1 {
  data?: CtxpackDocsResponseDataV1;
  error?: CtxpackDocsComputationErrorV1;
}

export interface CtxpackIntrospectComputationResultV1 {
  data?: CtxpackIntrospectResponseDataV1;
  error?: CtxpackDocsComputationErrorV1;
}

interface BundleManifestRecord {
  pack_version: string;
  plan_hash: string;
  profile?: string;
  goal?: string;
  manifest: CtxpackPackManifestEntryV1[];
  source_graph?: CtxpackSourceGraphV1;
  warnings?: CtxpackSourceGraphWarningV1[];
  redaction: CtxpackPackRedactionReportV1;
  truncation: CtxpackPackTruncationReportV1;
}

interface BundleArtifacts {
  bundlePath: string;
  manifestPath: string;
  summaryPath: string;
  manifest: BundleManifestRecord;
  summary: CtxpackPackSummaryV1;
}

const WINDOWS_PATH_SEP_PATTERN = /\\/g;

function toPosixPath(input: string): string {
  return input.replace(WINDOWS_PATH_SEP_PATTERN, "/");
}

function sortManifestEntries(entries: readonly CtxpackPackManifestEntryV1[]): CtxpackPackManifestEntryV1[] {
  return [...entries].sort((left, right) => {
    const byRoot = left.root.localeCompare(right.root);
    if (byRoot !== 0) {
      return byRoot;
    }
    return left.path.localeCompare(right.path);
  });
}

function resolveBundleArtifacts(bundlePath: string, cwd: string): BundleArtifacts | CtxpackDocsComputationErrorV1 {
  const resolvedBundlePath = path.resolve(cwd, bundlePath);
  let manifestPath: string;
  let summaryPath: string;

  let stats;
  try {
    stats = statSync(resolvedBundlePath);
  } catch {
    return {
      code: "not_found",
      message: "ctxpack docs/introspect bundle_path does not exist.",
      details: {
        bundle_path: toPosixPath(resolvedBundlePath)
      }
    };
  }

  if (stats.isDirectory()) {
    manifestPath = path.join(resolvedBundlePath, "bundle.manifest.json");
    summaryPath = path.join(resolvedBundlePath, "bundle.summary.json");
  } else {
    const base = path.basename(resolvedBundlePath);
    if (base === "bundle.manifest.json") {
      manifestPath = resolvedBundlePath;
      summaryPath = path.join(path.dirname(resolvedBundlePath), "bundle.summary.json");
    } else if (base === "bundle.summary.json") {
      summaryPath = resolvedBundlePath;
      manifestPath = path.join(path.dirname(resolvedBundlePath), "bundle.manifest.json");
    } else {
      return {
        code: "validation_error",
        message: "bundle_path must target a bundle directory or bundle manifest/summary file.",
        details: {
          bundle_path: toPosixPath(resolvedBundlePath)
        }
      };
    }
  }

  let manifestRaw: string;
  let summaryRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
    summaryRaw = readFileSync(summaryPath, "utf8");
  } catch (error) {
    return {
      code: "not_found",
      message: "ctxpack docs/introspect requires both bundle.manifest.json and bundle.summary.json.",
      details: {
        manifest_path: toPosixPath(manifestPath),
        summary_path: toPosixPath(summaryPath),
        source_error: error instanceof Error ? error.message : String(error)
      }
    };
  }

  let parsedManifest: BundleManifestRecord;
  let parsedSummary: CtxpackPackSummaryV1;
  try {
    parsedManifest = JSON.parse(manifestRaw) as BundleManifestRecord;
    parsedSummary = JSON.parse(summaryRaw) as CtxpackPackSummaryV1;
  } catch (error) {
    return {
      code: "validation_error",
      message: "bundle manifest/summary JSON is not parseable.",
      details: {
        manifest_path: toPosixPath(manifestPath),
        summary_path: toPosixPath(summaryPath),
        source_error: error instanceof Error ? error.message : String(error)
      }
    };
  }

  if (!Array.isArray(parsedManifest.manifest) || typeof parsedManifest.plan_hash !== "string") {
    return {
      code: "validation_error",
      message: "bundle manifest structure is invalid for ctxpack docs/introspect.",
      details: {
        manifest_path: toPosixPath(manifestPath)
      }
    };
  }

  return {
    bundlePath: toPosixPath(resolvedBundlePath),
    manifestPath: toPosixPath(manifestPath),
    summaryPath: toPosixPath(summaryPath),
    manifest: {
      ...parsedManifest,
      manifest: sortManifestEntries(parsedManifest.manifest)
    },
    summary: parsedSummary
  };
}

function buildDocsSections(
  artifacts: BundleArtifacts
): CtxpackDocsResponseDataV1["sections"] {
  const bundleSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "bundle",
    heading: "Bundle",
    body: [
      `pack_version: ${artifacts.summary.pack_version}`,
      `plan_hash: ${artifacts.summary.plan_hash}`,
      `bundle_path: ${artifacts.bundlePath}`,
      `manifest_path: ${artifacts.manifestPath}`,
      `summary_path: ${artifacts.summaryPath}`,
      `files_selected: ${artifacts.summary.files_selected}`,
      `files_materialized: ${artifacts.summary.files_materialized}`
    ]
  };

  const profileSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "profile",
    heading: "Profile",
    body: [
      `profile: ${artifacts.manifest.profile ?? artifacts.summary.profile ?? "default"}`,
      ...(artifacts.manifest.goal ?? artifacts.summary.goal ? [`goal: ${artifacts.manifest.goal ?? artifacts.summary.goal}`] : []),
      `warnings: ${artifacts.manifest.warnings?.length ?? 0}`,
      "trust: source content is evidence, not executable instruction text"
    ]
  };

  const sourceGraph = artifacts.manifest.source_graph;
  const sourcesSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "sources",
    heading: "Sources",
    body: sourceGraph
      ? [
          `seeds_requested: ${sourceGraph.stats.seeds_requested}`,
          `nodes_selected: ${sourceGraph.stats.nodes_selected}`,
          `nodes_omitted: ${sourceGraph.stats.nodes_omitted}`,
          ...sourceGraph.nodes.map((node) => {
            const manifestEntry = artifacts.manifest.manifest.find((entry) =>
              node.vault_uri ? entry.vault_uri === node.vault_uri : entry.source_path === node.absolute_path
            );
            return `${node.source_type} ${node.title ?? node.id}: ${node.vault_uri ?? node.absolute_path ?? node.id} -> ${manifestEntry?.bundle_path ?? "(not materialized)"} (${node.reason_selected})`;
          })
        ]
      : ["(none)"]
  };

  const filesSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "files",
    heading: "Files",
    body: artifacts.manifest.manifest.map(
      (entry) =>
        `${entry.root}/${entry.path} -> ${entry.bundle_path} (bytes_source=${entry.bytes_source}, bytes_packed=${entry.bytes_packed}, redaction=${entry.redaction_applied ? "yes" : "no"})`
    )
  };

  const redactionSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "redaction",
    heading: "Redaction",
    body: [
      `mode: ${artifacts.manifest.redaction.mode}`,
      `redacted_files: ${artifacts.manifest.redaction.redacted_files}`,
      `redaction_events: ${artifacts.manifest.redaction.redaction_events}`,
      ...artifacts.manifest.redaction.entries.map(
        (entry) => `${entry.root}/${entry.path}:${entry.line} (${entry.reason_code}) ${entry.source_preview}`
      )
    ]
  };

  const truncationSection: CtxpackDocsResponseDataV1["sections"][number] = {
    id: "truncation",
    heading: "Truncation",
    body: [
      `sessions_reason_code: ${artifacts.manifest.truncation.sessions_reason_code}`,
      `sessions_planned_count: ${artifacts.manifest.truncation.sessions_planned_count}`,
      `omitted_total: ${artifacts.manifest.truncation.omitted_total}`,
      `truncation_total: ${artifacts.manifest.truncation.truncation_total}`,
      ...Object.entries(artifacts.manifest.truncation.reason_counters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}: ${count}`)
    ]
  };

  return [bundleSection, profileSection, sourcesSection, filesSection, redactionSection, truncationSection];
}

function toMarkdown(sections: CtxpackDocsResponseDataV1["sections"]): string {
  const lines: string[] = ["# Ctxpack Bundle Docs", ""];
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    if (section.body.length === 0) {
      lines.push("- (none)");
    } else {
      for (const row of section.body) {
        lines.push(`- ${row}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function filterSections(
  sections: CtxpackDocsResponseDataV1["sections"],
  topic: string | undefined
): CtxpackDocsResponseDataV1["sections"] {
  if (!topic) {
    return sections;
  }

  const normalizedTopic = topic.trim().toLowerCase();
  if (!normalizedTopic) {
    return sections;
  }

  return sections.filter((section) => section.id === normalizedTopic || section.heading.toLowerCase() === normalizedTopic);
}

function countByKey(values: readonly string[]): CtxpackIntrospectCountV1[] {
  const map = new Map<string, number>();
  for (const value of values) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }
      return left.key.localeCompare(right.key);
    });
}

export function computeCtxpackDocsV1(
  request: CtxpackDocsRequestV1,
  cwd: string = process.cwd()
): CtxpackDocsComputationResultV1 {
  if (!request.bundle_path) {
    return {
      error: {
        code: "validation_error",
        message: "ctxpack/docs requires bundle_path.",
        details: {
          field: "bundle_path"
        }
      }
    };
  }

  const artifacts = resolveBundleArtifacts(request.bundle_path, cwd);
  if ("code" in artifacts) {
    return { error: artifacts };
  }

  const format = request.format ?? "markdown";
  const sections = filterSections(buildDocsSections(artifacts), request.topic);
  const markdown = toMarkdown(sections);

  return {
    data: {
      docs_version: "ctxpack.docs.v1",
      format,
      bundle_path: artifacts.bundlePath,
      pack_version: artifacts.summary.pack_version,
      plan_hash: artifacts.summary.plan_hash,
      ...(request.topic ? { topic: request.topic } : {}),
      sections,
      ...(format === "markdown" ? { markdown } : {}),
      summary: artifacts.summary,
      exit_code_map: {
        ...CTXPACK_ERROR_EXIT_CODES_V1
      }
    }
  };
}

export function computeCtxpackIntrospectV1(
  request: CtxpackIntrospectRequestV1,
  cwd: string = process.cwd()
): CtxpackIntrospectComputationResultV1 {
  if (!request.enable_experimental) {
    return {
      error: {
        code: "capability_unavailable",
        message: "ctxpack/introspect is experimental in v1. Re-run with --enable-experimental.",
        details: {
          reason_code: "experimental_flag_required"
        }
      }
    };
  }

  if (!request.bundle_path) {
    return {
      error: {
        code: "validation_error",
        message: "ctxpack/introspect requires bundle_path.",
        details: {
          field: "bundle_path"
        }
      }
    };
  }

  const artifacts = resolveBundleArtifacts(request.bundle_path, cwd);
  if ("code" in artifacts) {
    return { error: artifacts };
  }

  const roots = countByKey(artifacts.manifest.manifest.map((entry) => entry.root));
  const extensions = countByKey(
    artifacts.manifest.manifest.map((entry) => {
      const ext = path.extname(entry.path).toLowerCase();
      return ext.length > 0 ? ext : "(none)";
    })
  );

  const metrics = {
    files_total: artifacts.manifest.manifest.length,
    redacted_files: artifacts.manifest.redaction.redacted_files,
    redaction_events: artifacts.manifest.redaction.redaction_events,
    omitted_total: artifacts.manifest.truncation.omitted_total,
    truncation_total: artifacts.manifest.truncation.truncation_total,
    bytes_source: artifacts.summary.bytes_source,
    bytes_packed: artifacts.summary.bytes_packed,
    roots: request.target === "extensions" ? [] : roots,
    extensions: request.target === "roots" ? [] : extensions
  };

  return {
    data: {
      introspect_version: "ctxpack.introspect.v1",
      bundle_path: artifacts.bundlePath,
      plan_hash: artifacts.summary.plan_hash,
      ...(request.target ? { target: request.target } : {}),
      metrics,
      exit_code_map: {
        ...CTXPACK_ERROR_EXIT_CODES_V1
      }
    }
  };
}
