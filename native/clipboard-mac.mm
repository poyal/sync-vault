#import <AppKit/AppKit.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
static void number(uint32_t value){fwrite(&value,4,1,stdout);}
int main(int argc,char** argv){ @autoreleasepool {
    if(argc<2)return 2;
    NSString *qa=NSProcessInfo.processInfo.environment[@"SYNC_VAULT_QA_STATION"];
    NSPasteboard *pb=[qa hasPrefix:@"SyncVaultQA-"]?[NSPasteboard pasteboardWithName:qa]:[NSPasteboard generalPasteboard];
    if(!strcmp(argv[1],"watch")){
        NSInteger last=pb.changeCount;
        for(;;){@autoreleasepool{
            if(getppid()==1)return 0;
            NSInteger seq=pb.changeCount;
            if(seq!=last){printf("%ld\n",(long)seq);fflush(stdout);last=seq;}
            [NSThread sleepForTimeInterval:0.15];
        }}
    }
    if(!strcmp(argv[1],"inspect")){
        number((uint32_t)pb.changeCount);
        NSArray *types=pb.types;
        bool secret=[types containsObject:@"org.nspasteboard.ConcealedType"]||[types containsObject:@"application/x-nspasteboard-concealed-type"]||[types containsObject:@"org.nspasteboard.TransientType"];
        fputc(secret?1:[types containsObject:@"io.syncvault.remote"]?2:0,stdout);
        if(!secret&&[types containsObject:NSPasteboardTypeFileURL]){
            for(NSURL *url in [pb readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}]){
                const char* s=url.path.UTF8String;if(s)fwrite(s,strlen(s)+1,1,stdout);
            }
        }return 0;
    }
    if(!strcmp(argv[1],"images")){
        if(pb.pasteboardItems.count<2)return 0;
        for(NSPasteboardItem *item in pb.pasteboardItems){
            NSData *png=[item dataForType:NSPasteboardTypePNG];
            if(!png){NSData *tiff=[item dataForType:NSPasteboardTypeTIFF];if(tiff){NSBitmapImageRep *rep=[NSBitmapImageRep imageRepWithData:tiff];png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];}}
            if(png){if(png.length>32*1024*1024)return 4;number((uint32_t)png.length);fwrite(png.bytes,png.length,1,stdout);}
        }return 0;
    }
    if(!strcmp(argv[1],"content")){
        NSData *input=[[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        id obj=[NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if(![obj isKindOfClass:NSDictionary.class])return 5;
        NSPasteboardItem *item=[[NSPasteboardItem alloc] init];
        if([obj[@"png"] isKindOfClass:NSString.class]){
            NSData *png=[[NSData alloc] initWithBase64EncodedString:obj[@"png"] options:0];
            if(!png.length||![item setData:png forType:NSPasteboardTypePNG])return 5;
        }else if([obj[@"text"] isKindOfClass:NSString.class]){
            [item setString:obj[@"text"] forType:NSPasteboardTypeString];
            if([obj[@"html"] isKindOfClass:NSString.class])[item setData:[obj[@"html"] dataUsingEncoding:NSUTF8StringEncoding] forType:NSPasteboardTypeHTML];
        }else return 5;
        [item setString:@"1" forType:@"io.syncvault.remote"];
        [pb prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
        return [pb writeObjects:@[item]]?0:6;
    }
    if(!strcmp(argv[1],"files")){
        NSData *input=[[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSMutableArray *items=[NSMutableArray array];const char *s=(const char*)input.bytes;size_t pos=0;
        while(pos<input.length){size_t n=strnlen(s+pos,input.length-pos);if(!n||pos+n>=input.length)return 5;
            NSString *name=[[NSString alloc] initWithBytes:s+pos length:n encoding:NSUTF8StringEncoding];if(!name)return 5;
            NSPasteboardItem *item=[[NSPasteboardItem alloc] init];[item setString:[[NSURL fileURLWithPath:name] absoluteString] forType:NSPasteboardTypeFileURL];[item setString:@"1" forType:@"io.syncvault.remote"];[items addObject:item];pos+=n+1;}
        [pb prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];return [pb writeObjects:items]?0:6;
    }
    return 2;
}}

