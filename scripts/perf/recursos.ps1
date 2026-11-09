# E6 - Arranque y consumo de recursos de ASTER (Windows).
#
# Mide, sobre la aplicacion empaquetada:
#   - tamano del frontend compilado (`dist/`) y del ejecutable de release;
#   - tiempo hasta que la ventana principal tiene handle (arranque en frio y
#     en caliente, N corridas);
#   - RAM de la app + sus procesos hijo de WebView2;
#   - CPU en reposo durante unos segundos.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts/perf/recursos.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/perf/recursos.ps1 -Runs 3
#   powershell -ExecutionPolicy Bypass -File scripts/perf/recursos.ps1 -ExePath "ruta\ASTER.exe"
#
# Si no existe un ejecutable de release, el script igualmente documenta
# tamanos y entorno, y explica por que no midio el arranque.

[CmdletBinding()]
param(
    [string]$ExePath = "",
    [int]$Runs = 5,
    [int]$TimeoutSeconds = 45,
    [int]$SettleSeconds = 4,
    [int]$IdleSeconds = 6,
    [string]$OutDir = "docs/perf",
    [switch]$SkipLaunch
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $repo
$outPath = Join-Path $repo $OutDir
New-Item -ItemType Directory -Path $outPath -Force | Out-Null

function Write-Utf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-HumanSize([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ("{0:N2} GB" -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ("{0:N2} MB" -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ("{0:N1} KB" -f ($Bytes / 1KB)) }
    return ("{0} B" -f [int]$Bytes)
}

# ---------------------------------------------------------------- entorno ---
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$rustc = ""
try { $rustc = (& rustc --version 2>$null) } catch { }

$environment = [ordered]@{
    fecha = (Get-Date).ToString("o")
    equipo = $env:COMPUTERNAME
    sistema = ("{0} {1}" -f $os.Caption, $os.Version)
    cpu = $cpu.Name
    nucleos_fisicos = $cpu.NumberOfCores
    hilos = $cpu.NumberOfLogicalProcessors
    ram_total = Get-HumanSize ([double]$cs.TotalPhysicalMemory)
    powershell = $PSVersionTable.PSVersion.ToString()
    node = (& node --version)
    npm = (& npm --version)
    rustc = $rustc
}

# ------------------------------------------------------------- artefactos ---
$artifacts = @()
function Add-Artifact([string]$Kind, [string]$Path) {
    if (-not (Test-Path $Path)) { return }
    $item = Get-Item $Path
    $script:artifacts += [pscustomobject]@{
        tipo = $Kind
        ruta = $item.FullName.Substring($repo.Length + 1)
        bytes = $item.Length
        tamano = Get-HumanSize ([double]$item.Length)
        modificado = $item.LastWriteTime.ToString("o")
    }
}

Add-Artifact "Ejecutable release" "src-tauri\target\release\aster-desktop-assistant.exe"
Add-Artifact "Ejecutable debug" "src-tauri\target\debug\aster-desktop-assistant.exe"

$bundleDir = "src-tauri\target\release\bundle"
if (Test-Path $bundleDir) {
    Get-ChildItem $bundleDir -Recurse -File -Include *.msi, *.exe, *.nsis.zip -ErrorAction SilentlyContinue |
        ForEach-Object { Add-Artifact "Instalador" $_.FullName }
}

$distDir = "dist"
$distFiles = @()
$distBytes = 0
if (Test-Path $distDir) {
    $distFiles = @(Get-ChildItem $distDir -Recurse -File | ForEach-Object {
        $distBytes += $_.Length
        [pscustomobject]@{
            ruta = $_.FullName.Substring($repo.Length + 1)
            bytes = $_.Length
            tamano = Get-HumanSize ([double]$_.Length)
        }
    })
}
$distFiles = $distFiles | Sort-Object bytes -Descending

# ------------------------------------------------------- seleccion de exe ---
$launchReason = ""
$exe = $null
if ($ExePath) {
    if (Test-Path $ExePath) { $exe = (Resolve-Path $ExePath).Path }
    else { $launchReason = "La ruta indicada no existe: $ExePath" }
} elseif (Test-Path "src-tauri\target\release\aster-desktop-assistant.exe") {
    $exe = (Resolve-Path "src-tauri\target\release\aster-desktop-assistant.exe").Path
} elseif (Test-Path "src-tauri\target\debug\aster-desktop-assistant.exe") {
    $launchReason = "Solo hay ejecutable de debug; un binario de debug carga la URL de desarrollo de Vite y no representa el arranque empaquetado."
} else {
    $launchReason = "No existe un ejecutable compilado. Ejecute 'npx tauri build --no-bundle' antes de medir el arranque."
}

if ($SkipLaunch) { $launchReason = "Medicion de arranque omitida con -SkipLaunch." }

# --------------------------------------------------------------- procesos ---
function Get-TreeProcessIds([int]$RootProcessId) {
    $parent = @{}
    foreach ($p in Get-CimInstance Win32_Process) {
        $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId
    }
    $set = New-Object "System.Collections.Generic.HashSet[int]"
    [void]$set.Add($RootProcessId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($key in @($parent.Keys)) {
            if ($set.Contains([int]$parent[$key]) -and -not $set.Contains([int]$key)) {
                [void]$set.Add([int]$key)
                $changed = $true
            }
        }
    }
    return @($set)
}

function Get-TreeUsage([int]$RootProcessId) {
    $ids = Get-TreeProcessIds $RootProcessId
    $procs = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    $ram = 0
    $private = 0
    $cpu = 0
    $webviews = 0
    foreach ($p in $procs) {
        $ram += $p.WorkingSet64
        $private += $p.PrivateMemorySize64
        try { $cpu += $p.TotalProcessorTime.TotalMilliseconds } catch { }
        if ($p.ProcessName -like "*msedgewebview2*") { $webviews += 1 }
    }
    return [pscustomobject]@{
        procesos = $procs.Count
        webviews = $webviews
        ram_bytes = $ram
        ram = Get-HumanSize ([double]$ram)
        privada = Get-HumanSize ([double]$private)
        cpu_ms = $cpu
    }
}

function Close-Tree([int]$RootProcessId) {
    $ids = Get-TreeProcessIds $RootProcessId
    $proc = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    if ($proc) {
        try { [void]$proc.CloseMainWindow() } catch { }
        try {
            if (-not $proc.WaitForExit(5000)) {
                Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
    # WebView2 puede crear hijos tardios o sobrevivir al cierre del padre. Se
    # vuelve a resolver el arbol (el PPID sigue apuntando al proceso cerrado) y
    # se eliminan los que queden.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $ids = Get-TreeProcessIds $RootProcessId
        $live = @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -ne $PID -and $_.ProcessName -in @("aster-desktop-assistant", "msedgewebview2", "crashpad_handler")
        })
        if ($live.Count -eq 0) { break }
        foreach ($p in $live) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 1
}

function Measure-Start([string]$Path, [int]$Index) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Path -PassThru
    $windowMs = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $proc.Refresh()
        if ($proc.HasExited) { break }
        if ($proc.MainWindowHandle -ne 0) {
            $watch.Stop()
            $windowMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1)
            break
        }
    }
    if ($null -eq $windowMs) {
        $watch.Stop()
        if (-not $proc.HasExited) { Close-Tree $proc.Id }
        throw "La ventana no aparecio en $TimeoutSeconds s (corrida $Index)."
    }

    Start-Sleep -Seconds $SettleSeconds
    $usage = Get-TreeUsage $proc.Id

    $cpuStart = (Get-TreeUsage $proc.Id).cpu_ms
    Start-Sleep -Seconds $IdleSeconds
    $cpuEnd = (Get-TreeUsage $proc.Id).cpu_ms
    $cpuPercent = 0
    if ($cpuStart -ne $null -and $cpuEnd -ge $cpuStart) {
        $cpuPercent = 100.0 * ($cpuEnd - $cpuStart) / ($IdleSeconds * 1000.0) / $cpu.NumberOfLogicalProcessors
    }

    $result = [pscustomobject]@{
        corrida = $Index
        tipo = $(if ($Index -eq 1) { "frio" } else { "caliente" })
        ventana_ms = $windowMs
        ram_bytes = $usage.ram_bytes
        ram = $usage.ram
        ram_privada = $usage.privada
        procesos = $usage.procesos
        webviews = $usage.webviews
        cpu_reposo_pct = [math]::Round($cpuPercent, 2)
    }

    Close-Tree $proc.Id
    return $result
}

function Get-Stats([double[]]$Values) {
    $clean = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
    if ($clean.Count -eq 0) { return $null }
    $sum = 0
    foreach ($v in $clean) { $sum += $v }
    $rank = [math]::Ceiling(0.95 * $clean.Count) - 1
    if ($rank -lt 0) { $rank = 0 }
    if ($rank -ge $clean.Count) { $rank = $clean.Count - 1 }
    return [pscustomobject]@{
        n = $clean.Count
        media = [math]::Round($sum / $clean.Count, 1)
        mediana = [math]::Round($clean[[math]::Floor(($clean.Count - 1) / 2)], 1)
        p95 = [math]::Round($clean[$rank], 1)
        minimo = [math]::Round($clean[0], 1)
        maximo = [math]::Round($clean[$clean.Count - 1], 1)
    }
}

# ----------------------------------------------------------------- arranque ---
$starts = @()
if ($exe -and -not $SkipLaunch) {
    Write-Host "Midiendo arranque de $exe ($Runs corridas)..."
    for ($i = 1; $i -le $Runs; $i++) {
        Write-Host ("  corrida {0}/{1}" -f $i, $Runs)
        $starts += Measure-Start $exe $i
    }
}

$startStats = $null
if ($starts.Count -gt 0) {
    $startStats = Get-Stats ([double[]]@($starts | ForEach-Object { $_.ventana_ms }))
}
$ramStats = $null
if ($starts.Count -gt 0) {
    $ramStats = Get-Stats ([double[]]@($starts | ForEach-Object { $_.ram_bytes / 1MB }))
}

# ------------------------------------------------------------------ salida ---
$payload = [ordered]@{
    entorno = $environment
    artefactos = $artifacts
    dist = [ordered]@{
        bytes = $distBytes
        tamano = Get-HumanSize ([double]$distBytes)
        archivos = $distFiles
    }
    ejecutable = $exe
    motivo_sin_arranque = $launchReason
    corridas = $starts
    arranque_ms = $startStats
    ram_mb = $ramStats
}
Write-Utf8 (Join-Path $outPath "recursos.json") ($payload | ConvertTo-Json -Depth 8)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# E6 - Arranque y consumo de recursos")
$lines.Add("")
$lines.Add(("Generado: {0}" -f $environment.fecha))
$lines.Add("")

$lines.Add("## Entorno")
$lines.Add("")
$lines.Add("| Dato | Valor |")
$lines.Add("| --- | --- |")
$lines.Add(("| Sistema | {0} |" -f $environment.sistema))
$lines.Add(("| CPU | {0} ({1} nucleos / {2} hilos) |" -f $environment.cpu, $environment.nucleos_fisicos, $environment.hilos))
$lines.Add(("| RAM | {0} |" -f $environment.ram_total))
$lines.Add(("| Node / npm | {0} / {1} |" -f $environment.node, $environment.npm))
$lines.Add(("| Rust | {0} |" -f $environment.rustc))
$lines.Add("")

$lines.Add("## Artefactos")
$lines.Add("")
if ($artifacts.Count -eq 0) {
    $lines.Add("No se encontro ningun ejecutable ni instalador compilado.")
} else {
    $lines.Add("| Tipo | Ruta | Tamano |")
    $lines.Add("| --- | --- | ---: |")
    foreach ($a in $artifacts) {
        $lines.Add(("| {0} | `{1}` | {2} |" -f $a.tipo, $a.ruta, $a.tamano))
    }
}
$lines.Add("")
$lines.Add(("Frontend compilado (`dist/`): **{0}** en {1} archivos." -f (Get-HumanSize ([double]$distBytes)), $distFiles.Count))
$lines.Add("")
if ($distFiles.Count -gt 0) {
    $lines.Add("| Archivo | Tamano |")
    $lines.Add("| --- | ---: |")
    foreach ($f in $distFiles) { $lines.Add(("| `{0}` | {1} |" -f $f.ruta, $f.tamano)) }
    $lines.Add("")
}

$lines.Add("## Arranque")
$lines.Add("")
if ($starts.Count -eq 0) {
    $lines.Add("No se midio el arranque: $launchReason")
} else {
    $lines.Add("Tiempo desde `Start-Process` hasta que `MainWindowHandle` deja de ser 0.")
    $lines.Add("La corrida 1 es **fria** (primer proceso de la tanda); las siguientes son **calientes**.")
    $lines.Add("")
    $lines.Add("| Corrida | Tipo | Ventana (ms) | RAM total | RAM privada | Procesos | WebView2 | CPU reposo |")
    $lines.Add("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    foreach ($s in $starts) {
        $lines.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} % |" -f $s.corrida, $s.tipo, $s.ventana_ms, $s.ram, $s.ram_privada, $s.procesos, $s.webviews, $s.cpu_reposo_pct))
    }
    $lines.Add("")
    $lines.Add("| Estadistica | Ventana (ms) | RAM (MB) |")
    $lines.Add("| --- | ---: | ---: |")
    $lines.Add(("| n | {0} | {1} |" -f $startStats.n, $ramStats.n))
    $lines.Add(("| Media | {0} | {1} |" -f $startStats.media, $ramStats.media))
    $lines.Add(("| Mediana | {0} | {1} |" -f $startStats.mediana, $ramStats.mediana))
    $lines.Add(("| p95 | {0} | {1} |" -f $startStats.p95, $ramStats.p95))
    $lines.Add(("| Minimo | {0} | {1} |" -f $startStats.minimo, $ramStats.minimo))
    $lines.Add(("| Maximo | {0} | {1} |" -f $startStats.maximo, $ramStats.maximo))
    $lines.Add("")
    $lines.Add("La RAM incluye el proceso principal y todos sus descendientes (motor de WebView2).")
}
$lines.Add("")
$lines.Add("## Limitaciones")
$lines.Add("")
$lines.Add("- La primera corrida no vacia la cache de archivos del sistema: es un arranque en frio de **proceso**, no tras reiniciar Windows.")
$lines.Add("- `MainWindowHandle` indica que la ventana ya existe; no garantiza que React haya pintado el primer cuadro.")
$lines.Add("- El consumo en reposo varia con la pagina visible, el motor de voz y la sincronizacion de OneDrive.")
$lines.Add("- Los procesos de WebView2 se atribuyen por arbol de descendencia; otras apps con WebView2 no se cuentan.")
$lines.Add("")

Write-Utf8 (Join-Path $outPath "recursos.md") ($lines -join "`r`n")

Write-Host ""
Write-Host ("Escrito en {0}" -f $outPath)
if ($startStats) {
    Write-Host ("Arranque mediana: {0} ms | RAM mediana: {1} MB" -f $startStats.mediana, $ramStats.mediana)
} else {
    Write-Host ("Sin medicion de arranque: {0}" -f $launchReason)
}
