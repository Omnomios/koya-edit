; tree-sitter-c highlights (simplified).
; Derived from tree-sitter/tree-sitter-c queries/highlights.scm

(identifier) @variable

"break" @keyword
"case" @keyword
"const" @keyword
"continue" @keyword
"default" @keyword
"do" @keyword
"else" @keyword
"enum" @keyword
"extern" @keyword
"for" @keyword
"if" @keyword
"inline" @keyword
"return" @keyword
"sizeof" @keyword
"static" @keyword
"struct" @keyword
"switch" @keyword
"typedef" @keyword
"union" @keyword
"volatile" @keyword
"while" @keyword
"goto" @keyword

"#define" @keyword
"#elif" @keyword
"#else" @keyword
"#endif" @keyword
"#if" @keyword
"#ifdef" @keyword
"#ifndef" @keyword
"#include" @keyword
(preproc_directive) @keyword

"--" @operator
"-" @operator
"-=" @operator
"->" @operator
"=" @operator
"!=" @operator
"*" @operator
"&" @operator
"&&" @operator
"+" @operator
"++" @operator
"+=" @operator
"<" @operator
"==" @operator
">" @operator
"||" @operator
"/" @operator
"%" @operator
"|" @operator
"^" @operator
"<<" @operator
">>" @operator

"." @punctuation
";" @punctuation
"," @punctuation
"(" @punctuation
")" @punctuation
"[" @punctuation
"]" @punctuation
"{" @punctuation
"}" @punctuation

(string_literal) @string
(system_lib_string) @string
(null) @constant
(number_literal) @number
(char_literal) @number

(field_identifier) @property
(type_identifier) @type
(primitive_type) @type
(sized_type_specifier) @type

(call_expression function: (identifier) @function)
(function_declarator declarator: (identifier) @function)

(comment) @comment
