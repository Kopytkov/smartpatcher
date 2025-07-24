/**
 * Tree-sitter grammar for generic C++/TypeScript match-block parsing
 */

const PREC = {
  STRING: 1,
  CHAR: 1,
  COMMENT: 1,
};

module.exports = grammar({
  name: 'match',

  extras: $ => [
    $.comment,
    /\r?\n|\s+/  // пробелы и переносы строк автоматически пропускаются
  ],

  rules: {
    // Корневое правило: повторяемость любых элементов
    source_file: $ => repeat($.item),

    // Любой элемент в match-блоке
    item: $ => choice(
      $.wildcard,
      $.inserter,
      $.folder,
      $.block_curly,
      $.block_paren,
      $.block_square,
      $.block_angle,
      $.string_literal,
      $.char_literal,
      $.comment,
      $.text
    ),

    // Точный wildcard для пропуска кода: ровно три точки
    wildcard: $ => '...',
    // Маркер вставки: >>>
    inserter: $ => '>>>',
    // Маркер удаления/фолдинга: <<<
    folder: $ => '<<<',

    // Вложенные блоки различных скобок
    block_curly: $ => seq('{', repeat($.item), '}'),
    block_paren: $ => seq('(', repeat($.item), ')'),
    block_square: $ => seq('[', repeat($.item), ']'),
    block_angle: $ => seq('<', repeat($.item), '>'),

    // Строковые литералы C++/TS
    string_literal: $ => choice(
      seq('"', repeat(choice($.escape_sequence, /[^"\\\n]/)), '"'),
      seq("'", repeat(choice($.escape_sequence, /[^'\\\n]/)), "'")
    ),
    char_literal: $ => seq("'", repeat(choice($.escape_sequence, /[^'\\\n]/)), "'"),
    escape_sequence: $ => token(seq('\\', /./)),

    // Комментарии C++
    comment: $ => choice(
      token(seq('//', /.*/)),
      token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'))
    ),

    // Любой прочий текст (без точек) — идентификаторы, операторы, числа и т.п.
    text: $ => token(/[^.<>{}\[\]"'\/\s]+/)
  }
});
