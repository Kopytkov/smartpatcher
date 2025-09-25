/**
 * Tree-sitter grammar for generic C++/TypeScript match-block parsing
 */

const PREC = {
  STRING: 1,
  CHAR: 1,
  COMMENT: 1,
  OPERATOR: 2, // Приоритет для операторов, чтобы разрешить конфликты
};

module.exports = grammar({
  name: 'match',

  extras: $ => [
    $.comment,
    /\r?\n|\s+/  // Пробелы и переносы строк
  ],

  conflicts: $ => [
    [$.inserter, $.operator], // Конфликт между >>> и >>
    [$.folder, $.operator],   // Конфликт между <<< и <<
  ],

  rules: {
    // Корневое правило
    source_file: $ => repeat($.item),

    // Любой элемент в match-блоке
    item: $ => choice(
      $.wildcard,
      $.inserter,
      $.folder,
      $.skipper,
      $.block_curly,
      $.block_paren,
      $.block_square,
      $.block_angle,
      $.string_literal,
      $.char_literal,
      $.comment,
      $.number_literal,
      $.operator,
      $.punctuation,
      $.text
    ),

    // Точный wildcard для пропуска кода
    wildcard: $ => '...',
    // Маркер вставки: >>>
    inserter: $ => '>>>',
    // Маркер удаления/фолдинга: <<<
    folder: $ => '<<<',
    // Пропуск до следующего символа
    skipper: $ => '._.',

    // Вложенные блоки
    block_curly: $ => seq('{', repeat($.item), '}'),
    block_paren: $ => seq('(', repeat($.item), ')'),
    block_square: $ => seq('[', repeat($.item), ']'),
    block_angle: $ => seq('<', repeat($.item), '>'),

    // Строковые и символьные литералы
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

    // Числовые литералы (целые и с плавающей точкой)
    number_literal: $ => token(choice(
      /[0-9]+/,                     // Целые: 123
      /0[xX][0-9a-fA-F]+/,         // Шестнадцатеричные: 0x1A
      /0[bB][01]+/,                // Двоичные: 0b1010
      /[0-7]+/,                    // Восьмеричные: 0123
      /[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?/ // Плавающая точка: 1.23, .123, 1.23e-4
    )),

    // Операторы C++
    operator: $ => token(prec(PREC.OPERATOR, choice(
      '+', '-', '*', '/', '%',
      '==', '!=', '<=', '>=', '<', '>',
      '&&', '||', '!',
      '&', '|', '^', '~', '<<', '>>',
      '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
      '++', '--', '->', '.', '::', '.*', '->*'
    ))),

    // Прочая пунктуация
    punctuation: $ => token(choice(
      ',', ';', '?', ':', '#'
    )),

    // Текст (идентификаторы и прочее, теперь включая точку)
    text: $ => token(/[^<>{}\[\]"'\/\s]+/) // Убрали . из исключений
  }
});