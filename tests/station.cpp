#define UNICODE
#include <windows.h>
#include <shlobj.h>
#include <string>
#include <vector>
#include <cwchar>
// Start an Electron test process on a private Windows station. Its clipboard
// is separate from the signed-in user's interactive clipboard.
int wmain(int argc,wchar_t** argv){
    if(argc<4)return 2;
    std::wstring name=argv[1];
    if(name.rfind(L"SyncVaultQA-",0)!=0)return 3;
    HWINSTA station=CreateWindowStationW(name.c_str(),0,WINSTA_ALL_ACCESS,nullptr);
    if(!station||!SetProcessWindowStation(station))return 4;
    HDESK desktop=CreateDesktopW(L"Default",nullptr,nullptr,0,GENERIC_ALL,nullptr);
    if(!desktop)return 5;
    if(std::wstring(argv[2])==L"--local-files"){
        if(!SetThreadDesktop(desktop)) return 8;
        HWND owner=CreateWindowExW(0,L"STATIC",L"",0,0,0,0,0,HWND_MESSAGE,nullptr,nullptr,nullptr);
        if(!owner)return 9;
        std::vector<wchar_t> names;
        for(int i=3;i<argc;i++){
            names.insert(names.end(),argv[i],argv[i]+wcslen(argv[i])+1);
        }
        names.push_back(0);
        HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE|GMEM_ZEROINIT,sizeof(DROPFILES)+names.size()*sizeof(wchar_t));
        if(!memory)return 10;
        auto info=static_cast<DROPFILES*>(GlobalLock(memory));
        if(!info)return 11;
        info->pFiles=sizeof(DROPFILES);info->fWide=TRUE;
        memcpy(reinterpret_cast<char*>(info)+sizeof(DROPFILES),names.data(),names.size()*sizeof(wchar_t));
        GlobalUnlock(memory);
        if(!OpenClipboard(owner))return 12;
        const bool ok=EmptyClipboard() && SetClipboardData(CF_HDROP,memory);
        CloseClipboard();
        if(!ok)GlobalFree(memory);
        return ok?0:13;
    }
    if(argc!=4)return 2;
    std::wstring desktopName=name+L"\\Default";
    std::wstring cmd=L"\""+std::wstring(argv[2])+L"\" --disable-gpu --no-sandbox \""+argv[3]+L"\"";
    STARTUPINFOW si={sizeof(si)};si.lpDesktop=desktopName.data();
    PROCESS_INFORMATION pi={};
    if(!CreateProcessW(argv[2],cmd.data(),nullptr,nullptr,TRUE,0,nullptr,nullptr,&si,&pi))return 6;
    DWORD wait=WaitForSingleObject(pi.hProcess,60000),code=7;
    if(wait==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&code);else TerminateProcess(pi.hProcess,7);
    CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)code;
}

