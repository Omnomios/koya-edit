; tree-sitter-json highlights (VS Code Dark+-style scopes via theme.syntax).
; Key strings use @property (light blue); values stay @string (orange).

(string) @string

(pair
  key: (string) @property)

(number) @number

[
  (null)
  (true)
  (false)
] @constant

(escape_sequence) @string

[
  "{"
  "}"
  "["
  "]"
  ","
  ":"
] @punctuation
