import { readFile } from "node:fs/promises";
import path from "node:path";
import type { InstructionTracePartial } from "./types";

const TEMPLATE_TOKEN_PATTERN =
  /\{\{\{\s*([A-Za-z0-9_]+)\s*\}\}\}|\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const PARTIAL_INCLUDE_PATTERN = /\{\{>\s*([^}\s]+)\s*\}\}/g;

export interface InstructionTemplateRenderOptions {
  includePartialContents?: boolean;
  maxPartialDepth?: number;
  orderOffset?: number;
}

export interface InstructionTemplateRenderResult {
  expandedText: string;
  output: string;
  tokenNames: string[];
  unresolvedTokens: string[];
  missingPartials: string[];
  partials: InstructionTracePartial[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tokenizeInstructionTemplate(source: string): string[] {
  const tokens = new Set<string>();
  for (const match of source.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    const token = match[1] ?? match[2];
    if (token) {
      tokens.add(token);
    }
  }
  return [...tokens].sort((left, right) => left.localeCompare(right));
}

export function collectInstructionUnresolvedTokens(rendered: string): string[] {
  return tokenizeInstructionTemplate(rendered);
}

export function renderInstructionTemplateTokens(
  source: string,
  replacements: Record<string, string | number | boolean>,
): string {
  return Object.entries(replacements).reduce((rendered, [token, value]) => {
    const pattern = new RegExp(
      `\\{\\{\\{\\s*${escapeRegExp(token)}\\s*\\}\\}\\}|\\{\\{\\s*${escapeRegExp(token)}\\s*\\}\\}`,
      "g",
    );
    return rendered.replace(pattern, String(value));
  }, source);
}

async function expandInstructionPartials(
  source: string,
  partialsDir: string,
  options: InstructionTemplateRenderOptions,
): Promise<{
  expandedText: string;
  missingPartials: string[];
  partials: InstructionTracePartial[];
}> {
  const partials: InstructionTracePartial[] = [];
  const missingPartials = new Set<string>();
  const maxPartialDepth = options.maxPartialDepth ?? 5;
  let order = options.orderOffset ?? 0;

  async function expand(
    input: string,
    stack: string[],
    depth: number,
  ): Promise<string> {
    if (depth > maxPartialDepth || !input.includes("{{>")) {
      return input;
    }

    const matches = [...input.matchAll(PARTIAL_INCLUDE_PATTERN)];
    if (matches.length === 0) {
      return input;
    }

    let lastIndex = 0;
    let output = "";

    for (const match of matches) {
      const [rawMatch, rawName = ""] = match;
      output += input.slice(lastIndex, match.index ?? 0);
      lastIndex = (match.index ?? 0) + rawMatch.length;

      const partialName = rawName.trim();
      const partialPath = path.join(partialsDir, `${partialName}.md.mustache`);
      order += 1;

      if (stack.includes(partialPath)) {
        const cycle = [...stack, partialPath]
          .map((entry) => path.basename(entry, ".md.mustache"))
          .join(" -> ");
        throw new Error(`Circular partial include detected: ${cycle}`);
      }

      let partialText = "";
      try {
        partialText = await readFile(partialPath, "utf8");
      } catch {
        missingPartials.add(partialName);
        partials.push({
          name: partialName,
          order,
          missing: true,
        });
        output += `<!-- Missing partial: ${partialName} -->`;
        continue;
      }

      partials.push({
        name: partialName,
        path: partialPath,
        order,
        ...(options.includePartialContents ? { content: partialText } : {}),
      });
      output += await expand(partialText, [...stack, partialPath], depth + 1);
    }

    output += input.slice(lastIndex);
    return output;
  }

  return {
    expandedText: await expand(source, [], 0),
    missingPartials: [...missingPartials].sort((left, right) => left.localeCompare(right)),
    partials,
  };
}

export async function renderInstructionTemplateSource(
  source: string,
  partialsDir: string,
  replacements: Record<string, string | number | boolean>,
  options: InstructionTemplateRenderOptions = {},
): Promise<InstructionTemplateRenderResult> {
  const expanded = await expandInstructionPartials(source, partialsDir, options);
  const output = renderInstructionTemplateTokens(expanded.expandedText, replacements);
  return {
    expandedText: expanded.expandedText,
    output,
    tokenNames: tokenizeInstructionTemplate(expanded.expandedText),
    unresolvedTokens: collectInstructionUnresolvedTokens(output),
    missingPartials: expanded.missingPartials,
    partials: expanded.partials,
  };
}

export async function renderInstructionTemplateFile(
  templatePath: string,
  partialsDir: string,
  replacements: Record<string, string | number | boolean>,
  options: InstructionTemplateRenderOptions = {},
): Promise<InstructionTemplateRenderResult> {
  const source = await readFile(templatePath, "utf8");
  return renderInstructionTemplateSource(source, partialsDir, replacements, options);
}
