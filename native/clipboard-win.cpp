#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <iterator>
#include <vector>
#include <string>
#include <cstring>
#include <cstdint>
static HANDLE parentHandle;
static UINT format(const wchar_t* name){ return RegisterClipboardFormatW(name); }
static bool openClipboard(HWND owner){
    for(int i=0;i<20;i++){if(OpenClipboard(owner))return true; Sleep(5);}
    return false;
}
static bool isZero(UINT id){
    auto h=GetClipboardData(id);
    if(!h || GlobalSize(h)<sizeof(DWORD))return false;
    auto p=static_cast<const DWORD*>(GlobalLock(h));
    bool result=p && *p==0;
    if(p)GlobalUnlock(h);
    return result;
}
static std::string utf8(const std::wstring& text){
    int n=WideCharToMultiByte(CP_UTF8,0,text.data(),(int)text.size(),nullptr,0,nullptr,nullptr);
    std::string out(n,'\0'); WideCharToMultiByte(CP_UTF8,0,text.data(),(int)text.size(),out.data(),n,nullptr,nullptr);return out;
}
static bool put(UINT kind,const void* data,size_t len){
    HGLOBAL h=GlobalAlloc(GMEM_MOVEABLE,len);if(!h)return false;
    void* p=GlobalLock(h);if(!p){GlobalFree(h);return false;}
    memcpy(p,data,len);GlobalUnlock(h);
    if(!SetClipboardData(kind,h)){GlobalFree(h);return false;}return true;
}
static LRESULT CALLBACK notify(HWND w,UINT m,WPARAM a,LPARAM b){
    if(m==WM_CLIPBOARDUPDATE){std::cout<<GetClipboardSequenceNumber()<<std::endl;if(!std::cout)PostQuitMessage(0);return 0;}
    if(m==WM_TIMER && parentHandle && WaitForSingleObject(parentHandle,0)==WAIT_OBJECT_0){PostQuitMessage(0);return 0;}
    return DefWindowProcW(w,m,a,b);
}
int wmain(int argc,wchar_t** argv){
    if(argc<2)return 2;std::wstring mode=argv[1];
    wchar_t qa[100]={};
    if(GetEnvironmentVariableW(L"SYNC_VAULT_QA_STATION",qa,100)){
        std::wstring name(qa);
        if(name.rfind(L"SyncVaultQA-",0)!=0 || name.find_first_not_of(L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-")!=std::wstring::npos)return 9;
        HWINSTA station=CreateWindowStationW(qa,0,WINSTA_ALL_ACCESS,nullptr);
        if(!station||!SetProcessWindowStation(station))return 10;
        HDESK desk=CreateDesktopW(L"Default",nullptr,nullptr,0,GENERIC_ALL,nullptr);
        if(!desk||!SetThreadDesktop(desk))return 11;
    }
    WNDCLASSW wc={};wc.lpfnWndProc=notify;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"SyncVaultClipboard";
    RegisterClassW(&wc);HWND window=CreateWindowW(wc.lpszClassName,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,wc.hInstance,nullptr);
    if(mode==L"watch"){
        if(!window||!AddClipboardFormatListener(window))return 3;
        std::cout<<GetClipboardSequenceNumber()<<std::endl;
        if(argc>2)parentHandle=OpenProcess(SYNCHRONIZE,FALSE,wcstoul(argv[2],nullptr,10));
        SetTimer(window,1,3000,nullptr);MSG msg;
        while(GetMessageW(&msg,nullptr,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}return 0;
    }
    _setmode(_fileno(stdout),_O_BINARY);_setmode(_fileno(stdin),_O_BINARY);
    if(mode==L"inspect"){
        if(!openClipboard(window))return 4;
        uint32_t seq=GetClipboardSequenceNumber();std::cout.write((char*)&seq,4);
        bool secret=IsClipboardFormatAvailable(format(L"ExcludeClipboardContentFromMonitorProcessing"))||
            IsClipboardFormatAvailable(format(L"Clipboard Viewer Ignore"))||
            isZero(format(L"CanUploadToCloudClipboard"))||isZero(format(L"CanIncludeInClipboardHistory"));
        const bool remote=IsClipboardFormatAvailable(format(L"SyncVault.Remote"));
        std::cout.put(remote?2:secret?1:0);
        if((!secret||remote) && IsClipboardFormatAvailable(CF_HDROP)){
            HDROP files=(HDROP)GetClipboardData(CF_HDROP);
            UINT n=DragQueryFileW(files,0xffffffff,nullptr,0);
            for(UINT i=0;i<n && i<8001;i++){
                UINT count=DragQueryFileW(files,i,nullptr,0);
                std::wstring name(count+1,L'\0');DragQueryFileW(files,i,name.data(),count+1);name.resize(count);
                auto data=utf8(name); std::cout.write(data.data(),data.size());std::cout.put(0);
            }
        }
        CloseClipboard();return 0;
    }
    if(qa[0] && mode==L"read-content"){
        if(!openClipboard(window))return 4;
        for(UINT kind : {UINT(CF_UNICODETEXT),format(L"HTML Format"),format(L"PNG")}){
            std::string bytes;
            HANDLE h=GetClipboardData(kind);const size_t size=h?GlobalSize(h):0;
            if(size> (kind==format(L"PNG")?32u:4u)*1024*1024){CloseClipboard();return 4;}
            if(size){const char* p=static_cast<const char*>(GlobalLock(h));if(p){
                if(kind==CF_UNICODETEXT){auto w=reinterpret_cast<const wchar_t*>(p);bytes=utf8(std::wstring(w,wcsnlen(w,size/2)));}
                else if(kind==format(L"HTML Format")) bytes.assign(p,strnlen(p,size));
                else {size_t end=8;while(end+12<=size){const unsigned char* chunk=(const unsigned char*)(p+end);
                    uint32_t n=(uint32_t(chunk[0])<<24)|(uint32_t(chunk[1])<<16)|(uint32_t(chunk[2])<<8)|chunk[3];
                    if(n>size-end-12)break;end+=n+12;if(!memcmp(chunk+4,"IEND",4)){bytes.assign(p,end);break;}}}
                GlobalUnlock(h);}}
            uint32_t n=(uint32_t)bytes.size();std::cout.write((char*)&n,4);std::cout.write(bytes.data(),n);
        } CloseClipboard();return 0;
    }
    if(qa[0] && (mode==L"write-content" || mode==L"qa-write")){
        std::string fields[3];
        for(auto& f:fields){uint32_t n;if(!std::cin.read((char*)&n,4)||n>32u*1024*1024)return 5;f.resize(n);if(n&&!std::cin.read(f.data(),n))return 5;}
        if(!openClipboard(window))return 4;
        bool ok=EmptyClipboard();DWORD one=1;
        if(!fields[2].empty())ok=ok&&put(format(L"PNG"),fields[2].data(),fields[2].size());
        else {auto& t=fields[0];int n=MultiByteToWideChar(CP_UTF8,0,t.data(),(int)t.size(),nullptr,0);std::wstring w(n,L'\0');MultiByteToWideChar(CP_UTF8,0,t.data(),(int)t.size(),w.data(),n);
          ok=ok&&put(CF_UNICODETEXT,w.c_str(),(w.size()+1)*sizeof(wchar_t));if(!fields[1].empty())ok=ok&&put(format(L"HTML Format"),fields[1].c_str(),fields[1].size()+1);}
        if(mode!=L"qa-write")ok=ok&&put(format(L"SyncVault.Remote"),&one,4);CloseClipboard();return ok?0:5;
    }
    if(mode==L"files" || (qa[0] && mode==L"qa-files")){
        std::string input((std::istreambuf_iterator<char>(std::cin)),{});if(input.empty()||input.back()!=0)return 5;
        int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),(int)input.size(),nullptr,0);if(!count)return 6;
        std::vector<char> out(sizeof(DROPFILES)+(count+1)*sizeof(wchar_t),0);
        auto d=(DROPFILES*)out.data();d->pFiles=sizeof(DROPFILES);d->fWide=TRUE;
        MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),(int)input.size(),(wchar_t*)(out.data()+sizeof(DROPFILES)),count);
        if(!openClipboard(window))return 7;DWORD zero=0,one=1;
        bool ok=EmptyClipboard() && put(CF_HDROP,out.data(),out.size());
        if(mode==L"files")ok=ok && put(format(L"SyncVault.Remote"),&one,4) && put(format(L"CanUploadToCloudClipboard"),&zero,4);
        CloseClipboard();return ok?0:8;
    }
    return 2;
}

