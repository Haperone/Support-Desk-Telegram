import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['README.md', 'README_RU.md', 'docs/README.md', 'monitor/README.md', 'alert-serverless/README.md'];
for (const language of ['en', 'ru']) {
  files.push(...readdirSync(join(root, 'docs', language)).filter(name => name.endsWith('.md')).map(name => `docs/${language}/${name}`));
}
const bodies = new Map(), headings = new Map(), errors = [];
function body(name) {
  if (!bodies.has(name)) bodies.set(name, readFileSync(join(root, name), 'utf8'));
  return bodies.get(name);
}
function anchors(name) {
  if (headings.has(name)) return headings.get(name);
  const text = body(name).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, ''), result = new Set(), counts = new Map();
  for (const match of text.matchAll(/^(?:#{1,6})\s+(.+)$/gm)) {
    const slug = match[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    result.add(slug + (count ? `-${count}` : '')); counts.set(slug, count + 1);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  headings.set(name, result); return result;
}
let links = 0;
for (const name of files) {
  for (const match of body(name).matchAll(/\[([^\]]*)\]\(([^)]+)\)|\bhref=["']([^"']+)["']/g)) {
    const ref = match[2] || match[3];
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
    links++;
    const [path, fragment] = ref.split('#');
    const target = path ? relative(root, resolve(root, dirname(name), decodeURIComponent(path))).replaceAll('\\', '/') : name;
    if (target.startsWith('../') || isAbsolute(target) || !existsSync(join(root, target))) {
      errors.push(`${name}: missing local target ${ref}`); continue;
    }
    if (fragment && target.endsWith('.md') && !anchors(target).has(decodeURIComponent(fragment))) errors.push(`${name}: missing anchor ${ref}`);
    if ((name === 'README.md' || name.startsWith('docs/en/')) && target.startsWith('docs/ru/') && !/Русский|Russian/.test(match[1] || '')) {
      errors.push(`${name}: English guide links to Russian instructions: ${ref}`);
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`${files.length} documentation files: ${links} local links and language destinations OK`);
