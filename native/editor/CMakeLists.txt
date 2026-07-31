cmake_minimum_required(VERSION 3.16)
cmake_policy(SET CMP0048 NEW)

project(sm-editor VERSION 0.1.0 DESCRIPTION "KoyaEdit Module/editor gap-fill plugin")

include(FetchContent)

# Populate sources only — do not add_subdirectory (grammar CMakeLists conflict on ts-test).
FetchContent_Declare(tree_sitter
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter.git
  GIT_TAG v0.24.7
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_javascript
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-javascript.git
  GIT_TAG v0.23.1
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_c
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-c.git
  GIT_TAG v0.23.2
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_cpp
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-cpp.git
  GIT_TAG v0.23.4
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_json
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-json.git
  GIT_TAG v0.24.8
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_markdown
  GIT_REPOSITORY https://github.com/tree-sitter-grammars/tree-sitter-markdown.git
  GIT_TAG v0.4.1
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_html
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-html.git
  GIT_TAG v0.23.2
  GIT_SHALLOW TRUE
)
FetchContent_Declare(tree_sitter_css
  GIT_REPOSITORY https://github.com/tree-sitter/tree-sitter-css.git
  GIT_TAG v0.23.2
  GIT_SHALLOW TRUE
)

FetchContent_GetProperties(tree_sitter)
if(NOT tree_sitter_POPULATED)
  FetchContent_Populate(tree_sitter)
endif()
FetchContent_GetProperties(tree_sitter_javascript)
if(NOT tree_sitter_javascript_POPULATED)
  FetchContent_Populate(tree_sitter_javascript)
endif()
FetchContent_GetProperties(tree_sitter_c)
if(NOT tree_sitter_c_POPULATED)
  FetchContent_Populate(tree_sitter_c)
endif()
FetchContent_GetProperties(tree_sitter_cpp)
if(NOT tree_sitter_cpp_POPULATED)
  FetchContent_Populate(tree_sitter_cpp)
endif()
FetchContent_GetProperties(tree_sitter_json)
if(NOT tree_sitter_json_POPULATED)
  FetchContent_Populate(tree_sitter_json)
endif()
FetchContent_GetProperties(tree_sitter_markdown)
if(NOT tree_sitter_markdown_POPULATED)
  FetchContent_Populate(tree_sitter_markdown)
endif()
FetchContent_GetProperties(tree_sitter_html)
if(NOT tree_sitter_html_POPULATED)
  FetchContent_Populate(tree_sitter_html)
endif()
FetchContent_GetProperties(tree_sitter_css)
if(NOT tree_sitter_css_POPULATED)
  FetchContent_Populate(tree_sitter_css)
endif()

add_library(tree-sitter-lib STATIC
  ${tree_sitter_SOURCE_DIR}/lib/src/lib.c
)
target_include_directories(tree-sitter-lib PUBLIC
  ${tree_sitter_SOURCE_DIR}/lib/include
)
target_compile_definitions(tree-sitter-lib PRIVATE TREE_SITTER_HIDE_SYMBOLS)
set_target_properties(tree-sitter-lib PROPERTIES POSITION_INDEPENDENT_CODE ON)

function(add_ts_grammar name srcdir)
  set(sources ${srcdir}/src/parser.c)
  if(EXISTS ${srcdir}/src/scanner.c)
    list(APPEND sources ${srcdir}/src/scanner.c)
  elseif(EXISTS ${srcdir}/src/scanner.cc)
    list(APPEND sources ${srcdir}/src/scanner.cc)
  endif()
  add_library(ts_${name} STATIC ${sources})
  target_include_directories(ts_${name} PRIVATE
    ${srcdir}/src
    ${tree_sitter_SOURCE_DIR}/lib/include
  )
  target_link_libraries(ts_${name} PUBLIC tree-sitter-lib)
  set_target_properties(ts_${name} PROPERTIES POSITION_INDEPENDENT_CODE ON)
endfunction()

add_ts_grammar(javascript ${tree_sitter_javascript_SOURCE_DIR})
add_ts_grammar(c ${tree_sitter_c_SOURCE_DIR})
add_ts_grammar(cpp ${tree_sitter_cpp_SOURCE_DIR})
add_ts_grammar(json ${tree_sitter_json_SOURCE_DIR})
add_ts_grammar(markdown ${tree_sitter_markdown_SOURCE_DIR}/tree-sitter-markdown)
add_ts_grammar(markdown_inline ${tree_sitter_markdown_SOURCE_DIR}/tree-sitter-markdown-inline)
add_ts_grammar(html ${tree_sitter_html_SOURCE_DIR})
add_ts_grammar(css ${tree_sitter_css_SOURCE_DIR})

add_library(sm-editor SHARED
  src/module.cpp
  src/highlight.cpp
)

target_include_directories(sm-editor PRIVATE src sdk ${tree_sitter_SOURCE_DIR}/lib/include)

find_package(Threads REQUIRED)
target_link_libraries(sm-editor PRIVATE
  Threads::Threads
  tree-sitter-lib
  ts_javascript
  ts_c
  ts_cpp
  ts_json
  ts_markdown
  ts_markdown_inline
  ts_html
  ts_css
  ${CMAKE_DL_LIBS}
)

target_compile_features(sm-editor PUBLIC cxx_std_20)

set_target_properties(sm-editor PROPERTIES
  OUTPUT_NAME "sm-editor"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)
