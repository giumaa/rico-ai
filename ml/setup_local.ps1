<#
.SYNOPSIS
  Create ml\.venv and install the Rico fine-tuning stack for a small NVIDIA GPU on Windows
  (tested target: Quadro T2000 4 GB, Turing sm_75).

.DESCRIPTION
  1. finds Python 3.12 (or 3.10-3.13)
  2. checks the NVIDIA driver (nvidia-smi) and picks a PyTorch CUDA 12.x wheel (cu126 by default;
     the cu126 wheels include sm_75 kernels and run on any driver that supports CUDA 12.6+)
  3. creates ml\.venv, installs torch (<2.13, the range Unsloth supports), the core stack
     (ml\requirements-train.txt) and - unless -NoUnsloth - Unsloth (+ triton-windows). If Unsloth fails the
     scripts transparently fall back to plain PEFT + bitsandbytes.
  4. runs `safe_runner.py --selfcheck`

  Nothing is installed outside ml\.venv. Re-run with -Recreate to rebuild from scratch.
  Run with:  powershell -ExecutionPolicy Bypass -File ml\setup_local.ps1

.PARAMETER Python     Path to python.exe (auto-detected when omitted)
.PARAMETER CudaTag    auto|cu126|cu128 (auto = cu126)
.PARAMETER NoUnsloth  skip Unsloth (PEFT + bitsandbytes only)
.PARAMETER Recreate   delete and recreate ml\.venv
#>
[CmdletBinding()]
param(
    [string]$Python = "",
    [ValidateSet("auto", "cu126", "cu128")][string]$CudaTag = "auto",
    [switch]$NoUnsloth,
    [switch]$Recreate
)

$ErrorActionPreference = "Stop"
$ml = $PSScriptRoot
$root = Split-Path -Parent $ml
$venv = Join-Path $ml ".venv"
$work = Join-Path $ml "work"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$logFile = Join-Path $work "setup_local.log"
Start-Transcript -Path $logFile -Append | Out-Null

function Say([string]$msg, [string]$color = "Cyan") {
    Write-Host ("[setup {0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -ForegroundColor $color
}

function Invoke-Native([string]$exe, [string[]]$arguments, [switch]$AllowFail) {
    Say ("> {0} {1}" -f $exe, ($arguments -join " ")) "DarkGray"
    & $exe @arguments
    if ($LASTEXITCODE -ne 0 -and -not $AllowFail) {
        throw "Command failed (exit $LASTEXITCODE): $exe $($arguments -join ' ')"
    }
    return $LASTEXITCODE
}

try {
    # ---- 1. python ------------------------------------------------------------------------------------------
    if (-not $Python) {
        $candidates = @()
        try { $p = (& py -3.12 -c "import sys;print(sys.executable)" 2>$null); if ($p) { $candidates += $p } } catch { }
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe")
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe")
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe")
        foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $Python = $c; break } }
    }
    if (-not $Python -or -not (Test-Path $Python)) {
        throw "Python 3.12 not found. Install it (winget install Python.Python.3.12) or pass -Python <path>."
    }
    $pyver = (& $Python -c "import sys;print('%d.%d' % sys.version_info[:2])").Trim()
    Say "Python $pyver at $Python"
    if ($pyver -notmatch "^3\.(10|11|12|13)$") { throw "Unsupported Python $pyver (need 3.10 - 3.13)" }

    # ---- 2. GPU / driver ------------------------------------------------------------------------------------
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) {
        Say "nvidia-smi not found - install the NVIDIA driver first (https://www.nvidia.com/Download/index.aspx)." "Red"
        throw "No NVIDIA driver"
    }
    $hdr = (& nvidia-smi | Out-String)
    $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader | Select-Object -First 1).Trim()
    $mem = (& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1).Trim()
    Say "GPU: $gpuName ($mem MiB)"
    $cudaMajor = 0; $cudaMinor = 0
    if ($hdr -match "CUDA Version:\s*(\d+)\.(\d+)") { $cudaMajor = [int]$Matches[1]; $cudaMinor = [int]$Matches[2] }
    Say "driver supports CUDA $cudaMajor.$cudaMinor"
    if (($cudaMajor -lt 12) -or ($cudaMajor -eq 12 -and $cudaMinor -lt 6)) {
        Say "Your NVIDIA driver is too old for the CUDA 12.6 PyTorch wheels. Update it (free) from nvidia.com and re-run." "Red"
        throw "Driver too old"
    }
    if ($CudaTag -eq "auto") { $CudaTag = "cu126" }
    if ($CudaTag -eq "cu128" -and -not ($cudaMajor -gt 12 -or ($cudaMajor -eq 12 -and $cudaMinor -ge 8))) {
        throw "cu128 needs a driver that supports CUDA 12.8+; use -CudaTag cu126"
    }
    Say "using PyTorch wheel index: $CudaTag"

    # ---- 3. venv --------------------------------------------------------------------------------------------
    if ($Recreate -and (Test-Path $venv)) { Say "removing old venv"; Remove-Item -Recurse -Force $venv }
    if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
        Say "creating venv at $venv"
        Invoke-Native $Python @("-m", "venv", $venv) | Out-Null
    }
    $vpy = Join-Path $venv "Scripts\python.exe"
    Invoke-Native $vpy @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", "--disable-pip-version-check") | Out-Null

    # ---- 4. torch (CUDA wheel) -------------------------------------------------------------------------------
    Say "installing PyTorch (this downloads ~2.5 GB the first time) ..."
    Invoke-Native $vpy @("-m", "pip", "install", "torch>=2.8,<2.13", "torchvision", "--index-url",
        "https://download.pytorch.org/whl/$CudaTag", "--disable-pip-version-check") | Out-Null

    # ---- 5. core stack ---------------------------------------------------------------------------------------
    Say "installing transformers / peft / bitsandbytes / datasets ..."
    Invoke-Native $vpy @("-m", "pip", "install", "-r", (Join-Path $ml "requirements-train.txt"),
        "--disable-pip-version-check") | Out-Null

    # ---- 6. unsloth (optional) -------------------------------------------------------------------------------
    if (-not $NoUnsloth) {
        Say "installing Unsloth (faster + less VRAM; falls back to PEFT if this fails) ..."
        $rc = Invoke-Native $vpy @("-m", "pip", "install", "unsloth", "--disable-pip-version-check") -AllowFail
        if ($rc -ne 0) {
            Say "Unsloth install failed - continuing with the PEFT + bitsandbytes engine (still works, needs a bit more VRAM)." "Yellow"
        }
    }

    # ---- 7. verify -------------------------------------------------------------------------------------------
    Say "verifying the environment ..."
    $env:PYTHONUTF8 = "1"
    $rc = Invoke-Native $vpy @((Join-Path $ml "safe_runner.py"), "--selfcheck") -AllowFail
    if ($rc -eq 0) {
        Say "OK. Next: run the local trainer:" "Green"
        Say "  powershell -ExecutionPolicy Bypass -File ml\train_local_safe.ps1" "Green"
    } else {
        Say "Self-check reported problems - read the lines above (see also $logFile)." "Yellow"
    }
}
catch {
    Say ("FAILED: " + $_.Exception.Message) "Red"
    Say "Log: $logFile" "Red"
    Stop-Transcript | Out-Null
    exit 1
}
Stop-Transcript | Out-Null
exit 0
