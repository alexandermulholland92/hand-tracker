// ht_pieces.cpp — a phone's part of a big torrent, by pieces (the user, 2026-11-25: "I want libtorrent on it to download
// by splitting up the work between devices and each getting pieces to send back to the device that's chosen to be the
// download location"): what cluster/node/pieces.py does on a Pi with Debian's python3-libtorrent, here in the Cluster
// app with its own libtorrent (2.0.16, built without OpenSSL: no HTTPS trackers), as the service (downloads.py) asks
// for it through the app (PhoneNative's / ClusterMember.swift's "pieces-start"): only the pieces from first up to end,
// into the folder, seeding them while it runs, its status in state/status.json every 2 s, state/control.json obeyed
// ({"paused": true} pauses it, {"stop": true} ends it), its progress in state/resume.dat (every 5 minutes and as it
// ends, so it goes on from there). Peers kept few (40), uTP, DHT and local peer discovery off, as pieces.py. Each part
// runs on a thread of its own, with a libtorrent session of its own (as pieces.py runs as a program of its own).
#include "ht_pieces.h"

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/error_code.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/write_resume_data.hpp>

#include <sys/stat.h>
#include <sys/types.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace lt = libtorrent;
using clk = std::chrono::steady_clock;

namespace {

constexpr int SAVE_EVERY_S = 300;

struct Part {
    std::atomic<bool> stop{false};
    std::atomic<bool> running{true};
};

std::mutex g_lock;
std::map<std::string, std::shared_ptr<Part>> g_parts;

void make_dirs(std::string const& path) {
    for (size_t at = 1; at <= path.size(); ++at) {
        if (at == path.size() || path[at] == '/') {
            mkdir(path.substr(0, at).c_str(), 0700);
        }
    }
}

std::string read_file(std::string const& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        return {};
    }
    std::ostringstream s;
    s << f.rdbuf();
    return s.str();
}

void write_file(std::string const& path, std::string const& data) {
    std::string tmp = path + ".new";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f << data;
    }
    std::rename(tmp.c_str(), path.c_str());
}

// ({"key": true}, as downloads.py writes control.json: json.dump)
bool said(std::string const& json, char const* key) {
    std::string k = std::string("\"") + key + "\"";
    size_t at = json.find(k);
    if (at == std::string::npos) {
        return false;
    }
    at = json.find(':', at + k.size());
    if (at == std::string::npos) {
        return false;
    }
    at = json.find_first_not_of(" \t\r\n", at + 1);
    return at != std::string::npos && json.compare(at, 4, "true") == 0;
}

std::string quoted(std::string const& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof buf, "\\u%04x", c);
            out += buf;
        } else {
            out += c;
        }
    }
    return out + "\"";
}

char const* state_name(lt::torrent_status::state_t s) {
    switch (s) {
    case lt::torrent_status::checking_files:
        return "checking_files";
    case lt::torrent_status::downloading_metadata:
        return "downloading_metadata";
    case lt::torrent_status::downloading:
        return "downloading";
    case lt::torrent_status::finished:
        return "finished";
    case lt::torrent_status::seeding:
        return "seeding";
    case lt::torrent_status::checking_resume_data:
        return "checking_resume_data";
    default:
        return "unknown";
    }
}

// Its progress written down (libtorrent says it in an alert: waited for, up to wait_ms).
void save_resume(lt::session& ses, lt::torrent_handle const& h, std::string const& path, int wait_ms = 10000) {
    if (!h.is_valid() || !h.status(lt::status_flags_t{}).has_metadata) {
        return;
    }
    h.save_resume_data(lt::torrent_handle::flush_disk_cache);
    auto until = clk::now() + std::chrono::milliseconds(wait_ms);
    while (clk::now() < until) {
        ses.wait_for_alert(std::chrono::milliseconds(500));
        std::vector<lt::alert*> alerts;
        ses.pop_alerts(&alerts);
        for (lt::alert* a : alerts) {
            if (auto rd = lt::alert_cast<lt::save_resume_data_alert>(a)) {
                std::vector<char> buf = lt::write_resume_data_buf(rd->params);
                write_file(path, std::string(buf.begin(), buf.end()));
                return;
            }
            if (lt::alert_cast<lt::save_resume_data_failed_alert>(a)) {
                return;
            }
        }
    }
}

void run(std::shared_ptr<Part> part, std::shared_ptr<lt::torrent_info> ti, std::string folder, int first, int end, std::string state, int port) {
    std::string const status_file = state + "/status.json", control_file = state + "/control.json", resume_file = state + "/resume.dat";
    try {
        lt::settings_pack p;
        p.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:" + std::to_string(port));
        p.set_bool(lt::settings_pack::enable_dht, false);
        p.set_bool(lt::settings_pack::enable_lsd, false);
        p.set_bool(lt::settings_pack::enable_upnp, true);
        p.set_bool(lt::settings_pack::enable_natpmp, true);
        p.set_bool(lt::settings_pack::enable_incoming_utp, false);
        p.set_bool(lt::settings_pack::enable_outgoing_utp, false);
        p.set_int(lt::settings_pack::connections_limit, 40);
        p.set_str(lt::settings_pack::user_agent, "Cluster pieces/1");
        p.set_int(lt::settings_pack::alert_mask, lt::alert_category::error | lt::alert_category::storage);
        lt::session ses{lt::session_params(p)};

        int const n = ti->num_pieces();
        first = std::max(0, std::min(first, n));
        end = std::max(0, std::min(end, n));
        std::vector<lt::download_priority_t> mine(static_cast<size_t>(n), lt::dont_download);
        for (int i = first; i < end; ++i) {
            mine[static_cast<size_t>(i)] = lt::default_priority;
        }
        lt::add_torrent_params atp;
        std::string const resume = read_file(resume_file);
        if (!resume.empty()) {
            lt::error_code ec;
            atp = lt::read_resume_data(lt::span<char const>(resume.data(), static_cast<std::ptrdiff_t>(resume.size())), ec);
            if (ec) {
                atp = lt::add_torrent_params();  // (unreadable: checked again from the files instead)
            }
        }
        atp.ti = ti;
        atp.save_path = folder;
        atp.piece_priorities = mine;
        atp.flags &= ~lt::torrent_flags::auto_managed;
        atp.flags &= ~lt::torrent_flags::paused;
        lt::error_code aec;
        lt::torrent_handle h = ses.add_torrent(std::move(atp), aec);
        if (aec) {
            write_file(status_file, "{\"have\": 0, \"of\": " + std::to_string(end - first) + ", \"done\": false, \"error\": " + quoted(aec.message()) + "}");
            part->running = false;
            return;
        }
        h.prioritize_pieces(mine);
        auto saved = clk::now();
        bool paused = false;
        std::string problem;
        while (!part->stop) {
            std::string const ctl = read_file(control_file);
            if (said(ctl, "stop")) {
                break;
            }
            bool const want = said(ctl, "paused");
            if (want != paused) {
                paused = want;
                if (paused) {
                    h.pause();
                } else {
                    h.resume();
                }
            }
            lt::torrent_status const s = h.status();
            int have = 0;
            if (s.has_metadata && !s.pieces.empty()) {
                for (int i = first; i < end; ++i) {
                    if (s.pieces.get_bit(lt::piece_index_t(i))) {
                        ++have;
                    }
                }
            }
            std::vector<lt::alert*> alerts;  // (a file it couldn't write, say: said in its status)
            ses.pop_alerts(&alerts);
            for (lt::alert* a : alerts) {
                if (lt::alert_cast<lt::file_error_alert>(a) || lt::alert_cast<lt::torrent_error_alert>(a)) {
                    problem = a->message();
                }
            }
            std::string const error = s.errc ? s.errc.message() : problem;
            std::ostringstream js;
            js << "{\"have\": " << have << ", \"of\": " << (end - first) << ", \"done\": " << ((end > first && have == end - first) ? "true" : "false")
               << ", \"down\": " << s.download_rate << ", \"up\": " << s.upload_rate << ", \"peers\": " << s.num_peers
               << ", \"state\": " << quoted(state_name(s.state)) << ", \"paused\": " << (paused ? "true" : "false") << ", \"error\": " << quoted(error)
               << ", \"upEver\": " << s.all_time_upload << ", \"downEver\": " << s.all_time_download << ", \"at\": " << std::time(nullptr) << "}";
            write_file(status_file, js.str());
            if (clk::now() - saved > std::chrono::seconds(SAVE_EVERY_S)) {
                save_resume(ses, h, resume_file);
                saved = clk::now();
            }
            for (int i = 0; i < 20 && !part->stop; ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
        h.pause();
        save_resume(ses, h, resume_file);
    } catch (std::exception const& e) {
        write_file(status_file, std::string("{\"have\": 0, \"of\": ") + std::to_string(end - first) + ", \"done\": false, \"error\": " + quoted(e.what()) + "}");
    }
    part->running = false;
}

}  // namespace

extern "C" int ht_pc_start(const char* torrent, const char* folder, int first, int end, const char* state, int port, char* err, int errsize) {
    auto fail = [&](std::string const& why) {
        if (err != nullptr && errsize > 0) {
            std::snprintf(err, static_cast<size_t>(errsize), "%s", why.c_str());
        }
        return 1;
    };
    if (torrent == nullptr || folder == nullptr || state == nullptr || *state == '\0') {
        return fail("Which torrent, folder and state folder?");
    }
    std::lock_guard<std::mutex> guard(g_lock);
    auto it = g_parts.find(state);
    if (it != g_parts.end() && it->second->running) {
        return 0;
    }
    lt::error_code ec;
    auto ti = std::make_shared<lt::torrent_info>(std::string(torrent), ec);
    if (ec) {
        return fail("Its torrent file couldn't be read: " + ec.message());
    }
    make_dirs(folder);
    make_dirs(state);
    auto part = std::make_shared<Part>();
    g_parts[state] = part;
    try {
        std::thread(run, part, ti, std::string(folder), first, end, std::string(state), port).detach();
    } catch (std::exception const& e) {
        part->running = false;
        return fail(std::string("It couldn't start: ") + e.what());
    }
    return 0;
}

extern "C" int ht_pc_running(const char* state) {
    std::lock_guard<std::mutex> guard(g_lock);
    auto it = state != nullptr ? g_parts.find(state) : g_parts.end();
    return it != g_parts.end() && it->second->running ? 1 : 0;
}

extern "C" void ht_pc_stop(const char* state) {
    std::shared_ptr<Part> part;
    {
        std::lock_guard<std::mutex> guard(g_lock);
        auto it = state != nullptr ? g_parts.find(state) : g_parts.end();
        if (it == g_parts.end()) {
            return;
        }
        part = it->second;
    }
    part->stop = true;
    for (int i = 0; i < 300 && part->running; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}
