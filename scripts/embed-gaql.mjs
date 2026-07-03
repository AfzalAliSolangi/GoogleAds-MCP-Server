#!/usr/bin/env node
/**
 * Regenerates shared/gaql_resources_embed.ts from google-ads-mcp's gaql_resources.txt
 * (run from repo root or adjust SOURCE path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const source = path.resolve(
  root,
  '../google-ads-mcp/ads_mcp/gaql_resources.txt',
);
const out = path.join(root, 'shared', 'gaql_resources_embed.ts');

const text = fs.readFileSync(source, 'utf8');
const body = `/** Auto-generated from google-ads-mcp gaql_resources.txt — run: npm run embed-gaql */
export const GAQL_RESOURCES_TEXT: string = ${JSON.stringify(text)};
`;
fs.writeFileSync(out, body, 'utf8');
console.error('Wrote', out);
