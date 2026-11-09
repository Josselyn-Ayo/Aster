# exportar.ps1 - Genera DOCX y PDF del informe de pruebas de rendimiento.
#
# Convierte docs/PRUEBAS_RENDIMIENTO.md a:
#   docs/perf/PRUEBAS_RENDIMIENTO.docx
#   docs/perf/PRUEBAS_RENDIMIENTO.pdf
#
# Requisitos: Microsoft Word instalado (Office / Microsoft 365).
# No requiere Pandoc, Puppeteer ni dependencias externas.
#
# Uso rapido (desde la raiz del proyecto):
#   npm run perf:export
#
# Uso directo:
#   powershell -ExecutionPolicy Bypass -File scripts/perf/exportar.ps1
#
# Parametros opcionales:
#   -SoloDocx    : genera solo el DOCX
#   -SoloPdf     : genera solo el PDF
#   -AbrirAlFinal: abre el DOCX en Word al terminar

[CmdletBinding()]
param(
    [switch]$SoloDocx,
    [switch]$SoloPdf,
    [switch]$AbrirAlFinal
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- rutas ---
$repo   = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$mdPath = Join-Path $repo "docs\PRUEBAS_RENDIMIENTO.md"
$outDir = Join-Path $repo "docs\perf"
$docx   = Join-Path $outDir "PRUEBAS_RENDIMIENTO.docx"
$pdf    = Join-Path $outDir "PRUEBAS_RENDIMIENTO.pdf"

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

if (-not (Test-Path $mdPath)) {
    Write-Error "No existe $mdPath"
    exit 1
}

# ---------------------------------------------------------------- Markdown -> HTML ---
# Conversion basica de Markdown a HTML para que Word lo importe correctamente.
function ConvertTo-HtmlDoc {
    param([string]$Markdown)

    $lines  = $Markdown -split "`r?`n"
    $output = New-Object System.Collections.Generic.List[string]
    $inPre  = $false
    $inTable = $false
    $preBuffer = New-Object System.Collections.Generic.List[string]

    foreach ($line in $lines) {
        # Bloques de codigo
        if ($line -match '^```') {
            if ($inPre) {
                $encoded = [System.Web.HttpUtility]::HtmlEncode(($preBuffer -join "`n"))
                $output.Add("<pre><code>$encoded</code></pre>")
                $preBuffer.Clear()
                $inPre = $false
            } else {
                if ($inTable) { $output.Add("</table>"); $inTable = $false }
                $inPre = $true
            }
            continue
        }
        if ($inPre) { $preBuffer.Add($line); continue }

        # Tablas
        if ($line -match '^\|.+\|$') {
            if (-not $inTable) {
                $output.Add('<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:9pt">')
                $inTable = $true
                $headerDone = $false
            }
            if ($line -match '^\|[\s\-:]+\|') {
                $headerDone = $true
                continue
            }
            $cells = ($line -split '\|') | Select-Object -Skip 1 | Select-Object -SkipLast 1
            if (-not $headerDone) {
                $output.Add('<tr>')
                foreach ($c in $cells) {
                    $output.Add("<th style='background:#2c3e50;color:#fff;padding:6px'>$($c.Trim())</th>")
                }
                $output.Add('</tr>')
            } else {
                $output.Add('<tr>')
                foreach ($c in $cells) {
                    $output.Add("<td style='padding:5px;border:1px solid #ccc'>$($c.Trim())</td>")
                }
                $output.Add('</tr>')
            }
            continue
        }

        if ($inTable) { $output.Add("</table>"); $inTable = $false }

        # Encabezados
        if ($line -match '^######\s+(.+)') { $output.Add("<h6>$($Matches[1])</h6>"); continue }
        if ($line -match '^#####\s+(.+)')  { $output.Add("<h5>$($Matches[1])</h5>"); continue }
        if ($line -match '^####\s+(.+)')   { $output.Add("<h4>$($Matches[1])</h4>"); continue }
        if ($line -match '^###\s+(.+)')    { $output.Add("<h3>$($Matches[1])</h3>"); continue }
        if ($line -match '^##\s+(.+)')     { $output.Add("<h2>$($Matches[1])</h2>"); continue }
        if ($line -match '^#\s+(.+)')      { $output.Add("<h1>$($Matches[1])</h1>"); continue }

        # Lineas horizontales
        if ($line -match '^---+$') { $output.Add("<hr/>"); continue }

        # Listas
        if ($line -match '^- (.+)') { $output.Add("<ul><li>$($Matches[1])</li></ul>"); continue }
        if ($line -match '^\d+\. (.+)') { $output.Add("<ol><li>$($Matches[1])</li></ol>"); continue }

        # Linea vacia
        if ($line.Trim() -eq '') { $output.Add("<br/>"); continue }

        # Parrafo normal con formato inline
        $p = $line
        # Negrita + cursiva
        $p = [regex]::Replace($p, '\*\*\*(.+?)\*\*\*', '<strong><em>$1</em></strong>')
        # Negrita
        $p = [regex]::Replace($p, '\*\*(.+?)\*\*', '<strong>$1</strong>')
        # Cursiva
        $p = [regex]::Replace($p, '\*(.+?)\*', '<em>$1</em>')
        # Codigo inline
        $p = [regex]::Replace($p, '`([^`]+)`', {
            param($m)
            "<code style='background:#f0f0f0;font-family:Consolas,monospace;font-size:9pt;padding:1px 3px'>$([System.Web.HttpUtility]::HtmlEncode($m.Groups[1].Value))</code>"
        })
        # Links Markdown [texto](url)
        $p = [regex]::Replace($p, '\[([^\]]+)\]\([^\)]+\)', '$1')

        $output.Add("<p style='margin:4px 0'>$p</p>")
    }

    if ($inTable) { $output.Add("</table>") }

    return $output -join "`n"
}

Add-Type -AssemblyName System.Web

Write-Host "Leyendo $mdPath ..."
$mdRaw = [System.IO.File]::ReadAllText($mdPath, [System.Text.Encoding]::UTF8)
$body  = ConvertTo-HtmlDoc -Markdown $mdRaw
$fecha = Get-Date -Format "yyyy-MM-dd HH:mm"

$css = @'
body    { font-family: Calibri, Arial, sans-serif; font-size: 11pt;
          margin: 0; color: #111; line-height: 1.4; }
h1      { font-size: 20pt; color: #1a1a2e; border-bottom: 2px solid #2c3e50;
          padding-bottom: 6px; margin-top: 32px; }
h2      { font-size: 15pt; color: #2c3e50; border-bottom: 1px solid #95a5a6;
          padding-bottom: 4px; margin-top: 24px; }
h3      { font-size: 12pt; color: #2c3e50; margin-top: 18px; }
h4,h5,h6 { font-size: 11pt; color: #34495e; margin-top: 14px; }
table   { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 9pt; }
th      { background: #2c3e50; color: #fff; padding: 6px 8px; }
td      { padding: 5px 8px; border: 1px solid #bdc3c7; }
tr:nth-child(even) td { background: #f8f9fa; }
pre     { background: #f4f4f4; border-left: 3px solid #3498db; padding: 10px;
          font-family: Consolas, monospace; font-size: 9pt; white-space: pre-wrap; }
hr      { border: none; border-top: 1px solid #ccc; margin: 18px 0; }
ul,ol   { margin: 6px 0; padding-left: 22px; }
'@

# Portada simplificada que va dentro del mismo documento
$portada = @"
<div style='text-align:center;margin:40px 0 60px 0;padding:30px;border:2px solid #2c3e50;border-radius:6px'>
  <h1 style='border:none;font-size:22pt;color:#1a1a2e'>Pruebas de Rendimiento<br>ASTER (E1&ndash;E6)</h1>
  <p style='font-size:14pt;color:#555;margin-top:12px'>ASTER &mdash; Asistente Virtual Multimodal de Escritorio</p>
  <p style='font-size:11pt;color:#777;margin-top:28px'>
    Generado: $fecha<br>
    Versi&oacute;n: 1.0
  </p>
</div>
<hr/>
"@

$html = @"
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Pruebas de Rendimiento ASTER</title>
  <style>$css</style>
</head>
<body>
$portada
$body
</body>
</html>
"@

$tmpHtml = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "aster_perf_$([System.IO.Path]::GetRandomFileName()).html")
[System.IO.File]::WriteAllText($tmpHtml, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Archivo HTML temporal: $tmpHtml"

# ---------------------------------------------------------------- Word COM ---
$word = $null
try {
    Write-Host "Iniciando Microsoft Word..."
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0  # wdAlertsNone

    Write-Host "Importando HTML en Word..."
    $doc = $word.Documents.Open(
        $tmpHtml,  # FileName
        $false,    # ConfirmConversions
        $false,    # ReadOnly
        $false     # AddToRecentFiles
    )

    # Margenes academicos (en puntos; 1 cm = 28.35 pt).
    # Se omite PaperSize para evitar error cuando no hay impresora A4 configurada;
    # Word usa el tamano por defecto del sistema (normalmente A4 o Letter).
    $pg = $doc.PageSetup
    $pg.TopMargin    = 70.9   # 2.5 cm
    $pg.BottomMargin = 70.9   # 2.5 cm
    $pg.LeftMargin   = 85.0   # 3.0 cm (lado encuadernado)
    $pg.RightMargin  = 56.7   # 2.0 cm

    if (-not $SoloPdf) {
        Write-Host "Guardando DOCX en $docx ..."
        $doc.SaveAs2($docx, 16)   # 16 = wdFormatXMLDocument (.docx)
        Write-Host "  DOCX guardado."
    }

    if (-not $SoloDocx) {
        Write-Host "Exportando PDF en $pdf ..."
        $doc.ExportAsFixedFormat(
            $pdf,   # OutputFileName
            17,     # ExportFormat: wdExportFormatPDF
            $false, # OpenAfterExport
            0,      # OptimizeFor: wdExportOptimizeForPrint
            0,      # Range: wdExportAllDocument
            1,      # From
            1,      # To
            0,      # Item: wdExportDocumentContent
            $true,  # IncludeDocProps
            $true,  # KeepIRM
            0,      # CreateBookmarks: wdExportCreateNoBookmarks
            $true,  # DocStructureTags
            $true,  # BitmapMissingFonts
            $false  # UseISO19005_1
        )
        Write-Host "  PDF guardado."
    }

    $doc.Close($false)

} catch {
    Write-Error "Error al usar Word COM: $_"
    Write-Host ""
    Write-Host "El archivo HTML para revision manual esta en:"
    Write-Host "  $tmpHtml"
    Write-Host "Puedes abrirlo en Word y guardarlo manualmente como DOCX/PDF."
    exit 1
} finally {
    if ($word) {
        try { $word.Quit() } catch { }
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
    }
    if (Test-Path $tmpHtml) { Remove-Item $tmpHtml -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "======================================================"
Write-Host " Exportacion completada"
Write-Host "======================================================"
if (-not $SoloPdf -and (Test-Path $docx)) {
    $sz = [math]::Round((Get-Item $docx).Length / 1KB, 1)
    Write-Host "  DOCX: $docx  ($sz KB)"
}
if (-not $SoloDocx -and (Test-Path $pdf)) {
    $sz = [math]::Round((Get-Item $pdf).Length / 1KB, 1)
    Write-Host "  PDF:  $pdf  ($sz KB)"
}
Write-Host ""

if ($AbrirAlFinal -and (Test-Path $docx)) {
    Start-Process $docx
}
