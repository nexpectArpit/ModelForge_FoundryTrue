/**
 * Tool Schema Extractor
 *
 * Extracts tool/function schemas defined for LLMs in the repository.
 * Detects:
 *   1. OpenAI-style tool/function arrays: `const TOOLS = [{ name: '...', parameters: { ... } }]`
 *   2. Named tool objects: `const searchTool = { name: '...', description: '...', parameters: ... }`
 *   3. Zod schema objects: `z.object({ query: z.string(), ... })`
 *
 * Emits ToolSchema records with exact source locations and JSON parameter schemas.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ToolSchema } from '../types.js';
import { SKIP_DIRS, SOURCE_EXTENSIONS } from './source-scanner.js';

export function extractToolSchemas(repoPath: string): ToolSchema[] {
  const schemas: ToolSchema[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = path.extname(entry);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      try {
        const content = readFileSync(fullPath, 'utf8');
        const relPath = path.relative(repoPath, fullPath);
        const fileSchemas = extractToolSchemasFromFile(content, relPath);
        schemas.push(...fileSchemas);
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(repoPath);
  return schemas;
}

export function extractToolSchemasFromFile(fileContent: string, filePath: string): ToolSchema[] {
  const schemas: ToolSchema[] = [];

  // Strategy 1: Find arrays that contain tool-like objects
  const arrayBlockRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\[/g;
  let arrayMatch: RegExpExecArray | null;

  while ((arrayMatch = arrayBlockRegex.exec(fileContent)) !== null) {
    const startIdx = arrayMatch.index + arrayMatch[0].length - 1; // position of '['
    const arrayContent = extractBracketContent(fileContent, startIdx, '[', ']');
    if (!arrayContent) continue;
    if (!looksLikeToolArray(arrayContent)) continue;

    const toolObjects = extractObjectsFromArray(arrayContent);
    for (const toolObj of toolObjects) {
      const schema = parseToolObject(toolObj, filePath, fileContent, startIdx);
      if (schema) {
        schemas.push(schema);
      }
    }
  }

  // Strategy 2: Look for standalone Zod schema definitions
  const zodSchemaRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+Schema)\s*=\s*z\.object\s*\(/g;
  let zodMatch: RegExpExecArray | null;

  while ((zodMatch = zodSchemaRegex.exec(fileContent)) !== null) {
    const schemaName = zodMatch[1];
    const startIdx = zodMatch.index;
    const lineNum = fileContent.substring(0, startIdx).split('\n').length;

    const parenStart = fileContent.indexOf('(', startIdx + zodMatch[0].length - 1);
    if (parenStart === -1) continue;
    const content = extractBracketContent(fileContent, parenStart, '(', ')');
    if (!content) continue;

    const properties = extractZodProperties(content);
    if (Object.keys(properties).length > 0) {
      schemas.push({
        name: schemaName,
        description: `Zod schema: ${schemaName}`,
        parameters_schema: { type: 'object', properties },
        source_file: filePath,
        source_line: lineNum,
      });
    }
  }

  return schemas;
}

function extractBracketContent(
  content: string,
  startIdx: number,
  open: string,
  close: string,
): string | null {
  if (content[startIdx] !== open) return null;

  let depth = 0;
  let inString: string | null = null;

  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i];

    if (!inString && (ch === "'" || ch === '"' || ch === '`')) {
      inString = ch;
      continue;
    }
    if (inString && ch === inString && content[i - 1] !== '\\') {
      inString = null;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return content.substring(startIdx, i + 1);
      }
    }
  }

  return null;
}

function looksLikeToolArray(content: string): boolean {
  return (
    /name\s*:/.test(content) &&
    (/parameters\s*:/.test(content) || /description\s*:/.test(content))
  );
}

function extractObjectsFromArray(arrayContent: string): string[] {
  const objects: string[] = [];
  const inner = arrayContent.slice(1, -1).trim();
  if (!inner) return objects;

  let depth = 0;
  let objStart = -1;
  let inString: string | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (!inString && (ch === "'" || ch === '"' || ch === '`')) {
      inString = ch;
      continue;
    }
    if (inString && ch === inString && inner[i - 1] !== '\\') {
      inString = null;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        objects.push(inner.substring(objStart, i + 1));
        objStart = -1;
      }
    }
  }

  return objects;
}

function parseToolObject(
  objContent: string,
  filePath: string,
  fullFileContent: string,
  arrayStartIdx: number,
): ToolSchema | null {
  const nameMatch = objContent.match(/name\s*:\s*['"]([^'"]+)['"]/);
  if (!nameMatch) return null;

  const toolName = nameMatch[1];
  const descMatch = objContent.match(/description\s*:\s*['"]([^'"]+)['"]/);
  const description = descMatch ? descMatch[1] : `Tool: ${toolName}`;

  const paramsIdx = objContent.indexOf('parameters');
  let parametersSchema: Record<string, unknown> = {};

  if (paramsIdx >= 0) {
    const colonIdx = objContent.indexOf(':', paramsIdx);
    if (colonIdx >= 0) {
      let braceIdx = colonIdx + 1;
      while (braceIdx < objContent.length && /\s/.test(objContent[braceIdx])) braceIdx++;

      if (objContent[braceIdx] === '{') {
        const paramContent = extractBracketContent(objContent, braceIdx, '{', '}');
        if (paramContent) {
          parametersSchema = parseParametersBlock(paramContent);
        }
      }
    }
  }

  const toolDefIdx = fullFileContent.indexOf(nameMatch[0], arrayStartIdx);
  const sourceLine = toolDefIdx >= 0
    ? fullFileContent.substring(0, toolDefIdx).split('\n').length
    : 1;

  return {
    name: toolName,
    description,
    parameters_schema: parametersSchema,
    source_file: filePath,
    source_line: sourceLine,
  };
}

function parseParametersBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const typeMatch = block.match(/type\s*:\s*['"]([^'"]+)['"]/);
  if (typeMatch) result.type = typeMatch[1];

  const reqMatch = block.match(/required\s*:\s*\[([^\]]*)\]/);
  if (reqMatch) {
    const reqItems = reqMatch[1].match(/['"]([^'"]+)['"]/g);
    result.required = reqItems ? reqItems.map(s => s.replace(/['"]/g, '')) : [];
  }

  const propsIdx = block.indexOf('properties');
  if (propsIdx >= 0) {
    const colonIdx = block.indexOf(':', propsIdx);
    if (colonIdx >= 0) {
      let braceIdx = colonIdx + 1;
      while (braceIdx < block.length && /\s/.test(block[braceIdx])) braceIdx++;

      if (block[braceIdx] === '{') {
        const propsContent = extractBracketContent(block, braceIdx, '{', '}');
        if (propsContent) {
          result.properties = parsePropertiesBlock(propsContent);
        }
      }
    }
  }

  return result;
}

function parsePropertiesBlock(block: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const inner = block.slice(1, -1);

  const propRegex = /(\w+)\s*:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(inner)) !== null) {
    const propName = match[1];
    const braceStart = match.index + match[0].length - 1;
    const propContent = extractBracketContent(inner, braceStart, '{', '}');
    if (!propContent) continue;

    const propDef: Record<string, unknown> = {};
    const typeMatch = propContent.match(/type\s*:\s*['"]([^'"]+)['"]/);
    if (typeMatch) propDef.type = typeMatch[1];

    const descMatch = propContent.match(/description\s*:\s*['"]([^'"]+)['"]/);
    if (descMatch) propDef.description = descMatch[1];

    const enumMatch = propContent.match(/enum\s*:\s*\[([^\]]*)\]/);
    if (enumMatch) {
      const enumItems = enumMatch[1].match(/['"]([^'"]+)['"]/g);
      propDef.enum = enumItems ? enumItems.map(s => s.replace(/['"]/g, '')) : [];
    }

    properties[propName] = propDef;
  }

  return properties;
}

function extractZodProperties(content: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const propRegex = /(\w+)\s*:\s*z\.(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(content)) !== null) {
    const propName = match[1];
    const zodType = match[2];

    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      object: 'object',
      array: 'array',
      enum: 'string',
    };

    properties[propName] = { type: typeMap[zodType] ?? 'string' };
  }

  return properties;
}
