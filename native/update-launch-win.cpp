#define UNICODE
#define _UNICODE
#include <windows.h>
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

// Windows command-line quoting for arguments passed to CommandLineToArgvW.
static std::wstring quote(const std::wstring& value) {
    std::wstring out = L"\"";
    size_t slashes = 0;
    for (wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        if (c == L'"') out.append(slashes * 2 + 1, L'\\');
        else out.append(slashes, L'\\');
        out.push_back(c);
        slashes = 0;
    }
    out.append(slashes * 2, L'\\');
    return out + L"\"";
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 9) return 2;
    const fs::path script(argv[1]), transaction(argv[7]);
    if (!transaction.is_absolute() || script != transaction / L"swap.ps1") return 3;
    wchar_t system[MAX_PATH];
    if (!GetSystemDirectoryW(system, MAX_PATH)) return 4;
    const fs::path shell = fs::path(system) / L"WindowsPowerShell" / L"v1.0" / L"powershell.exe";
    std::wstring cmd = quote(shell.wstring()) + L" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + quote(script.wstring());
    const wchar_t* fields[] = {L"-ParentPid", L"-Target", L"-Replacement", L"-Container", L"-ProfileRoot", L"-Transaction", L"-Ticket"};
    for (int i=2; i<argc; ++i) cmd += L" " + std::wstring(fields[i-2]) + L" " + quote(argv[i]);

    // Give Windows PowerShell a real hidden console, independent of the Electron process.
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    auto start = [&](DWORD flags) {
        std::vector<wchar_t> args(cmd.begin(), cmd.end());
        args.push_back(0);
        return CreateProcessW(shell.c_str(), args.data(), nullptr, nullptr, FALSE,
            flags | CREATE_NEW_CONSOLE, nullptr, transaction.c_str(), &startup, &process);
    };
    if (!start(CREATE_BREAKAWAY_FROM_JOB)) {
        if (GetLastError() != ERROR_ACCESS_DENIED || !start(0)) return 5;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}

