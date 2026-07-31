/*
  KoyaEdit Module/editor

  Native gap-fill plugin for host filesystem IO and future OS/engine capabilities
  that Koya intentionally does not expose through Koya/Assets.

  JS API (MVP):
    readText(path) -> Promise<string>
    writeText(path, text) -> Promise<void>
    readDir(path) -> Promise<Array<{ name, type, path }>>
    stat(path) -> Promise<{ size, isFile, isDirectory, mtimeMs }>
    mkdir(path, opts?) -> Promise<void>
    exists(path) -> Promise<boolean>
    watch(path, opts?) -> Promise<{ id, on, off, close }>
    unwatch(id) -> Promise<void>
    loadGrammar(path, symbol, languageId) -> Promise<boolean>
    highlight({ source, language, query, onChunk?, ... }) -> Promise<{ spans }>
    writeBinary(path, bytes[]) -> Promise<void>
    runCommand({ cmd, args?, cwd? }) -> Promise<{ code, stdout, stderr }>
*/
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <cstdint>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/inotify.h>
#include <unistd.h>

#include <sys/wait.h>

#include "quickjs.h"
#include "module_hooks.h"
#include "highlight.hpp"

namespace fs = std::filesystem;

enum class JobKind {
    ReadText,
    WriteText,
    ReadDir,
    Stat,
    Mkdir,
    Exists,
    Watch,
    Unwatch,
    LoadGrammar,
    Highlight,
    WriteBinary,
    RunCommand
};

struct DirEntry {
    std::string name;
    std::string type;
    std::string path;
};

struct StatInfo {
    uint64_t size = 0;
    bool isFile = false;
    bool isDirectory = false;
    double mtimeMs = 0;
};

struct WatchEvent {
    uint32_t watchId = 0;
    std::string type;
    std::string path;
    std::string path2;
};

struct Job {
    JobKind kind = JobKind::Exists;
    std::string path;
    std::string text;
    std::string language;
    std::string query;
    std::string injectionLanguage;
    std::string injectionQuery;
    std::string symbol;
    std::vector<uint8_t> bytes;
    std::vector<std::string> args;
    std::string cwd;
    bool recursive = false;
    uint32_t watchId = 0;
    uint32_t preferStartByte = 0;
    uint32_t preferEndByte = 0;
    uint32_t preferFromRow = 0;
    uint32_t preferToRow = 0;
    uint32_t chunkLines = 64;
    JSValue resolve = JS_UNDEFINED;
    JSValue reject = JS_UNDEFINED;
    JSValue onChunk = JS_UNDEFINED; // optional highlight progress callback
};

struct WatchState {
    uint32_t id = 0;
    std::string root;
    bool recursive = false;
    int inotifyFd = -1;
    std::unordered_map<int, std::string> wdToPath;
    std::unordered_map<std::string, int> pathToWd;
    std::vector<JSValue> changeListeners;
    std::thread thread;
    std::atomic<bool> running{false};
};

static JSContext* g_ctx = nullptr;
static std::mutex g_job_mutex;
static std::condition_variable g_job_cv;
static std::queue<Job> g_jobs;
static std::thread g_worker;
static std::atomic<bool> g_worker_running{false};
static std::mutex g_comp_mutex;
static std::queue<std::function<void()>> g_completions;

static std::mutex g_watch_mutex;
static std::unordered_map<uint32_t, std::unique_ptr<WatchState>> g_watches;
static std::atomic<uint32_t> g_next_watch_id{1};

static std::string js_to_std_string(JSContext* ctx, JSValueConst v)
{
    const char* c = JS_ToCString(ctx, v);
    std::string s = c ? c : "";
    if(c) JS_FreeCString(ctx, c);
    return s;
}

/** Run cmd+args in cwd; capture stdout/stderr. Returns exit code via outCode. */
static int run_host_command(const std::string& cmd,
                            const std::vector<std::string>& args,
                            const std::string& cwd,
                            std::string& stdoutOut,
                            std::string& stderrOut)
{
    int outPipe[2] = { -1, -1 };
    int errPipe[2] = { -1, -1 };
    if(pipe(outPipe) != 0 || pipe(errPipe) != 0)
    {
        stderrOut = "pipe failed";
        return 127;
    }
    const pid_t pid = fork();
    if(pid < 0)
    {
        close(outPipe[0]); close(outPipe[1]);
        close(errPipe[0]); close(errPipe[1]);
        stderrOut = "fork failed";
        return 127;
    }
    if(pid == 0)
    {
        if(!cwd.empty())
        {
            if(chdir(cwd.c_str()) != 0) _exit(127);
        }
        dup2(outPipe[1], STDOUT_FILENO);
        dup2(errPipe[1], STDERR_FILENO);
        close(outPipe[0]); close(outPipe[1]);
        close(errPipe[0]); close(errPipe[1]);
        std::vector<char*> argv;
        argv.reserve(args.size() + 2);
        argv.push_back(const_cast<char*>(cmd.c_str()));
        for(const auto& a : args)
            argv.push_back(const_cast<char*>(a.c_str()));
        argv.push_back(nullptr);
        execvp(cmd.c_str(), argv.data());
        _exit(127);
    }
    close(outPipe[1]);
    close(errPipe[1]);

    auto read_fd = [](int fd, std::string& into) {
        char buf[4096];
        for(;;)
        {
            const ssize_t n = read(fd, buf, sizeof(buf));
            if(n > 0) into.append(buf, (size_t)n);
            else break;
        }
        close(fd);
    };
    read_fd(outPipe[0], stdoutOut);
    read_fd(errPipe[0], stderrOut);

    int status = 0;
    if(waitpid(pid, &status, 0) < 0) return 127;
    if(WIFEXITED(status)) return WEXITSTATUS(status);
    return 127;
}

static void post_completion(std::function<void()> fn)
{
    std::lock_guard<std::mutex> lk(g_comp_mutex);
    g_completions.push(std::move(fn));
}

static JSValue make_error_obj(JSContext* ctx, const std::string& message)
{
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message.c_str()));
    return err;
}

static void reject_job(JSContext* ctx, JSValue reject, const std::string& message)
{
    JSValue err = make_error_obj(ctx, message);
    JSValue ret = JS_Call(ctx, reject, JS_UNDEFINED, 1, &err);
    JS_FreeValue(ctx, err);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, reject);
}

static void resolve_undefined(JSContext* ctx, JSValue resolve)
{
    JSValue undef = JS_UNDEFINED;
    JSValue ret = JS_Call(ctx, resolve, JS_UNDEFINED, 1, &undef);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, resolve);
}

static bool get_bool_prop(JSContext* ctx, JSValueConst obj, const char* name, bool fallback)
{
    if(!JS_IsObject(obj)) return fallback;
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    bool out = fallback;
    if(JS_IsBool(v)) out = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    return out;
}

static uint32_t get_u32_prop(JSContext* ctx, JSValueConst obj, const char* name, uint32_t fallback)
{
    if(!JS_IsObject(obj)) return fallback;
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    uint32_t out = fallback;
    if(!JS_IsUndefined(v) && !JS_IsNull(v))
    {
        uint32_t n = 0;
        if(!JS_ToUint32(ctx, &n, v)) out = n;
    }
    JS_FreeValue(ctx, v);
    return out;
}

static std::string entry_type(const fs::directory_entry& entry)
{
    std::error_code ec;
    if(entry.is_directory(ec)) return "dir";
    if(entry.is_regular_file(ec)) return "file";
    return "other";
}

static bool should_skip_watch_dir(const fs::path& path)
{
    const std::string name = path.filename().string();
    return name == ".git" || name == "node_modules" || name == "__pycache__"
        || name == ".cursor" || name == "build" || name == "bin" || name == ".cache"
        || name == "target" || name == "dist" || name == ".svn" || name == ".hg";
}

static void add_inotify_watch(WatchState& watch, const std::string& path)
{
    if(watch.inotifyFd < 0) return;
    if(watch.pathToWd.count(path)) return;
    // Omit IN_ATTRIB — noisy and not needed for editor tree/file sync.
    const uint32_t mask = IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_MODIFY | IN_DELETE_SELF | IN_MOVE_SELF;
    int wd = inotify_add_watch(watch.inotifyFd, path.c_str(), mask);
    if(wd < 0) return;
    watch.wdToPath[wd] = path;
    watch.pathToWd[path] = wd;
}

static void seed_recursive_watches(WatchState& watch, const std::string& root)
{
    add_inotify_watch(watch, root);
    if(!watch.recursive) return;
    std::error_code ec;
    if(!fs::is_directory(root, ec)) return;
    auto options = fs::directory_options::skip_permission_denied;
    for(auto it = fs::recursive_directory_iterator(root, options, ec);
        it != fs::recursive_directory_iterator();
        it.increment(ec))
    {
        if(ec)
        {
            ec.clear();
            continue;
        }
        if(!it->is_directory(ec)) continue;
        if(should_skip_watch_dir(it->path()))
        {
            it.disable_recursion_pending();
            continue;
        }
        add_inotify_watch(watch, it->path().string());
    }
}

static void emit_watch_event(uint32_t watchId, const std::string& type, const std::string& path, const std::string& path2)
{
    post_completion([watchId, type, path, path2]() {
        if(!g_ctx) return;
        std::vector<JSValue> listeners;
        {
            std::lock_guard<std::mutex> lk(g_watch_mutex);
            auto it = g_watches.find(watchId);
            if(it == g_watches.end()) return;
            for(auto& cb : it->second->changeListeners) listeners.push_back(JS_DupValue(g_ctx, cb));
        }
        JSValue evt = JS_NewObject(g_ctx);
        JS_SetPropertyStr(g_ctx, evt, "type", JS_NewString(g_ctx, type.c_str()));
        JS_SetPropertyStr(g_ctx, evt, "path", JS_NewString(g_ctx, path.c_str()));
        if(!path2.empty()) JS_SetPropertyStr(g_ctx, evt, "path2", JS_NewString(g_ctx, path2.c_str()));
        for(auto& cb : listeners)
        {
            JSValue ret = JS_Call(g_ctx, cb, JS_UNDEFINED, 1, &evt);
            JS_FreeValue(g_ctx, ret);
            JS_FreeValue(g_ctx, cb);
        }
        JS_FreeValue(g_ctx, evt);
    });
}

static void watch_thread_main(WatchState* watch)
{
    constexpr size_t kBuf = 4096;
    alignas(struct inotify_event) char buf[kBuf];
    while(watch->running.load())
    {
        pollfd pfd{};
        pfd.fd = watch->inotifyFd;
        pfd.events = POLLIN;
        int pr = poll(&pfd, 1, 250);
        if(pr <= 0) continue;
        ssize_t n = read(watch->inotifyFd, buf, sizeof(buf));
        if(n <= 0) continue;
        for(char* ptr = buf; ptr < buf + n;)
        {
            auto* ev = reinterpret_cast<inotify_event*>(ptr);
            ptr += sizeof(inotify_event) + ev->len;
            std::string dir;
            {
                std::lock_guard<std::mutex> lk(g_watch_mutex);
                auto it = watch->wdToPath.find(ev->wd);
                if(it == watch->wdToPath.end()) continue;
                dir = it->second;
            }
            std::string name = (ev->len > 0) ? std::string(ev->name) : std::string();
            std::string full = name.empty() ? dir : (dir + "/" + name);
            std::string type = "modify";
            if(ev->mask & (IN_CREATE | IN_MOVED_TO)) type = "create";
            else if(ev->mask & (IN_DELETE | IN_MOVED_FROM | IN_DELETE_SELF)) type = "delete";
            else if(ev->mask & IN_MOVE_SELF) type = "rename";
            emit_watch_event(watch->id, type, full, "");
            if(watch->recursive && (ev->mask & (IN_CREATE | IN_MOVED_TO)))
            {
                std::error_code ec;
                if(fs::is_directory(full, ec) && !should_skip_watch_dir(full))
                {
                    std::lock_guard<std::mutex> lk(g_watch_mutex);
                    add_inotify_watch(*watch, full);
                }
            }
        }
    }
}

static uint32_t start_watch(const std::string& path, bool recursive, std::string& error)
{
    std::error_code ec;
    if(!fs::exists(path, ec))
    {
        error = "watch path does not exist";
        return 0;
    }
    int fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if(fd < 0)
    {
        error = "inotify_init1 failed";
        return 0;
    }
    auto watch = std::make_unique<WatchState>();
    watch->id = g_next_watch_id++;
    watch->root = path;
    watch->recursive = recursive;
    watch->inotifyFd = fd;
    seed_recursive_watches(*watch, path);
    watch->running = true;
    WatchState* raw = watch.get();
    watch->thread = std::thread(watch_thread_main, raw);
    uint32_t id = watch->id;
    std::lock_guard<std::mutex> lk(g_watch_mutex);
    g_watches[id] = std::move(watch);
    return id;
}

static void stop_watch(uint32_t id)
{
    std::unique_ptr<WatchState> watch;
    {
        std::lock_guard<std::mutex> lk(g_watch_mutex);
        auto it = g_watches.find(id);
        if(it == g_watches.end()) return;
        watch = std::move(it->second);
        g_watches.erase(it);
    }
    watch->running = false;
    if(watch->thread.joinable()) watch->thread.join();
    if(g_ctx)
    {
        for(auto& cb : watch->changeListeners) JS_FreeValue(g_ctx, cb);
        watch->changeListeners.clear();
    }
    if(watch->inotifyFd >= 0)
    {
        close(watch->inotifyFd);
        watch->inotifyFd = -1;
    }
}

static JSValue make_watch_handle(JSContext* ctx, uint32_t id);

static JSValue js_watch_on(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv)
{
    if(argc < 2 || !JS_IsString(argv[0]) || !JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "on(event, callback)");
    std::string event = js_to_std_string(ctx, argv[0]);
    if(event != "change") return JS_ThrowTypeError(ctx, "only 'change' is supported");
    JSValue idv = JS_GetPropertyStr(ctx, this_val, "id");
    int64_t id64 = 0;
    JS_ToInt64(ctx, &id64, idv);
    JS_FreeValue(ctx, idv);
    {
        std::lock_guard<std::mutex> lk(g_watch_mutex);
        auto it = g_watches.find((uint32_t)id64);
        if(it == g_watches.end()) return JS_ThrowTypeError(ctx, "invalid watch handle");
        it->second->changeListeners.push_back(JS_DupValue(ctx, argv[1]));
    }
    return JS_DupValue(ctx, this_val);
}

static JSValue js_watch_off(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv)
{
    if(argc < 2 || !JS_IsString(argv[0]) || !JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "off(event, callback)");
    JSValue idv = JS_GetPropertyStr(ctx, this_val, "id");
    int64_t id64 = 0;
    JS_ToInt64(ctx, &id64, idv);
    JS_FreeValue(ctx, idv);
    {
        std::lock_guard<std::mutex> lk(g_watch_mutex);
        auto it = g_watches.find((uint32_t)id64);
        if(it == g_watches.end()) return JS_UNDEFINED;
        auto& listeners = it->second->changeListeners;
        for(auto lit = listeners.begin(); lit != listeners.end(); ++lit)
        {
            if(JS_VALUE_GET_PTR(*lit) == JS_VALUE_GET_PTR(argv[1]))
            {
                JS_FreeValue(ctx, *lit);
                listeners.erase(lit);
                break;
            }
        }
    }
    return JS_UNDEFINED;
}

static JSValue js_watch_close(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv)
{
    (void)argc;
    (void)argv;
    JSValue idv = JS_GetPropertyStr(ctx, this_val, "id");
    int64_t id64 = 0;
    JS_ToInt64(ctx, &id64, idv);
    JS_FreeValue(ctx, idv);
    stop_watch((uint32_t)id64);
    return JS_UNDEFINED;
}

static JSValue make_watch_handle(JSContext* ctx, uint32_t id)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "id", JS_NewInt32(ctx, (int32_t)id));
    JS_SetPropertyStr(ctx, obj, "on", JS_NewCFunction(ctx, js_watch_on, "on", 2));
    JS_SetPropertyStr(ctx, obj, "off", JS_NewCFunction(ctx, js_watch_off, "off", 2));
    JS_SetPropertyStr(ctx, obj, "close", JS_NewCFunction(ctx, js_watch_close, "close", 0));
    return obj;
}

static void ensure_worker_started();

static void worker_main()
{
    while(g_worker_running.load())
    {
        Job job;
        {
            std::unique_lock<std::mutex> lk(g_job_mutex);
            g_job_cv.wait(lk, [] { return !g_jobs.empty() || !g_worker_running.load(); });
            if(!g_worker_running.load() && g_jobs.empty()) break;
            job = std::move(g_jobs.front());
            g_jobs.pop();
        }

        try
        {
            switch(job.kind)
            {
                case JobKind::ReadText: {
                    std::ifstream in(job.path, std::ios::binary);
                    if(!in) throw std::runtime_error("failed to open file for reading");
                    std::ostringstream ss;
                    ss << in.rdbuf();
                    std::string text = ss.str();
                    post_completion([resolve = job.resolve, reject = job.reject, text = std::move(text)]() mutable {
                        if(!g_ctx) return;
                        JSValue s = JS_NewStringLen(g_ctx, text.data(), text.size());
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &s);
                        JS_FreeValue(g_ctx, s);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::WriteText: {
                    fs::path parent = fs::path(job.path).parent_path();
                    if(!parent.empty()) fs::create_directories(parent);
                    std::ofstream out(job.path, std::ios::binary | std::ios::trunc);
                    if(!out) throw std::runtime_error("failed to open file for writing");
                    out.write(job.text.data(), (std::streamsize)job.text.size());
                    if(!out) throw std::runtime_error("failed to write file");
                    post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                        if(!g_ctx) return;
                        resolve_undefined(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::ReadDir: {
                    std::vector<DirEntry> entries;
                    std::error_code ec;
                    for(const auto& entry : fs::directory_iterator(job.path, fs::directory_options::skip_permission_denied, ec))
                    {
                        if(ec)
                        {
                            ec.clear();
                            continue;
                        }
                        DirEntry de;
                        de.name = entry.path().filename().string();
                        de.type = entry_type(entry);
                        de.path = entry.path().string();
                        entries.push_back(std::move(de));
                    }
                    std::sort(entries.begin(), entries.end(), [](const DirEntry& a, const DirEntry& b) {
                        if(a.type != b.type) return a.type == "dir" && b.type != "dir";
                        return a.name < b.name;
                    });
                    post_completion([resolve = job.resolve, reject = job.reject, entries = std::move(entries)]() mutable {
                        if(!g_ctx) return;
                        JSValue arr = JS_NewArray(g_ctx);
                        for(uint32_t i = 0; i < entries.size(); ++i)
                        {
                            JSValue obj = JS_NewObject(g_ctx);
                            JS_SetPropertyStr(g_ctx, obj, "name", JS_NewString(g_ctx, entries[i].name.c_str()));
                            JS_SetPropertyStr(g_ctx, obj, "type", JS_NewString(g_ctx, entries[i].type.c_str()));
                            JS_SetPropertyStr(g_ctx, obj, "path", JS_NewString(g_ctx, entries[i].path.c_str()));
                            JS_SetPropertyUint32(g_ctx, arr, i, obj);
                        }
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &arr);
                        JS_FreeValue(g_ctx, arr);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Stat: {
                    std::error_code ec;
                    auto st = fs::status(job.path, ec);
                    if(ec) throw std::runtime_error(ec.message());
                    auto ftime = fs::last_write_time(job.path, ec);
                    StatInfo info;
                    info.isDirectory = fs::is_directory(st);
                    info.isFile = fs::is_regular_file(st);
                    if(info.isFile)
                    {
                        auto sz = fs::file_size(job.path, ec);
                        if(!ec) info.size = (uint64_t)sz;
                    }
                    if(!ec)
                    {
                        auto sctp = std::chrono::time_point_cast<std::chrono::milliseconds>(
                            ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now());
                        info.mtimeMs = (double)sctp.time_since_epoch().count();
                    }
                    post_completion([resolve = job.resolve, reject = job.reject, info]() mutable {
                        if(!g_ctx) return;
                        JSValue obj = JS_NewObject(g_ctx);
                        JS_SetPropertyStr(g_ctx, obj, "size", JS_NewInt64(g_ctx, (int64_t)info.size));
                        JS_SetPropertyStr(g_ctx, obj, "isFile", JS_NewBool(g_ctx, info.isFile));
                        JS_SetPropertyStr(g_ctx, obj, "isDirectory", JS_NewBool(g_ctx, info.isDirectory));
                        JS_SetPropertyStr(g_ctx, obj, "mtimeMs", JS_NewFloat64(g_ctx, info.mtimeMs));
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &obj);
                        JS_FreeValue(g_ctx, obj);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Mkdir: {
                    if(job.recursive) fs::create_directories(job.path);
                    else fs::create_directory(job.path);
                    post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                        if(!g_ctx) return;
                        resolve_undefined(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Exists: {
                    std::error_code ec;
                    bool ok = fs::exists(job.path, ec);
                    post_completion([resolve = job.resolve, reject = job.reject, ok]() mutable {
                        if(!g_ctx) return;
                        JSValue b = JS_NewBool(g_ctx, ok);
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &b);
                        JS_FreeValue(g_ctx, b);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Watch: {
                    std::string error;
                    uint32_t id = start_watch(job.path, job.recursive, error);
                    if(id == 0) throw std::runtime_error(error.empty() ? "watch failed" : error);
                    post_completion([resolve = job.resolve, reject = job.reject, id]() mutable {
                        if(!g_ctx) return;
                        JSValue handle = make_watch_handle(g_ctx, id);
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &handle);
                        JS_FreeValue(g_ctx, handle);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Unwatch: {
                    stop_watch(job.watchId);
                    post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                        if(!g_ctx) return;
                        resolve_undefined(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::LoadGrammar: {
                    std::string error;
                    const bool ok = highlight_load_grammar(job.path, job.symbol, job.language, error);
                    if(!ok) throw std::runtime_error(error.empty() ? "loadGrammar failed" : error);
                    post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                        if(!g_ctx) return;
                        JSValue b = JS_NewBool(g_ctx, 1);
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &b);
                        JS_FreeValue(g_ctx, b);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::Highlight: {
                    std::string error;
                    HighlightStreamOpts opts;
                    opts.preferStartByte = job.preferStartByte;
                    opts.preferEndByte = job.preferEndByte;
                    opts.preferFromRow = job.preferFromRow;
                    opts.preferToRow = job.preferToRow;
                    opts.linesPerChunk = job.chunkLines ? job.chunkLines : 64;
                    opts.injectionLanguage = job.injectionLanguage;
                    opts.injectionQuery = job.injectionQuery;

                    JSValue onChunk = job.onChunk;
                    job.onChunk = JS_UNDEFINED;

                    auto emit_chunk = [onChunk](std::vector<HighlightSpan>&& spans,
                                                uint32_t fromRow,
                                                uint32_t toRow,
                                                bool done) {
                        post_completion([onChunk, spans = std::move(spans), fromRow, toRow, done]() mutable {
                            if(!g_ctx || JS_IsUndefined(onChunk) || !JS_IsFunction(g_ctx, onChunk))
                                return;
                            JSValue obj = JS_NewObject(g_ctx);
                            JSValue arr = JS_NewArray(g_ctx);
                            for(uint32_t i = 0; i < spans.size(); ++i)
                            {
                                JSValue span = JS_NewObject(g_ctx);
                                JS_SetPropertyStr(g_ctx, span, "start", JS_NewUint32(g_ctx, spans[i].start));
                                JS_SetPropertyStr(g_ctx, span, "end", JS_NewUint32(g_ctx, spans[i].end));
                                JS_SetPropertyStr(g_ctx, span, "scope", JS_NewString(g_ctx, spans[i].scope.c_str()));
                                JS_SetPropertyUint32(g_ctx, arr, i, span);
                            }
                            JS_SetPropertyStr(g_ctx, obj, "spans", arr);
                            JS_SetPropertyStr(g_ctx, obj, "fromRow", JS_NewUint32(g_ctx, fromRow));
                            JS_SetPropertyStr(g_ctx, obj, "toRow", JS_NewUint32(g_ctx, toRow));
                            JS_SetPropertyStr(g_ctx, obj, "done", JS_NewBool(g_ctx, done));
                            JSValue ret = JS_Call(g_ctx, onChunk, JS_UNDEFINED, 1, &obj);
                            JS_FreeValue(g_ctx, obj);
                            JS_FreeValue(g_ctx, ret);
                        });
                    };

                    const bool haveChunk = !JS_IsUndefined(onChunk);
                    auto spans = highlight_run_stream(
                        job.text, job.language, job.query, opts,
                        haveChunk ? HighlightChunkFn(emit_chunk) : HighlightChunkFn{},
                        error);
                    if(!error.empty() && spans.empty())
                    {
                        post_completion([onChunk]() mutable {
                            if(g_ctx && !JS_IsUndefined(onChunk)) JS_FreeValue(g_ctx, onChunk);
                        });
                        throw std::runtime_error(error);
                    }
                    // When streaming, skip copying the full span table into QuickJS.
                    post_completion([resolve = job.resolve, reject = job.reject, onChunk,
                                    spans = haveChunk ? std::vector<HighlightSpan>{} : std::move(spans)]() mutable {
                        if(!g_ctx) return;
                        if(!JS_IsUndefined(onChunk)) JS_FreeValue(g_ctx, onChunk);
                        JSValue obj = JS_NewObject(g_ctx);
                        JSValue arr = JS_NewArray(g_ctx);
                        for(uint32_t i = 0; i < spans.size(); ++i)
                        {
                            JSValue span = JS_NewObject(g_ctx);
                            JS_SetPropertyStr(g_ctx, span, "start", JS_NewUint32(g_ctx, spans[i].start));
                            JS_SetPropertyStr(g_ctx, span, "end", JS_NewUint32(g_ctx, spans[i].end));
                            JS_SetPropertyStr(g_ctx, span, "scope", JS_NewString(g_ctx, spans[i].scope.c_str()));
                            JS_SetPropertyUint32(g_ctx, arr, i, span);
                        }
                        JS_SetPropertyStr(g_ctx, obj, "spans", arr);
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &obj);
                        JS_FreeValue(g_ctx, obj);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::WriteBinary: {
                    fs::path parent = fs::path(job.path).parent_path();
                    if(!parent.empty()) fs::create_directories(parent);
                    std::ofstream out(job.path, std::ios::binary | std::ios::trunc);
                    if(!out) throw std::runtime_error("failed to open for write: " + job.path);
                    if(!job.bytes.empty())
                        out.write(reinterpret_cast<const char*>(job.bytes.data()), (std::streamsize)job.bytes.size());
                    if(!out) throw std::runtime_error("failed to write: " + job.path);
                    post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                        if(!g_ctx) return;
                        resolve_undefined(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
                case JobKind::RunCommand: {
                    std::string stdoutOut;
                    std::string stderrOut;
                    const int code = run_host_command(job.path, job.args, job.cwd, stdoutOut, stderrOut);
                    post_completion([resolve = job.resolve, reject = job.reject, code,
                                    stdoutOut = std::move(stdoutOut),
                                    stderrOut = std::move(stderrOut)]() mutable {
                        if(!g_ctx) return;
                        JSValue obj = JS_NewObject(g_ctx);
                        JS_SetPropertyStr(g_ctx, obj, "code", JS_NewInt32(g_ctx, code));
                        JS_SetPropertyStr(g_ctx, obj, "stdout", JS_NewString(g_ctx, stdoutOut.c_str()));
                        JS_SetPropertyStr(g_ctx, obj, "stderr", JS_NewString(g_ctx, stderrOut.c_str()));
                        JSValue ret = JS_Call(g_ctx, resolve, JS_UNDEFINED, 1, &obj);
                        JS_FreeValue(g_ctx, obj);
                        JS_FreeValue(g_ctx, ret);
                        JS_FreeValue(g_ctx, resolve);
                        JS_FreeValue(g_ctx, reject);
                    });
                    break;
                }
            }
        }
        catch(const std::exception& ex)
        {
            std::string message = ex.what();
            post_completion([resolve = job.resolve, reject = job.reject, message = std::move(message)]() mutable {
                if(!g_ctx) return;
                JS_FreeValue(g_ctx, resolve);
                reject_job(g_ctx, reject, message);
            });
        }
        catch(...)
        {
            post_completion([resolve = job.resolve, reject = job.reject]() mutable {
                if(!g_ctx) return;
                JS_FreeValue(g_ctx, resolve);
                reject_job(g_ctx, reject, "unknown Module/editor error");
            });
        }
    }
}

static void ensure_worker_started()
{
    bool expected = false;
    if(g_worker_running.compare_exchange_strong(expected, true))
        g_worker = std::thread(worker_main);
}

static JSValue enqueue_job(JSContext* ctx, Job job)
{
    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    job.resolve = JS_DupValue(ctx, funcs[0]);
    job.reject = JS_DupValue(ctx, funcs[1]);
    {
        std::lock_guard<std::mutex> lk(g_job_mutex);
        g_jobs.push(std::move(job));
    }
    ensure_worker_started();
    g_job_cv.notify_one();
    JS_FreeValue(ctx, funcs[0]);
    JS_FreeValue(ctx, funcs[1]);
    return promise;
}

static JSValue js_read_text(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "readText(path)");
    Job job;
    job.kind = JobKind::ReadText;
    job.path = js_to_std_string(ctx, argv[0]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_write_text(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 2 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "writeText(path, text)");
    Job job;
    job.kind = JobKind::WriteText;
    job.path = js_to_std_string(ctx, argv[0]);
    job.text = js_to_std_string(ctx, argv[1]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_read_dir(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "readDir(path)");
    Job job;
    job.kind = JobKind::ReadDir;
    job.path = js_to_std_string(ctx, argv[0]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_stat(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "stat(path)");
    Job job;
    job.kind = JobKind::Stat;
    job.path = js_to_std_string(ctx, argv[0]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_mkdir(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "mkdir(path, opts?)");
    Job job;
    job.kind = JobKind::Mkdir;
    job.path = js_to_std_string(ctx, argv[0]);
    job.recursive = argc >= 2 ? get_bool_prop(ctx, argv[1], "recursive", false) : false;
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_exists(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "exists(path)");
    Job job;
    job.kind = JobKind::Exists;
    job.path = js_to_std_string(ctx, argv[0]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_watch(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "watch(path, opts?)");
    Job job;
    job.kind = JobKind::Watch;
    job.path = js_to_std_string(ctx, argv[0]);
    job.recursive = argc >= 2 ? get_bool_prop(ctx, argv[1], "recursive", true) : true;
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_unwatch(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1) return JS_ThrowTypeError(ctx, "unwatch(id|handle)");
    Job job;
    job.kind = JobKind::Unwatch;
    if(JS_IsObject(argv[0]))
    {
        JSValue idv = JS_GetPropertyStr(ctx, argv[0], "id");
        int64_t id64 = 0;
        JS_ToInt64(ctx, &id64, idv);
        JS_FreeValue(ctx, idv);
        job.watchId = (uint32_t)id64;
    }
    else
    {
        int64_t id64 = 0;
        JS_ToInt64(ctx, &id64, argv[0]);
        job.watchId = (uint32_t)id64;
    }
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_load_grammar(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 3 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]) || !JS_IsString(argv[2]))
        return JS_ThrowTypeError(ctx, "loadGrammar(path, symbol, languageId)");
    Job job;
    job.kind = JobKind::LoadGrammar;
    job.path = js_to_std_string(ctx, argv[0]);
    job.symbol = js_to_std_string(ctx, argv[1]);
    job.language = js_to_std_string(ctx, argv[2]);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_highlight(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "highlight({ source, language, query })");
    JSValue sourceV = JS_GetPropertyStr(ctx, argv[0], "source");
    JSValue languageV = JS_GetPropertyStr(ctx, argv[0], "language");
    JSValue queryV = JS_GetPropertyStr(ctx, argv[0], "query");
    JSValue onChunkV = JS_GetPropertyStr(ctx, argv[0], "onChunk");
    if(!JS_IsString(sourceV) || !JS_IsString(languageV) || !JS_IsString(queryV))
    {
        JS_FreeValue(ctx, sourceV);
        JS_FreeValue(ctx, languageV);
        JS_FreeValue(ctx, queryV);
        JS_FreeValue(ctx, onChunkV);
        return JS_ThrowTypeError(ctx, "highlight({ source, language, query }) requires strings");
    }
    Job job;
    job.kind = JobKind::Highlight;
    job.text = js_to_std_string(ctx, sourceV);
    job.language = js_to_std_string(ctx, languageV);
    job.query = js_to_std_string(ctx, queryV);
    JSValue injLangV = JS_GetPropertyStr(ctx, argv[0], "injectionLanguage");
    JSValue injQueryV = JS_GetPropertyStr(ctx, argv[0], "injectionQuery");
    if(JS_IsString(injLangV)) job.injectionLanguage = js_to_std_string(ctx, injLangV);
    if(JS_IsString(injQueryV)) job.injectionQuery = js_to_std_string(ctx, injQueryV);
    JS_FreeValue(ctx, injLangV);
    JS_FreeValue(ctx, injQueryV);
    job.preferStartByte = get_u32_prop(ctx, argv[0], "preferStartByte", 0);
    job.preferEndByte = get_u32_prop(ctx, argv[0], "preferEndByte", 0);
    job.preferFromRow = get_u32_prop(ctx, argv[0], "preferFromRow", 0);
    job.preferToRow = get_u32_prop(ctx, argv[0], "preferToRow", 0);
    job.chunkLines = get_u32_prop(ctx, argv[0], "chunkLines", 64);
    if(JS_IsFunction(ctx, onChunkV))
        job.onChunk = JS_DupValue(ctx, onChunkV);
    else
        job.onChunk = JS_UNDEFINED;
    JS_FreeValue(ctx, sourceV);
    JS_FreeValue(ctx, languageV);
    JS_FreeValue(ctx, queryV);
    JS_FreeValue(ctx, onChunkV);
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_write_binary(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 2 || !JS_IsString(argv[0]) || !JS_IsArray(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "writeBinary(path, bytes[])");
    Job job;
    job.kind = JobKind::WriteBinary;
    job.path = js_to_std_string(ctx, argv[0]);
    const JSValue arr = argv[1];
    JSValue lenV = JS_GetPropertyStr(ctx, arr, "length");
    int64_t len = 0;
    if(JS_ToInt64(ctx, &len, lenV) || len < 0)
    {
        JS_FreeValue(ctx, lenV);
        return JS_ThrowTypeError(ctx, "writeBinary: invalid byte array");
    }
    JS_FreeValue(ctx, lenV);
    job.bytes.resize((size_t)len);
    for(int64_t i = 0; i < len; ++i)
    {
        JSValue v = JS_GetPropertyUint32(ctx, arr, (uint32_t)i);
        int32_t n = 0;
        if(JS_ToInt32(ctx, &n, v))
        {
            JS_FreeValue(ctx, v);
            return JS_ThrowTypeError(ctx, "writeBinary: non-numeric byte");
        }
        JS_FreeValue(ctx, v);
        job.bytes[(size_t)i] = (uint8_t)(n & 0xff);
    }
    return enqueue_job(ctx, std::move(job));
}

static JSValue js_run_command(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if(argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "runCommand({ cmd, args?, cwd? })");
    JSValue cmdV = JS_GetPropertyStr(ctx, argv[0], "cmd");
    if(!JS_IsString(cmdV))
    {
        JS_FreeValue(ctx, cmdV);
        return JS_ThrowTypeError(ctx, "runCommand requires cmd string");
    }
    Job job;
    job.kind = JobKind::RunCommand;
    job.path = js_to_std_string(ctx, cmdV); // reuse path field as cmd
    JS_FreeValue(ctx, cmdV);

    JSValue cwdV = JS_GetPropertyStr(ctx, argv[0], "cwd");
    if(JS_IsString(cwdV)) job.cwd = js_to_std_string(ctx, cwdV);
    JS_FreeValue(ctx, cwdV);

    JSValue argsV = JS_GetPropertyStr(ctx, argv[0], "args");
    if(JS_IsArray(ctx, argsV))
    {
        JSValue lenV = JS_GetPropertyStr(ctx, argsV, "length");
        int64_t len = 0;
        JS_ToInt64(ctx, &len, lenV);
        JS_FreeValue(ctx, lenV);
        for(int64_t i = 0; i < len; ++i)
        {
            JSValue v = JS_GetPropertyUint32(ctx, argsV, (uint32_t)i);
            if(JS_IsString(v)) job.args.push_back(js_to_std_string(ctx, v));
            JS_FreeValue(ctx, v);
        }
    }
    JS_FreeValue(ctx, argsV);
    return enqueue_job(ctx, std::move(job));
}

static int editor_module_init(JSContext* ctx, JSModuleDef* m)
{
    highlight_register_builtins();
    JS_SetModuleExport(ctx, m, "readText", JS_NewCFunction(ctx, js_read_text, "readText", 1));
    JS_SetModuleExport(ctx, m, "writeText", JS_NewCFunction(ctx, js_write_text, "writeText", 2));
    JS_SetModuleExport(ctx, m, "readDir", JS_NewCFunction(ctx, js_read_dir, "readDir", 1));
    JS_SetModuleExport(ctx, m, "stat", JS_NewCFunction(ctx, js_stat, "stat", 1));
    JS_SetModuleExport(ctx, m, "mkdir", JS_NewCFunction(ctx, js_mkdir, "mkdir", 2));
    JS_SetModuleExport(ctx, m, "exists", JS_NewCFunction(ctx, js_exists, "exists", 1));
    JS_SetModuleExport(ctx, m, "watch", JS_NewCFunction(ctx, js_watch, "watch", 2));
    JS_SetModuleExport(ctx, m, "unwatch", JS_NewCFunction(ctx, js_unwatch, "unwatch", 1));
    JS_SetModuleExport(ctx, m, "loadGrammar", JS_NewCFunction(ctx, js_load_grammar, "loadGrammar", 3));
    JS_SetModuleExport(ctx, m, "highlight", JS_NewCFunction(ctx, js_highlight, "highlight", 1));
    JS_SetModuleExport(ctx, m, "writeBinary", JS_NewCFunction(ctx, js_write_binary, "writeBinary", 2));
    JS_SetModuleExport(ctx, m, "runCommand", JS_NewCFunction(ctx, js_run_command, "runCommand", 1));
    return 0;
}

static void editor_update_callback(void*)
{
    std::queue<std::function<void()>> local;
    {
        std::lock_guard<std::mutex> lk(g_comp_mutex);
        std::swap(local, g_completions);
    }
    while(!local.empty())
    {
        auto fn = std::move(local.front());
        local.pop();
        fn();
    }
}

static void editor_cleanup_callback(void*)
{
    g_worker_running = false;
    g_job_cv.notify_all();
    if(g_worker.joinable()) g_worker.join();

    std::vector<uint32_t> ids;
    {
        std::lock_guard<std::mutex> lk(g_watch_mutex);
        for(auto& kv : g_watches) ids.push_back(kv.first);
    }
    for(uint32_t id : ids) stop_watch(id);

    {
        std::lock_guard<std::mutex> lk(g_job_mutex);
        while(!g_jobs.empty())
        {
            Job& job = g_jobs.front();
            if(g_ctx)
            {
                JS_FreeValue(g_ctx, job.resolve);
                JS_FreeValue(g_ctx, job.reject);
                if(!JS_IsUndefined(job.onChunk)) JS_FreeValue(g_ctx, job.onChunk);
            }
            g_jobs.pop();
        }
    }
    {
        std::lock_guard<std::mutex> lk(g_comp_mutex);
        while(!g_completions.empty()) g_completions.pop();
    }
}

extern "C" {
JSModuleDef* integrateV1(JSContext* ctx, const char* module_name, RegisterHookFunc registerHook, const KoyaRendererV1*)
{
    g_ctx = ctx;
    registerHook("update", editor_update_callback);
    registerHook("cleanup", editor_cleanup_callback);
    JSModuleDef* m = JS_NewCModule(ctx, module_name, editor_module_init);
    if(!m) return nullptr;
    JS_AddModuleExport(ctx, m, "readText");
    JS_AddModuleExport(ctx, m, "writeText");
    JS_AddModuleExport(ctx, m, "readDir");
    JS_AddModuleExport(ctx, m, "stat");
    JS_AddModuleExport(ctx, m, "mkdir");
    JS_AddModuleExport(ctx, m, "exists");
    JS_AddModuleExport(ctx, m, "watch");
    JS_AddModuleExport(ctx, m, "unwatch");
    JS_AddModuleExport(ctx, m, "loadGrammar");
    JS_AddModuleExport(ctx, m, "highlight");
    JS_AddModuleExport(ctx, m, "writeBinary");
    JS_AddModuleExport(ctx, m, "runCommand");
    return m;
}
}