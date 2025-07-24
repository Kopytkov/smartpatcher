#!/usr/bin/env node

/**
 * CLI-утилита на Node.js для применения Markdown-патчей к C++-файлам без готового парсера.
 * Учитывает отступы, расположение `>>>` на той же строке или в новой, а также вставку внутри строки.
 */
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';

// Лексер для match-блока
function lexMatch(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('...', i)) { tokens.push({ type: 'wildcard', text: '...' }); i += 3; continue; }
    if (text.startsWith('>>>', i)) { tokens.push({ type: 'inserter', text: '>>>' }); i += 3; continue; }
    if (text.startsWith('<<<', i)) { tokens.push({ type: 'folder', text: '<<<' }); i += 3; continue; }
    const ch = text[i];
    if ('{}()[]<>'.includes(ch)) { tokens.push({ type: 'bracket', text: ch }); i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j += 2;
        else j++;
      }
      tokens.push({ type: 'string', text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      const com = end < 0 ? text.slice(i) : text.slice(i, end);
      tokens.push({ type: 'comment', text: com });
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const com = end < 0 ? text.slice(i) : text.slice(i, end + 2);
      tokens.push({ type: 'comment', text: com });
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const m = /^[^\s\.\/"'\(\)\{\}\[\]<>]+/.exec(text.slice(i));
    if (m) {
      tokens.push({ type: 'text', text: m[0] });
      i += m[0].length;
      continue;
    }
    tokens.push({ type: 'char', text: ch });
    i++;
  }
  return tokens;
}

// Собирает листовые токены из AST C++
function getLeafTokens(src) {
  const parser = new Parser();
  parser.setLanguage(Cpp);
  const tree = parser.parse(src);
  const leaves = [];
  function walk(node) {
    if (node.childCount === 0) {
      leaves.push({ text: node.text, startIndex: node.startIndex });
    } else { for (let i = 0; i < node.childCount; i++) walk(node.child(i)); }
  }
  walk(tree.rootNode);
  return leaves;
}

// Поиск оффсета вставки (с поддержкой wildcard)
function findInsertionOffset(sourceTokens, patternTokens, srcLength) {
  let s = 0;
  let offset = null;
  for (let i = 0; i < patternTokens.length; i++) {
    const p = patternTokens[i];
    if (p.type === 'comment' || p.type === 'folder') continue;
    if (p.type === 'inserter') {
      offset = s >= sourceTokens.length ? srcLength : sourceTokens[s].startIndex;
      continue;
    }
    if (p.type === 'wildcard') {
      const next = patternTokens.slice(i + 1).find(t => !['wildcard','comment','folder','inserter'].includes(t.type));
      if (next) {
        while (s < sourceTokens.length && sourceTokens[s].text !== next.text) s++;
      } else { s = sourceTokens.length; }
      continue;
    }
    while (s < sourceTokens.length && sourceTokens[s].text !== p.text) s++;
    if (s >= sourceTokens.length) throw new Error(`Токен '${p.text}' не найден`);
    s++;
  }
  if (offset === null) throw new Error('Нет inserter в паттерне');
  return offset;
}

// Извлечение match/patch из Markdown
function extractBlocks(md) {
  const m = /###.*?\bmatch\b[\s\S]*?```(?:\w+)?\s*([\s\S]*?)```/mi.exec(md);
  const p = /###.*?\bpatch\b[\s\S]*?```(?:\w+)?\s*([\s\S]*?)```/mi.exec(md);
  if (!m || !p) throw new Error('Не удалось извлечь блоки');
  return { match: m[1], patch: p[1] };
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('src', { alias: 's', demandOption: true })
    .option('mp', { alias: 'm', demandOption: true })
    .option('out', { alias: 'o', demandOption: true }).argv;

  const src = fs.readFileSync(argv.src, 'utf8');
  const md = fs.readFileSync(argv.mp, 'utf8');
  const { match, patch } = extractBlocks(md);

  // Inline или новая строка?
  const matchLines = match.split(/\r?\n/);
  const inserterLine = matchLines.find(line => line.includes('>>>')) || '';
  const isInline = inserterLine.trim() !== '>>>';

  const patt = lexMatch(match);
  const srcTokens = getLeafTokens(src);
  const offset = findInsertionOffset(srcTokens, patt, src.length);

  // --- Новый блок для корректной вставки ---
  let beforeRaw = src.slice(0, offset);
  const lastNlIdx = beforeRaw.lastIndexOf('\n');
  const afterLastNl = beforeRaw.slice(lastNlIdx + 1);
  const indent = afterLastNl.match(/^\s*/)[0];

  // Если строка-плейсхолдер пустая — убираем её
  const isPlaceholderLine = /^[\s]*$/.test(afterLastNl);
  let beforeBase = isPlaceholderLine
    ? beforeRaw.slice(0, lastNlIdx + 1)
    : beforeRaw;

  // Для inline удаляем лишний перенос строки, если он есть
  if (isInline && beforeBase.endsWith('\n')) {
    beforeBase = beforeBase.slice(0, -1);
  }

  // Добавляем перевод строки перед вставкой, если нужно
  const needsNl = !isInline && offset !== 0 && !beforeBase.endsWith('\n');

  // Формируем текст патча с учётом inline
  let patchedLines;
  if (isInline) {
    // Inline-вставка: без отступов и без новой строки
    patchedLines = patch.trim();
  } else {
    patchedLines = patch
      .split(/\r?\n/)
      .map(line => indent + line)
      .join('\n');
  }
  const insertText = (needsNl ? '\n' : '') + patchedLines;
  // --- Конец нового блока ---

  const result = beforeBase + insertText + src.slice(offset);
  fs.mkdirSync(path.dirname(argv.out), { recursive: true });
  fs.writeFileSync(argv.out, result, 'utf8');
  console.log(`Patched at byte offset ${offset}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
