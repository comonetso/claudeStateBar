# 음성·번역 공급자

Claude State Bar 설정의 **TTS · STT · 번역 공급자** 칸에서 언어 하나와 기능별 API 공급자를 고릅니다.

| 기능 | 공급자 | 기본값 |
| --- | --- | --- |
| 번역 | Google(Gemini), OpenAI(ChatGPT), Anthropic(Claude) | Google |
| 읽기 | Google, OpenAI | Google, Zephyr |
| 받아쓰기 | Google, OpenAI | Google |

공통 언어는 한국어, 영어, 일본어, 중국어, 스페인어, 프랑스어, 아랍어 순입니다. 설정을 저장하기 전에는 Paseo 화면 언어(한국어/영어)를 따르며, 없으면 한국어입니다.

지금 고른 목소리를 누르면 목록이 펼쳐집니다. 이름을 누르면 고르고 접힙니다. 미리 듣기는 선택을 바꾸지 않고 설정 언어의 고정 문장을 읽습니다. 다시 누르면 멈춥니다. 같은 공급자·목소리·언어의 소리는 설정 화면이 열려 있는 동안 다시 합성하지 않습니다. 칸을 접었다 펴도 유지됩니다. 들리는 소리는 AI가 합성한 음성입니다.

목록은 공급자마다 많이 쓰이는 여성 목소리 6개입니다. Google은 **Zephyr, Aoede, Callirrhoe, Despina, Kore, Leda**(성별은 Google 공식 값), OpenAI는 **marin, alloy, coral, nova, sage, shimmer**(OpenAI는 성별을 공식으로 밝히지 않아 여성 목소리로 통하는 것)입니다. 예전에 저장한 지원 목소리가 이 목록 밖이면 맨 위에 더 보이며 선택을 유지합니다.

**공급자 설정 저장**을 눌러 언어·공급자·목소리를 적용합니다. 설정은 `~/.paseo/claude-state-bar/speech.json`에 저장됩니다(`PASEO_HOME`이 있으면 그 아래). PC에서 저장하면 받아쓰기 이름 힌트와 같은 서버들에도 보내며 서버별 결과를 보여 줍니다. 서버에서 도는 대화는 그 데몬의 설정과 키를 씁니다.

선택한 공급자가 필요로 하는 키 칸만 보입니다. **키 저장**은 이 기기의 기존 `google.env`에서 비어 있지 않은 칸만 바꾸며 저장한 값은 화면으로 돌려주지 않습니다. Google은 번역·받아쓰기에 `GOOGLE_GEMINI_KEY`, 읽기에 `GOOGLE_TTS_KEY`를 쓰며, OpenAI는 `OPENAI_API_KEY`, Anthropic은 `ANTHROPIC_API_KEY`를 씁니다. 키 확인은 짧은 번역·합성 요청을 보내고 키별 결과를 보여 줍니다. 마이크나 받아쓰기 API 자체를 시험하는 기능은 아닙니다.

번역 보관은 공급자와 언어별로 나뉩니다. 공급자가 없던 옛 항목은 Google 것으로 읽고 원래의 7일 만료를 유지합니다. 키가 없거나 요청이 실패하면 사유를 표시하며 다른 공급자로 넘기지 않습니다.

**생각 상자 자동 번역**(처음엔 꺼짐)을 켜면 번역 단추를 누르지 않아도 생각 상자를 처음부터 번역해 보여 줍니다. 고른 언어로 쓰이지 않은 문단만 번역하고, 번역이 오기 전까지는 원문이 잠깐 보입니다. 켜 둔 동안 상자 단추는 원문 보기와 읽기만 남고, 읽기는 번역이 오기를 기다렸다가 번역문으로 읽습니다. 끄면 단추가 번역·읽기·번역읽기로 돌아가며, 번역읽기는 읽는 동안만 번역을 보여 주고 끝나면 원래 화면으로 돌아갑니다. 서버에서 도는 대화는 그 서버의 키 파일로 번역합니다. 바로 아래 **생각 상자 자동 펼침**(처음엔 켜짐)은 자동 번역이 켜져 있을 때 지금 생각 중인 상자를 열고 높이 제한을 풀어 스크롤 없이 보이게 합니다.

모델: Gemini `gemini-3.5-flash-lite`(번역), `gemini-3.8-flash`(받아쓰기), Anthropic `claude-haiku-5-5`(번역), OpenAI `gpt-4.1-mini`(번역·받아쓰기 다듬기), `gpt-4o-mini-tts`(읽기), `gpt-transcribe`(받아쓰기).

목소리 근거: [Google Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI CLI 합성 예제](https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create).

## PC 연결이 끊겼을 때

PC 연결이 끊기면 Calladmin-Gabia가 프로젝트 목록과 관리 화면, 사용량, 설정 화면, 받아쓰기 입력창 보호를 대신 맡습니다. PC가 다시 연결되면 PC로 돌아오며 한 화면에 이 기능들이 한 벌만 보입니다. 다른 서버는 대신 맡지 않고 직원 데몬은 기존대로 동작합니다.

PC 데몬은 시작할 때와 목록·고정·카테고리/프로젝트 순서 파일이 바뀔 때 받아쓰기 이름 힌트와 같은 서버들에 별도 사본을 보냅니다. 사본은 `~/.paseo/claude-state-bar/pc-offline-projects.json`에 저장되며 서버 자신의 목록 파일과 다릅니다. 전달에 실패하면 다음 변경이나 데몬 시작 때 다시 시도합니다. 대체 서버에는 성공적으로 전달된 사본이 있어야 합니다.

Calladmin-Gabia가 대신 맡는 동안 목록·설정은 보기만 가능합니다. PC 프로젝트를 누르면 연결 끊김 안내가 나오고 연결된 서버 프로젝트는 평소대로 열립니다. 사용량과 표시되는 설정 값은 Calladmin-Gabia의 값입니다. 설정·공급자·키·이름 저장, 음원 업로드, 목록 편집과 순서 초기화는 막힙니다. 자동 알림 소리, 기기 사이 설정 맞추기, 화면 배치 저장/가져오기, 대표 기기 지정, 칸 최대화 기록은 PC가 맡습니다. 받아쓰기 입력창 보호는 기존에 지원하던 앱 버전에서만 작동합니다.
