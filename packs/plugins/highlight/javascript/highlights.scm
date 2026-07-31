; JavaScript highlights — structural scopes for VS Code–style colouring.
; Predicates supported by Module/editor: #eq? #not-eq? #any-of? #not-any-of?
; #match? (limited patterns). Do not use #is? / #lua-match? (rejected).

; Variables (lowest priority — specialised rules below override)
;--------------------------------------------------------------
(identifier) @variable

; Member access (.parentState) — default foreground (not the instance colour).
; Object-literal keys override to @property below.
(property_identifier) @member
(private_property_identifier) @member
(shorthand_property_identifier) @property
(shorthand_property_identifier_pattern) @property

; Object keys (key: value) — white like members (not instance orange)
;----------------------------------------------------------------
(pair
  key: (property_identifier) @property)
(pair
  key: (string) @string)
(pair
  key: (number) @number)

(object_pattern
  (shorthand_property_identifier_pattern) @variable)
(object_pattern
  (object_assignment_pattern
    (shorthand_property_identifier_pattern) @variable))
(object_pattern
  (pair_pattern
    key: (property_identifier) @property))

; Parameters
;-----------
(formal_parameters
  (identifier) @variable.parameter)
(formal_parameters
  (rest_pattern
    (identifier) @variable.parameter))
(formal_parameters
  (assignment_pattern
    left: (identifier) @variable.parameter))
(formal_parameters
  (object_pattern
    (pair_pattern
      value: (identifier) @variable.parameter)))
(formal_parameters
  (object_pattern
    (shorthand_property_identifier_pattern) @variable.parameter))
(formal_parameters
  (array_pattern
    (identifier) @variable.parameter))
(arrow_function
  parameter: (identifier) @variable.parameter)
(catch_clause
  parameter: (identifier) @variable.parameter)

; Function / method definitions
;------------------------------
(function_expression name: (identifier) @function)
(function_declaration name: (identifier) @function)
(generator_function name: (identifier) @function)
(generator_function_declaration name: (identifier) @function)
(method_definition
  name: [(property_identifier) (private_property_identifier)] @function.method)
(method_definition
  name: (property_identifier) @constructor
  (#eq? @constructor "constructor"))

(pair
  key: (property_identifier) @function.method
  value: [(function_expression) (arrow_function)])

(assignment_expression
  left: (member_expression
    property: (property_identifier) @function.method)
  right: [(function_expression) (arrow_function)])

(variable_declarator
  name: (identifier) @function
  value: [(function_expression) (arrow_function)])
(assignment_expression
  left: (identifier) @function
  right: [(function_expression) (arrow_function)])

; Function / method calls
;------------------------
(call_expression function: (identifier) @function)
(call_expression
  function: (member_expression
    property: [(property_identifier) (private_property_identifier)] @function.method))
(call_expression
  function: (await_expression (identifier) @function))
(call_expression
  function: (await_expression
    (member_expression
      property: [(property_identifier) (private_property_identifier)] @function.method)))

; UPPER_SNAKE constants
;----------------------
([
  (identifier)
  (shorthand_property_identifier)
  (shorthand_property_identifier_pattern)
 ] @constant
 (#match? @constant "^[A-Z_][A-Z\\d_]+$"))

; No broad PascalCase→type: Math must stay @variable (cyan) for Math.hypot.
; Ctors are listed in @type.builtin below.

; Built-in ctors (Number, String, Map, …) — green. Namespaces like Math stay
; @variable (cyan) so Math.hypot paints Math blue and hypot purple.
;-------------------------------------------------------------------------------
((identifier) @type.builtin
 (#any-of? @type.builtin
  "Object" "Function" "Boolean" "Symbol" "Number" "Date" "String" "RegExp"
  "Map" "Set" "WeakMap" "WeakSet" "Promise" "Array" "Int8Array" "Uint8Array"
  "Uint8ClampedArray" "Int16Array" "Uint16Array" "Int32Array" "Uint32Array"
  "Float32Array" "Float64Array" "BigInt64Array" "BigUint64Array"
  "ArrayBuffer" "SharedArrayBuffer" "DataView" "Proxy"
  "Error" "EvalError" "RangeError" "ReferenceError" "SyntaxError" "TypeError"
  "URIError" "AggregateError" "BigInt"))

((identifier) @function.builtin
 (#any-of? @function.builtin
  "eval" "isFinite" "isNaN" "parseFloat" "parseInt"
  "decodeURI" "decodeURIComponent" "encodeURI" "encodeURIComponent" "require"))

((identifier) @variable.builtin
 (#any-of? @variable.builtin
  "arguments" "module" "console" "window" "document" "globalThis" "self" "global"
  "Math" "JSON" "Reflect" "Atomics" "Intl"))

((identifier) @module.builtin
 (#eq? @module.builtin "Intl"))

(class_declaration name: (identifier) @type)
(new_expression constructor: (identifier) @constructor)
(new_expression
  constructor: (member_expression property: (property_identifier) @constructor))

; for (let index = …) / for (const x of …) — loop vars → param orange
(for_statement
  initializer: (lexical_declaration
    (variable_declarator
      name: (identifier) @variable.parameter)))
(for_in_statement
  left: (identifier) @variable.parameter)

; Literals
;---------
[(this) (super)] @variable.builtin

[(true) (false)] @boolean
[(null) (undefined)] @constant.builtin

((identifier) @constant.builtin
 (#any-of? @constant.builtin "NaN" "Infinity"))

(comment) @comment
[(string) (template_string)] @string
(regex) @string
(number) @number

(template_substitution
  "${" @keyword
  "}" @keyword) @embedded

; Operators / punctuation
;------------------------
(optional_chain) @operator

; => matches call colour (purple) in the reference theme
"=>" @function

["-" "--" "-=" "+" "++" "+=" "*" "*=" "**" "**=" "/" "/=" "%" "%="
 "<" "<=" "<<" "<<=" "=" "==" "===" "!" "!=" "!==" ">" ">=" ">>" ">>="
 ">>>" ">>>=" "~" "^" "&" "|" "^=" "&=" "|=" "&&" "||" "??" "&&=" "||=" "??="
 "..."] @operator

(ternary_expression ["?" ":"] @operator)

["(" ")" "[" "]" "{" "}"] @punctuation
[";" "." "," ":"] @punctuation

; Keywords (highest among word tokens — structural string matches)
;-----------------------------------------------------------------
["as" "async" "await" "break" "case" "catch" "class" "const" "continue"
 "debugger" "default" "delete" "do" "else" "export" "extends" "finally"
 "for" "from" "function" "get" "if" "import" "in" "instanceof" "let" "new"
 "of" "return" "set" "static" "switch" "target" "throw" "try" "typeof" "var"
 "void" "while" "with" "yield"] @keyword

; Import / export bindings — default foreground (override var/type)
;------------------------------------------------------------------
(import_clause (identifier) @module)
(namespace_import (identifier) @module)
(named_imports
  (import_specifier name: (identifier) @module))
(import_specifier alias: (identifier) @module)
(export_specifier name: (identifier) @module)
(export_specifier alias: (identifier) @module)
