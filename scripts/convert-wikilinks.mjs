#!/usr/bin/env node
/**
 * Convert Obsidian Wikilinks in Astro's published Markdown copy.
 *
 * Run from the website repository root:
 *   node scripts/convert-wikilinks.mjs
 *
 * Or from the parent GitHub Actions checkout:
 *   node website/scripts/convert-wikilinks.mjs
 *
 * No npm dependencies. Sources are the files already copied from
 * _BLOG/PUBLISHED/ into website/src/content/blog/.
 *
 * Assumptions:
 * - Your Astro blog routes use `/blog/${post.id}/` (the usual blog starter).
 * - Article filenames determine Astro IDs (e.g. "My Post.md" -> "my-post").
 * - All image files referenced by embeds are inside the published directory.
 * - Slugs explicitly overridden in Markdown frontmatter are not supported.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(scriptDir, '..');
const postsRoot = path.join(websiteRoot, 'src', 'content', 'blog');
const BLOG_URL_PREFIX = '/blog/';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

function slash(value) {
  return value.split(path.sep).join('/');
}

function key(value) {
  return value.normalize('NFC').toLocaleLowerCase('en');
}

// Astro's glob loader makes URL-friendly IDs from filenames. To keep URL
// predictions unambiguous, support ordinary filenames (letters, numbers,
// spaces, hyphens and underscores); use kebab-case filenames for best results.
function slugPart(value) {
  const part = value.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[_\s]+/gu, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (!part) throw new Error(`Unable to create a URL slug from: ${value}`);
  return part;
}

function articleSlug(relativeFile) {
  const parts = slash(relativeFile).replace(/\.md$/i, '').split('/');
  return parts.map(slugPart).join('/');
}

function frontmatterEnd(lines) {
  if (!lines.length || lines[0].trim() !== '---') return -1;
  const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (close < 0) throw new Error('Unclosed YAML frontmatter');
  return close;
}

function hasCustomSlug(lines) {
  const end = frontmatterEnd(lines);
  if (end < 0) return false;
  return lines.slice(1, end).some(line => /^slug\s*:/i.test(line));
}

async function listFiles(folder) {
  const results = [];
  async function scan(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in published content: ${fullPath}`);
      }
      if (entry.isDirectory()) await scan(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  await scan(folder);
  return results.sort();
}

function markdownEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function toRelativeImageUrl(fromFile, imageFile) {
  let rel = slash(path.relative(path.dirname(fromFile), imageFile));
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

// Simple GitHub-style heading fragments, sufficient for normal Markdown
// headings. Custom heading IDs, complex inline HTML and block anchors need
// additional handling and intentionally fail rather than publish broken links.
function headingSlug(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
}

function collectHeadingIds(text) {
  const ids = new Map();
  const seen = new Map();
  const lines = text.split(/\r?\n/);
  const fmEnd = frontmatterEnd(lines);
  let fence = null;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    const matchFence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (matchFence) {
      const marker = matchFence[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length &&
        new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const title = heading[1].trim();
    const base = headingSlug(title);
    if (!base) continue;
    const number = seen.get(base) ?? 0;
    const slug = number === 0 ? base : `${base}-${number}`;
    seen.set(base, number + 1);
    // Match by full heading, independent of case, while retaining duplicate IDs.
    const titleKey = key(title);
    if (!ids.has(titleKey)) ids.set(titleKey, slug);
  }
  return ids;
}

function buildIndex(fileList) {
  const notes = [];
  const images = [];
  const slugs = new Map();
  for (const file of fileList) {
    const relative = slash(path.relative(postsRoot, file));
    if (path.extname(file).toLowerCase() === '.md') {
      const slug = articleSlug(relative);
      if (slugs.has(slug)) throw new Error(`Two posts use the same URL /blog/${slug}/: ${relative} and ${slugs.get(slug)}`);
      slugs.set(slug, relative);
      notes.push({ file, relative, slug, stem: path.basename(relative, '.md') });
    } else if (IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      images.push({ file, relative, name: path.basename(file) });
    }
  }
  return { notes, images };
}

function findTarget(query, current, candidates, type) {
  const cleaned = query.replace(/\\/g, '/').trim()
    .replace(/^_BLOG\/PUBLISHED\//i, '')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) throw new Error(`Invalid ${type} target: ${query}`);
  const currentFolder = path.posix.dirname(current.relative);
  const stripped = type === 'note' ? cleaned.replace(/\.md$/i, '') : cleaned;
  const normalized = path.posix.normalize(stripped);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${type} target escapes published folder: ${query}`);
  }
  // Explicit paths match relative to current article or published root.
  const hasFolder = stripped.includes('/');
  const exactPaths = [
    path.posix.normalize(path.posix.join(currentFolder, normalized)),
    normalized,
  ];
  const matches = candidates.filter(item => {
    const candidateName = type === 'note' ? item.relative.replace(/\.md$/i, '') : item.relative;
    if (hasFolder) return exactPaths.some(p => key(p) === key(candidateName));
    return key(type === 'note' ? item.stem : item.name) === key(stripped);
  });
  if (matches.length === 0) throw new Error(`${type} target not found in published content: [[${query}]]`);
  if (matches.length > 1) throw new Error(`Ambiguous ${type} target [[${query}]]: ${matches.map(x => x.relative).join(', ')}. Use a path.`);
  return matches[0];
}

function parseLink(raw, current, index, noteByFile) {
  const embed = raw.startsWith('!');
  const wikiText = raw.slice(embed ? 3 : 2, -2).trim();
  const pipeAt = wikiText.indexOf('|');
  const targetAndHeading = (pipeAt >= 0 ? wikiText.slice(0, pipeAt) : wikiText).trim();
  const customText = pipeAt >= 0 ? wikiText.slice(pipeAt + 1).trim() : null;
  if (!targetAndHeading) throw new Error(`Empty Wikilink: ${raw}`);
  const hashAt = targetAndHeading.indexOf('#');
  const noteName = (hashAt >= 0 ? targetAndHeading.slice(0, hashAt) : targetAndHeading).trim();
  const headingName = hashAt >= 0 ? targetAndHeading.slice(hashAt + 1).trim() : null;

  if (targetAndHeading.includes('^') || (headingName && headingName.startsWith('#'))) {
    throw new Error(`Obsidian block/subheading searches aren't supported: ${raw}`);
  }
  if (embed) {
    if (headingName || !IMAGE_EXTENSIONS.has(path.posix.extname(noteName).toLowerCase())) {
      throw new Error(`Only image embeds are supported; can't embed a note or block: ${raw}`);
    }
    if (customText && /^\d+(x\d+)?$/i.test(customText)) {
      throw new Error(`Image sizing via |width is unsupported; use standard Markdown or a component: ${raw}`);
    }
    const image = findTarget(noteName, current, index.images, 'image');
    const alt = customText || path.posix.basename(noteName, path.posix.extname(noteName));
    return `![${markdownEscape(alt)}](${toRelativeImageUrl(current.file, image.file)})`;
  }

  if (!noteName && !headingName) throw new Error(`Invalid Wikilink: ${raw}`);
  // Image attachments should be written as ![[image.png]], not regular note links.
  if (IMAGE_EXTENSIONS.has(path.posix.extname(noteName).toLowerCase())) {
    throw new Error(`Use an image embed ![[${noteName}]] instead: ${raw}`);
  }
  const target = noteName ? findTarget(noteName, current, index.notes, 'note') : current;
  const targetText = noteByFile.get(target.file);
  const headings = collectHeadingIds(targetText);
  let anchor = '';
  if (headingName !== null) {
    if (!headingName) throw new Error(`Empty heading in ${raw}`);
    if (!headings.has(key(headingName))) {
      throw new Error(`Heading "${headingName}" not found in published article "${target.relative}"`);
    }
    anchor = `#${encodeURI(headings.get(key(headingName)))}`;
  }
  const linkText = customText || headingName || path.posix.basename(target.stem);
  const url = `${BLOG_URL_PREFIX}${target.slug}/${anchor}`;
  return `[${markdownEscape(linkText)}](${url})`;
}

function convertBody(text, current, index, noteByFile) {
  const lines = text.split('\n');
  const fmEnd = frontmatterEnd(lines);
  let fence = null;
  let inlineTicks = 0;
  let changed = 0;

  function convertPlain(value, lineNo) {
    const regex = /!?\[\[[^\[\]\r\n]+\]\]/g;
    let result = '';
    let start = 0;
    for (const match of value.matchAll(regex)) {
      const offset = match.index;
      // Do not transform escaped literal Wikilinks.
      let backslashes = 0;
      for (let j = offset - 1; j >= 0 && value[j] === '\\'; j--) backslashes++;
      if (backslashes % 2) continue;
      result += value.slice(start, offset);
      try {
        result += parseLink(match[0], current, index, noteByFile);
      } catch (error) {
        throw new Error(`${current.relative}:${lineNo}: ${error.message}`);
      }
      start = offset + match[0].length;
      changed++;
    }
    result += value.slice(start);
    // Reject leftover unconverted constructs rather than silently publishing them.
    if (/(?<!\\)!?\[\[/.test(result)) {
      throw new Error(`${current.relative}:${lineNo}: Unrecognized or unsupported Wikilink`);
    }
    return result;
  }

  for (let i = fmEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    if (inlineTicks === 0) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (match) {
        const marker = match[1];
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length &&
          new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
        continue;
      }
    }
    if (fence) continue;
    // Preserve inline code spans (including spans extending across lines).
    let updated = '';
    let start = 0;
    for (const match of line.matchAll(/`+/g)) {
      const ticks = match[0].length;
      if (inlineTicks === 0) {
        updated += convertPlain(line.slice(start, match.index), i + 1);
        inlineTicks = ticks;
      } else {
        updated += line.slice(start, match.index);
        if (ticks === inlineTicks) inlineTicks = 0;
      }
      updated += match[0];
      start = match.index + ticks;
    }
    updated += inlineTicks === 0
      ? convertPlain(line.slice(start), i + 1)
      : line.slice(start);
    lines[i] = updated;
  }
  return { text: lines.join('\n'), changed };
}

async function main() {
  const directory = await fs.stat(postsRoot).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error(`Published directory does not exist: ${postsRoot}`);
  }
  const index = buildIndex(await listFiles(postsRoot));
  const noteByFile = new Map();
  for (const note of index.notes) {
    const value = await fs.readFile(note.file, 'utf8');
    if (hasCustomSlug(value.split(/\r?\n/))) {
      throw new Error(`${note.relative}: frontmatter slug: overrides aren't supported by this converter. Use a matching filename-based slug.`);
    }
    noteByFile.set(note.file, value);
  }
  // Convert and validate everything before writing any results.
  const output = [];
  let total = 0;
  for (const note of index.notes) {
    const result = convertBody(noteByFile.get(note.file), note, index, noteByFile);
    output.push({ file: note.file, ...result });
    total += result.changed;
  }
  for (const entry of output) {
    if (entry.text !== noteByFile.get(entry.file)) {
      await fs.writeFile(entry.file, entry.text, 'utf8');
    }
  }
  console.log(`Validated ${index.notes.length} published posts; converted ${total} Obsidian links/embeds.`);
}

main().catch(error => {
  console.error(`Wikilink conversion failed: ${error.message}`);
  process.exitCode = 1;
});
