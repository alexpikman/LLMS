# vLLM Gateway — Высокопроизводительный движок инференса LLM (GGUF + OpenAI API + PagedAttention)

[🇷🇺 Русская версия](#русская-версия) · [🇬🇧 English Version](#english-version)

---

<a id="русская-версия"></a>

## 🇷🇺 Русская версия

**vLLM Gateway** — это полнофункциональный сервер инференса LLM и инженерная веб-студия с открытым OpenAI-совместимым API (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`), поддержкой локального запуска **GGUF-моделей на CPU и GPU**, загрузчиком весов из всех основных хабов и реальной визуализацией KV-кэша **PagedAttention**.

### Основные возможности

1. **Локальный запуск GGUF на CPU и GPU (`llama-server`)**
   - Запуск квантованных моделей (`.gguf`: `Q4_K_M`, `Q5_K_M`, `Q8_0`, `IQ4_XS` и др.) на NVIDIA CUDA, Apple Silicon Metal или CPU.
   - Гибкая настройка режима вычислений (`Auto`, `GPU Offload`, `Только CPU`), количества слоёв GPU (`--n-gpu-layers`), потоков CPU (`--threads`), размера контекста (`--ctx-size`) и параллельных слотов (`--parallel`).
   - Встроенный установщик бинарника `llama-server` из официальных релизов `ggml-org/llama.cpp` прямо из интерфейса.
2. **Загрузка моделей из всех известных источников**
   - **Hugging Face Hub**: поиск GGUF-репозиториев, просмотр дерева квантований и прямая загрузка.
   - **Ollama Registry v2**: получение OCI-манифестов (`registry.ollama.ai`) и скачивание GGUF-слоёв по SHA-256.
   - **ModelScope Hub**: поиск и загрузка `.gguf`-файлов из `modelscope.cn`.
   - **Прямой URL**: проверка заголовков `HEAD` / `Content-Range` и потоковая загрузка.
   - Поддержка **паузы и докачки** (`HTTP Range`), отображение реальной скорости (МБ/с) и оставшегося времени (ETA).
3. **Аппаратный профилировщик ПК и индикатор совместимости**
   - Автоматическое определение процессора, потоков, реальной доступной оперативной памяти (`MemAvailable` / `os.freemem`), свободного места на диске, GPU VRAM через `nvidia-smi` и Unified Memory на Apple Silicon.
   - Расчёт требуемой памяти (`Размер весов GGUF + KV-кэш под max_model_len + оверхед рантайма`) с выдачей чёткого вердикта:
     - **Подходит для GPU** — модель и KV-кэш целиком помещаются в VRAM.
     - **Гибрид GPU + CPU** — точная рекомендация числа слоёв для выгрузки в VRAM с размещением остатка в RAM.
     - **Только CPU (RAM)** — модель помещается в оперативную память.
     - **Недостаточно памяти / диска** — честное предупреждение до начала загрузки.
4. **PagedAttention KV-кэш и GPU Context Controller**
   - Динамическая сетка физических блоков (`P0..PN`), микро-слотов внутри каждого блока (`16` или `32`), расчёт внутренней хвостовой фрагментации, повторное использование префиксных блоков (`Prefix Caching`, `refCount`) и инспекция таблицы соответствия `Logical -> Physical Block Table`.
   - Боковой виджет **GPU Context Controller** для изменения `kv_memory_utilization`, `total_blocks`, `block_size`, `max_num_seqs` и `max_model_len` на лету.
5. **OpenAI-совместимый API и реальные бенчмарки (Recharts)**
   - Поддержка SSE-стриминга и JSON-ответов для `curl`, Python (`openai`), LangChain и других клиентов.
   - Раздел бенчмарков с последовательным или конкурентным (`1 → 2 → 4`) нагрузочным тестированием и графиками пропускной способности (`tokens/sec`) и задержки (`TTFT`) на базе **Recharts**.

---

### Быстрая автоматическая установка через GitHub (Бинарник)

#### Linux и macOS

```bash
VLLM_REPO="<OWNER>/<REPO>" curl -fsSL https://raw.githubusercontent.com/<OWNER>/<REPO>/main/install.sh | bash
```

Или если репозиторий уже клонирован локально:

```bash
./install.sh
```

#### Windows (PowerShell)

```powershell
$env:VLLM_REPO="<OWNER>/<REPO>"; irm https://raw.githubusercontent.com/<OWNER>/<REPO>/main/install.ps1 | iex
```

Для Windows 10/11 x64 также публикуется полноценный установщик:
`vllm-gateway-setup-win-x64.exe`. Он устанавливает приложение в профиль текущего
пользователя, создаёт ярлык и регистрирует деинсталлятор. Пользовательские модели
хранятся отдельно в `%USERPROFILE%\.vllm-gateway` и не удаляются при деинсталляции.

После установки запустите vLLM Gateway из меню «Пуск» или ярлыка на рабочем столе.
Интерфейс и API станут доступны по адресу: **`http://localhost:3000`**

---

### Запуск из исходников и сборка бинарного файла

Требования: **Node.js 22+**, **Bun**.

```bash
# 1. Установка зависимостей по bun.lock
bun install --frozen-lockfile

# 2. Режим разработки (Express + Vite HMR-middleware на порту 3000)
bun run dev

# 3. Продакшен-сборка фронтенда и запуск Node-сервера
bun run build
NODE_ENV=production npm start

# 4. Сборка автономного бинарника (Node.js Single Executable Application)
bun run build:release
# Результат находится в папке ./release-build/
```

Для автоматической публикации релизных архивов (`linux-x64`, `linux-arm64`, `macos-arm64`, `win-x64`) через GitHub Actions достаточно создать тег вида `v1.0.0`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

### Переменные окружения (`.env`)

| Переменная | Описание | По умолчанию |
| :--- | :--- | :--- |
| `PORT` | HTTP-порт сервера и OpenAI API | `3000` |
| `VLLM_DATA_DIR` | Директория хранения `.gguf` моделей и бинарника `llama-server` | `~/.vllm-gateway` |
| `LLAMA_SERVER_PATH` | Явный путь к исполняемому файлу `llama-server` | Автопоиск (`PATH`, `~/.vllm-gateway/bin`) |
| `GEMINI_API_KEY` | Ключ Google Gemini API для облачных развёртываний (опционально) | — |
| `HF_TOKEN` | Токен Hugging Face для приватных/закрытых GGUF-репозиториев | — |
| `MODELSCOPE_TOKEN` | Токен ModelScope (опционально) | — |

---

### Пример использования OpenAI API

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-3b-instruct-q4_k_m",
    "messages": [{"role": "user", "content": "Объясни принцип PagedAttention в 3 предложениях"}],
    "stream": true
  }'
```

---
---

<a id="english-version"></a>

## 🇬🇧 English Version

**vLLM Gateway** is a production-ready LLM inference gateway and engineering studio providing an OpenAI-compatible API (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`), local **GGUF model execution on CPU & GPU**, a multi-source model downloader, real PC hardware compatibility scoring, and live **PagedAttention KV-cache** block visualization.

### Key Features

1. **Local GGUF Inference on CPU & GPU (`llama-server`)**
   - Run quantized `.gguf` models (`Q4_K_M`, `Q5_K_M`, `Q8_0`, `IQ4_XS`, etc.) on NVIDIA CUDA, Apple Silicon Metal, or CPU.
   - Configure compute mode (`Auto`, `GPU Offload`, `CPU Only`), offloaded GPU layers (`--n-gpu-layers`), CPU threads (`--threads`), context size (`--ctx-size`), and parallel slots (`--parallel`).
   - Built-in one-click installer for official `llama-server` binaries from `ggml-org/llama.cpp` GitHub Releases.
2. **Multi-Source Model Downloader (with Pause & Resume)**
   - **Hugging Face Hub**: search GGUF repositories, browse quantization trees, and download directly.
   - **Ollama Registry v2**: fetch OCI manifests (`registry.ollama.ai`) and download SHA-256 GGUF model blobs.
   - **ModelScope Hub**: query ModelScope repositories and pull `.gguf` weights.
   - **Direct URL**: inspect `HEAD` / `Content-Range` metadata and stream with HTTP `Range` resume support, live throughput (MB/s), and ETA.
3. **Real PC Hardware Profiler & Compatibility Indicator**
   - Reads real host CPU model/threads/architecture, system RAM (`MemAvailable` / `os.freemem`), free disk space, NVIDIA GPU VRAM via `nvidia-smi`, and Apple Silicon unified memory.
   - Compares hardware resources against `GGUF file size + KV-cache estimate for active max_model_len + runtime overhead` to assign a deterministic runnability verdict:
     - **Fits on GPU** (`gpu_full`): full VRAM offload.
     - **Hybrid GPU + CPU** (`gpu_partial`): calculates exact recommended `--n-gpu-layers`.
     - **CPU Only (RAM)** (`cpu_only`): fits within free system RAM.
     - **Insufficient Memory / Disk** (`insufficient`): honest pre-download warning.
4. **Real-Time PagedAttention Grid & GPU Context Controller**
   - Visualizes physical KV-cache blocks (`P0..PN`), token micro-slots (`16` or `32`), internal tail fragmentation, shared prefix blocks (`refCount`), and per-request `Logical -> Physical` block tables.
   - Sidebar **GPU Context Controller** adjusts `kv_memory_utilization`, `total_blocks`, `block_size`, `max_num_seqs`, and `max_model_len` on the fly.
5. **OpenAI API Console & Real Throughput Benchmarks (Recharts)**
   - Live SSE & JSON requests mapped directly to real token throughput (`tokens/sec`), `TTFT`, and `TPOT` charts rendered with **Recharts**.

---

### One-Line GitHub Installation (Standalone Binary)

#### Linux & macOS

```bash
VLLM_REPO="<OWNER>/<REPO>" curl -fsSL https://raw.githubusercontent.com/<OWNER>/<REPO>/main/install.sh | bash
```

Or from a cloned repository:

```bash
./install.sh
```

#### Windows (PowerShell)

```powershell
$env:VLLM_REPO="<OWNER>/<REPO>"; irm https://raw.githubusercontent.com/<OWNER>/<REPO>/main/install.ps1 | iex
```

Start the gateway:

```bash
vllm-gateway
```

Open **`http://localhost:3000`** in your browser.

---

### Build from Source & Package Standalone Binary

Requirements: **Node.js 22+**, **Bun**.

```bash
# Install dependencies from bun.lock
bun install --frozen-lockfile

# Run in development mode (Express + Vite middleware on port 3000)
bun run dev

# Production build & start
bun run build
NODE_ENV=production npm start

# Build standalone Node.js SEA executable + dist/ in ./release-build/
bun run build:release
```

To trigger automated multi-platform GitHub Release builds (`linux-x64`, `linux-arm64`, `macos-arm64`, `win-x64`), push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

### Environment Variables (`.env`)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP server & OpenAI API port | `3000` |
| `VLLM_DATA_DIR` | Storage path for `.gguf` weights and `llama-server` binaries | `~/.vllm-gateway` |
| `LLAMA_SERVER_PATH` | Explicit path to `llama-server` binary | Auto-detected (`PATH`, `~/.vllm-gateway/bin`) |
| `GEMINI_API_KEY` | Optional Google Gemini API key for cloud deployments | — |
| `HF_TOKEN` | Optional Hugging Face token for gated/private repos | — |
| `MODELSCOPE_TOKEN` | Optional ModelScope token | — |

---

### OpenAI API Usage Example

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="not-needed")

response = client.chat.completions.create(
    model="qwen2.5-3b-instruct-q4_k_m",
    messages=[{"role": "user", "content": "Explain PagedAttention briefly."}],
)
print(response.choices[0].message.content)
```
