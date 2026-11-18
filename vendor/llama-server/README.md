# Локальные архивы llama-server / Local llama-server Archives

Поместите в эту папку официальный архив `llama.cpp` для вашей ОС (`.zip` для Windows или `.tar.gz` для Linux/macOS), чтобы установить и настроить `llama-server` без доступа к интернету:

- **Windows (CPU x64)**: `llama-b...-bin-win-cpu-x64.zip`
- **Windows (NVIDIA CUDA x64)**: `llama-b...-bin-win-cuda-12.4-x64.zip` (+ при необходимости `cudart-llama-bin-win-cuda-12.4-x64.zip`)
- **Windows (Vulkan x64)**: `llama-b...-bin-win-vulkan-x64.zip`
- **Linux (x64 CPU / CUDA)**: `llama-b...-bin-ubuntu-x64.tar.gz` / `llama-b...-bin-ubuntu-cuda-12.8-x64.tar.gz`
- **macOS (Apple Silicon / Intel)**: `llama-b...-bin-macos-arm64.tar.gz` / `llama-b...-bin-macos-x64.tar.gz`

После добавления архива:
1. Нажмите **«Установить из архива проекта»** на панели ресурсов ПК в веб-интерфейсе, либо
2. Запустите `install.sh` / `install.ps1` — установщик автоматически обнаружит и распакует подходящий архив в `~/.vllm-gateway/bin`.
