$ErrorActionPreference = "Stop"

$python = "C:\Users\Nemifist\.speechedit_venv\Scripts\python.exe"
$script = Join-Path (Split-Path -Parent $PSScriptRoot) "tools\tts-host-server.py"
$logDir = "C:\Ucontent\data\tmp"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existing = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*tts-host-server.py*" -or $_.CommandLine -like "*ucontent_tts_host_server.py*" }
foreach ($proc in $existing) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$env:UCONTENT_TTS_TMP = $logDir
$env:TMP = $logDir
$env:TEMP = $logDir
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:UCONTENT_TTS_HOST = "0.0.0.0"
$env:UCONTENT_TTS_PORT = "8765"
$env:UCONTENT_TTS_REF_AUDIO = "C:\Ucontent\ref.wav"
$env:UCONTENT_TTS_CKPT = "C:\Ucontent\data\models\my_russian_voice\model_last.pt"
$env:UCONTENT_TTS_VOCAB = "C:\Users\Nemifist\.speechedit_venv\Lib\data\my_russian_voice_char\vocab.txt"
$env:UCONTENT_TTS_DEVICE = "cuda"

Start-Process -FilePath $python `
  -ArgumentList @($script) `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "ucontent_tts_host.log") `
  -RedirectStandardError (Join-Path $logDir "ucontent_tts_host.err")

$deadline = (Get-Date).AddSeconds(90)
do {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 5
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
} while ((Get-Date) -lt $deadline)

$stdoutPath = Join-Path $logDir "ucontent_tts_host.log"
$stderrPath = Join-Path $logDir "ucontent_tts_host.err"
if (Test-Path $stdoutPath) {
  Get-Content -Encoding UTF8 -Tail 40 $stdoutPath
}
if (Test-Path $stderrPath) {
  Get-Content -Encoding UTF8 -Tail 80 $stderrPath
}
throw "TTS host service did not become ready on http://127.0.0.1:8765"
