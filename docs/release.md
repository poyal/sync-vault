# Sync Vault 릴리즈 절차

Windows 11 x64와 Apple Silicon Mac에서 각각 빌드하고, 검증한 파일을 그대로 전달합니다. GitHub Actions에는 빌드·서명·업로드를 맡기지 않습니다. Passport와 Soft Vault의 로컬 릴리즈 절차에서 사용하는 동일 커밋 빌드, 설치본 시험, 전달 후 해시 대조를 따릅니다.

| 용도 | 버전 기준 | 배포처와 수명 |
| --- | --- | --- |
| 개발판 시험 | `package.json`의 `syncVaultDevVersion` | OS별 Dev 설치본과 `installer.json`을 임시 전달하고 시험이 끝나면 삭제합니다. |
| 정식 설치 | `package.json`의 `version` | 검증한 EXE와 DMG를 전달합니다. GitHub Releases 게시를 요청한 경우 아래 수동 게시 절차를 따릅니다. |
| 앱 내 업데이트 | 같은 정식 버전 | GitHub 정식 릴리즈에서 두 OS의 ZIP과 서명된 목록을 제공합니다. |

## 1. 소스와 작업 위치 확정

1. 정식 후보는 직전 배포보다 높은 `X.Y.Z`를 사용합니다. 버전 변경 시 `npm version <버전> --no-git-tag-version`으로 `package.json`과 `package-lock.json`을 함께 갱신하고 후보 커밋을 확정합니다. 두 OS에서 `git status --short`가 비어 있는지, `git rev-parse HEAD`와 `release-key.pub`가 일치하는지 확인합니다.
2. Windows에는 Node.js·npm·Visual Studio C++ Build Tools, Mac에는 Node.js·npm·Xcode Command Line Tools를 준비합니다. 원격 Mac에서는 첫 명령부터 작업 폴더, 임시 디렉터리, 의존성 캐시와 산출물을 모두 `~/Workspace/personal/` 아래에 둡니다. 허용 경로 밖에 쓰는 설치·로그인 시험은 별도 시험 환경에서 실행합니다. [원격 작업 필수 정리](e2e.md#원격-작업-필수-정리)
3. 로컬 검증 기록에 버전, 전체 커밋 SHA, 실행 일시, OS·아키텍처, Node·npm 버전을 적습니다. 두 OS의 결과를 개별 기록하고 실패·미실행 항목과 재시험 결과를 남깁니다. [기존 검증 기록](../VERIFICATION.md)

## 2. 개발판 임시 전달

각 OS의 저장소 루트에서 `npm ci`, `npm run dist:dev`를 실행합니다. 출력 위치는 `artifacts/dev/<실행 ID>/<win-x64 또는 mac-arm64>/`입니다. 두 OS의 `installer.json`에서 `version`, `commit`, `sourceSha256`이 같은지 확인합니다.

1. `npm run dev:delivery -- copy <원본 installer.json> <새 전달 폴더>`로 EXE 또는 DMG와 명세를 복사합니다. 다른 기기로 전송한 뒤에는 그 기기에서 `npm run dev:delivery -- verify <전달본 installer.json>`을 실행합니다.
2. Dev 설치본은 별도 앱 ID와 프로필을 사용합니다. 정식 앱과의 공존 및 정식 업데이트 차단을 확인합니다. [설치본 E2E](e2e.md)
3. 시험이 끝나면 `npm run dev:delivery -- clean <전달본 installer.json>`으로 해시가 일치하는 설치본을 제거합니다. 이 명령이 남긴 `installer.json`, 시험 앱, 해당 실행에서 만든 복사본과 임시 폴더도 정리하고 경로를 다시 확인합니다.

## 3. 정식 후보 빌드와 실기기 검증

각 OS에서 저장소 루트를 기준으로 `npm ci`, `npm run check`, `npm run test:e2e`를 실행합니다. 이어서 해당 OS의 패키징 명령을 실행합니다. 패키징은 앱을 다시 빌드하므로 설치 시험은 이때 생성된 파일로 수행합니다.

| 빌드 환경 | 패키징 명령 | `release/`에서 회수할 파일 |
| --- | --- | --- |
| Windows x64 | `npm run dist:win` | `SyncVault-<버전>-win-x64.exe`, `SyncVault-<버전>-win32-x64.zip` |
| macOS arm64 | `npm run dist:mac` | `SyncVault-<버전>-mac-arm64.dmg`, `SyncVault-<버전>-darwin-arm64.zip` |

빌드 기기에서 네 파일의 크기와 SHA-256을 기록합니다. Windows에서는 `Get-FileHash -Algorithm SHA256 -LiteralPath <파일>`, Mac에서는 `shasum -a 256 <파일>`을 사용합니다. Mac 산출물을 로컬로 회수한 후 원본과 대조합니다.

| 확인 대상 | 통과 근거 |
| --- | --- |
| 새 설치와 재실행 | Windows는 실제 EXE로 설치하고, Mac은 `hdiutil verify <DMG>` 후 DMG에서 복사한 앱을 실행합니다. 첫 실행, 창을 닫은 상태의 트레이·메뉴 막대 동작, 정상 종료·재실행, 기기 ID와 설정 보존을 양쪽에서 확인합니다. Windows Authenticode, Mac 앱 서명·공증 상태를 각각 기록합니다. |
| 두 기기 간 공유와 성능 | 같은 LAN의 후보 설치본으로 연결 승인, 양방향 클립보드·파일 가져오기, 연결 중단·재개를 확인합니다. 목록 p95, 5 GiB 이어받기와 최종 해시, 창을 숨긴 20분간 CPU·메모리를 기록합니다. [실기기 실행 환경](e2e.md) · [성능 합격 기준](performance.md) |
| 이전판 업데이트와 복구 | GitHub 응답을 대체한 시험에서 공개 버전 판정, 서명·해시 검증, 취소·재시도를 확인합니다. 게시 후 GitHub 업데이트 지원 설치본에서 전송 완료 후 설치와 앱 재시작, 기기 ID·설정·수신 파일 보존을 확인합니다. 최초 전환은 새 설치본으로 교체해 검증합니다. 시작 실패 복구는 `node tests/rollback.mjs`로 검사합니다. |

한 OS에서 두 프로필로 수행한 결과에는 해당 OS만 기록합니다. 설치본을 다시 만들었거나 필수 항목이 실패했다면 새 파일의 해시와 해당 시험 결과를 확인한 후 배포합니다.

## 4. GitHub에 올릴 업데이트 자산 서명

기존 앱과 같은 `release-key.pub`를 포함해 빌드합니다. 서명 Windows 계정은 기존 DPAPI 개인키를 사용하고, 별도로 보관한 기존 Ed25519 개인키는 `SYNC_VAULT_SIGNING_FILE`로 지정할 수 있습니다. `.release-keys/`는 서명 기기에만 둡니다. `node scripts/release.mjs init`은 독립된 서명 체계를 처음 만들 때만 사용합니다.

빌드한 두 ZIP을 서명 기기의 `release/`에 모으고 다음 PowerShell을 실행합니다. `publish` 명령은 로컬에서 파일을 준비합니다. `SYNC_VAULT_RELEASE_NOTES`에는 앱의 업데이트 화면에 표시할 변경 내역을 넣습니다.

```powershell
$version = node -p "require('./package.json').version"
$staging = "release/github-$version"
if (Test-Path -LiteralPath $staging) { throw "이미 존재하는 경로입니다. 새 후보 폴더를 지정하세요." }
node scripts/release.mjs publish $staging $version "release/SyncVault-$version-win32-x64.zip" "release/SyncVault-$version-darwin-arm64.zip"
```

서명 스크립트는 ZIP마다 해당 OS의 목록과 서명을 만들고 0.2.1 클라이언트용 통합 목록과 서명도 생성합니다. 목록의 버전·플랫폼·파일명·바이트 수·SHA-256을 원본 ZIP과 대조하세요. 각 JSON은 서명할 때 사용한 바이트 그대로 게시합니다. 두 OS를 함께 배포할 때는 아래 열 파일을 한 릴리즈에 첨부합니다.

| 용도 | 자산 |
| --- | --- |
| 수동 설치·복구 | Windows EXE, Mac DMG |
| 앱 내 설치 | `SyncVault-<버전>-win32-x64.zip`, `SyncVault-<버전>-darwin-arm64.zip` |
| Windows 업데이트 검증 | `update-win32-x64.json`, `update-win32-x64.sig` |
| Mac 업데이트 검증 | `update-darwin-arm64.json`, `update-darwin-arm64.sig` |
| 기존 0.2.1과의 호환 | `update.json`, `update.sig` |

새 클라이언트는 현재 플랫폼의 목록과 서명을 우선 사용합니다. 두 파일이 모두 없는 이전 릴리즈는 통합 목록으로 확인합니다. 앱 내 패키지를 제공하지 않는 릴리즈는 GitHub에 게시된 해당 OS 설치 파일을 안내합니다. 서명이나 크기가 맞지 않으면 앱 내 업데이트를 중단합니다.

게시 전에는 `node tests/upgrade.mjs <GitHub 업데이트를 지원하는 이전 앱 폴더> <대상 버전> <서명된 자산 폴더>`로 설치를 시험합니다. Windows는 EXE를 포함하는 앱 디렉터리, Mac은 설치된 `.app`을 지정합니다. 시험은 앱 복사본에서 GitHub 응답을 후보 자산으로 대체하고, 실제 ZIP 다운로드·서명 및 해시 검사·전송 완료 후 앱 교체·재시작·데이터 보존을 확인합니다. 게시 후 마지막 인수를 생략하면 실제 GitHub 공개 자산으로 같은 절차를 실행합니다.

## 5. GitHub Releases 수동 게시와 마무리

1. 게시 요청을 받으면 검증한 커밋에 `v<버전>` 태그를 지정하고 `poyal/sync-vault`의 Releases에 초안을 만듭니다. 변경 내역과 OS별 설치 방법을 적고 위 열 파일을 첨부합니다. 기존 태그나 같은 이름의 자산이 있으면 먼저 커밋과 해시를 대조합니다. 수정판에는 새 버전을 부여합니다.
2. 초안 자산을 새 로컬 폴더로 내려받아 열 파일의 크기와 SHA-256을 원본과 대조합니다. 정식 릴리즈로 게시하고 최신 릴리즈로 지정합니다. 공개 후 인증 없이 `releases/latest`와 자산에 접근할 수 있는지 확인하고 다시 내려받아 해시를 대조합니다. 비공개 저장소의 설치 사용자에게는 인증 없는 GitHub 업데이트를 제공할 수 없습니다. [GitHub 최신 릴리즈 API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
3. GitHub 업데이트를 지원하는 직전 설치본의 **설정 → 앱 정보 · 업데이트**에서 각 OS의 공개 버전과 변경 내역, 다운로드 취소·재시도, 재시작 후 설치 버전을 확인합니다. 최초 전환 시 기존 0.1.1 사용자는 새 EXE 또는 DMG로 한 번 교체합니다. 개발판은 개발 설치본으로만 갱신합니다.
4. 게시 후 문제가 발견되면 수정한 상위 버전을 같은 절차로 배포합니다. 버전별 검증 기록에 커밋, OS별 결과, 열 파일의 해시, 태그와 릴리즈 URL을 남깁니다. 원격 접속을 끝내기 전에 작업 자원을 회수·삭제하고 허용 경로 안의 Git 체크아웃만 남았는지 확인합니다. [원격 작업 필수 정리](e2e.md#원격-작업-필수-정리)
