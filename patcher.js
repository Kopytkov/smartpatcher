#!/usr/bin/env node

/**
 * CLI-утилита на Node.js для применения Markdown-патчей к C++-файлам с учетом вложенности.
 * Учитывает отступы, расположение `>>>` и уровень вложенности скобок `{}`.
 */
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { execSync } from 'child_process';

// Лексер для match-блока с учетом вложенности
function lexMatch(text) {
  const tokens = [];
  let i = 0;
  let nestingLevel = 0; // Уровень вложенности

  while (i < text.length) {
    // 1. Пробелы/табуляции/переносы
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }

    // 2. Мета‑токены
    if (text.startsWith('...', i)) {
      tokens.push({ type: 'wildcard', text: '...', nestingLevel });
      i += 3;
      continue;
    }
    if (text.startsWith('>>>', i)) {
      tokens.push({ type: 'inserter', text: '>>>', nestingLevel });
      i += 3;
      continue;
    }
    if (text.startsWith('<<<', i)) {
      tokens.push({ type: 'folder', text: '<<<', nestingLevel });
      i += 3;
      continue;
    }

    // 3. Препроцессор‑директива (e.g. #include)
    const dir = /^#[A-Za-z_]\w*/.exec(text.slice(i));
    if (dir) {
      tokens.push({ type: 'directive', text: dir[0], nestingLevel });
      i += dir[0].length;
      continue;
    }

    // 4. Строковый литерал
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      let stringParts = [];
      let start = j;

      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') {
          // Пропускаем экранированные символы
          j += 2;
          continue;
        }
        // Проверяем на наличие >>> или <<< внутри строки
        if (text.startsWith('>>>', j) || text.startsWith('<<<', j)) {
          if (start < j) {
            // Сохраняем текст до мета-токена как часть строки
            stringParts.push({ type: 'string', text: text.slice(start, j), nestingLevel });
          }
          const metaType = text.startsWith('>>>', j) ? 'inserter' : 'folder';
          stringParts.push({ type: metaType, text: text.slice(j, j + 3), nestingLevel });
          j += 3;
          start = j;
          continue;
        }
        j++;
      }

      // Сохраняем оставшуюся часть строки, если она есть
      if (start < j) {
        stringParts.push({ type: 'string', text: text.slice(start, j), nestingLevel });
      }

      // Добавляем открывающую кавычку
      tokens.push({ type: 'string', text: quote, nestingLevel });
      // Добавляем все части строки и мета-токены
      tokens.push(...stringParts);
      // Добавляем закрывающую кавычку, если она есть
      if (j < text.length && text[j] === quote) {
        tokens.push({ type: 'string', text: quote, nestingLevel });
        j++;
      }
      i = j;
      continue;
    }
    
    // 5. Комментарии
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      tokens.push({ type: 'comment', text: text.slice(i, end < 0 ? undefined : end), nestingLevel });
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      tokens.push({ type: 'comment', text: text.slice(i, end < 0 ? undefined : end + 2), nestingLevel });
      i = end < 0 ? text.length : end + 2;
      continue;
    }

    // 6. Многосимвольные операторы
    const multiOp = /^(==|!=|<=|>=|\+\+|--|->|&&|\|\||<<|>>)/.exec(text.slice(i));
    if (multiOp) {
      tokens.push({ type: 'operator', text: multiOp[0], nestingLevel });
      i += multiOp[0].length;
      continue;
    }

    // 7. Идентификаторы
    const id = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (id) {
      tokens.push({ type: 'identifier', text: id[0], nestingLevel });
      i += id[0].length;
      continue;
    }

    // 8. Числа
    const num = /^\d+/.exec(text.slice(i));
    if (num) {
      tokens.push({ type: 'number', text: num[0], nestingLevel });
      i += num[0].length;
      continue;
    }

    // 9. Скобки (отслеживаем вложенность)
    if (/[{(}\[\])]/.test(text[i])) {
      if (text[i] === '{') nestingLevel++;
      tokens.push({ type: 'bracket', text: text[i], nestingLevel });
      if (text[i] === '}') nestingLevel--;
      i++;
      continue;
    }

    // 10. Всё остальное — одиночный символ
    tokens.push({ type: 'symbol', text: text[i], nestingLevel });
    i++;
  }
  return tokens;
}

// Собирает листовые токены из AST C++ с учетом вложенности
function getLeafTokens(src) {
  const parser = new Parser();
  parser.setLanguage(Cpp);
  const tree = parser.parse(src);
  const leaves = [];

  function walk(node, nestingLevel = 0) {
    if (node.type === 'compound_statement') {
      nestingLevel++; // Увеличиваем уровень при входе в блок
    }
    if (node.childCount === 0) {
      leaves.push({ text: node.text, startIndex: node.startIndex, nestingLevel });
    } else {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel);
      }
    }
  }
  walk(tree.rootNode);
  return leaves;
}

// Поиск оффсетов вставки и удаления с учетом вложенности
function findInsertionOffset(sourceTokens, patternTokens, srcLength) {
  // Специальный случай: заменить всё
  if (
    patternTokens.length === 3 &&
    patternTokens[0].type === 'inserter' &&
    patternTokens[1].type === 'wildcard' &&
    patternTokens[2].type === 'folder'
  ) {
    return { insertionOffset: 0, deleteOffset: srcLength };
  }
  // Специальный случай: вставка в конце кода
  if (
    patternTokens.length === 2 &&
    patternTokens[0].type === 'wildcard' &&
    patternTokens[1].type === 'inserter'
  ) {
    return { insertionOffset: srcLength, deleteOffset: null };
  }

  let insertionOffset = null;
  let deleteOffset = null;

  function recurse(si, pi, currentNestingLevel = 0) {
    if (pi === patternTokens.length) return insertionOffset;

    const p = patternTokens[pi];
    // Пропускаем комментарии
    if (p.type === 'comment') {
      return recurse(si, pi + 1, currentNestingLevel);
    }
    // Inserter — маркер вставки
    if (p.type === 'inserter') {
      insertionOffset = (si >= sourceTokens.length)
        ? srcLength
        : sourceTokens[si].startIndex;
      return recurse(si, pi + 1, currentNestingLevel);
    }
    // Folder (<<<) — маркер удаления
    if (p.type === 'folder') {
      deleteOffset = (si >= sourceTokens.length)
        ? srcLength
        : sourceTokens[si].startIndex;
      return recurse(si, pi + 1, currentNestingLevel);
    }
    // Wildcard с учетом вложенности
    if (p.type === 'wildcard') {
      let nextIdx = pi + 1;
      while (
        nextIdx < patternTokens.length &&
        ['wildcard', 'comment', 'folder', 'inserter'].includes(patternTokens[nextIdx].type)
      ) {
        nextIdx++;
      }
      if (nextIdx >= patternTokens.length) {
        return recurse(sourceTokens.length, nextIdx, currentNestingLevel);
      }
      const nextTok = patternTokens[nextIdx];
      for (let sj = si; sj <= sourceTokens.length; sj++) {
        // Проверяем, чтобы уровень вложенности совпадал
        if (sj < sourceTokens.length && sourceTokens[sj].nestingLevel !== p.nestingLevel) {
          continue;
        }
        if (sj < sourceTokens.length && sourceTokens[sj].text !== nextTok.text) {
          continue;
        }
        // Если это '}', проверяем, чтобы уровень вложенности совпадал с ожидаемым
        if (sj < sourceTokens.length && nextTok.text === '}' && sourceTokens[sj].nestingLevel !== nextTok.nestingLevel) {
          continue;
        }
        const r = recurse(sj, pi + 1, sourceTokens[sj]?.nestingLevel || currentNestingLevel);
        if (r != null) return r;
      }
      return null;
    }
    if (si < sourceTokens.length && sourceTokens[si].text === p.text && sourceTokens[si].nestingLevel === p.nestingLevel) {
      return recurse(si + 1, pi + 1, sourceTokens[si].nestingLevel);
    }
    return null;
  }

  recurse(0, 0, 0);
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

  const matchLines = match.split(/\r?\n/);
  const inserterLine = matchLines.find(line => line.includes('>>>')) || '';
  const isInline = inserterLine.trim() !== '>>>';

  const patt = lexMatch(match);
  const srcTokens = getLeafTokens(src);
  const { insertionOffset: offset, deleteOffset } = findInsertionOffset(srcTokens, patt, src.length);

  // --- Подготовка вставки ---
  let beforeRaw = src.slice(0, offset);
  const lastNlIdx = beforeRaw.lastIndexOf('\n');
  const afterLastNl = beforeRaw.slice(lastNlIdx + 1);
  const indent = afterLastNl.match(/^\s*/)?.[0] || '';

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

  // Если есть deleteOffset и он после insertOffset — удаляем участок
  const tailStart = (deleteOffset != null && deleteOffset > offset)
    ? deleteOffset
    : offset;
  const result = beforeBase + insertText + src.slice(tailStart);
  fs.mkdirSync(path.dirname(argv.out), { recursive: true });
  fs.writeFileSync(argv.out, result, 'utf8');
  console.log(`Patched at byte offset ${offset}`);

  // --- Подсветка и позиционирование курсора ---
  const patchLines = patch.trim().split(/\r?\n/);
  const patchLineCount = patchLines.length;

  const beforeLines = beforeBase.split('\n');
  const startLine = beforeLines.length;
  const startCol = isInline
    ? (beforeLines[beforeLines.length - 1] || '').length
    : indent.length;

  const endLine = startLine + patchLineCount - 1;
  const endCol = isInline
    ? startCol + patchLines[0].length
    : patchLines[patchLineCount - 1].length + indent.length;

  const cursorLine = endLine;
  const cursorColumn = endCol + 1; // курсор после последнего символа

  const filePath = path.resolve(argv.out);
  const codeCmd = `code --goto "${filePath}:${cursorLine}:${cursorColumn}"`;

  // Формируем URI для подсветки через расширение
  const encodedPath = encodeURIComponent(filePath);
  const uri = `vscode://DK.vscode-smartpatch-highlighter?path=${encodedPath}&startLine=${startLine-1}&startCol=${startCol}&endLine=${endLine-1}&endCol=${endCol}`;

  try {
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