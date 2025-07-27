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
import { execSync } from 'child_process';

// Лексер для match-блока
function lexMatch(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    // 1. Пробелы/табуляции/переносы
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }

    // 2. Мета‑токены
    if (text.startsWith('...', i)) {
      tokens.push({ type: 'wildcard', text: '...' });
      i += 3;
      continue;
    }
    if (text.startsWith('>>>', i)) {
      tokens.push({ type: 'inserter', text: '>>>' });
      i += 3;
      continue;
    }
    if (text.startsWith('<<<', i)) {
      tokens.push({ type: 'folder', text: '<<<' });
      i += 3;
      continue;
    }

    // 3. Препроцессор‑директива (e.g. #include)
    const dir = /^#[A-Za-z_]\w*/.exec(text.slice(i));
    if (dir) {
      tokens.push({ type: 'directive', text: dir[0] });
      i += dir[0].length;
      continue;
    }

    // 4. Строковый литерал
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j += 2;
        else j++;
      }
      tokens.push({ type: 'string', text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // 5. Комментарии
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      tokens.push({ type: 'comment', text: text.slice(i, end < 0 ? undefined : end) });
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      tokens.push({ type: 'comment', text: text.slice(i, end < 0 ? undefined : end + 2) });
      i = end < 0 ? text.length : end + 2;
      continue;
    }

    // 6. Многосимвольные операторы
    const multiOp = /^(==|!=|<=|>=|\+\+|--|->|&&|\|\||<<|>>)/.exec(text.slice(i));
    if (multiOp) {
      tokens.push({ type: 'operator', text: multiOp[0] });
      i += multiOp[0].length;
      continue;
    }

    // 7. Идентификаторы
    const id = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (id) {
      tokens.push({ type: 'identifier', text: id[0] });
      i += id[0].length;
      continue;
    }

    // 8. Числа
    const num = /^\d+/.exec(text.slice(i));
    if (num) {
      tokens.push({ type: 'number', text: num[0] });
      i += num[0].length;
      continue;
    }

    // 9. Всё остальное — одиночный символ
    tokens.push({ type: 'symbol', text: text[i] });
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

// Поиск оффсетов вставки и удаления (с поддержкой wildcard)
function findInsertionOffset(sourceTokens, patternTokens, srcLength) {
  // специальный случай: заменить всё
  if (
    patternTokens.length === 3 &&
    patternTokens[0].type === 'inserter' &&
    patternTokens[1].type === 'wildcard' &&
    patternTokens[2].type === 'folder'
  ) {
    return { insertionOffset: 0, deleteOffset: srcLength };
  }
  // специальный случай: вставка в конце кода
  if (
    patternTokens.length === 2 &&
    patternTokens[0].type === 'wildcard' &&
    patternTokens[1].type === 'inserter'
  ) {
    return { insertionOffset: srcLength, deleteOffset: null };
  }

  let insertionOffset = null;
  let deleteOffset = null;

  function recurse(si, pi) {
    if (pi === patternTokens.length) return insertionOffset;

    const p = patternTokens[pi];
    // пропускаем комментарии
    if (p.type === 'comment') {
      return recurse(si, pi + 1);
    }
    // inserter — маркер вставки
    if (p.type === 'inserter') {
      insertionOffset = (si >= sourceTokens.length)
        ? srcLength
        : sourceTokens[si].startIndex;
      return recurse(si, pi + 1);
    }
    // folder (<<<) — маркер удаления
    if (p.type === 'folder') {
      deleteOffset = (si >= sourceTokens.length)
        ? srcLength
        : sourceTokens[si].startIndex;
      return recurse(si, pi + 1);
    }
    if (p.type === 'wildcard') {
      let nextIdx = pi + 1;
      while (
        nextIdx < patternTokens.length &&
        ['wildcard','comment','folder','inserter'].includes(patternTokens[nextIdx].type)
      ) {
        nextIdx++;
      }
      if (nextIdx >= patternTokens.length) {
        return recurse(sourceTokens.length, nextIdx);
      }
      const nextTok = patternTokens[nextIdx];
      for (let sj = si; sj <= sourceTokens.length; sj++) {
        if (sj < sourceTokens.length && sourceTokens[sj].text !== nextTok.text) continue;
        const r = recurse(sj, pi + 1);
        if (r != null) return r;
      }
      return null;
    }
    if (si < sourceTokens.length && sourceTokens[si].text === p.text) {
      return recurse(si + 1, pi + 1);
    }
    return null;
  }

  recurse(0, 0);
  if (insertionOffset == null) {
    throw new Error('Не удалось найти место вставки по паттерну');
  }
  return { insertionOffset, deleteOffset };
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
  const { insertionOffset: offset, deleteOffset } = findInsertionOffset(srcTokens, patt, src.length);

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

  // Если есть deleteOffset и он после insertOffset — удаляем участок
  const tailStart = (deleteOffset != null && deleteOffset > offset)
    ? deleteOffset
    : offset;
  const result = beforeBase + insertText + src.slice(tailStart);
  fs.mkdirSync(path.dirname(argv.out), { recursive: true });
  fs.writeFileSync(argv.out, result, 'utf8');
  console.log(`Patched at byte offset ${offset}`);

  // Вычисляем позицию курсора в конце вставленного текста
  const beforeLines = beforeBase.split('\n');
  let cursorLine = beforeLines.length;
  let cursorColumn = (beforeLines[beforeLines.length - 1] || '').length + insertText.length + 1;

  // Вычисляем начальную позицию для подсветки (начало patch)
  let startLine = cursorLine - 1; // Нумерация в VSCode с 0
  let startCol;
  if (isInline) {
    // Для inline: начало — это позиция курсора минус длина patch
    startCol = cursorColumn - patch.trim().length - 1;
  } else {
    // Для многострочного: начало — это начало первой строки patch, учитывая indent
    startCol = indent.length;
  }

  // Формируем команду для открытия файла в VSCode
  const filePath = path.resolve(argv.out);
  const codeCmd = `code --goto "${filePath}:${cursorLine}:${cursorColumn}"`;

  // Формируем URI для подсветки через расширение
  const encodedPath = encodeURIComponent(filePath);
  const uri = `vscode://DK.vscode-smartpatch-highlighter?path=${encodedPath}&startLine=${startLine}&startCol=${startCol}&endLine=${cursorLine - 1}&endCol=${cursorColumn - 1}`;

  // Выполняем команды
  try {
    // Открываем файл в VSCode
    execSync(codeCmd, { stdio: 'inherit' });

    // Вызываем URI для подсветки
    let openUriCmd;
    if (process.platform === 'win32') {
      openUriCmd = `start "" "${uri}"`;
    } else if (process.platform === 'darwin') {
      openUriCmd = `open "${uri}"`;
    } else {
      openUriCmd = `xdg-open "${uri}"`;
    }
    execSync(openUriCmd, { stdio: 'inherit' });
  } catch (err) {
    console.error(err.message);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});