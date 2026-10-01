<#
.SYNOPSIS
  Fine-tune Rico on THIS PC's NVIDIA GPU (e.g. Quadro T2000 4 GB) without lagging or overheating it.

.DESCRIPTION
  Wraps ml\safe_runner.py (which wraps ml\train_lora.py):
    * runs at BelowNormal process priority, 4 CPU threads
    * seq 768, batch 1, grad-accum 16, gradient checkpointing, 92% VRAM cap
    * watchdog: pauses at >= 78 C, resumes at <= 70 C, stops (with checkpoint) at >= 85 C
    * duty cycle: GPU busy ~65% of the time (-Duty)
    * checkpoint every 50 steps; just run the same command again to RESUME
    * pause/resume by hand:  -Pause / -Resume  (creates / deletes ml\work\PAUSE)

  First run ml\setup_local.ps1 once. Training data: ml\data\rico_sft.jsonl (made by the "distill" workflow).
  Run with:  powershell -ExecutionPolicy Bypass -File ml\train_local_safe.ps1

.PARAMETER Preset    qwen3-4b-2507 (default, fits 4 GB) | qwen35-2b | qwen3-1.7b | qwen35-4b (needs >= 11 GB, not for T2000)
.PARAMETER Duty      average GPU busy fraction 0.3-1.0 (default 0.65). Lower = cooler and quieter.
.PARAMETER Export    after training: merge -> GGUF -> Q4_K_M -> Rico metadata + shards (needs ~10 GB RAM, 15 GB disk)
.PARAMETER SelfCheck print environment / GPU diagnostics and exit
.PARAMETER ExtraArgs additional arguments forwarded to train_lora.py (e.g. -ExtraArgs '--max-samples','2000')
#>
[CmdletBinding()]
param(
    [string]$Preset = "qwen3-4b-2507",
    [string]$Data = "",
    [string]$Out = "",
    [double]$Duty = 0.65,
    [int]$MaxTemp = 78,
    [int]$ResumeTemp = 70,
    [int]$HardTemp = 85,
    [int]$SeqLen = 768,
    [int]$Threads = 4,
    [double]$Epochs = 2,
    [int]$MaxSteps = -1,
    [switch]$Export,
    [switch]$Pause,
    [switch]$Resume,
    [switch]$SelfCheck,
    [switch]$Force,
    [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"
$ml = $PSScriptRoot
$root = Split-Path -Parent $ml
$work = Join-Path $ml "work"
$pauseFile = Join-Path $work "PAUSE"
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Say([string]$msg, [string]$color = "Cyan") {
    Write-Host ("[local-train {0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -ForegroundColor $color
}

if ($Pause) {
    Set-Content -Path $pauseFile -Value "paused $(Get-Date -Format s)"
    Say "PAUSE flag created: training will stop between micro-steps within a few seconds (GPU idles)." "Yellow"
    exit 0
}
if ($Resume) {
    Remove-Item -Force -ErrorAction SilentlyContinue $pauseFile
    Say "PAUSE flag removed: training resumes." "Green"
    exit 0
}

$py = Join-Path $ml ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Say "ml\.venv not found. Run first:  powershell -ExecutionPolicy Bypass -File ml\setup_local.ps1" "Red"
    exit 1
}
$runner = Join-Path $ml "safe_runner.py"

# lower OUR priority: the python child inherits it (safe_runner lowers it again for itself)
try {
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
} catch { Say "could not set BelowNormal priority: $_" "Yellow" }

$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:OMP_NUM_THREADS = "$Threads"
$env:MKL_NUM_THREADS = "$Threads"
$env:TOKENIZERS_PARALLELISM = "false"

if ($SelfCheck) {
    & $py $runner --selfcheck
    exit $LASTEXITCODE
}

if (-not $Data) { $Data = Join-Path $ml "data\rico_sft.jsonl" }
if (-not (Test-Path $Data)) {
    Say "Training data not found: $Data" "Red"
    Say "Run the 'Distill' GitHub workflow, download ml/data/rico_sft.jsonl (artifact or commit) and retry." "Red"
    exit 1
}
if (-not $Out) { $Out = Join-Path $ml "outputs\rico-lite-local" }

$safeArgs = @("--max-temp", "$MaxTemp", "--resume-temp", "$ResumeTemp", "--hard-temp", "$HardTemp",
              "--duty", "$Duty", "--threads", "$Threads", "--pause-file", $pauseFile)
if ($Force) { $safeArgs += "--force" }
$trainArgs = @("--preset", $Preset, "--data", $Data, "--out", $Out, "--seq-len", "$SeqLen", "--epochs", "$Epochs")
if ($MaxSteps -gt 0) { $trainArgs += @("--max-steps", "$MaxSteps") }
if ($Export) { $trainArgs += "--export" }
$trainArgs += $ExtraArgs

Start-Transcript -Path (Join-Path $work "train_local.log") -Append | Out-Null
Say "preset=$Preset  duty=$Duty  pause>=${MaxTemp}C resume<=${ResumeTemp}C  threads=$Threads  out=$Out"
Say "Tips: -Duty 0.5 = cooler/quieter.  Pause: -Pause   Resume: -Resume   Stop: Ctrl+C (re-run to resume from the last checkpoint)." "DarkGray"
Say "Live status: type ml\work\status.json   |   log: ml\work\train_local.log" "DarkGray"

& $py $runner @safeArgs "--" @trainArgs
$rc = $LASTEXITCODE
Stop-Transcript | Out-Null

switch ($rc) {
    0 { Say "Finished. Adapter: $Out\adapter" "Green" }
    2 { Say "Pre-flight check refused to start (GPU too small / busy / no nvidia-smi). See messages above." "Red" }
    3 { Say "Stopped early (thermal stop). Run the same command later to resume from the last checkpoint." "Yellow" }
    default { Say "Exited with code $rc (see log)." "Red" }
}
exit $rc
