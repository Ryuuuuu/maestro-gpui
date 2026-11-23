# Maestro GPUI Viewer

`maestro mcp`에서 제공하는 기기 화면과 명령 로그를 보는 프로젝트입니다. 데스크톱은 Rust GPUI로 직접 그리며 웹은 Maestro의 원본 React Viewer를 사용합니다. 두 화면 왼쪽의 **Ask Maestro…** 입력창에 요청을 쓰고 Enter를 누르면 선택한 모델이 현재 Viewer를 제공하는 MCP 프로세스의 도구를 호출합니다.

## 실행

이 Windows 작업 폴더에는 로컬 실행용 Maestro와 Java가 `.tools`에 준비되어 있고, 현재 모델 공급자는 **Codex**입니다. 설치된 Codex CLI의 ChatGPT 로그인을 사용합니다. 기본 Codex 모델을 쓰려면 `MODEL`을 비워 두세요.

```sh
npm run desktop
npm run web
```

둘 중 사용할 명령 하나를 실행하세요. 웹 모드는 기본 브라우저에서 `http://127.0.0.1:18379`를 엽니다. 포트는 환경 변수 `PORT`로 변경할 수 있습니다. 브라우저를 직접 열려면 `npm run web -- --no-open`을 사용하세요. 데스크톱 모드는 창을 닫으면, 웹 모드는 터미널에서 Ctrl+C를 누르면 해당 MCP 세션이 종료됩니다. 각 실행은 새 세션을 만듭니다. 별도로 실행한 다른 에이전트의 MCP 세션과 로그를 합치지 않습니다.

## 새 컴퓨터에서 준비

1. Node.js 22.12 이상, Java 17 이상과 Viewer가 포함된 Maestro CLI를 설치합니다. 이 프로젝트에서 실제 연결을 검증한 CLI 버전은 2.12.1입니다. `maestro mcp`가 PATH에서 실행되거나 `.env`의 `MAESTRO_BIN`이 실행 파일을 가리켜야 합니다. [Maestro 설치 안내](https://docs.maestro.dev/get-started/installing-maestro)
2. 데스크톱 모드는 최신 stable Rust와 플랫폼 빌드 도구가 필요합니다. Windows는 Visual Studio C++ Build Tools 및 Windows SDK, macOS는 Xcode와 Metal 빌드 도구, Linux는 C/C++ 툴체인, Vulkan 및 X11/Wayland 개발 라이브러리를 사용합니다. Ubuntu용 패키지는 [빌드 워크플로](.github/workflows/build.yml)에 있습니다.
3. 프로젝트 루트에서 의존성을 설치합니다.

```sh
npm ci
npm ci --prefix web
```

4. `.env.example`을 `.env`로 복사하고 모델을 설정합니다. macOS·Linux에서는 `cp .env.example .env`, PowerShell에서는 `Copy-Item .env.example .env`를 사용할 수 있습니다.
5. Android 기기 또는 에뮬레이터, macOS의 iOS 시뮬레이터를 준비하고 실행 모드를 선택합니다. 연결 가능한 기기가 하나면 Viewer가 자동으로 스트리밍을 시작합니다. 기기가 여러 대이면 상단 오른쪽 **기기** 목록에서 대상을 선택하세요. 새로 연결한 기기는 목록 옆 새로고침 버튼으로 불러옵니다. 실제 기기 제어 범위는 해당 호스트의 Maestro 드라이버를 따릅니다.

## 동선 통신 기록

Python 3.12와 Android Platform Tools(`adb`)를 준비하고 프로젝트 루트에서 `npm run setup:proxy`를 한 번 실행하세요. 웹과 GPUI 모두 같은 로컬 엔진을 사용합니다. 엔진은 공식 mitmproxy 패키지의 `DumpMaster`와 `FlowWriter`를 사용합니다. [mitmproxy 소스](https://github.com/mitmproxy/mitmproxy)

1. 상단에서 기기를 선택하고 **프록시 OFF**를 눌러 켭니다. Android는 ADB를 통해 선택한 기기의 시스템 HTTP 프록시를 연결하며, 프록시를 끄거나 Viewer를 정상 종료하면 해제합니다. iOS 시뮬레이터에서는 **통신 기록**에 표시되는 루프백 주소를 테스트 클라이언트의 HTTP 프록시로 지정하세요.
2. **동선 생성**에서 프롬프트, `/run` 또는 **동선 파일 실행**으로 실행합니다. **통신 기록**에는 해당 실행 구간에 프록시를 경유해 시작된 요청과 HTTPS 터널 연결이 표시됩니다. 기기의 다른 앱이 같은 구간에 만든 요청도 포함됩니다.
3. 기록에서 요청을 누르면 요청·응답 헤더와 텍스트 본문 미리보기가 펼쳐집니다. 실행이 끝나면 원하는 실행을 고른 뒤 **파일 저장**을 누르세요. 저장 창은 `captures/`에서 열립니다. 저장한 파일은 `mitmweb -r 파일명.mitm`으로 다시 열 수 있습니다. 저장 전 기록은 현재 Viewer 세션 동안 유지됩니다.

HTTPS 연결은 기본적으로 원래의 TLS 연결을 유지하며 새 CONNECT 요청을 기록합니다. 테스트 앱에서 HTTPS 요청·응답까지 확인할 때는 `.env`의 `MAESTRO_PROXY_HTTPS_HOSTS`에 정확한 테스트 호스트 이름을 쉼표로 구분해 넣고 프록시를 다시 켜세요. 테스트 클라이언트가 이 프로젝트에서 생성한 공개 인증서 `.tools/proxy-config/mitmproxy-ca-cert.pem`을 신뢰해야 합니다. 시스템 프록시를 사용하지 않는 앱의 직접 연결이나 UDP 트래픽은 수집 대상에서 제외됩니다.

## 모델 설정

| 모델 서비스 | MODEL_PROVIDER | 자격 증명 또는 주소 |
| --- | --- | --- |
| Codex CLI | `codex` | `codex login`으로 로그인. CLI 경로가 필요한 경우 `CODEX_BIN` |
| OpenAI GPT | `openai` | `OPENAI_API_KEY` |
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Ollama, LM Studio 등 OpenAI 호환 서버 | `local` | `MODEL_BASE_URL`, 필요한 경우 `LOCAL_API_KEY` |

`MODEL`에는 해당 서비스에서 사용할 수 있는 실제 모델 ID를 넣습니다. 로컬 서버는 Chat Completions와 도구 호출을 지원해야 합니다. 예를 들어 Ollama에서는 아래와 같이 설정한 뒤 `MODEL`을 설치된 모델 태그로 바꿉니다.

```dotenv
MODEL_PROVIDER=local
MODEL_BASE_URL=http://127.0.0.1:11434/v1
MODEL=your-installed-model
```

모델 설정은 프롬프트를 보낼 때마다 `.env`에서 다시 읽습니다. 예를 들어 Claude로 전환하려면 `MODEL_PROVIDER=anthropic`, `MODEL=<사용할 Claude 모델 ID>`, `ANTHROPIC_API_KEY=<API 키>`를 저장하면 다음 요청부터 적용됩니다. Codex는 앱 서버의 동적 도구를 통해 현재 Viewer 세션의 Maestro MCP를 호출합니다. CLI에서 `codex app-server`를 지원해야 하며 검증 버전은 0.171.0입니다. Maestro 실행 파일 또는 Java 경로를 변경했을 때는 앱을 다시 실행하세요. 키와 모델 요청은 Node 프로세스에서 처리합니다. 프롬프트 한 건당 MCP 도구를 여러 번 사용할 수 있으며 최대 32단계입니다. 실행 중에는 같은 세션에서 두 번째 요청을 시작할 수 없습니다. 입력창 아래 터미널에서 모델 응답, 도구 호출과 완료, 오류를 실시간으로 확인할 수 있습니다.

## 원본과 구현 범위

기준 소스는 Maestro 커밋 `d9561331af38c6417ff39ce655251aea898ae3f6`의 [MCP Viewer](https://github.com/mobile-dev-inc/Maestro/tree/d9561331af38c6417ff39ce655251aea898ae3f6/maestro-cli/mcp-viewer)와 [Viewer 서버](https://github.com/mobile-dev-inc/Maestro/blob/d9561331af38c6417ff39ce655251aea898ae3f6/maestro-cli/src/main/java/maestro/cli/mcp/viewer/McpViewerServer.kt)입니다. `web/`에 원본 화면을 포함하고 프롬프트 및 화면 높이 처리를 추가했습니다. `src/`의 네이티브 화면은 같은 이벤트 형식, 아이콘 경로, 글꼴과 명령 상태를 사용합니다.

- 명령 스냅샷을 ID 순서로 병합하고 최상위 명령, 상태 아이콘, YAML 구문 색상, 실패 메시지를 표시합니다. 실행 행 추적, 로그 비우기, 패널 접기·펼치기를 지원합니다.
- 양쪽 모두 MJPEG 기기 화면, 실행 중 강조, 탭·스와이프·문자 입력 오버레이, 정규화한 터치 좌표와 키보드 HID 입력을 사용합니다.
- 전원, 볼륨, 뒤로, 홈, 최근 앱 버튼은 원본과 같은 입력을 전송합니다. iOS에서는 뒤로 버튼을 숨깁니다.
- 라이트·다크 테마는 시스템 설정을 따릅니다. GPUI와 브라우저의 텍스트 렌더링, 그림자와 애니메이션에는 차이가 있을 수 있습니다.

## 검증

```sh
cargo test --locked
npm test
npm --prefix web run build
```

실제 MCP까지 검증하려면 `TEST_MAESTRO=1` 환경 변수를 설정하고 `node --env-file-if-exists=.env --test`를 실행하세요. 로컬 테스트 모델이 `list_devices`를 호출하고 실제 Maestro 응답이 모델로 돌아오는지 확인합니다. 유료 API 키는 필요하지 않습니다.

Maestro 코드와 아이콘은 Apache-2.0 라이선스를 따릅니다. Inter 및 JetBrains Mono 글꼴의 OFL 라이선스는 `assets/`에 포함되어 있습니다.

## 동선 저장 및 다시 실행

입력창 아래의 **성공 동선 저장**은 현재 세션에서 Maestro MCP의 `run`이 성공한 호출을 프롬프트와 기기별로 모읍니다. 여러 동선이 있으면 목록에서 저장할 항목을 선택하세요. 실패한 호출, 기기 목록 조회, 직접 누른 터치는 포함하지 않습니다. 웹과 데스크톱 모두 프로젝트의 `flows/`에서 시스템 저장 창을 엽니다. 파일명과 저장 위치를 확인하고 저장하세요. 동선 검색과 Ask Maestro는 `flows/` 바로 아래의 YAML 파일을 찾습니다. 다른 폴더에 저장한 파일은 **동선 파일 실행**으로 열 수 있습니다. Linux의 저장 창에는 Zenity 또는 KDialog가 필요합니다.

**동선 생성 → 저장된 동선 검색**에서 파일명 일부를 입력하세요. 파일을 선택하면 Ask Maestro에 실행 명령이 채워지고 Enter로 실행합니다. Ask Maestro에 `/run 로그인.yaml`을 직접 입력하거나 “저장된 로그인 동선을 찾아서 실행해 줘”처럼 요청할 수도 있습니다.

**동선 파일 실행**에서 YAML 파일을 선택하면 현재 기기에 곧바로 실행합니다. 모델 호출 없이 같은 Maestro MCP 세션을 사용하며, 명령 패널과 터미널에서 결과를 볼 수 있습니다. 실패하면 그 시점에서 중단합니다.

단일 인라인 실행은 원본 Maestro YAML을 저장합니다. 여러 번의 실행이나 명시적인 환경 변수가 있으면 각 단계와 변수를 보존하는 Viewer YAML을 저장합니다. 파일·디렉터리 기반 실행은 성공한 파일 경로를 기록하므로 다시 실행할 때 해당 파일과 의존 리소스가 그 위치에 있어야 합니다.

**동선 파일 수정**을 누르면 입력창과 Maestro MCP 사이에 편집기가 열립니다. `flows/` 파일을 골라 YAML을 수정하고 **저장**을 누르세요. 패널을 접어도 작성 중인 내용은 유지됩니다.

Android 휴대폰에 PC 키보드로 한글을 입력하려면 휴대폰 입력란을 클릭하고 기기 옆의 **한/영**을 누르세요. 휴대폰 키보드에 한국어가 활성화되어 있어야 하며, USB 키보드 입력은 PATH의 `adb`와 기기의 `hid` 명령을 사용합니다.

## 금취 점검 모의 엔진

점검 시작 시 웹과 GPUI는 선택한 항목, 동선 파일명, 기기 ID를 로컬 서버에 보냅니다. 모의 엔진은 항목별 시작·로그·예시 결과를 HTTP로 돌려줍니다. 화면은 서버가 발행한 SSE 스냅샷으로 로그, 진행표, 점검 이력을 갱신합니다. 결과는 선택 순서에 따라 미리 정한 값이며 모델 호출이나 실제 기기 점검은 수행하지 않습니다. 서버를 재시작하면 이력은 초기화됩니다.

- `POST /api/inspection/start` — `{selected: [0, 2], files: [], device: null}` 형태로 요청하면 실행 ID를 반환합니다.
- `POST /api/inspection/event` — 엔진은 실행 ID와 항목 번호에 `type: "start"`, `type: "log"`와 `text`, 또는 `type: "result"`와 `result`를 붙여 전송합니다. 서버는 현재 항목과 이벤트 순서를 확인합니다.
- `GET /api/inspection/stream` — 연결 즉시 현재 스냅샷을 받고 이후 변경 사항을 구독합니다.
- `POST /api/inspection/reset` — 완료하거나 실패한 실행을 닫고 새 점검을 준비합니다. 이력은 서버 세션 동안 유지됩니다.
