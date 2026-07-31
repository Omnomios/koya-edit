#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct HighlightSpan
{
    uint32_t start = 0; // Unicode code point offset
    uint32_t end = 0;   // half-open
    std::string scope;
};

struct HighlightStreamOpts
{
    /** Prefer this UTF-8 byte range first (e.g. visible viewport). 0,0 = none. */
    uint32_t preferStartByte = 0;
    uint32_t preferEndByte = 0;
    /** Prefer this half-open line range first. to=0 means unused. */
    uint32_t preferFromRow = 0;
    uint32_t preferToRow = 0;
    /** Lines per streamed chunk after the preferred range. */
    uint32_t linesPerChunk = 64;
    /**
     * Optional nested language for `(inline)` nodes (markdown → markdown_inline).
     * When set, each matching node is re-parsed with injectionLanguage + injectionQuery.
     */
    std::string injectionLanguage;
    std::string injectionQuery;
};

/**
 * Progress callback invoked on the worker thread. The host must marshal to the
 * JS thread (e.g. post_completion). Chunks use code-point offsets.
 * fromRow/toRow are the half-open line range this chunk owns; done marks EOF.
 */
using HighlightChunkFn = std::function<void(std::vector<HighlightSpan>&& spans,
                                            uint32_t fromRow,
                                            uint32_t toRow,
                                            bool done)>;

/** Register built-in javascript / c / cpp / json / markdown grammars. Safe to call multiple times. */
void highlight_register_builtins();

/**
 * dlopen a grammar shared library and register it under languageId.
 * symbol is typically "tree_sitter_<id>".
 */
bool highlight_load_grammar(const std::string& path,
                            const std::string& symbol,
                            const std::string& languageId,
                            std::string& error);

bool highlight_has_language(const std::string& languageId);

/**
 * Parse source as UTF-8, run highlights query, return non-overlapping
 * code-point spans (later captures win on overlap).
 */
std::vector<HighlightSpan> highlight_run(const std::string& source,
                                         const std::string& languageId,
                                         const std::string& query,
                                         std::string& error);

/**
 * Full parse once, then query + flatten in line blocks, streaming each block
 * through onChunk so the UI can paint progressively. Returns all spans (also
 * delivered via chunks) for callers that want the complete set.
 */
std::vector<HighlightSpan> highlight_run_stream(const std::string& source,
                                                const std::string& languageId,
                                                const std::string& query,
                                                const HighlightStreamOpts& opts,
                                                const HighlightChunkFn& onChunk,
                                                std::string& error);
