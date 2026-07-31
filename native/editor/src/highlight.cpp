#include "highlight.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <tree_sitter/api.h>

extern "C" {
const TSLanguage* tree_sitter_javascript(void);
const TSLanguage* tree_sitter_c(void);
const TSLanguage* tree_sitter_cpp(void);
const TSLanguage* tree_sitter_json(void);
const TSLanguage* tree_sitter_markdown(void);
const TSLanguage* tree_sitter_markdown_inline(void);
const TSLanguage* tree_sitter_html(void);
const TSLanguage* tree_sitter_css(void);
}

namespace {

struct LoadedGrammar
{
    const TSLanguage* language = nullptr;
    void* handle = nullptr; // non-null if dlopen'd
};

struct CachedQuery
{
    const TSLanguage* language = nullptr;
    std::string source;
    TSQuery* query = nullptr;
};

std::mutex g_mu;
std::unordered_map<std::string, LoadedGrammar> g_languages;
std::vector<CachedQuery> g_query_caches;
bool g_builtins = false;

uint32_t utf8_codepoint_count(const char* data, uint32_t byteLen)
{
    uint32_t count = 0;
    uint32_t i = 0;
    while(i < byteLen)
    {
        const unsigned char c = (unsigned char)data[i];
        if(c < 0x80) i += 1;
        else if((c >> 5) == 0x6) i += 2;
        else if((c >> 4) == 0xE) i += 3;
        else if((c >> 3) == 0x1E) i += 4;
        else i += 1;
        ++count;
    }
    return count;
}

std::string capture_scope_name(TSQuery* query, uint32_t captureId)
{
    uint32_t len = 0;
    const char* name = ts_query_capture_name_for_id(query, captureId, &len);
    if(!name || len == 0) return {};
    return std::string(name, len);
}

std::string node_text(const std::string& source, TSNode node)
{
    const uint32_t sb = ts_node_start_byte(node);
    const uint32_t eb = ts_node_end_byte(node);
    if(sb >= eb || eb > source.size()) return {};
    return source.substr(sb, eb - sb);
}

/** Find capture text in a match by capture name (without leading @). */
std::string capture_text_by_name(const TSQueryMatch& match,
                                 TSQuery* query,
                                 const std::string& source,
                                 const std::string& name)
{
    for(uint16_t i = 0; i < match.capture_count; ++i)
    {
        if(capture_scope_name(query, match.captures[i].index) == name)
            return node_text(source, match.captures[i].node);
    }
    return {};
}

bool simple_match_regex(const std::string& text, const std::string& pattern)
{
    // Minimal subset used by highlight queries — avoid pulling a regex engine.
    if(pattern == "^[A-Z]")
        return !text.empty() && text[0] >= 'A' && text[0] <= 'Z';
    // PascalCase: starts with uppercase, second char lowercase (Number, Math, Map).
    if(pattern == "^[A-Z][a-z]")
        return text.size() >= 2
            && text[0] >= 'A' && text[0] <= 'Z'
            && text[1] >= 'a' && text[1] <= 'z';
    if(pattern == "^[A-Z_][A-Z\\d_]+$" || pattern == "^[A-Z_][A-Z\\\\d_]+$")
    {
        if(text.size() < 2) return false;
        if(!(text[0] == '_' || (text[0] >= 'A' && text[0] <= 'Z'))) return false;
        for(size_t i = 1; i < text.size(); ++i)
        {
            const char c = text[i];
            if(!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'))
                return false;
        }
        return true;
    }
    return text == pattern;
}

/**
 * Evaluate #eq? / #any-of? / #match? (and not- variants) for a match.
 * Unsupported predicates (#is? local, …) reject the match.
 */
bool match_predicates_ok(TSQuery* query, const TSQueryMatch& match, const std::string& source)
{
    uint32_t stepCount = 0;
    const TSQueryPredicateStep* steps =
        ts_query_predicates_for_pattern(query, match.pattern_index, &stepCount);
    if(!steps || stepCount == 0) return true;

    size_t i = 0;
    while(i < stepCount)
    {
        if(steps[i].type != TSQueryPredicateStepTypeString) return false;
        uint32_t nameLen = 0;
        const char* namePtr = ts_query_string_value_for_id(query, steps[i].value_id, &nameLen);
        const std::string pred(namePtr ? namePtr : "", nameLen);
        ++i;

        std::vector<std::string> args;
        while(i < stepCount && steps[i].type != TSQueryPredicateStepTypeDone)
        {
            if(steps[i].type == TSQueryPredicateStepTypeCapture)
            {
                const std::string cap = capture_scope_name(query, steps[i].value_id);
                args.push_back(capture_text_by_name(match, query, source, cap));
            }
            else if(steps[i].type == TSQueryPredicateStepTypeString)
            {
                uint32_t len = 0;
                const char* s = ts_query_string_value_for_id(query, steps[i].value_id, &len);
                args.emplace_back(s ? s : "", len);
            }
            else return false;
            ++i;
        }
        if(i < stepCount && steps[i].type == TSQueryPredicateStepTypeDone) ++i;

        bool ok = false;
        if(pred == "eq?" && args.size() == 2)
            ok = args[0] == args[1];
        else if(pred == "not-eq?" && args.size() == 2)
            ok = args[0] != args[1];
        else if((pred == "any-of?" || pred == "not-any-of?") && args.size() >= 2)
        {
            ok = false;
            for(size_t a = 1; a < args.size(); ++a)
                if(args[0] == args[a]) { ok = true; break; }
            if(pred == "not-any-of?") ok = !ok;
        }
        else if(pred == "match?" && args.size() == 2)
            ok = simple_match_regex(args[0], args[1]);
        else if(pred == "not-match?" && args.size() == 2)
            ok = !simple_match_regex(args[0], args[1]);
        else
            return false;

        if(!ok) return false;
    }
    return true;
}

struct RawCapture
{
    uint32_t startByte = 0;
    uint32_t endByte = 0;
    uint32_t order = 0;
    std::string scope;
};

/** Flatten overlapping captures: later order wins. Output sorted by start.
 *  Byte→code-point conversion is monotonic O(n) over the swept region. */
std::vector<HighlightSpan> flatten_captures(const std::string& source, std::vector<RawCapture>& raw)
{
    std::sort(raw.begin(), raw.end(), [](const RawCapture& a, const RawCapture& b) {
        if(a.startByte != b.startByte) return a.startByte < b.startByte;
        if(a.endByte != b.endByte) return a.endByte > b.endByte;
        return a.order < b.order;
    });

    struct Event
    {
        uint32_t byte = 0;
        int delta = 0; // +1 start, -1 end
        uint32_t order = 0;
        std::string scope;
    };
    std::vector<Event> events;
    events.reserve(raw.size() * 2);
    for(const auto& c : raw)
    {
        if(c.startByte >= c.endByte || c.scope.empty()) continue;
        events.push_back({c.startByte, +1, c.order, c.scope});
        events.push_back({c.endByte, -1, c.order, c.scope});
    }
    std::sort(events.begin(), events.end(), [](const Event& a, const Event& b) {
        if(a.byte != b.byte) return a.byte < b.byte;
        if(a.delta != b.delta) return a.delta < b.delta;
        return a.order < b.order;
    });

    struct Active
    {
        uint32_t order;
        std::string scope;
    };
    std::vector<Active> active;
    auto top_scope = [&]() -> const std::string* {
        if(active.empty()) return nullptr;
        const Active* best = &active[0];
        for(const auto& a : active)
            if(a.order >= best->order) best = &a;
        return &best->scope;
    };

    // Monotonic UTF-8 byte → code-point cursor (avoids O(n²) rescans).
    uint32_t cpAt = 0;
    uint32_t byteAt = 0;
    auto codepoint_at = [&](uint32_t byte) -> uint32_t {
        if(byte > source.size()) byte = (uint32_t)source.size();
        if(byte < byteAt)
        {
            cpAt = 0;
            byteAt = 0;
        }
        const char* data = source.data();
        while(byteAt < byte)
        {
            const unsigned char c = (unsigned char)data[byteAt];
            if(c < 0x80) byteAt += 1;
            else if((c >> 5) == 0x6) byteAt += 2;
            else if((c >> 4) == 0xE) byteAt += 3;
            else if((c >> 3) == 0x1E) byteAt += 4;
            else byteAt += 1;
            ++cpAt;
        }
        return cpAt;
    };

    std::vector<HighlightSpan> out;
    uint32_t cursor = 0;
    const std::string* current = nullptr;

    auto flush_to = [&](uint32_t byte) {
        if(!current || byte <= cursor)
        {
            cursor = byte;
            return;
        }
        const uint32_t startCp = codepoint_at(cursor);
        const uint32_t endCp = codepoint_at(byte);
        if(endCp > startCp)
        {
            if(!out.empty() && out.back().end == startCp && out.back().scope == *current)
                out.back().end = endCp;
            else
                out.push_back({startCp, endCp, *current});
        }
        cursor = byte;
    };

    for(const Event& ev : events)
    {
        flush_to(ev.byte);
        if(ev.delta > 0) active.push_back({ev.order, ev.scope});
        else
        {
            for(auto it = active.begin(); it != active.end(); ++it)
            {
                if(it->order == ev.order && it->scope == ev.scope)
                {
                    active.erase(it);
                    break;
                }
            }
        }
        current = top_scope();
    }
    return out;
}

/** Byte offset of the start of each line, plus one past EOF. */
std::vector<uint32_t> line_byte_starts(const std::string& source)
{
    std::vector<uint32_t> starts;
    starts.reserve(256);
    starts.push_back(0);
    for(uint32_t i = 0; i < source.size(); ++i)
    {
        if(source[i] == '\n')
            starts.push_back(i + 1);
    }
    return starts;
}

TSQuery* get_or_compile_query(const TSLanguage* language, const std::string& querySource, std::string& error)
{
    std::lock_guard<std::mutex> lk(g_mu);
    for(CachedQuery& cached : g_query_caches)
    {
        if(cached.language == language && cached.source == querySource)
            return cached.query;
    }

    uint32_t errOffset = 0;
    TSQueryError errType = TSQueryErrorNone;
    TSQuery* query = ts_query_new(language, querySource.data(), (uint32_t)querySource.size(), &errOffset, &errType);
    if(!query)
    {
        error = "invalid highlight query (offset " + std::to_string(errOffset) + ", err " + std::to_string((int)errType) + ")";
        return nullptr;
    }
    if(g_query_caches.size() >= 12)
    {
        ts_query_delete(g_query_caches.front().query);
        g_query_caches.erase(g_query_caches.begin());
    }
    g_query_caches.push_back({language, querySource, query});
    return query;
}

std::vector<HighlightSpan> query_byte_range(TSQuery* query,
                                            TSTree* tree,
                                            const std::string& source,
                                            uint32_t startByte,
                                            uint32_t endByte,
                                            uint32_t& order)
{
    if(startByte >= endByte) return {};
    TSQueryCursor* cursor = ts_query_cursor_new();
    ts_query_cursor_set_byte_range(cursor, startByte, endByte);
    ts_query_cursor_exec(cursor, query, ts_tree_root_node(tree));

    std::vector<RawCapture> raw;
    raw.reserve(64);
    TSQueryMatch match;
    while(ts_query_cursor_next_match(cursor, &match))
    {
        if(!match_predicates_ok(query, match, source)) continue;
        for(uint16_t i = 0; i < match.capture_count; ++i)
        {
            const TSQueryCapture& cap = match.captures[i];
            const TSNode node = cap.node;
            const uint32_t sb = ts_node_start_byte(node);
            const uint32_t eb = ts_node_end_byte(node);
            std::string scope = capture_scope_name(query, cap.index);
            if(scope.empty() || sb >= eb) continue;
            // Clip to the requested range so chunk ownership is stable.
            const uint32_t cs = std::max(sb, startByte);
            const uint32_t ce = std::min(eb, endByte);
            if(cs >= ce) continue;
            // Later patterns in the query file win over earlier ones (e.g.
            // @module / @function override a generic @variable).
            const uint32_t pri = (uint32_t(match.pattern_index) << 16) | uint32_t(i);
            raw.push_back({cs, ce, pri, std::move(scope)});
            order = std::max(order, pri + 1);
        }
    }
    ts_query_cursor_delete(cursor);
    return flatten_captures(source, raw);
}

const TSLanguage* lookup_language(const std::string& languageId, std::string& error)
{
    highlight_register_builtins();
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_languages.find(languageId);
    if(it == g_languages.end() || !it->second.language)
    {
        error = "unknown highlight language: " + languageId;
        return nullptr;
    }
    return it->second.language;
}

void collect_named_ranges(TSNode node, const char* typeName,
                          std::vector<std::pair<uint32_t, uint32_t>>& out)
{
    if(std::strcmp(ts_node_type(node), typeName) == 0)
    {
        out.emplace_back(ts_node_start_byte(node), ts_node_end_byte(node));
        return;
    }
    const uint32_t n = ts_node_named_child_count(node);
    for(uint32_t i = 0; i < n; ++i)
        collect_named_ranges(ts_node_named_child(node, i), typeName, out);
}

/**
 * Re-parse each `inline` range with injectionLanguage and append coloured spans
 * that overlap [startByte, endByte).
 */
void append_injection_spans(const std::string& source,
                            const std::vector<std::pair<uint32_t, uint32_t>>& ranges,
                            uint32_t startByte,
                            uint32_t endByte,
                            const std::string& injectionLanguage,
                            const std::string& injectionQuery,
                            std::vector<HighlightSpan>& spans)
{
    if(injectionLanguage.empty() || injectionQuery.empty() || ranges.empty())
        return;
    std::string injErr;
    const TSLanguage* injLang = lookup_language(injectionLanguage, injErr);
    if(!injLang) return;
    TSQuery* injQuery = get_or_compile_query(injLang, injectionQuery, injErr);
    if(!injQuery) return;

    TSParser* injParser = ts_parser_new();
    if(!ts_parser_set_language(injParser, injLang))
    {
        ts_parser_delete(injParser);
        return;
    }

    uint32_t order = 0;
    for(const auto& range : ranges)
    {
        const uint32_t a = range.first;
        const uint32_t b = range.second;
        if(b <= startByte || a >= endByte || b <= a) continue;
        if(b > source.size()) continue;
        const std::string slice = source.substr(a, b - a);
        TSTree* injTree = ts_parser_parse_string(
            injParser, nullptr, slice.data(), (uint32_t)slice.size());
        if(!injTree) continue;
        auto part = query_byte_range(
            injQuery, injTree, slice, 0, (uint32_t)slice.size(), order);
        ts_tree_delete(injTree);
        const uint32_t cpBase = utf8_codepoint_count(source.data(), a);
        for(auto& span : part)
        {
            span.start += cpBase;
            span.end += cpBase;
            spans.push_back(std::move(span));
        }
    }
    ts_parser_delete(injParser);
}

} // namespace

void highlight_register_builtins()
{
    std::lock_guard<std::mutex> lk(g_mu);
    if(g_builtins) return;
    g_languages["javascript"] = {tree_sitter_javascript(), nullptr};
    g_languages["c"] = {tree_sitter_c(), nullptr};
    g_languages["cpp"] = {tree_sitter_cpp(), nullptr};
    g_languages["json"] = {tree_sitter_json(), nullptr};
    g_languages["markdown"] = {tree_sitter_markdown(), nullptr};
    g_languages["markdown_inline"] = {tree_sitter_markdown_inline(), nullptr};
    g_languages["html"] = {tree_sitter_html(), nullptr};
    g_languages["css"] = {tree_sitter_css(), nullptr};
    g_builtins = true;
}

bool highlight_load_grammar(const std::string& path,
                            const std::string& symbol,
                            const std::string& languageId,
                            std::string& error)
{
    if(path.empty() || symbol.empty() || languageId.empty())
    {
        error = "loadGrammar requires path, symbol, and language id";
        return false;
    }
    void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if(!handle)
    {
        error = dlerror() ? dlerror() : "dlopen failed";
        return false;
    }
    dlerror();
    using LangFn = const TSLanguage* (*)(void);
    auto* fn = reinterpret_cast<LangFn>(dlsym(handle, symbol.c_str()));
    const char* err = dlerror();
    if(err || !fn)
    {
        error = err ? err : "dlsym failed";
        dlclose(handle);
        return false;
    }
    const TSLanguage* lang = fn();
    if(!lang)
    {
        error = "grammar symbol returned null";
        dlclose(handle);
        return false;
    }
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_languages.find(languageId);
    if(it != g_languages.end() && it->second.handle)
        dlclose(it->second.handle);
    g_languages[languageId] = {lang, handle};
    // Drop cached queries if language id may have changed under us.
    for(CachedQuery& cached : g_query_caches)
    {
        if(cached.query) ts_query_delete(cached.query);
    }
    g_query_caches.clear();
    return true;
}

bool highlight_has_language(const std::string& languageId)
{
    std::lock_guard<std::mutex> lk(g_mu);
    return g_languages.count(languageId) > 0;
}

std::vector<HighlightSpan> highlight_run_stream(const std::string& source,
                                                const std::string& languageId,
                                                const std::string& querySource,
                                                const HighlightStreamOpts& opts,
                                                const HighlightChunkFn& onChunk,
                                                std::string& error)
{
    const TSLanguage* language = lookup_language(languageId, error);
    if(!language) return {};

    if(querySource.empty())
    {
        error = "empty highlight query";
        return {};
    }

    TSQuery* query = get_or_compile_query(language, querySource, error);
    if(!query) return {};

    TSParser* parser = ts_parser_new();
    if(!ts_parser_set_language(parser, language))
    {
        error = "failed to set tree-sitter language (ABI mismatch?)";
        ts_parser_delete(parser);
        return {};
    }

    const std::vector<uint32_t> lineStarts = line_byte_starts(source);
    const uint32_t lineCount = (uint32_t)lineStarts.size();
    const uint32_t sourceBytes = (uint32_t)source.size();
    const uint32_t chunkLines = std::max(8u, opts.linesPerChunk ? opts.linesPerChunk : 64u);

    auto line_for_byte = [&](uint32_t byte) -> uint32_t {
        auto it = std::upper_bound(lineStarts.begin(), lineStarts.end(), byte);
        if(it == lineStarts.begin()) return 0;
        return (uint32_t)(std::distance(lineStarts.begin(), it) - 1);
    };

    auto byte_at_line = [&](uint32_t row) -> uint32_t {
        if(row >= lineCount) return sourceBytes;
        return lineStarts[row];
    };

    // Resolve preferred visible window before any heavy parse.
    uint32_t preferFrom = 0;
    uint32_t preferTo = 0;
    if(opts.preferToRow > opts.preferFromRow)
    {
        preferFrom = std::min(opts.preferFromRow, lineCount);
        preferTo = std::min(opts.preferToRow, lineCount);
    }
    else if(opts.preferEndByte > opts.preferStartByte && opts.preferEndByte <= sourceBytes + 1)
    {
        preferFrom = line_for_byte(opts.preferStartByte);
        preferTo = std::min(lineCount, line_for_byte(std::min(opts.preferEndByte, sourceBytes)) + 1);
    }
    if(preferTo > preferFrom)
    {
        if(preferFrom > 2) preferFrom -= 2;
        if(preferTo + 2 < lineCount) preferTo += 2;
        else preferTo = lineCount;
    }

    // Fast path: parse only the visible slice and emit colours before the
    // full-document parse. Approximate (slice loses outer context) but paints
    // the viewport while the accurate pass catches up.
    const bool previewOk = onChunk
        && preferTo > preferFrom
        && sourceBytes > 4096
        && (preferTo - preferFrom) < lineCount;
    if(previewOk)
    {
        const uint32_t b0 = byte_at_line(preferFrom);
        const uint32_t b1 = byte_at_line(preferTo);
        if(b1 > b0)
        {
            const std::string slice = source.substr(b0, b1 - b0);
            TSTree* previewTree = ts_parser_parse_string(
                parser, nullptr, slice.data(), (uint32_t)slice.size());
            if(previewTree)
            {
                uint32_t previewOrder = 0;
                auto spans = query_byte_range(
                    query, previewTree, slice, 0, (uint32_t)slice.size(), previewOrder);
                const uint32_t cpBase = utf8_codepoint_count(source.data(), b0);
                for(auto& span : spans)
                {
                    span.start += cpBase;
                    span.end += cpBase;
                }
                onChunk(std::move(spans), preferFrom, preferTo, false);
                ts_tree_delete(previewTree);
            }
        }
    }

    TSTree* tree = ts_parser_parse_string(parser, nullptr, source.data(), (uint32_t)source.size());
    if(!tree)
    {
        error = "tree-sitter parse failed";
        ts_parser_delete(parser);
        return {};
    }

    std::vector<std::pair<uint32_t, uint32_t>> injectionRanges;
    if(!opts.injectionLanguage.empty() && !opts.injectionQuery.empty())
        collect_named_ranges(ts_tree_root_node(tree), "inline", injectionRanges);

    // Build ordered half-open line ranges to process.
    std::vector<std::pair<uint32_t, uint32_t>> blocks;
    blocks.reserve((lineCount / chunkLines) + 2);

    auto push_block = [&](uint32_t from, uint32_t to) {
        if(to > lineCount) to = lineCount;
        if(from >= to) return;
        blocks.emplace_back(from, to);
    };

    if(preferTo > preferFrom)
        push_block(preferFrom, preferTo);

    for(uint32_t row = 0; row < lineCount; )
    {
        if(preferTo > preferFrom && row >= preferFrom && row < preferTo)
        {
            row = preferTo;
            continue;
        }
        uint32_t to = std::min(lineCount, row + chunkLines);
        if(preferTo > preferFrom && row < preferFrom && to > preferFrom)
            to = preferFrom;
        push_block(row, to);
        row = to;
    }

    std::vector<HighlightSpan> all;
    if(!onChunk) all.reserve(256);
    uint32_t order = 0;

    for(const auto& block : blocks)
    {
        const uint32_t fromRow = block.first;
        const uint32_t toRow = block.second;
        const uint32_t startByte = byte_at_line(fromRow);
        const uint32_t endByte = byte_at_line(toRow);
        auto spans = query_byte_range(query, tree, source, startByte, endByte, order);
        append_injection_spans(
            source, injectionRanges, startByte, endByte,
            opts.injectionLanguage, opts.injectionQuery, spans);
        if(onChunk)
            onChunk(std::move(spans), fromRow, toRow, false);
        else
            all.insert(all.end(),
                       std::make_move_iterator(spans.begin()),
                       std::make_move_iterator(spans.end()));
    }

    if(!onChunk)
    {
        std::sort(all.begin(), all.end(), [](const HighlightSpan& a, const HighlightSpan& b) {
            if(a.start != b.start) return a.start < b.start;
            return a.end < b.end;
        });
    }
    else
        onChunk({}, 0, 0, true);

    ts_tree_delete(tree);
    ts_parser_delete(parser);
    // query is cached — do not delete
    return all;
}

std::vector<HighlightSpan> highlight_run(const std::string& source,
                                         const std::string& languageId,
                                         const std::string& querySource,
                                         std::string& error)
{
    HighlightStreamOpts opts;
    opts.linesPerChunk = 1000000; // single block
    return highlight_run_stream(source, languageId, querySource, opts, nullptr, error);
}
